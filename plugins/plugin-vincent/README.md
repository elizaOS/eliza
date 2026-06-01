# @elizaos/plugin-vincent

Adds Vincent trading integration to an [elizaOS](https://github.com/elizaOS/eliza) agent. Vincent ([heyvincent.ai](https://heyvincent.ai)) provides OAuth-gated trading access on Hyperliquid and Polymarket.

## What this plugin provides

- **OAuth connection flow** — server-side PKCE OAuth against Vincent. The agent handles the code verifier; the user's browser visits the Vincent authorization page and is redirected back. No secrets are exposed to the browser.
- **Trading strategy management** — configure a named strategy (`dca`, `rebalance`, `threshold`, or `manual`) with params, execution interval, and dry-run mode, stored in the agent config.
- **Dashboard UI** — a full-screen React view showing connection status, wallet addresses and balances, strategy settings, and P&L analytics. Available in desktop, XR, and terminal (TUI) variants.

## Capabilities added

| Capability | Description |
|------------|-------------|
| Vincent OAuth | Connect/disconnect a Vincent account via PKCE OAuth |
| Connection status | Poll whether Vincent is connected and which venues are available |
| Strategy config | Read and update the active trading strategy |
| Trading profile | Retrieve P&L analytics (via Vincent API) |
| Wallet overview | Display the agent's EVM and Solana wallet addresses and balances |

## API routes registered

All routes use `rawPath: true` — they appear at these exact paths regardless of plugin prefix:

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/vincent/start-login` | Begin OAuth: returns `authUrl` to open in browser |
| `GET` | `/callback/vincent` | OAuth redirect landing page; exchanges code for tokens |
| `GET` | `/api/vincent/status` | Connection status and available trading venues |
| `POST` | `/api/vincent/disconnect` | Clear stored Vincent credentials |
| `GET` | `/api/vincent/trading-profile` | P&L profile data |
| `GET` | `/api/vincent/strategy` | Current strategy configuration |
| `POST` | `/api/vincent/strategy` | Update strategy configuration |

## Enabling the plugin

Add `vincentPlugin` to your agent's plugin list:

```ts
import { vincentPlugin } from "@elizaos/plugin-vincent";

const agent = {
  plugins: [vincentPlugin],
  // ...
};
```

The overlay app self-registers when the package is imported, making the Vincent dashboard available in the UI apps grid.

## Configuration

The plugin stores its state in the elizaOS agent config file (no additional env vars required). After a successful OAuth flow the following fields are written to config:

| Field | Description |
|-------|-------------|
| `vincent.accessToken` | Vincent OAuth access token |
| `vincent.refreshToken` | OAuth refresh token (if provided) |
| `vincent.clientId` | Dynamically registered OAuth client ID |
| `vincent.connectedAt` | Unix timestamp of connection |
| `trading.strategy` | Strategy name: `dca`, `rebalance`, `threshold`, or `manual` |
| `trading.params` | Strategy-specific parameter object |
| `trading.intervalSeconds` | Execution interval in seconds |
| `trading.dryRun` | Whether to run in dry-run mode |

The Vincent API base URL (`https://heyvincent.ai`) is not configurable via env var.

## OAuth flow

1. The UI calls `POST /api/vincent/start-login`.
2. The agent registers a dynamic OAuth client with Vincent, generates a PKCE challenge, and returns an `authUrl`.
3. The UI opens `authUrl` in the system browser.
4. The user authenticates; Vincent redirects to `GET /callback/vincent` on the local agent server.
5. The agent exchanges the authorization code for tokens using the stored PKCE verifier and persists them.
6. The UI polls `GET /api/vincent/status` until `connected: true`.

Pending login sessions expire after 10 minutes. A server restart during a flow requires restarting the login.

## Development

```bash
bun run --cwd plugins/plugin-vincent build     # full build
bun run --cwd plugins/plugin-vincent test      # unit tests
bun run --cwd plugins/plugin-vincent clean     # clean dist
```
