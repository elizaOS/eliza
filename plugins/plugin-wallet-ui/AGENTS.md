# @elizaos/plugin-wallet-ui

Non-custodial wallet inventory UI plugin for elizaOS — renders token balances, NFTs, trading stats, and market data across EVM chains and Solana.

## Purpose / role

Adds a full wallet inventory surface to an Eliza agent's shell UI. It registers shell pages (`/inventory`), standalone bundled views (standard, XR, TUI), a chat-sidebar widget showing live balances, and all supporting React components and hooks. It is a UI-only plugin with no actions, providers, evaluators, or server-side services — all data is fetched from `@elizaos/plugin-wallet` via the `@elizaos/ui` `client` API layer. The plugin is opt-in; the host shell must import and register it (via `register.ts` side-effects) at boot.

Peer deps: `@elizaos/app-core`, `@elizaos/plugin-wallet`, `react >=18`.

## Plugin surface

This plugin registers no elizaOS actions, providers, services, or evaluators. It registers UI surface only via `src/register-routes.ts` (imported as a side-effect by `src/register.ts`):

| Surface | ID / path | What it does |
|---|---|---|
| App shell page | `wallet.inventory` → `/inventory` | Full inventory view mounted in the agent shell |
| Standalone view (standard) | `wallet` → `/wallet` | Bundled `InventoryView`; `dist/views/bundle.js` |
| Standalone view (XR) | `wallet` (type: `xr`) → `/wallet` | Same view served in XR context |
| Standalone view (TUI) | `wallet` (type: `tui`) → `/wallet/tui` | Terminal inventory (`InventoryTuiView`) |
| Chat sidebar widget | `wallet.status` / slot: `chat-sidebar` | Compact balance + address summary in chat rail |

The plugin descriptor object is `walletAppPlugin` (`src/plugin.ts`).

## Layout

```
src/
  index.ts                 Full re-export barrel; re-exports register.ts + ui.ts,
                           so importing it also triggers register-routes.ts
  ui.ts                    Re-exports + triggers register-routes.ts side-effect
  register.ts              Side-effect entry: imports register-routes.ts
  register-routes.ts       Calls registerAppRoutePluginLoader, registerAppShellPage,
                           registerBuiltinWidgets — must run once at boot
  plugin.ts                walletAppPlugin Plugin descriptor (views, widgets, navTabs)
  InventoryView.tsx         Main full-page wallet view: balances, NFTs, trading profile,
                           market overview, timeline. ~2800 lines; also exports
                           InventoryTuiView (TUI surface) and interact (TUI input handler).
  wallet-rpc.ts            Re-exports buildWalletRpcUpdateRequest /
                           resolveInitialWalletRpcSelections from @elizaos/shared
  inventory/
    chainConfig.ts         CHAIN_CONFIGS registry (8 chains), all URL/address/gas
                           helpers: getChainConfig, getExplorerTokenUrl,
                           getExplorerTxUrl, getNativeLogoUrl, getContractLogoUrl,
                           getStablecoinAddress, resolveChainKey, chainKeyToWalletRpcChain
    constants.ts           TokenRow, NftItem interfaces; chainIcon, formatBalance,
                           isBscChainName, isAvaxChainName, toNormalizedAddress
    inventory-chain-filters.ts  InventoryChainFilters helpers: matchesInventoryChainFilter,
                           computeSingleChainFocus, toggleInventoryChainFilter
    useInventoryData.ts    useInventoryData hook — normalises raw API responses into
                           sorted/filtered TokenRow[] and NftItem[] + derived state
    TokenLogo.tsx          <TokenLogo> — renders token logo img with TrustWallet CDN
                           fallback; calls normalizeInventoryImageUrl
    ChainIcon.tsx          <ChainIcon> — inline SVG chain icons (ETH, BASE, BSC,
                           AVAX, SOL only; returns null for others)
    media-url.ts           normalizeInventoryImageUrl — converts ipfs://, ipns://,
                           ar:// URIs to HTTP gateway URLs
    index.ts               Barrel re-export for inventory/
  widgets/
    wallet-status.tsx      WalletStatusSidebarWidget + WALLET_STATUS_WIDGET definition;
                           renders abbreviated balance + chain badges in chat rail
```

