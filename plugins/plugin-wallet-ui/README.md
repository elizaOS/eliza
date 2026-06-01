# @elizaos/plugin-wallet-ui

Non-custodial wallet inventory UI for elizaOS agents. Adds a full wallet surface — token balances, NFTs, market overview, trading analytics, and a compact chat-sidebar widget — to any agent shell that loads this plugin.

## What it does

- Displays EVM (Ethereum, Base, BNB Chain, Avalanche, Arbitrum, Optimism, Polygon) and Solana token balances and NFTs.
- Shows portfolio value, per-chain allocation, P&L chart, recent swaps, and top movers from the agent's trading profile.
- Renders a market overview (spot prices, top movers, prediction market data) when the wallet has no balance history yet.
- Provides a compact wallet-status sidebar widget in the chat rail with live balance totals and one-click address copy.
- Serves the inventory in three view types: standard (web/desktop), XR, and TUI (terminal).

## Capabilities added

| Surface | Description |
|---|---|
| Shell page `/inventory` | Full wallet inventory page registered in the agent shell nav |
| Standalone view `/wallet` | Bundled `InventoryView` (standard and XR) loadable by the view manager |
| TUI view `/wallet/tui` | Terminal-friendly `InventoryTuiView` |
| Chat sidebar widget | `wallet.status` — compact balance summary with chain badges and address copy |

No new elizaOS actions, providers, or server-side services are added. All data is fetched from `@elizaos/plugin-wallet` through the shared `client` API.

## Requirements

- `@elizaos/plugin-wallet` must be loaded — this plugin reads wallet data via the wallet API.
- `@elizaos/app-core` peer dep for shell page and widget registration.
- React 18 or later.

## Enabling the plugin

Import the side-effect module once at app boot so shell pages and widgets are registered before the shell mounts:

```ts
import "@elizaos/plugin-wallet-ui/ui";
// or import the walletAppPlugin descriptor for custom registration:
import { walletAppPlugin } from "@elizaos/plugin-wallet-ui";
```

Pass `walletAppPlugin` to your elizaOS plugin loader if your shell uses the plugin registry.

## Supported chains

**Primary inventory chains** (per-user filter toggles):
- Ethereum, Base, BNB Chain (BSC), Avalanche (AVAX), Solana

**Additional chains** (URL/config helpers only, no filter toggle):
- Arbitrum, Optimism, Polygon

## Configuration

No environment variables are required. Wallet RPC provider selection (Eliza Cloud, Alchemy, QuickNode, Helius/Birdeye, or Custom) is managed by `@elizaos/plugin-wallet` and surfaced via the in-app RPC settings button.

User preferences (hidden tokens, sidebar width) are stored in `localStorage` with `eliza:wallet:*` key prefixes.

## Building

```bash
bun run --cwd plugins/plugin-wallet-ui build
```

This runs three steps: `tsup` for the plugin entry, `vite` for the standalone views bundle (`dist/views/bundle.js`), and `tsc` for type declarations. Both the tsup and vite outputs must be present for a complete distribution.
