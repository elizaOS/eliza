# Prediction markets (core)

Purpose: domain service for offchain prediction markets (CPMM).

Include:
- CPMM pricing (yes/no market AMM).
- `PredictionMarketService`: init market, buy/sell (AMM + fees), resolve/payout, snapshots/trades/broadcast, cache invalidation via ports.
- Required ports: DB (markets/positions/history), Wallet, Fees config, Broadcast, Cache, Clock.

Notes:
- Market rows can be created lazily on first trade via `ensureMarket(...)` (internal).
- For engine flows that create questions first and want the market to exist immediately (e.g. NPC betting context), use `ensureMarketExists(...)`.

Steps:
1) Define DTOs (buy/sell/resolve).
2) Reuse `prediction-pricing` (moved here).
3) Move resolution/payout from handlers into the service.
4) Adapt Next handlers + NPC flows to call this service.
