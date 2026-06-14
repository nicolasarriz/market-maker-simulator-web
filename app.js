/* =========================================================
 * Market Maker Simulator — Web port
 * Author: Nicolás Arriz
 * Inspired by the AmplifyMe Finance Accelerator.
 * Original Python version: github.com/nicolasarriz/market-maker-simulator
 * ========================================================= */

// ==================== PARAMS ====================
const CLIENT_COMM_BP = 1.5;
const EXCH_COMM_BP = 0.5;
const TICK_MS = 1500;
const MAX_CHART_POINTS = 120;

// Per-symbol liquidity profile (#4). The index (SPX) is deeper and tighter than
// the single name (AAPL): smaller exchange spread, larger typical tickets, less
// price impact per share, lower base vol, and a larger risk limit.
const SYMBOL_CONFIG = {
  AAPL: {
    start: 150.0, volBp: 3.0, anchorDriftBp: 0.40,
    exchHalfSpreadBp: 6.0, exchBlock: 100, exchMaxHalfSpreadBp: 150.0,
    impactBpPer1k: 8.0,
    rfqSizes: [100, 250, 500, 1000],
    clientHalfSpreadBp: 12.0,
    posLimitNotional: 2_000_000,
  },
  SPX: {
    start: 4200.0, volBp: 1.5, anchorDriftBp: 0.25,
    exchHalfSpreadBp: 2.0, exchBlock: 250, exchMaxHalfSpreadBp: 80.0,
    impactBpPer1k: 3.0,
    rfqSizes: [50, 100, 200, 400],
    clientHalfSpreadBp: 6.0,
    posLimitNotional: 5_000_000,
  },
};
// Inventory skew (#1) and risk limits (#2).
const MAX_SKEW_BP = 8.0;       // max center shift applied to suggested client quote
const POS_WARN_FRAC = 0.75;    // highlight positions above this fraction of the limit

