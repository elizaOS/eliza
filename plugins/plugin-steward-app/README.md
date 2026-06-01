# @elizaos/plugin-steward-app

Wallet management plugin for elizaOS agents. Provides EVM and Solana wallet infrastructure, Steward cloud-signing vault integration, a browser wallet bridge, DEX trade/transfer execution, and a React dashboard view.

## What it does

- **Wallet operations:** generate or import EVM/Solana wallets; read addresses and balances; export private keys; read/write config.
- **Steward vault integration:** connects to a [Steward](https://stwd.cloud) signing vault for cloud-managed key custody, policy enforcement, pending approval queues, and webhook events.
- **Browser wallet bridge:** relays sign/transaction requests between an in-browser wallet (MetaMask, Phantom, etc.) and the agent's API server.
- **DEX trading:** BSC trade preflight, quote, and execution; token transfers; transaction status tracking.
- **Context providers:** injects wallet balances and receive addresses into the agent's planning context every turn so the LLM can answer portfolio/holdings/address questions without invoking a mutating action.
- **Dashboard views:** `StewardView` (web, XR) and `StewardTuiView` (terminal) show transaction history and the pending approval queue.

## Capabilities added to an Eliza agent

| Capability | Details |
|------------|---------|
| `walletRouterAction` | Executes wallet sub-actions (preview, swap, transfer) across registered chain backends |
| `stewardBalanceProvider` | Per-turn balance snapshot (EVM chains + Solana) injected into planning context |
| `stewardReceiveAddressProvider` | Per-turn deposit address snapshot injected into planning context |
| ~30 HTTP routes | Full wallet + Steward management API under `/api/wallet/*` |
| `StewardView` | Dashboard panel: transaction history + approval queue |

## Installation

Add `stewardPlugin` from this package to your agent's plugin list:

```ts
import { stewardPlugin } from "@elizaos/plugin-steward-app";

const agent = new AgentRuntime({
  plugins: [stewardPlugin, /* ... */],
});
```

The plugin is **not** auto-enabled. It must be explicitly included.

## Required / optional configuration

| Env var | Required | Description |
|---------|----------|-------------|
| `STEWARD_API_URL` | For Steward signing | Base URL of your Steward vault instance |
| `STEWARD_API_KEY` | For Steward signing | API key (alternative to `STEWARD_AGENT_TOKEN`) |
| `STEWARD_AGENT_TOKEN` | For Steward signing | JWT bearer token for agent auth (alternative to `STEWARD_API_KEY`) |
| `STEWARD_AGENT_ID` | No | Agent ID in Steward; falls back to EVM address |
| `STEWARD_TENANT_ID` | No | Tenant ID for multi-tenant Steward deployments |
| `EVM_PRIVATE_KEY` | No | EVM wallet private key (local mode). Hydrated from OS keychain if absent. |
| `SOLANA_PRIVATE_KEY` | No | Solana wallet private key. Hydrated from OS keychain if absent. |
| `ELIZA_CLOUD_PROVISIONED` | No | Set to `1` in cloud containers to route all EVM signing through Steward (no local keys) |

Steward credentials can also be stored in `$ELIZA_STATE_DIR/steward-credentials.json` (written via the settings UI or `saveStewardCredentials`).

## Cloud-provisioned (key-less) mode

When running in a cloud container with `ELIZA_CLOUD_PROVISIONED=1` and `STEWARD_AGENT_TOKEN` set, the plugin can operate without any local private keys. Call `stewardEvmPreBoot` before loading plugins and `stewardEvmPostBoot` after to activate the Steward viem account bridge. All EVM signing is then delegated to the Steward API.

## Build

```bash
bun run --cwd plugins/plugin-steward-app build
```

The build has three stages:
- `build:js` — tsup compiles server/lib TypeScript
- `build:views` — Vite bundles the React dashboard views (`StewardView`, `StewardTuiView`)
- `build:types` — tsc emits `.d.ts` declarations

## Tests

```bash
bun run --cwd plugins/plugin-steward-app test
```

Live E2E tests (requires real Steward API credentials):

```bash
bun run --cwd plugins/plugin-steward-app test:e2e:manual
```

## API surface

All routes are registered under `/api/wallet/*` with no plugin-name prefix. Key groups:

- **Core wallet:** `/api/wallet/addresses`, `/api/wallet/balances`, `/api/wallet/import`, `/api/wallet/generate`, `/api/wallet/config`, `/api/wallet/export`
- **Trade:** `/api/wallet/trade/preflight`, `/api/wallet/trade/quote`, `/api/wallet/trade/execute`, `/api/wallet/trade/tx-status`, `/api/wallet/transfer/execute`
- **Steward vault:** `/api/wallet/steward-status`, `/api/wallet/steward-policies`, `/api/wallet/steward-tx-records`, `/api/wallet/steward-pending-approvals`, `/api/wallet/steward-approve-tx`, `/api/wallet/steward-deny-tx`, `/api/wallet/steward-sign`, `/api/wallet/steward-addresses`, `/api/wallet/steward-balances`, `/api/wallet/steward-tokens`, `/api/wallet/steward-webhook`, `/api/wallet/steward-webhook-events`
- **Browser bridge:** `/api/wallet/browser-transaction`, `/api/wallet/browser-sign-message`, `/api/wallet/browser-solana-sign-message`, `/api/wallet/browser-solana-transaction`
- **Compat:** `/api/wallet/os-store`, `/api/wallet/keys`, `/api/wallet/nfts`, `/api/wallet/trading/profile`, `/api/wallet/production-defaults`

The Steward webhook endpoint (`/api/wallet/steward-webhook`) is public (no auth required) to accept inbound webhook events from the Steward cloud.
