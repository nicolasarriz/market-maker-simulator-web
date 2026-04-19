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
class AssetPriceProcess {
  constructor(symbol, startPrice, volBp = 13.0) {
    this.symbol = symbol;
    this.price = startPrice;
    this.volBp = volBp;
  }
  step(news = null) {
    const epsBp = randGauss(0, this.volBp);
    const move = this.price * epsBp / 10000.0;
    let newsMove = 0.0;
    if (news) newsMove = this.price * news.direction * news.impactBp / 10000.0;
    this.price += move + newsMove;
    if (this.price <= 0) this.price = 0.01;
    return this.price;
  }
  applyTradeImpact(signedSize) {
    if (signedSize === 0) return this.price;
    const impactBp = 8.0 * signedSize / 1000.0;
    this.price *= 1.0 + impactBp / 10000.0;
    if (this.price <= 0) this.price = 0.01;
    return this.price;
  }
}

class NewsGenerator {
  constructor(probNews = 0.15) {
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
    const impactBp = randUniform(10, 80);
    const pool = direction > 0 ? this.POSITIVE : this.NEGATIVE;
    return { time: t, headline: randChoice(pool), direction, impactBp };
  }
}

class Client {
  constructor(name, aggressiveness = 0.6) {
    this.name = name;
    this.aggressiveness = aggressiveness;
  }
  decideTrade(side, size, trueMid, bid, ask) {
    const spreadBp = (ask - bid) / trueMid * 10000.0;
    const edgeBp = side === "sell"
      ? (bid - trueMid) / trueMid * 10000.0
      : (trueMid - ask) / trueMid * 10000.0;

    const baseProb = 0.2 + 0.5 * this.aggressiveness;
    let probTrade = baseProb + 0.02 * edgeBp - 0.003 * Math.max(0.0, spreadBp - 40.0);
    probTrade = Math.max(0.02, Math.min(0.95, probTrade));

    if (Math.random() < probTrade) {
      if (side === "sell") {
        return { action: "hit_bid", price: bid, msg: `OK, I'll sell you ${size} @ ${fmt(bid)}.` };
      } else {
        return { action: "lift_ask", price: ask, msg: `OK, I'll buy ${size} @ ${fmt(ask)}.` };
      }
    }

    let negoProb = 0.0;
    if (spreadBp > 60) negoProb += 0.4;
    if (edgeBp < -8) negoProb += 0.3;
    if (Math.abs(edgeBp) < 5) negoProb += 0.2;
    negoProb = Math.max(0.0, Math.min(0.85, negoProb));

    if (Math.random() < negoProb) {
      return {
        action: "negotiate",
        price: null,
        msg: this._negotiationMessage(side, size, trueMid, bid, ask, spreadBp, edgeBp),
      };
    }

    const msg = side === "sell"
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
  constructor(symbols = ["AAPL", "SPX"], startPrices = [150.0, 4200.0]) {
    this.time = 0;
    this.symbols = [...symbols];
    this.assets = {};
    symbols.forEach((s, i) => this.assets[s] = new AssetPriceProcess(s, startPrices[i]));
    this.newsGen = new NewsGenerator();
    this.client = new Client("HF_1", 0.6);
  }
  step() {
    this.time += 1;
    const news = this.newsGen.maybeGenerate(this.time);
    const newsSymbol = news ? randChoice(this.symbols) : null;
    const prices = {};
    for (const [sym, asset] of Object.entries(this.assets)) {
      const pNews = (news && sym === newsSymbol) ? news : null;
      prices[sym] = asset.step(pNews);
    }
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
    this.rngSizes = [100, 250, 500, 1000];
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
      const dir = news.direction > 0 ? "BULLISH" : "BEARISH";
      const symTxt = newsSymbol || "MKT";
      const txt = `${symTxt}: [${dir}] ${news.headline} (impact ~${fmt(news.impactBp, 1)}bp)`;
      this._appendNews(txt);
    }

    if (this.activeRfq === null && Math.random() < 0.6) {
      const side = randChoice(["buy", "sell"]);
      const size = randChoice(this.rngSizes);
      const sym = randChoice(this.symbols);
      const mid = prices[sym];
      this.activeRfq = { symbol: sym, side, size, mid };
      this.$rfqInfo.textContent = `Client RFQ: two-way price for ${sym}, size ${size} (side hidden).`;
      this.logChat("Client", `Please make me a price for ${size} ${sym}.`);
      this.$msgBar.textContent = "Enter BID/ASK on the left and press Enter.";
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
    const total = realized + mtm;
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
    if (txt.includes("BULLISH")) li.style.color = "var(--fg-positive)";
    else if (txt.includes("BEARISH")) li.style.color = "var(--fg-negative)";
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
      const tr = document.createElement("tr");
      tr.className = cls;
      tr.innerHTML = `<td>${sym}</td><td>${pos}</td><td>${fmt(avg)}</td><td>${fmtInt(value)}</td><td>${fmtInt(upnl)}</td>`;
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

    ctx.strokeStyle = "#333a4d";
    ctx.fillStyle = "#7f8aa5";
    ctx.font = "11px Consolas, monospace";
    ctx.setLineDash([4, 4]);
    const nLevels = 4;
    for (let i = 0; i <= nLevels; i++) {
      const level = minP + (maxP - minP) * i / nLevels;
      const y = H - padding - (level - minP) * scaleY;
      ctx.beginPath();
      ctx.moveTo(padding, y);
      ctx.lineTo(W - padding, y);
      ctx.stroke();
      ctx.fillText(fmt(level), 5, y + 3);
    }
    ctx.setLineDash([]);

    ctx.strokeStyle = "#ffcc33";
    ctx.lineWidth = 2;
    ctx.beginPath();
    series.forEach((p, i) => {
      const x = padding + i * scaleX;
      const y = H - padding - (p - minP) * scaleY;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();

    // last-price marker
    const lastX = padding + (series.length - 1) * scaleX;
    const lastY = H - padding - (series[series.length - 1] - minP) * scaleY;
    ctx.fillStyle = "#ffcc33";
    ctx.beginPath();
    ctx.arc(lastX, lastY, 3, 0, Math.PI * 2);
    ctx.fill();
  }

  // ==================== EXCHANGE MODEL ====================
  computeExchangeQuotes(mid, size) {
    size = Math.max(1, Math.abs(size));
    const baseBlock = 100;
    const baseHalfSpreadBp = 6.0;
    const sizeFactor = Math.pow(size / baseBlock, 1.1);
    let halfSpreadBp = baseHalfSpreadBp * sizeFactor;
    halfSpreadBp = Math.max(4.0, Math.min(150.0, halfSpreadBp));
    halfSpreadBp += randUniform(-1.0, 4.0);
    const bid = mid * (1 - halfSpreadBp / 10000.0);
    const ask = mid * (1 + halfSpreadBp / 10000.0);
    return [bid, ask];
  }

  // ==================== USER ACTIONS ====================
  sendQuote() {
    if (!this.activeRfq) { this.$msgBar.textContent = "No active RFQ to quote."; return; }
    const bid = parseFloat(this.$entryBid.value);
    const ask = parseFloat(this.$entryAsk.value);
    if (!isFinite(bid) || !isFinite(ask)) { this.$msgBar.textContent = "Invalid bid/ask."; return; }
    if (bid >= ask) { this.$msgBar.textContent = "Bid must be < Ask."; return; }

    const rfq = this.activeRfq;
    const { action, price: dealPrice, msg } = this.env.client.decideTrade(rfq.side, rfq.size, rfq.mid, bid, ask);
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

    let signedSize;
    if (action === "hit_bid") {
      const realized = this.mm.updatePosition(rfq.symbol, "buy", dealPrice, rfq.size, CLIENT_COMM_BP);
      this.$msgBar.textContent = `${rfq.symbol} – Client SELLS ${rfq.size} @ ${fmt(dealPrice)} -> you BUY. Realized PnL: ${fmtInt(realized)}`;
      this.logChat("Trade", `${rfq.symbol}: Client SOLD ${rfq.size} @ ${fmt(dealPrice)} (you BUY).`);
      signedSize = rfq.size;
    } else {
      const realized = this.mm.updatePosition(rfq.symbol, "sell", dealPrice, rfq.size, CLIENT_COMM_BP);
      this.$msgBar.textContent = `${rfq.symbol} – Client BUYS ${rfq.size} @ ${fmt(dealPrice)} -> you SELL. Realized PnL: ${fmtInt(realized)}`;
      this.logChat("Trade", `${rfq.symbol}: Client BOUGHT ${rfq.size} @ ${fmt(dealPrice)} (you SELL).`);
      signedSize = -rfq.size;
    }

    this.$rfqInfo.textContent = "RFQ completed.";
    const asset = this.env.assets[rfq.symbol];
    const newPrice = asset.applyTradeImpact(signedSize);
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
    const asset = this.env.assets[sym];
    const mid = asset.price;
    const [, ask] = this.computeExchangeQuotes(mid, size);
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
    const asset = this.env.assets[sym];
    const mid = asset.price;
    const [bid] = this.computeExchangeQuotes(mid, size);
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