// ==================== RNG HELPERS ====================
function randGauss(mean = 0, std = 1) {
  // Box–Muller
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return mean + std * Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}
function randChoice(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function randUniform(a, b) { return a + Math.random() * (b - a); }
function fmt(x, digits = 2) { return Number(x).toFixed(digits); }
function fmtInt(x) { return Math.round(x).toLocaleString("en-US"); }

// ==================== ENGINE ====================
// Mean-reverting GBM (Ornstein–Uhlenbeck on log-price) around a slowly
// random-walking "anchor", plus a decaying vol-cluster after news.
class AssetPriceProcess {
  constructor(symbol, cfg) {
    this.symbol = symbol;
    this.cfg = cfg;
    this.price = cfg.start;
    this.anchor = cfg.start;
    this.baseVolBp = cfg.volBp;
    this.anchorDriftBp = cfg.anchorDriftBp;
    this.meanRevStrength = 0.05;
    this.volShockBp = 0.0;
    this.pendingImpacts = [];
  }
  step() {
    this.anchor *= 1 + randGauss(0, this.anchorDriftBp) / 10000.0;
    this.volShockBp *= 0.85;

    const sigmaBp = this.baseVolBp + this.volShockBp;
    const eps = randGauss(0, sigmaBp);
    const reversionBp = -this.meanRevStrength * Math.log(this.price / this.anchor) * 10000.0;
    const move = this.price * (eps + reversionBp) / 10000.0;

    let newsMoveBp = 0.0;
    const remaining = [];
    for (const imp of this.pendingImpacts) {
      if (imp.leadLeft > 0) { imp.leadLeft -= 1; remaining.push(imp); continue; }
      newsMoveBp += imp.perTickBp;
      imp.ticksLeft -= 1;
      if (imp.ticksLeft > 0) remaining.push(imp);
    }
    this.pendingImpacts = remaining;
    const newsMove = this.price * newsMoveBp / 10000.0;

    this.price += move + newsMove;
    if (this.price <= 0) this.price = 0.01;
    return this.price;
  }
  scheduleNewsImpact(directionSign, totalImpactBp, leadTicks, durationTicks) {
    const perTickBp = directionSign * totalImpactBp / durationTicks;
    this.pendingImpacts.push({ leadLeft: leadTicks, ticksLeft: durationTicks, perTickBp });
    this.volShockBp += totalImpactBp * 0.20;
  }
  applyTradeImpact(signedSize) {
    if (signedSize === 0) return this.price;
    const impactBp = this.cfg.impactBpPer1k * signedSize / 1000.0;
    this.price *= 1.0 + impactBp / 10000.0;
    if (this.price <= 0) this.price = 0.01;
    return this.price;
  }
}

class NewsGenerator {
  constructor(probNews = 0.04) {
    this.probNews = probNews;
    this.POSITIVE = [
      "Earnings beat expectations",
      "Central bank signals rate cuts",
      "Strong jobs data",
      "Upgraded guidance",
      "Trade tensions ease",
    ];
    this.NEGATIVE = [
      "Earnings miss expectations",
      "Central bank hints at hikes",
      "Weak jobs data",
      "Profit warning",
      "Geopolitical tensions rise",
    ];
  }
  maybeGenerate(t) {
    if (Math.random() > this.probNews) return null;
    const direction = randChoice([-1, 1]);
    const impactBp = randUniform(15, 70);
    const leadTicks = Math.floor(randUniform(2, 5));
    const durationTicks = Math.floor(randUniform(3, 7));
    const pool = direction > 0 ? this.POSITIVE : this.NEGATIVE;
    return { time: t, headline: randChoice(pool), direction, impactBp, leadTicks, durationTicks };
  }
}

class Client {
  constructor(name, aggressiveness = 0.6) {
    this.name = name;
    this.aggressiveness = aggressiveness;
  }
  // Two-way RFQ (#3): the client has a hidden latent axe (`latentSide`) but only
  // commits to it if the price is acceptable — AND will pick off whichever side
  // you quote through fair value, regardless of its axe. That is the adverse
  // selection that punishes a badly skewed two-way price.
  decideTwoWay(latentSide, size, trueMid, bid, ask) {
    const spreadBp = (ask - bid) / trueMid * 10000.0;
    const sellEdgeBp = (bid - trueMid) / trueMid * 10000.0; // client sells @ bid
    const buyEdgeBp = (trueMid - ask) / trueMid * 10000.0;  // client buys @ ask

    // 1) Pick-off: a side quoted through fair value (positive edge) gets taken.
    const PICKOFF_BP = 1.0;
    if ((buyEdgeBp > PICKOFF_BP || sellEdgeBp > PICKOFF_BP) && Math.random() < 0.9) {
      if (buyEdgeBp >= sellEdgeBp) {
        return { action: "lift_ask", price: ask,
          msg: `Lifting your offer — ${size} @ ${fmt(ask)} (you're through fair).` };
      }
      return { action: "hit_bid", price: bid,
        msg: `Hitting your bid — ${size} @ ${fmt(bid)} (you're through fair).` };
    }

    // 2) Otherwise the client trades its latent axe if the level is good enough.
    const edgeBp = latentSide === "sell" ? sellEdgeBp : buyEdgeBp;
    const baseProb = 0.2 + 0.5 * this.aggressiveness;
    let probTrade = baseProb + 0.02 * edgeBp - 0.003 * Math.max(0.0, spreadBp - 40.0);
    probTrade = Math.max(0.02, Math.min(0.95, probTrade));

    if (Math.random() < probTrade) {
      if (latentSide === "sell") {
        return { action: "hit_bid", price: bid, msg: `OK, I'll sell you ${size} @ ${fmt(bid)}.` };
      }
      return { action: "lift_ask", price: ask, msg: `OK, I'll buy ${size} @ ${fmt(ask)}.` };
    }

    // 3) Negotiate or walk away (based on the latent side).
    let negoProb = 0.0;
    if (spreadBp > 60) negoProb += 0.4;
    if (edgeBp < -8) negoProb += 0.3;
    if (Math.abs(edgeBp) < 5) negoProb += 0.2;
    negoProb = Math.max(0.0, Math.min(0.85, negoProb));

    if (Math.random() < negoProb) {
      return {
        action: "negotiate",
        price: null,
        msg: this._negotiationMessage(latentSide, size, trueMid, bid, ask, spreadBp, edgeBp),
      };
    }

    const msg = latentSide === "sell"
      ? "No thanks, your bid is too low for me."
      : "No trade, your offer is too expensive.";
    return { action: "reject", price: null, msg };
  }
  _negotiationMessage(side, size, mid, bid, ask, spreadBp, edgeBp) {
    const line1 = `Mid ${fmt(mid)}, you quoted ${fmt(bid)}/${fmt(ask)} (${Math.round(spreadBp)}bp wide).`;
    const hints = [];
    if (spreadBp > 80) hints.push("Your spread is too wide, can you tighten it?");
    else if (spreadBp > 50) hints.push("Spread is a bit wide, tighten it a touch please.");
    if (side === "sell") {
      if (edgeBp < -5) hints.push("Your bid is too cheap, I need a better level to sell.");
      else hints.push("You're close on the bid, just improve it slightly.");
    } else {
      if (edgeBp < -5) hints.push("Your offer is too high, come closer to the mid.");
      else hints.push("You're close on the offer, can you shave a bit off?");
    }
    return line1 + "\n" + hints.join(" ");
  }
}

class MarketMaker {
  constructor(name, initialCash = 1_000_000.0) {
    this.name = name;
    this.cash = initialCash;
    this.positions = {};
    this.avgCost = {};
    this.trades = [];
    this.commissions = 0.0;
  }
  position(symbol) { return this.positions[symbol] || 0; }

  updatePosition(symbol, side, price, size, commissionRateBp = 0.0) {
    let pos = this.positions[symbol] || 0;
    let cost = this.avgCost[symbol] || 0.0;
    size = Math.abs(Math.round(size));
    if (size <= 0) return 0.0;

    const notional = price * size;
    const commission = Math.abs(notional) * commissionRateBp / 10000.0;
    this.commissions += commission;

    if (side === "buy") this.cash -= notional + commission;
    else this.cash += notional - commission;

    let realizedPnl = 0.0;

    if (pos === 0) {
      const newPos = side === "buy" ? size : -size;
      this.positions[symbol] = newPos;
      this.avgCost[symbol] = price;
    } else if (pos > 0) {
      if (side === "buy") {
        const newPos = pos + size;
        this.avgCost[symbol] = (cost * pos + price * size) / newPos;
        this.positions[symbol] = newPos;
      } else {
        if (size < pos) {
          const newPos = pos - size;
          realizedPnl = (price - cost) * size;
          this.positions[symbol] = newPos;
        } else if (size === pos) {
          realizedPnl = (price - cost) * size;
          this.positions[symbol] = 0;
          this.avgCost[symbol] = 0.0;
        } else {
          realizedPnl = (price - cost) * pos;
          const newShort = size - pos;
          this.positions[symbol] = -newShort;
          this.avgCost[symbol] = price;
        }
      }
    } else {
      const absPos = -pos;
      if (side === "sell") {
        const newPos = pos - size;
        this.avgCost[symbol] = (cost * absPos + price * size) / (absPos + size);
        this.positions[symbol] = newPos;
      } else {
        if (size < absPos) {
          const newPos = pos + size;
          realizedPnl = (cost - price) * size;
          this.positions[symbol] = newPos;
        } else if (size === absPos) {
          realizedPnl = (cost - price) * size;
          this.positions[symbol] = 0;
          this.avgCost[symbol] = 0.0;
        } else {
          realizedPnl = (cost - price) * absPos;
          const newLong = size - absPos;
          this.positions[symbol] = newLong;
          this.avgCost[symbol] = price;
        }
      }
    }

    this.trades.push({ symbol, side, price, size, pnl: realizedPnl, commission });
    return realizedPnl;
  }

  mtmPnl(prices) {
    let pnl = 0.0;
    for (const [sym, pos] of Object.entries(this.positions)) {
      const price = prices[sym] || 0.0;
      const cost = this.avgCost[sym] || 0.0;
      pnl += (price - cost) * pos;
    }
    return pnl;
  }
  realizedPnl() { return this.trades.reduce((acc, t) => acc + t.pnl, 0.0); }
}

class MarketEnvironment {
  constructor(symbols = ["AAPL", "SPX"]) {
    this.time = 0;
    this.symbols = [...symbols];
    this.assets = {};
    symbols.forEach(s => this.assets[s] = new AssetPriceProcess(s, SYMBOL_CONFIG[s]));
    this.newsGen = new NewsGenerator();
    this.client = new Client("HF_1", 0.6);
  }
  step() {
    this.time += 1;
    const news = this.newsGen.maybeGenerate(this.time);
    let newsSymbol = null;
    if (news) {
      newsSymbol = randChoice(this.symbols);
      this.assets[newsSymbol].scheduleNewsImpact(
        news.direction, news.impactBp, news.leadTicks, news.durationTicks,
      );
    }
    const prices = {};
    for (const [sym, asset] of Object.entries(this.assets)) prices[sym] = asset.step();
    return { newsSymbol, news, prices };
  }
}

// ==================== APP ====================
class MarketMakerApp {
  constructor() {
    this.env = new MarketEnvironment();
    this.mm = new MarketMaker("You");
    this.symbols = this.env.symbols;
    this.currentSymbol = this.symbols[0];
    this.priceHistory = {};
    this.symbols.forEach(s => this.priceHistory[s] = []);
    this.activeRfq = null;
    this.running = true;
    this.lastMids = {};
    this.symbols.forEach(s => this.lastMids[s] = this.env.assets[s].price);

    this._cacheDom();
    this._bindUi();
    this._buildSymbolMenu();
    this._buildMidTable();

    this.logChat("System", "Welcome to the Market Maker Simulator.");
    this.logChat("System", "Waiting for RFQs from client...");

    this._tickHandle = setInterval(() => this.tick(), TICK_MS);
    this._resizeCanvas();
    window.addEventListener("resize", () => this._resizeCanvas());
  }

  _cacheDom() {
    this.$time = document.getElementById("lbl-time");
    this.$realized = document.getElementById("lbl-realized");
    this.$unrealized = document.getElementById("lbl-unrealized");
    this.$total = document.getElementById("lbl-total");
    this.$commission = document.getElementById("lbl-commission");
    this.$cash = document.getElementById("lbl-cash");
    this.$btnPause = document.getElementById("btn-pause");
    this.$btnReset = document.getElementById("btn-reset");
    this.$chatList = document.getElementById("chat-list");
    this.$rfqInfo = document.getElementById("rfq-info");
    this.$entryBid = document.getElementById("entry-bid");
    this.$entryAsk = document.getElementById("entry-ask");
    this.$btnQuote = document.getElementById("btn-quote");
    this.$newsList = document.getElementById("news-list");
    this.$symbolSelect = document.getElementById("symbol-select");
    this.$lblMid = document.getElementById("lbl-mid");
    this.$lblExchBid = document.getElementById("lbl-exch-bid");
    this.$lblExchAsk = document.getElementById("lbl-exch-ask");
    this.$exchSize = document.getElementById("exch-size");
    this.$btnBuyExch = document.getElementById("btn-buy-exch");
    this.$btnSellExch = document.getElementById("btn-sell-exch");
    this.$midTable = document.getElementById("mid-table");
    this.$posBody = document.querySelector("#pos-table tbody");
    this.$msgBar = document.getElementById("msg-bar");
    this.$chartTitle = document.getElementById("chart-title");
    this.$canvas = document.getElementById("price-chart");
    this.ctx = this.$canvas.getContext("2d");
  }

  _bindUi() {
    this.$btnPause.addEventListener("click", () => this.togglePause());
    this.$btnReset.addEventListener("click", () => this.reset());
    this.$btnQuote.addEventListener("click", () => this.sendQuote());
    this.$entryBid.addEventListener("keydown", e => {
      if (e.key === "Enter") { e.preventDefault(); this.$entryAsk.focus(); this.$entryAsk.select(); }
    });
    this.$entryAsk.addEventListener("keydown", e => {
      if (e.key === "Enter") { e.preventDefault(); this.sendQuote(); }
    });
    this.$symbolSelect.addEventListener("change", e => this.onSymbolChange(e.target.value));
    this.$exchSize.addEventListener("input", () => this._updateExchangeView(this.env.assets[this.currentSymbol].price));
    this.$btnBuyExch.addEventListener("click", () => this.buyExchange());
    this.$btnSellExch.addEventListener("click", () => this.sellExchange());
  }

  _buildSymbolMenu() {
    this.$symbolSelect.innerHTML = "";
    this.symbols.forEach(s => {
      const opt = document.createElement("option");
      opt.value = s;
      opt.textContent = s;
      this.$symbolSelect.appendChild(opt);
    });
    this.$symbolSelect.value = this.currentSymbol;
  }

  _buildMidTable() {
    this.$midTable.innerHTML = "";
    this.midRows = {};
    this.symbols.forEach(sym => {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td>${sym}</td><td class="mid-val">${fmt(this.lastMids[sym])}</td><td class="mid-arrow">→</td>`;
      this.$midTable.appendChild(tr);
      this.midRows[sym] = {
        val: tr.querySelector(".mid-val"),
        arrow: tr.querySelector(".mid-arrow"),
      };
    });
  }

  _resizeCanvas() {
    const rect = this.$canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.$canvas.width = rect.width * dpr;
    this.$canvas.height = rect.height * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.drawPriceChart();
  }

  // ==================== TICK ====================
  tick() {
    if (!this.running) return;

    const { newsSymbol, news, prices } = this.env.step();
    for (const [sym, p] of Object.entries(prices)) this._recordPrice(sym, p);

    this._updatePnlAndHeader(prices);
    this._updateExchangeView(prices[this.currentSymbol]);
    this._updateMidMonitor(prices);

    if (news) {
      const symTxt = newsSymbol || "MKT";
      const hitsInSec = (news.leadTicks * TICK_MS / 1000).toFixed(1);
      const overSec = (news.durationTicks * TICK_MS / 1000).toFixed(1);
      const txt = `${symTxt}: ${news.headline} (~${fmt(news.impactBp, 0)}bp, hits in ${hitsInSec}s over ${overSec}s)`;
      this._appendNews(txt);
    }

    if (this.activeRfq === null && Math.random() < 0.6) {
      const side = randChoice(["buy", "sell"]); // latent axe, hidden from player
      const sym = randChoice(this.symbols);
      const size = randChoice(this.env.assets[sym].cfg.rfqSizes);
      const mid = prices[sym];
      this.activeRfq = { symbol: sym, side, size, mid };

      // #1 — suggest an inventory-skewed two-way and pre-fill the inputs.
      const sug = this.computeSuggestedQuote(sym, mid, size);
      this.$entryBid.value = fmt(sug.bid);
      this.$entryAsk.value = fmt(sug.ask);
      let skewTxt = "flat";
      if (sug.skewBp < -0.5) skewTxt = `skewed down ${fmt(-sug.skewBp, 1)}bp (you're long)`;
      else if (sug.skewBp > 0.5) skewTxt = `skewed up ${fmt(sug.skewBp, 1)}bp (you're short)`;

      this.$rfqInfo.textContent = `Client RFQ: two-way for ${sym}, size ${size} (side hidden). Suggested ${skewTxt}.`;
      this.logChat("Client", `Please make me a price for ${size} ${sym}.`);
      this.$msgBar.textContent = "Suggested quote pre-filled — adjust BID/ASK and press Enter.";
    } else if (this.activeRfq === null) {
      this.$rfqInfo.textContent = "No active RFQ.";
    }

    this.refreshPositions(prices);
    this.drawPriceChart();
  }

  // ==================== HELPERS ====================
  togglePause() {
    this.running = !this.running;
    this.$btnPause.textContent = this.running ? "Pause" : "Resume";
    this.$msgBar.textContent = this.running ? "Running – market time resumed." : "Paused – market time stopped.";
  }

  reset() {
    if (!confirm("Reset the simulation? All trades and PnL will be cleared.")) return;
    this.env = new MarketEnvironment();
    this.mm = new MarketMaker("You");
    this.currentSymbol = this.symbols[0];
    this.priceHistory = {};
    this.symbols.forEach(s => this.priceHistory[s] = []);
    this.activeRfq = null;
    this.running = true;
    this.symbols.forEach(s => this.lastMids[s] = this.env.assets[s].price);
    this.$btnPause.textContent = "Pause";
    this.$chatList.innerHTML = "";
    this.$newsList.innerHTML = "";
    this.$symbolSelect.value = this.currentSymbol;
    this._buildMidTable();
    this.$msgBar.textContent = "Simulation reset.";
    const prices = {};
    this.symbols.forEach(s => prices[s] = this.env.assets[s].price);
    this._updatePnlAndHeader(prices);
    this._updateExchangeView(prices[this.currentSymbol]);
    this.refreshPositions(prices);
    this.drawPriceChart();
    this.logChat("System", "Simulation reset. Waiting for new RFQs...");
  }

  _recordPrice(sym, price) {
    const lst = this.priceHistory[sym];
    lst.push(price);
    if (lst.length > MAX_CHART_POINTS) lst.shift();
  }

  _updatePnlAndHeader(prices) {
    const realized = this.mm.realizedPnl();
    const mtm = this.mm.mtmPnl(prices);
    // Total PnL is the true change in equity: gross trading PnL net of all
    // commissions paid. (cash + position value - initial cash == this.)
    const total = realized + mtm - this.mm.commissions;
    this.$time.textContent = `T: ${this.env.time}`;
    this.$realized.textContent = `Realized PnL: ${fmtInt(realized)}`;
    this.$unrealized.textContent = `Unrealized PnL: ${fmtInt(mtm)}`;
    this.$total.textContent = `Total PnL: ${fmtInt(total)}`;
    this.$cash.textContent = `Cash: ${fmtInt(this.mm.cash)}`;
    this.$commission.textContent = `Commission Paid: ${fmtInt(this.mm.commissions)}`;
    this.$realized.className = "stat " + (realized >= 0 ? "pos" : "neg");
    this.$unrealized.className = "stat " + (mtm >= 0 ? "pos" : "neg");
    this.$total.className = "stat highlight";
  }

  _updateExchangeView(mid) {
    this.$lblMid.textContent = `Mid: ${fmt(mid)}`;
    const size = this._getExchangeSizePreview();
    const [bid, ask] = this.computeExchangeQuotes(mid, size);
    this.$lblExchBid.textContent = `Bid: ${fmt(bid)}`;
    this.$lblExchAsk.textContent = `Ask: ${fmt(ask)}`;
  }

  _updateMidMonitor(prices) {
    this.symbols.forEach(sym => {
      const n = prices[sym] ?? this.env.assets[sym].price;
      const o = this.lastMids[sym] ?? n;
      let arrow = "→", color = "var(--fg-text)";
      if (n > o) { arrow = "↑"; color = "var(--fg-positive)"; }
      else if (n < o) { arrow = "↓"; color = "var(--fg-negative)"; }
      this.midRows[sym].val.textContent = fmt(n);
      this.midRows[sym].arrow.textContent = arrow;
      this.midRows[sym].arrow.style.color = color;
      this.lastMids[sym] = n;
    });
  }

  logChat(sender, text) {
    const li = document.createElement("li");
    const cls = sender === "System" ? "chat-system"
              : sender === "Client" ? "chat-client"
              : sender === "Trade"  ? "chat-trade"
              : sender === "Exchange" ? "chat-exchange"
              : "";
    li.className = cls;
    li.textContent = `[${sender}] ${text}`;
    this.$chatList.appendChild(li);
    while (this.$chatList.children.length > 200) this.$chatList.removeChild(this.$chatList.firstChild);
    this.$chatList.scrollTop = this.$chatList.scrollHeight;
  }

  _appendNews(txt) {
    const li = document.createElement("li");
    li.textContent = txt;
    this.$newsList.appendChild(li);
    while (this.$newsList.children.length > 40) this.$newsList.removeChild(this.$newsList.firstChild);
    this.$newsList.scrollTop = this.$newsList.scrollHeight;
  }

  refreshPositions(prices) {
    this.$posBody.innerHTML = "";
    this.symbols.forEach(sym => {
      const pos = this.mm.position(sym);
      const avg = this.mm.avgCost[sym] || 0.0;
      const price = prices[sym] ?? this.env.assets[sym].price;
      const value = pos * price;
      const upnl = pos !== 0 ? (price - avg) * pos : 0.0;
      const cls = upnl > 0 ? "pos-positive" : upnl < 0 ? "pos-negative" : "";

      // #2 — risk highlight vs the per-symbol notional limit.
      const limit = this.env.assets[sym].cfg.posLimitNotional;
      const used = Math.abs(value) / limit;
      let riskCls = "", mark = "";
      if (used > 1.0) { riskCls = "risk-over"; mark = " 🔴"; }
      else if (used > POS_WARN_FRAC) { riskCls = "risk-warn"; mark = " 🟠"; }

      const tr = document.createElement("tr");
      tr.className = `${cls} ${riskCls}`.trim();
      tr.innerHTML = `<td>${sym}${mark}</td><td>${pos}</td><td>${fmt(avg)}</td><td>${fmtInt(value)}</td><td>${fmtInt(upnl)}</td>`;
      this.$posBody.appendChild(tr);
    });
  }

  // ==================== CHART ====================
  drawPriceChart() {
    const ctx = this.ctx;
    const W = this.$canvas.clientWidth;
    const H = this.$canvas.clientHeight;
    ctx.clearRect(0, 0, W, H);

    const series = this.priceHistory[this.currentSymbol];
    if (!series || series.length < 2) return;

    let maxP = Math.max(...series);
    let minP = Math.min(...series);
    if (maxP === minP) { maxP += 1; minP -= 1; }

    const padding = 45;
    const scaleY = (H - 2 * padding) / (maxP - minP);
    const scaleX = (W - 2 * padding) / (series.length - 1);

    // grid + price levels
    ctx.strokeStyle = "rgba(255,255,255,0.06)";
    ctx.fillStyle = "#6b7d9c";
    ctx.font = "11px Consolas, monospace";
    ctx.setLineDash([3, 5]);
    ctx.lineWidth = 1;
    const nLevels = 4;
    for (let i = 0; i <= nLevels; i++) {
      const level = minP + (maxP - minP) * i / nLevels;
      const y = H - padding - (level - minP) * scaleY;
      ctx.beginPath();
      ctx.moveTo(padding, y);
      ctx.lineTo(W - padding, y);
      ctx.stroke();
      ctx.fillText(fmt(level), 6, y + 3);
    }
    ctx.setLineDash([]);

    // trend colour: green if rising over the window, red if falling
    const rising = series[series.length - 1] >= series[0];
    const lineColor = rising ? "#34e08a" : "#ff6166";
    const baseY = H - padding;
    const xAt = i => padding + i * scaleX;
    const yAt = p => baseY - (p - minP) * scaleY;

    // gradient area fill under the line
    const grad = ctx.createLinearGradient(0, padding, 0, baseY);
    grad.addColorStop(0, rising ? "rgba(52,224,138,0.28)" : "rgba(255,97,102,0.26)");
    grad.addColorStop(1, "rgba(52,224,138,0)");
    ctx.beginPath();
    ctx.moveTo(xAt(0), baseY);
    series.forEach((p, i) => ctx.lineTo(xAt(i), yAt(p)));
    ctx.lineTo(xAt(series.length - 1), baseY);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();

    // price line with soft glow
    ctx.save();
    ctx.strokeStyle = lineColor;
    ctx.lineWidth = 2;
    ctx.lineJoin = "round";
    ctx.shadowColor = lineColor;
    ctx.shadowBlur = 8;
    ctx.beginPath();
    series.forEach((p, i) => {
      const x = xAt(i), y = yAt(p);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.restore();

    // last-price marker with halo
    const lastX = xAt(series.length - 1);
    const lastY = yAt(series[series.length - 1]);
    ctx.fillStyle = "rgba(255,255,255,0.12)";
    ctx.beginPath();
    ctx.arc(lastX, lastY, 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = lineColor;
    ctx.beginPath();
    ctx.arc(lastX, lastY, 3.5, 0, Math.PI * 2);
    ctx.fill();
  }

  // ==================== EXCHANGE MODEL ====================
  computeExchangeQuotes(mid, size, sym = this.currentSymbol) {
    const cfg = this.env.assets[sym].cfg;
    size = Math.max(1, Math.abs(size));
    const sizeFactor = Math.pow(size / cfg.exchBlock, 1.1);
    let halfSpreadBp = cfg.exchHalfSpreadBp * sizeFactor;
    halfSpreadBp = Math.max(cfg.exchHalfSpreadBp * 0.7, Math.min(cfg.exchMaxHalfSpreadBp, halfSpreadBp));
    halfSpreadBp += randUniform(-1.0, 4.0);
    const bid = mid * (1 - halfSpreadBp / 10000.0);
    const ask = mid * (1 + halfSpreadBp / 10000.0);
    return [bid, ask];
  }

  // #1 — inventory-skewed two-way the player *should* quote a client. The center
  // is shifted away from your inventory (long -> lower, to encourage selling and
  // discourage buying), with a per-symbol half-spread on top.
  computeSuggestedQuote(sym, mid, size) {
    const cfg = this.env.assets[sym].cfg;
    const posNotional = this.mm.position(sym) * mid;
    const frac = Math.max(-1.5, Math.min(1.5, posNotional / cfg.posLimitNotional));
    const skewBp = -frac * MAX_SKEW_BP;
    const center = mid * (1 + skewBp / 10000.0);
    const half = cfg.clientHalfSpreadBp / 10000.0;
    return { bid: center * (1 - half), ask: center * (1 + half), skewBp };
  }

  // #2 — risk limits. Returns how a position change sits against the per-symbol
  // notional limit, and whether it *increases* exposure (reducing is always ok).
  _riskCheck(sym, deltaShares) {
    const cfg = this.env.assets[sym].cfg;
    const mid = this.env.assets[sym].price;
    const curPos = this.mm.position(sym);
    const newPos = curPos + deltaShares;
    const newNotional = Math.abs(newPos * mid);
    return {
      limit: cfg.posLimitNotional,
      newNotional,
      increasing: Math.abs(newPos) > Math.abs(curPos),
      over: newNotional > cfg.posLimitNotional,
    };
  }

  // ==================== USER ACTIONS ====================
  sendQuote() {
    if (!this.activeRfq) { this.$msgBar.textContent = "No active RFQ to quote."; return; }
    const bid = parseFloat(this.$entryBid.value);
    const ask = parseFloat(this.$entryAsk.value);
    if (!isFinite(bid) || !isFinite(ask)) { this.$msgBar.textContent = "Invalid bid/ask."; return; }
    if (bid >= ask) { this.$msgBar.textContent = "Bid must be < Ask."; return; }

    const rfq = this.activeRfq;
    // Evaluate the client's decision against the LIVE mid, not the mid frozen
    // when the RFQ arrived — the market keeps moving while you quote/negotiate.
    const liveMid = this.env.assets[rfq.symbol].price;
    rfq.mid = liveMid;
    const { action, price: dealPrice, msg } = this.env.client.decideTwoWay(rfq.side, rfq.size, liveMid, bid, ask);
    if (msg) this.logChat("Client", msg);

    if (action === "negotiate") {
      this.$msgBar.textContent = "Client is negotiating: improve your price and send again.";
      this.$rfqInfo.textContent = "Client negotiating: tighten or improve your quote.";
      return;
    }

    this.activeRfq = null;
    this.$entryBid.value = "";
    this.$entryAsk.value = "";

    if (action === "reject") {
      this.$msgBar.textContent = "Client: no trade at your price.";
      this.$rfqInfo.textContent = "RFQ expired (client rejected).";
      return;
    }

    // Market impact follows the CLIENT (the aggressor / liquidity taker):
    // a client sell pushes the price down, a client buy pushes it up. This is
    // what creates adverse selection — after the client sells to you, you are
    // long into a falling market, which is the core risk of market making.
    let aggressorSize;
    if (action === "hit_bid") {
      const realized = this.mm.updatePosition(rfq.symbol, "buy", dealPrice, rfq.size, CLIENT_COMM_BP);
      this.$msgBar.textContent = `${rfq.symbol} – Client SELLS ${rfq.size} @ ${fmt(dealPrice)} -> you BUY. Realized PnL: ${fmtInt(realized)}`;
      this.logChat("Trade", `${rfq.symbol}: Client SOLD ${rfq.size} @ ${fmt(dealPrice)} (you BUY).`);
      aggressorSize = -rfq.size;
    } else {
      const realized = this.mm.updatePosition(rfq.symbol, "sell", dealPrice, rfq.size, CLIENT_COMM_BP);
      this.$msgBar.textContent = `${rfq.symbol} – Client BUYS ${rfq.size} @ ${fmt(dealPrice)} -> you SELL. Realized PnL: ${fmtInt(realized)}`;
      this.logChat("Trade", `${rfq.symbol}: Client BOUGHT ${rfq.size} @ ${fmt(dealPrice)} (you SELL).`);
      aggressorSize = rfq.size;
    }

    this.$rfqInfo.textContent = "RFQ completed.";

    // #2 — warn (but don't block: the client chose) if the fill breaches your limit.
    const postRisk = this._riskCheck(rfq.symbol, 0);
    if (postRisk.over) {
      this.$msgBar.textContent += `  ⚠ ${rfq.symbol} over risk limit (${fmtInt(postRisk.newNotional)}/${fmtInt(postRisk.limit)}) — hedge on the exchange.`;
    }

    const asset = this.env.assets[rfq.symbol];
    const newPrice = asset.applyTradeImpact(aggressorSize);
    this._recordPrice(rfq.symbol, newPrice);

    const prices = {};
    for (const [s, a] of Object.entries(this.env.assets)) prices[s] = a.price;
    this._updatePnlAndHeader(prices);
    this._updateExchangeView(prices[this.currentSymbol]);
    this._updateMidMonitor(prices);
    this.refreshPositions(prices);
    this.drawPriceChart();
  }

  _getExchangeSizePreview() {
    const n = parseInt(this.$exchSize.value, 10);
    if (!isFinite(n) || n === 0) return 100;
    return Math.abs(n);
  }
  _getExchangeSizeStrict() {
    const raw = this.$exchSize.value.trim();
    if (!raw) { this.$msgBar.textContent = "Enter size (>0)."; return null; }
    const n = parseInt(raw, 10);
    if (!isFinite(n)) { this.$msgBar.textContent = "Size must be integer."; return null; }
    if (n === 0) { this.$msgBar.textContent = "Size 0: no trade."; return null; }
    return Math.abs(n);
  }

  buyExchange() {
    const size = this._getExchangeSizeStrict();
    if (size === null) return;
    const sym = this.currentSymbol;
    const risk = this._riskCheck(sym, size);
    if (risk.over && risk.increasing) {
      this.$msgBar.textContent = `RISK LIMIT: buying ${size} ${sym} would push exposure to ${fmtInt(risk.newNotional)} (limit ${fmtInt(risk.limit)}). Reduce risk first.`;
      return;
    }
    const asset = this.env.assets[sym];
    const mid = asset.price;
    const [, ask] = this.computeExchangeQuotes(mid, size, sym);
    this.mm.updatePosition(sym, "buy", ask, size, EXCH_COMM_BP);
    this.$msgBar.textContent = `${sym} – EXCHANGE: BOUGHT ${size} @ ${fmt(ask)}.`;
    this.logChat("Exchange", `${sym}: BOUGHT ${size} @ ${fmt(ask)}.`);
    const newPrice = asset.applyTradeImpact(size);
    this._recordPrice(sym, newPrice);
    this._refreshAll();
  }

  sellExchange() {
    const size = this._getExchangeSizeStrict();
    if (size === null) return;
    const sym = this.currentSymbol;
    const risk = this._riskCheck(sym, -size);
    if (risk.over && risk.increasing) {
      this.$msgBar.textContent = `RISK LIMIT: selling ${size} ${sym} would push exposure to ${fmtInt(risk.newNotional)} (limit ${fmtInt(risk.limit)}). Reduce risk first.`;
      return;
    }
    const asset = this.env.assets[sym];
    const mid = asset.price;
    const [bid] = this.computeExchangeQuotes(mid, size, sym);
    this.mm.updatePosition(sym, "sell", bid, size, EXCH_COMM_BP);
    this.$msgBar.textContent = `${sym} – EXCHANGE: SOLD ${size} @ ${fmt(bid)}.`;
    this.logChat("Exchange", `${sym}: SOLD ${size} @ ${fmt(bid)}.`);
    const newPrice = asset.applyTradeImpact(-size);
    this._recordPrice(sym, newPrice);
    this._refreshAll();
  }

  _refreshAll() {
    const prices = {};
    for (const [s, a] of Object.entries(this.env.assets)) prices[s] = a.price;
    this._updatePnlAndHeader(prices);
    this._updateExchangeView(prices[this.currentSymbol]);
    this._updateMidMonitor(prices);
    this.refreshPositions(prices);
    this.drawPriceChart();
  }

  onSymbolChange(value) {
    this.currentSymbol = value;
    this.$chartTitle.textContent = `PRICE CHART — ${value}`;
    this._updateExchangeView(this.env.assets[value].price);
    this.drawPriceChart();
  }
}

// ==================== BOOT ====================
document.addEventListener("DOMContentLoaded", () => {
  window.app = new MarketMakerApp();
});
