# Market Maker Simulator — Web Edition

**Live demo:** https://nicolasarriz.github.io/market-maker-simulator-web/

A browser-based market-making training game inspired by the **AmplifyMe Finance Accelerator**.
You play as the market maker on an investment bank trading desk, quoting two-way prices to a hedge-fund client and managing your risk against the exchange.

This is a full JavaScript port of my original Python/Tkinter simulator
([nicolasarriz/market-maker-simulator](https://github.com/nicolasarriz/market-maker-simulator)), rebuilt to run in any browser with zero installation.

---

## Features

- **RFQ workflow (Client panel)** — the client requests two-way prices for AAPL / SPX. Quote a bid and ask; the client may lift, hit, negotiate, or reject based on your spread and edge vs. mid.
- **Dynamic exchange quotes** — exchange bid/ask widen with trade size, and your own executions move the market via a simple impact model.
- **Live price chart** — real-time canvas chart with grid + price scale for the selected symbol.
- **Positions & PnL** — per-symbol net position, average cost, position value and unrealized PnL, plus global realized/unrealized/total PnL, cash and commissions paid.
- **News feed** — random bullish/bearish macro and stock headlines that feed shocks into the price process.
- **Pause / Resume / Reset** — freeze market time to study your book, or reset the session from scratch.

## How the simulation works

- **Prices** follow a stochastic process in basis points plus occasional news shocks.
- **Client behaviour** depends on your spread and edge vs. mid — tight, fair quotes get filled; wide or skewed quotes get rejected or negotiated.
- **Position tracking** uses full inventory accounting with average cost, so realized PnL is booked when you flatten or cross your position.
- **Commissions** are applied separately to client trades (1.5 bp) and exchange trades (0.5 bp).

## Tech

- Pure vanilla HTML / CSS / JavaScript — no frameworks, no backend.
- Hosted on GitHub Pages (static site).

## Run locally

Just open `index.html` in any modern browser. No build step, no dependencies.

## Author

Built by **Nicolás Arriz** as a training tool for Sales & Trading interview prep.
