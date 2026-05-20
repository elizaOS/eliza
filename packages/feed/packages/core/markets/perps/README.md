# Perpetuals (core)

Purpose: offchain synthetic perps domain service with funding/liquidation.

Include:
- Pricing/funding/liquidation utils, limits (min order, max position from OI).
- `PerpMarketService`: open/close, funding step, liquidation check, snapshots, broadcast/cache.
- Required ports: DB (markets/positions/price history), Wallet, Fees config, Broadcast, Cache, Clock.

Steps:
1) Define DTOs (open/close/funding/liquidation).
2) Implement as a stateless service with a single DB source of truth.
3) Expose a single market view for the API (no double source engine vs DB).
4) Adapt Next handlers to call this service.
