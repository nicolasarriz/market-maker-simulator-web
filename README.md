# Market Maker Simulator — Web Edition

**Live demo:** https://nicolasarriz.github.io/market-maker-simulator-web/

A browser-based market-making training game inspired by the **AmplifyMe Finance Accelerator**.
You play as the market maker on an investment bank trading desk, quoting two-way prices to a hedge-fund client and managing your risk against the exchange.

This is a full JavaScript port of my original Python/Tkinter simulator
([nicolasarriz/market-maker-simulator](https://github.com/nicolasarriz/market-maker-simulator)), rebuilt to run in any browser with zero installation.

---

## Features

- **Two-way RFQ workflow (Client panel)** — the client requests two-way prices for AAPL / SPX with its direction hidden. It trades its latent axe when your level is fair, negotiates or walks away when it isn't, and **picks off whichever side you quote through fair value** — so a badly skewed quote loses money.
- **Inventory-skewed quote helper** — each RFQ pre-fills a suggested bid/ask whose center is skewed by your current position (long → quote lower to offload, short → quote higher), with a per-symbol spread. Override it freely.
- **Risk limits** — each symbol has a notional position limit. Positions are highlighted as they approach (🟠) or breach (🔴) it; exchange trades that would increase exposure past the limit are blocked.
- **Per-symbol liquidity** — the index (SPX) is deeper than the single name (AAPL): tighter exchange spreads, larger typical tickets, lower price impact per share, and a bigger risk limit.
- **Dynamic exchange quotes** — exchange bid/ask widen with trade size, and your own executions move the market via a per-symbol impact model.
- **Live price chart** — real-time canvas chart with grid + price scale for the selected symbol.
- **Positions & PnL** — per-symbol net position, average cost, position value and unrealized PnL, plus global realized/unrealized/total PnL, cash and commissions paid.
- **News feed** — random bullish/bearish macro and stock headlines that feed shocks into the price process.
- **Pause / Resume / Reset** — freeze market time to study your book, or reset the session from scratch.

## How the simulation works

- **Prices** follow a mean-reverting stochastic process in basis points plus occasional news shocks. Trades create market impact in the direction of the aggressor, which mean-reverts over time (temporary impact).
- **Client behaviour** depends on your spread and edge vs. the *live* mid — tight, fair quotes get filled; wide or skewed quotes get rejected or negotiated; quotes through fair value get picked off (adverse selection).
- **Position tracking** uses full inventory accounting with average cost, so realized PnL is booked when you flatten or cross your position.
- **Commissions** are applied separately to client trades (1.5 bp) and exchange trades (0.5 bp), and are deducted from **Total PnL** (which equals the true change in equity).

## Tech

- Pure vanilla HTML / CSS / JavaScript — no frameworks, no backend.
- Hosted on GitHub Pages (static site).

## Run locally

Just open `index.html` in any modern browser. No build step, no dependencies.

## Author

Built by **Nicolás Arriz** as a training tool for Sales & Trading interview prep.
