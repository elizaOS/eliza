# @elizaos/app-polymarket

Native Polymarket app plugin for market discovery, orderbook quote reads, position reads, and trading readiness context.

## Agent Actions

When the runtime plugin is loaded, it exposes these agent actions:

- `PREDICTION_MARKET`

Use `target: "polymarket"` and `subaction: "read"` with `kind: "status" | "markets" | "market" | "orderbook" | "positions"` for public reads. Legacy names such as `POLYMARKET_READ`, `POLYMARKET_STATUS`, `POLYMARKET_GET_MARKETS`, and `POLYMARKET_GET_ORDERBOOK` remain compatibility similes for the consolidated action.

Use `subaction: "place-order"` for trading readiness. Signed order placement is intentionally disabled until CLOB signing support is implemented. Legacy `POLYMARKET_PLACE_ORDER` remains a compatibility simile and reports readiness and required configuration instead of placing trades.

## CLI Interoperability Checks

Use the same CLOB token id when comparing app output with the Polymarket CLI. Conditional tokens require the token id, not just the condition id.

Useful parity checks:

```sh
polymarket-trader diagnose
polymarket-trader gamma-markets --limit 3
polymarket-trader quote <TOKEN_ID>
polymarket-trader orderbook <TOKEN_ID>
polymarket-trader balance --asset-type COLLATERAL
```

The app route `GET /api/polymarket/orderbook?token_id=<TOKEN_ID>` reads the full CLOB orderbook and derives best bid and best ask from all returned levels, matching CLI quote semantics when the upstream CLOB response is not already sorted. Retry transient network errors such as `ECONNRESET` before treating parity checks as failures.
