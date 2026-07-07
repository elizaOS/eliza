# @elizaos/plugin-wallet-ui

Non-custodial wallet inventory UI plugin for elizaOS — renders token balances, NFTs, trading stats, and market data across EVM chains and Solana.

## Purpose / role

Adds a full wallet inventory surface to an Eliza agent's shell UI. It registers shell pages (`/inventory`), a standalone bundled GUI view, a chat-sidebar widget showing live balances, and all supporting React components and hooks. It is a UI-only plugin with no actions, providers, evaluators, or server-side services — all data is fetched from `@elizaos/plugin-wallet` via the `@elizaos/ui` `client` API layer. The plugin is opt-in; the host shell must import and register it (via `register.ts` side-effects) at boot.

Peer deps: `@elizaos/app-core`, `@elizaos/plugin-wallet`, `react >=18`.

## Plugin surface

This plugin registers no elizaOS actions, providers, services, or evaluators. It registers UI surface only via `src/register-routes.ts` (imported as a side-effect by `src/register.ts`):

| Surface | ID / path | What it does |
|---|---|---|
| App shell page | `wallet.inventory` → `/inventory` | Full inventory view mounted in the agent shell |
| Standalone view | `wallet` → `/wallet` | Bundled `InventoryView`; `dist/views/bundle.js`. GUI-only (`tui`/`xr` remain compatibility values in the manifest schema) |
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
                           market overview, timeline. ~2578 lines.
  InventoryView.helpers.ts  Shared wallet data helpers (loadWalletTuiState,
                           resolveWalletAddresses) used by InventoryView.tsx and
                           InventoryView.interact.ts; kept separate for Fast-Refresh
                           compatibility.
  InventoryView.interact.ts  The `interact` capability handler, split out of
                           InventoryView.tsx so that file exports only React components
                           and stays Fast-Refresh-compatible. Re-exported via
                           wallet-view-bundle.ts.
  wallet-rpc.ts            Re-exports buildWalletRpcUpdateRequest /
                           resolveInitialWalletRpcSelections from @elizaos/shared
  wallet-view-bundle.ts    View-bundle entry that re-exports components and `interact`
                           for the standalone Vite bundle (dist/views/bundle.js).
  components/
    InventorySpatialView.tsx  Spatial inventory view component.
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
- `InventoryView.tsx` is a single large file (~2578 lines). All wallet-page local types, formatters, and sub-components live there — do not split without verifying the Vite views bundle still resolves exports correctly.
- `InventoryView.interact.ts` is intentionally separate from `InventoryView.tsx` so the component file exports only React components and remains Fast-Refresh-compatible. The view bundle re-exports `interact` via `wallet-view-bundle.ts`.
- `wallet-rpc.ts` is a pure re-export from `@elizaos/shared`. Do not add logic here.
- Token logos are fetched from the TrustWallet/assets GitHub CDN. NFT images may be IPFS/Arweave URIs — always pass through `normalizeInventoryImageUrl` before rendering.
- The `walletEnabled` flag from `useApp()` gates the sidebar widget. When `walletEnabled === false`, the widget renders `null`.
- Supported primary chains for the inventory filter UI: `ethereum`, `base`, `bsc`, `avax`, `solana`. Chains `arbitrum`, `optimism`, `polygon` are in `CHAIN_CONFIGS` (for URL helpers) but are not primary filter toggles.
- See root `AGENTS.md` for repo-wide architecture rules, naming, logger requirements, and ESM conventions.

<!-- BEGIN: evidence-and-e2e-mandate (managed; canonical standard = repo-root AGENTS.md) -->
## ⛔ NON-NEGOTIABLE — evidence, trajectories & real end-to-end tests

> The binding, repo-wide standard is **[AGENTS.md](../../AGENTS.md)**. Read it.
> Nothing in this package is *done* until it is *proven* done — a reviewer must confirm it
> works **without reading the code**, from the artifacts you attach. This applies to **every**
> feature, fix, refactor, and chore here. "Tests pass" is not proof; "CI is green" is not proof.

- **Record AND read model trajectories.** Capture the *actual* inputs and outputs of the model
  from a **live** LLM — not the deterministic proxy, not a mock: the prompt, the
  providers/context, the raw model output, every tool/action call, and the result. Then **open
  the trajectory and review it by hand.** A captured-but-unread trajectory is not evidence
  (`packages/scenario-runner/bin/eliza-scenarios run <scenario> --report <out>`).
- **Real, full-featured E2E — no larp.** Every feature ships detailed end-to-end tests that
  drive the *real* path end to end. Not the happy "front door" only: cover error paths,
  edge/empty/invalid input, concurrency, roles/permissions, and adversarial input. A test that
  asserts against a mock/stub/fixture standing in for the thing under test **does not count**.
  If the real model/device/chain/connector/account is hard to reach, **make it reachable — that
  is the work**, not an excuse to mock. If the existing tests here are shallow or mocked, fixing
  them is part of your change.
- **Screenshots + logs at every phase**, plus a **complete walkthrough video/run-through** of
  the entire feature or view, start to finish (`bun run test:e2e:record`).
- **Manually review every artifact the change touches** — never just the green check: client
  logs (console + network), server logs (`[ClassName] …`), the model trajectories in and out,
  before/after full-page screenshots, **and the domain artifacts listed below for this package.**
- **No residuals. No shortcuts.** The goal is not "done" — it is *everything* done. Clear every
  blocker by the **hard path**: build the real architecture, stand up the real
  model/device/service, actually test it. Never leave a TODO, a stub, a stepping-stone, or a
  "follow-up." When unsure, research thoroughly, weigh the options, and ship the best,
  highest-effort, production-ready version. Keep going until every possibility is exhausted.

Artifacts → attached inline in the PR (MP4 video, JPG screenshots, logs in `<details>`); attach each evidence type **or**
explicitly mark it N/A with a reason — never leave it blank. If `develop` moved and changed
behavior, **re-capture** evidence; stale proof is worse than none.

**Capture & manually review for this package — wallet / chain / contracts:**
- On-chain transaction hash(es) + explorer link, wallet balance **before and after**, and the signed-payload/log trail — run against a testnet or fork.
- Revert / insufficient-funds / nonce / gas-estimation-failure paths, and signature-authorization (role/permission) checks.
- The decision trajectory when an agent initiated the on-chain action.
- Never a mocked RPC asserted green — prove the chain state actually changed.
<!-- END: evidence-and-e2e-mandate -->