## Commands

Only scripts that exist in `package.json`:

```bash
bun run --cwd plugins/plugin-wallet-ui build        # tsup JS + vite views bundle + tsc types
bun run --cwd plugins/plugin-wallet-ui build:js     # tsup only (plugin entry)
bun run --cwd plugins/plugin-wallet-ui build:views  # vite standalone views bundle → dist/views/
bun run --cwd plugins/plugin-wallet-ui build:types  # tsc declaration emit
bun run --cwd plugins/plugin-wallet-ui clean        # rm -rf dist
bun run --cwd plugins/plugin-wallet-ui test         # vitest run
```

## Config / env vars

This plugin reads no env vars directly. All runtime data comes from `@elizaos/plugin-wallet` through the `@elizaos/ui` `client` API (e.g. `client.getWalletBalances()`, `client.getWalletConfig()`, `client.getWalletNfts()`, `client.getWalletMarketOverview()`). Wallet RPC provider selection (Eliza Cloud, Alchemy, QuickNode, Helius/Birdeye, or Custom) is stored and fetched via the wallet API — not set via env here.

Two localStorage keys are used for user preferences (no config required):
- `eliza:wallet:hidden-token-ids:v1` — per-user token hide list
- `eliza:wallets:sidebar:width` / `eliza:wallets:sidebar:collapsed` — sidebar geometry

## How to extend

**Add a new EVM chain:**
1. Add a `ChainKey` variant to `src/inventory/chainConfig.ts` `ChainKey` union.
2. Add a `ChainConfig` entry to `CHAIN_CONFIGS` with explorer URLs, TrustWallet slug, gas thresholds, stablecoins, and `nameVariants`.
3. If the chain should appear in per-user filters, add its key to `PRIMARY_CHAIN_KEYS` in `chainConfig.ts` and to `PRIMARY_INVENTORY_CHAIN_KEYS` in `inventory-chain-filters.ts`.
4. Optionally add an SVG to `ChainIcon.tsx`.

**Add a new standalone view type:**
1. Create a new React component in `src/`.
2. Add a `views` entry in `src/plugin.ts` pointing to `bundlePath: "dist/views/bundle.js"` with the right `componentExport` and `viewType`.
3. Export the component from `vite.config.views.ts` entry points so it lands in `dist/views/bundle.js`.

**Add a new sidebar widget:**
1. Create a component implementing `ChatSidebarWidgetProps` (from `@elizaos/ui`).
2. Export a `ChatSidebarWidgetDefinition` constant.
3. Add it to `registerBuiltinWidgets([...])` in `src/register-routes.ts`.

## Conventions / gotchas

- `src/index.ts` and `src/ui.ts` both run the `register-routes.ts` side-effect at import time (`index.ts` re-exports `register.ts` + `ui.ts`). Importing either registers the shell page and widget. For component-only consumption without registration, import the specific component module directly (e.g. `./InventoryView.tsx`).
- `register-routes.ts` must execute exactly once. Duplicate registrations cause duplicate shell pages.
- The views bundle (`dist/views/bundle.js`) is built separately by `build:views` using Vite, not tsup. The tsup build only handles the plugin entry; both steps must run for a complete dist.
- `InventoryView.tsx` is a single large file (~2800 lines). All wallet-page local types, formatters, and sub-components live there — do not split without verifying the Vite views bundle still resolves exports correctly.
- `wallet-rpc.ts` is a pure re-export from `@elizaos/shared`. Do not add logic here.
- Token logos are fetched from the TrustWallet/assets GitHub CDN. NFT images may be IPFS/Arweave URIs — always pass through `normalizeInventoryImageUrl` before rendering.
- The `walletEnabled` flag from `useApp()` gates the sidebar widget. When `walletEnabled === false`, the widget renders `null`.
- Supported primary chains for the inventory filter UI: `ethereum`, `base`, `bsc`, `avax`, `solana`. Chains `arbitrum`, `optimism`, `polygon` are in `CHAIN_CONFIGS` (for URL helpers) but are not primary filter toggles.
- See root `AGENTS.md` for repo-wide architecture rules, naming, logger requirements, and ESM conventions.
