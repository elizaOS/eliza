# Core Markets (perps & prediction)

Goal: isolate market logic in a domain module independent of apps (Next/React), ready for Elysia/daemon.

Principles:
- Source of truth: DB (markets/positions/snapshots). Cache/engine may exist but must be reconstructible and non-divergent.
- Injected ports: Wallet, DB, Cache, Broadcast, Clock.
- Thin app/handlers: validation → service → response.

Planned structure:
- `shared/`: types, DTOs, config (fees/limits), ports/interfaces.
- `prediction/`: pricing (CPMM, optional concentrated liquidity), `PredictionMarketService` (init/buy/sell/resolve/payout).
- `perps/`: pricing/funding/liquidation, `PerpMarketService` (open/close/funding/liquidations/snapshots).

Steps:
1) Define shared ports/DTOs in `shared`.
2) Wrap existing perps logic into `PerpMarketService` (single market view).
3) Build `PredictionMarketService` and move resolve/payout out of handlers/tick.
4) Adapt Next handlers to these services.
