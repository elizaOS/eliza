# @elizaos/plugin-hyperliquid-app

Adds native [Hyperliquid](https://hyperliquid.xyz) perpetual-market integration to elizaOS agents. Eliza agents can query market listings, credential readiness, account positions, and open orders through both conversational actions and HTTP routes. Order placement is disabled by design — the plugin is read-only.

## Capabilities

- **Market discovery** — list all Hyperliquid perpetual markets with max leverage, size decimals, and active/delisted status.
- **Account positions** — read open perp positions for a configured EVM address (size, entry price, unrealized PnL, leverage, liquidation price).
- **Open orders** — read working limit orders for a configured account.
- **Credential status** — inspect which credential mode is active (`managed_vault`, `local_key`, or `none`) and whether account reads are available.
- **React UI views** — standard, XR, and terminal (TUI) views shipped in the plugin bundle and surfaced as agent app tabs.

## Actions

### `PERPETUAL_MARKET`

Conversational action that routes to the Hyperliquid provider. Recognized when the message contains Hyperliquid-related keywords (in English and several other languages) or when a `finance`, `crypto`, `trading`, or `payments` context is active.

**Parameters:**

| Parameter | Values | Description |
|---|---|---|
| `action` | `read`, `place_order` | Operation type. `place_order` returns a disabled-execution notice. |
| `kind` | `status`, `markets`, `market`, `positions`, `funding` | Sub-kind for `action=read`. |
| `coin` | e.g. `BTC`, `ETH` | Asset symbol for `kind=market`. |
| `target` | `hyperliquid` (default) | Provider selector; only Hyperliquid is registered today. |

**Examples:**
- "What is the Hyperliquid trading status?" → `action=read kind=status`
- "Show me Hyperliquid perp markets" → `action=read kind=markets`
- "What are my Hyperliquid positions?" → `action=read kind=positions`
- "Tell me about the BTC perp on Hyperliquid" → `action=read kind=market coin=BTC`

## API routes

All routes are mounted under `/api/hyperliquid/`. Public market reads require no credentials. Account reads require an EVM address to be configured.

| Method | Path | Description |
|---|---|---|
| GET | `/api/hyperliquid/status` | Credential and readiness status |
| GET | `/api/hyperliquid/markets` | All perpetual markets |
| GET | `/api/hyperliquid/positions` | Account perp positions |
| GET | `/api/hyperliquid/orders` | Open orders |
| POST | `/api/hyperliquid/*` | All write routes — returns 501 (execution disabled) |

## Configuration

No env vars are required for public market reads. To enable account-specific reads, configure one of:

| Env var | Description |
|---|---|
| `HYPERLIQUID_ACCOUNT_ADDRESS` or `HL_ACCOUNT_ADDRESS` | EVM address for positions/orders reads. Must be `0x`-prefixed 40-char hex. |
| `STEWARD_EVM_ADDRESS` or `ELIZA_MANAGED_EVM_ADDRESS` | Managed-vault EVM address (takes priority over the explicit env account). |

Optional signing credentials (reported in status only; this app keeps order execution disabled by design):

| Env var | Description |
|---|---|
| `EVM_PRIVATE_KEY`, `HYPERLIQUID_PRIVATE_KEY`, or `HL_PRIVATE_KEY` | Local signer private key. |
| `HYPERLIQUID_AGENT_KEY` or `HL_AGENT_KEY` | Hyperliquid API-wallet delegation key. |

## Enabling the plugin

Load `@elizaos/plugin-hyperliquid-app` in your agent character config:

```json
{
  "plugins": ["@elizaos/plugin-hyperliquid-app"]
}
```

Or register it programmatically:

```ts
import { hyperliquidPlugin } from "@elizaos/plugin-hyperliquid-app";

const runtime = new AgentRuntime({
  plugins: [hyperliquidPlugin],
  // ...
});
```

The plugin also self-registers as an elizaOS overlay app and route-plugin loader when imported, so it appears as a tab in the agent dashboard.

## Notes

- Order placement (POST routes) is intentionally disabled in this version. The `place_order` action op reports the blocked-execution reason rather than submitting any transaction.
- Funding-rate reads (`kind=funding`) use Hyperliquid's live `metaAndAssetCtxs` Info API response.
- Market data is fetched from `https://api.hyperliquid.xyz/info` (the public Hyperliquid Info API). No API key is required.
