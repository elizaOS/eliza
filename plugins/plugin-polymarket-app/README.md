# @elizaos/plugin-polymarket-app

Native Polymarket app plugin for elizaOS — market discovery, orderbook quote reads, position reads, and trading readiness context.

## What it does

Adds Polymarket prediction-market capabilities to an Eliza agent:

- **Market discovery** — lists active markets from the Polymarket Gamma API with bid/ask prices and 24-hour volume.
- **Single market detail** — fetches a market by Gamma ID or slug, including all outcome prices and CLOB token IDs.
- **Orderbook quotes** — reads full CLOB bid/ask depth for a token ID and derives best bid, best ask, midpoint, and spread.
- **Wallet positions** — returns open positions for a given wallet address from the Polymarket Data API.
- **Trading readiness** — reports which credentials are configured and why signed order placement is currently disabled.
- **UI views** — desktop, XR, and TUI views registered in the elizaOS view registry.

## Enabling the plugin

Add the package to the agent's plugin list:

```ts
import { polymarketPlugin } from "@elizaos/plugin-polymarket-app";

const agent = {
  plugins: [polymarketPlugin],
  // ...
};
```

No credentials are required for public reads. Trading configuration is optional (see below).

## Agent action: `PREDICTION_MARKET`

The plugin registers one agent action. Pass `action` (or `subaction`) and `kind` parameters:

| `action` | `kind` | Required params | Description |
|----------|--------|-----------------|-------------|
| `read` | `status` | — | Readiness and credential report |
| `read` | `markets` | — | Active market list (`limit` 1–100, `offset`) |
| `read` | `market` | `id` or `slug` | Single market detail |
| `read` | `orderbook` | `tokenId` (CLOB token id) | Full orderbook with best bid/ask |
| `read` | `positions` | `user` (wallet address) | Open positions for a wallet |
| `place_order` | — | — | Reports readiness; does not place trades |

Legacy action names (`POLYMARKET_READ`, `POLYMARKET_STATUS`, `POLYMARKET_GET_MARKETS`, `POLYMARKET_GET_ORDERBOOK`, `POLYMARKET_PLACE_ORDER`, etc.) are accepted as similes.

## API routes

The plugin registers these HTTP routes on the agent's API server:

| Method | Path | Query params |
|--------|------|-------------|
| GET | `/api/polymarket/status` | — |
| GET | `/api/polymarket/markets` | `limit`, `offset`, `active`, `closed`, `order`, `ascending`, `tag_id` |
| GET | `/api/polymarket/market` | `id` or `slug` |
| GET | `/api/polymarket/orderbook` | `token_id` |
| GET | `/api/polymarket/positions` | `user` |
| GET / POST | `/api/polymarket/orders` | Returns 501 (disabled) |

## Environment variables

Public reads (markets, orderbook, positions) require no credentials.

Signed CLOB trading is not yet implemented. When credentials are present the status endpoint reports them as ready; the `place_order` action still returns a readiness report only.

| Variable | Alias | Purpose |
|----------|-------|---------|
| `POLYMARKET_PRIVATE_KEY` | — | Wallet private key for signed orders |
| `CLOB_API_KEY` | `POLYMARKET_CLOB_API_KEY` | CLOB API key |
| `CLOB_API_SECRET` | `POLYMARKET_CLOB_SECRET` | CLOB API secret |
| `CLOB_API_PASSPHRASE` | `POLYMARKET_CLOB_PASSPHRASE` | CLOB API passphrase |

## CLI parity checks

Use the same CLOB token id when comparing agent output with the Polymarket CLI:

```sh
polymarket-trader diagnose
polymarket-trader gamma-markets --limit 3
polymarket-trader quote <TOKEN_ID>
polymarket-trader orderbook <TOKEN_ID>
polymarket-trader balance --asset-type COLLATERAL
```

The `/api/polymarket/orderbook` route reads the full CLOB orderbook and derives best bid and best ask from all returned levels, matching CLI quote semantics when the upstream CLOB response is not sorted. Retry transient network errors such as `ECONNRESET` before treating parity checks as failures.

## Building

```bash
bun run --cwd plugins/plugin-polymarket-app build
```

This runs tsup (runtime bundle), Vite (view bundle for desktop/TUI views), and tsc (type declarations).
