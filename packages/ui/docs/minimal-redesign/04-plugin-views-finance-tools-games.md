# 04 — Plugin Views Inventory: Finance · Tools · XR · Games

Per-view UX + code + state inventory of elizaOS **plugin** views (under `plugins/plugin-*/src`), feeding a minimalist, lighter, chat-first redesign. Repo root: `/home/shaw/milady/eliza`. Read-only review (no code edited).

**Redesign direction judged against:** minimalism (cut text/descriptions/borders/nested cards/tags/badges/redundant inputs; icons + color + whitespace over text); lighter feel (move off heavy black bg toward a single flat/futuristic look — orange `#ff8a24` accent, blue `#1d91e8` info, white/black text, some gray); floating chat overlay is the PRIMARY interface (glanceable, voice-forward, stay-in-chat); each view shows only essential info + view-dependent actions + proactive agent context + chat integration.

---

## Executive summary

### Real vs stub (24 views across 19 plugins)

**Essentially everything is REAL** — live data wiring, real protocols, no "coming soon." The honest exceptions:

- **Vincent `TradingProfileCard` — permanent stub:** `/api/vincent/trading-profile` is hardwired to `profile: null` (`plugins/plugin-vincent/src/routes.ts:464-471`), so the full P&L UI (`TradingProfileCard.tsx:67-108`) never renders in production. Dead-on-arrival card.
- **Steward `StewardVaultOverview.tsx` (477 lines) — DEAD CODE:** fully built, test-covered, **never rendered** (`StewardView` only mounts `ApprovalQueue` + `TransactionHistory`; grep finds only self + test referencing it).
- **plugin-xr — registers NO ViewDeclaration:** it ships only a server-side XR HTML host-chrome route (`plugins/plugin-xr/src/routes/xr-view-host.ts`) that mounts *other* plugins' bundles. Assessed as chrome only.
- **Finances DTO layer self-declares as a "migration scaffold"** (`plugins/plugin-finances/src/types.ts:1-9`) even though the view renders real route data.

### Structural redundancy patterns (apply across many plugins)

1. **XR ViewDeclarations are dead duplicates.** Almost every plugin declares `default` + `xr` + `tui`, but the `xr` entry re-points at the **same web component** as `default` (hyperliquid/shopify/steward/vincent/task-coordinator/screenshare/model-tester all do this). No XR-specific render exists. The genuinely separate surface is the authored-once `*SpatialView.tsx` (terminal/XR via `@elizaos/ui/spatial`), registered for the terminal only.
2. **The `*SpatialView.tsx` files are the minimalist reference the GUI views should converge toward.** `OrchestratorSpatialView.tsx`, `ModelTesterSpatialView.tsx`, `TrajectoryLoggerSpatialView.tsx` already use single-glyph-by-color status marks + `Divider label="…"` sections + borderless lists — exactly the target density. The web twins diverged into maximalism. This is **convergence, not new design.**
3. **A second full dark codepath: hand-maintained `#020617`/cyan TUI trees.** Hyperliquid/shopify/steward/vincent/wallet/polymarket each clone the web view as an inline-styled near-black JSX tree with hardcoded `rgba(125,211,252,…)` cyan borders — the exact heavy/dark treatment the redesign abandons, and ignoring Eliza tokens.
4. **Copy-pasted heavy card recipes.** The `linear-gradient + inset-shadow rounded-2xl/3xl` card is pasted 6+ times across Steward + Vincent. The games' `HeroHeader` + `StatusStripCard` + `HeroFrame` trio (~250 lines) is copy-pasted **byte-for-byte** across clawville, hyperscape, and defense (only accent + emoji differ).
5. **State over-encoding.** Connection/run status routinely shown 3-4× on one screen (border tint + badge + icon color + summary card + header pill). Wallet's account header packs ~12 chips/badges.
6. **Off-brand color drift.** Shopify/clawville/hyperscape/defense hardcode `#ff5800` (≠ brand `#ff8a24`); XR host chrome hardcodes indigo `#6366f1` (blue is forbidden) + near-black bg, with its own inline design system.

### Worst slop offenders (ranked, cross-section)

1. **`OrchestratorWorkbench.tsx` (4191 lines)** — heaviest view in scope. 9-10 conditional icon buttons + select + delete-dialog in one toolbar row (`:2033-2215`); 8 stacked bordered `InspectorSection` boxes; two parallel inspectors with duplicated chrome; `HeaderDivider` hairlines between every stat; 3 stackable banners; ~9 prose paragraphs.
2. **`SmartglassesView.tsx` (1369 lines)** — 6 stacked bordered panels, ~18 buttons, a 14-row hardware-test gate grid, a Platform tab-strip wrapping 2 sentences of static copy, a 9-row Report table duplicating state shown elsewhere. A lab/QA console masquerading as a top-level navTab.
3. **`StewardVaultOverview.tsx` (477 lines)** — fully built, never rendered. Delete or wire.
4. **Wallet `InventoryView.tsx` (2578 lines, ~37 components)** — rail-vs-dashboard duplication (NFTs/LP/positions rendered twice), ~12-badge account header.
5. **Game operator surfaces** — ~250 lines of triplicated hero chrome + double-HUD (bespoke hero on top of `GameOperatorShell` that already shows the same status/objective/location) + 34vh marketing banner pushing HUD below the fold.
6. **Shopify `ShopifySetupCard`** (`ShopifyAppView.tsx:111-261`) — ~150 inline-styled lines (hero, `<p>`, two described `SetupField`s with env-var `<code>`, capability pills) to say "set 2 env vars."
7. **Vincent disconnected teaser** (`VincentAppView.tsx:158-184`) — 3 bordered tiles spelling "Vincent/Wallet/OAuth", zero information.

### Highest-impact simplifications

- **Make the orchestrator task room = the floating chat overlay.** The conversation stream (`OrchestratorWorkbench.tsx:3931`) is already a chat; the redesign wants chat primary. Single biggest alignment win.
- **Flatten every "wall of bordered boxes"** into borderless icon+color lists — the repo already ships the template (`*SpatialView.tsx`). Targets: orchestrator's 8 sections, tasks-panel's 6 DetailLists, screenshare's 7 metric tiles, model-tester's 8 cards, smartglasses' 6 panels, finances' 3 cards.
- **Flip wallet + finances to a light surface** (match polymarket, the only one already light).
- **Delete dead/stub UI:** `StewardVaultOverview.tsx`, Vincent `TradingProfileCard` + disconnected teaser.
- **Extract the triplicated game hero chrome once** (or delete in favor of `GameOperatorShell`); kill double-HUD + triple status badges; shrink the 34vh banner to a thin status-dot bar.
- **Move human-in-the-loop approvals (Steward) INTO chat** — it's a yes/no agent prompt by nature.
- **Drop all manual refresh buttons** — polling already exists everywhere; refresh via chat.
- **Fix brand color drift** (`#ff5800`→`#ff8a24`; XR indigo→orange, lighten bg).

### Mergeable / removable / chat-replaceable

- **MERGE `CodingAgentTasksPanel` + `OrchestratorWorkbench`** — same task data, read-only-lite vs full read/write, already share the `TaskCardList` kit.
- **MERGE the orchestrator task room with the floating chat** — same conversation, two surfaces.
- **Steward → collapses to a history audit table** once approvals move to chat.
- **Vincent → collapses to OAuth button + WalletStatusCard** (strategy editing isn't even in the UI; `POST /strategy` has no client trigger — an endpoint-without-trigger violation).
- **Hyperliquid → a read-only ticker**; most is chat-answerable.
- **Screenshare → 2 chat actions + one live status pill** ("share my screen" / "connect to <link>").
- **Demote out of primary nav** (developer/hardware tools, reach via chat or a dev/device drawer): vector-browser, trajectory-logger, smartglasses, model-tester.
- **Wallet Movers/Activity/Market-pulse** are read-only context the floating chat can narrate on demand — strong chat-merge candidates.
- **`formatTime` duplicated** in `ApprovalQueue.tsx:349` and `TransactionHistory.tsx:234`; **phase-body components duplicated** in `PhaseDrilldown.tsx` and `TrajectoryLoggerSpatialView.tsx`.

---

# Part A — Wallet · Finances · Polymarket

All three wire **real live data** (no stubs). Theme split is the key lever: wallet + finances are dark-black (`bg-bg` / `#0a0a0a`); **polymarket is the only one already on a light surface** (`--bg #fff`, `--txt #111`). Pull wallet + finances toward polymarket's lighter look, and cut ~40-60% of chrome.

Theme citations: Finances dark bg `plugins/plugin-finances/src/components/finances/FinancesView.tsx:299`; Wallet dark `InventoryView.tsx:2240,:1755,:1866`; Polymarket light `plugins/plugin-polymarket-app/src/PolymarketAppView.tsx:14-15,186`.

## 1. Wallet — `wallet` / `InventoryView` (desktop+XR) — `plugins/plugin-wallet-ui/src/InventoryView.tsx:2042`

ViewDeclaration: `plugins/plugin-wallet-ui/src/plugin.ts:23-62` (standard `/wallet`, XR `/wallet`, TUI `/wallet/tui` → `InventoryTuiView`); shell nav tab `wallet.inventory` → `/inventory` (`plugin.ts:12-21`); chat-sidebar widget `wallet.status` (`plugin.ts:63-73`).

- **Purpose:** Full non-custodial portfolio page — balances, token list, NFTs, DeFi/LP positions, trading P&L, market overview, activity timeline.
- **Real or stub?** **REAL.** Live via `useApp()` + `client.getWalletTradingProfile()` / `client.getWalletMarketOverview()` (`:2043-2058, 2085, 2113`); localStorage hidden-token persistence (`:104-130`).
- **States:** error banner (`:2243`); `walletEnabled===false`→"Enable wallet" CTA (`:1770`); empty→`MarketPulseHero` (`:2270,:981`); populated holdings rail + 5 dashboard sections (`:2281-2345`); per-section empty states; loading via `refreshing` spinner + market skeleton (`:1024`); tabs tokens/defi/nfts (`:1711,1793-1811`); P&L window 24h/7d/30d (`:2288`).
- **Current visual structure (populated desktop):** ~37 component functions in one 2578-line file; holdings card + 5 more big rounded cards stacked.
  - Headers/titles: ~8 (`DashboardSection` ×5 at `:2283-2343`; rail account; market sub-headers).
  - Cards/panels: very heavy — `WalletHoldingsSection` rounded-28 (`:1755`) + 5 `DashboardSection` rounded-28 (`:1866`) + per-row rounded-2xl cards inside each. **20-40 nested rounded containers** on a populated wallet.
  - Borders/dividers: pervasive `border border-border/30`, `ring-2 ring-bg`, overlap rings on avatar (`:1430-1434`), chain badges (`:400-436`), every chip.
  - Tags/badges/chips: **extreme.** `WalletChainCluster` 5 chain pills (`:1293-1306`) + `WalletConnectionChip` ×2 (`:1444-1445`) + `WalletProviderDots` (`:1336`) + RPC button (`:1361`) + 2 address pills w/ chain-logo stacks (`:1316-1331`) + allocation chips (`:508-524`) + P&L `SummaryChip` (`:2303`) + tab count badges (`:1509`). **~12 chips/badges in the account header alone.**
  - Buttons: refresh ×N, RPC settings, enable-wallet, 3 tabs, 3 P&L-window, per-token hide (`:1580`), copy-address ×2, source links.
  - Inputs: none (good).
  - Tables/lists: token list, NFT grid (`:1959`), NFT rail (`:1604`), **LP list ×2** (rail `:1646` + dashboard `:2002`), movers columns (`:680`), activity log (`:1896`), market grid.

  **Heaviest offending JSX** — account header `WalletRailAccount` (`:1427-1473`): 16×16 avatar + `CircleDot` pip + USD number + `WalletChainCluster` (5 pills) + `WalletConnectionChip ×2` + `WalletRailRpcButton` (+`WalletProviderDots`) + refresh icon + `WalletAddressCluster` (2 pills each carrying overlapping `ChainLogoBadge` stacks) — roughly a dozen badged elements in one header. Second: `WalletChainCluster` (`:1293-1306`) static 5-chain pill row conveying no per-user info.
- **Heaviness / slop critique:** Two parallel renderings of the same data — `RailPositionList` (`:1635`)≈`LpPositionsPanel` (`:1991`); `RailNftList` (`:1597`)≈`NftPreview` (`:1951`); rail token list overlaps the P&L/allocation strip. Badge soup in the header is low information density. `SUPPORTED_WALLET_CHAINS` cluster is pure decoration (`:1293`). Decorative `WalletMotif` SVG (`:909-952`), `CircleDot` pip (`:1432`). `text-[0.68rem]`/`text-3xs` micro-type everywhere.
- **Minimization recommendations:** Collapse rail + dashboard into one column (don't show NFTs/LP/positions twice). Keep balance number, allocation bar, one token list, optional P&L sparkline. Move Movers/Activity/Market into chat. Delete the chain-support cluster; replace EVM/SOL chips + provider dots + RPC pill with a **single status dot** next to the balance (tap→RPC). Collapse the two address pills into one truncated address + copy. Convert P&L window/refresh/RPC to icon-only (orange active). View-dependent chat actions: refresh, hide token, copy address, open RPC settings, "show my P&L", "what moved today" (most already have `useAgentElement` ids).
- **Even-simpler note:** Strong chat-merge candidate — Movers, Activity, Market overview are read-only context the floating agent can narrate on demand. The chat-sidebar widget already covers the glanceable balance, so the full page is mostly redundant for the common case.

## 2. Wallet TUI — `wallet` (tui) / `InventoryTuiView` — `InventoryView.tsx:2351`

- **Real or stub?** **REAL** — `loadWalletTuiState()` (`:2363`), emits `data-view-state` JSON for the agent (`:2426`).
- **Structure:** 2 sections w/ `1px solid rgba(125,211,252,0.3)` borders (`:2454,2531`), monospace, hardcoded slate/cyan/emerald hex (`#020617`, `#7dd3fc`…). Refresh, address lines, 16-token grid, 4 movers, 4 nfts.
- **Critique/fix:** Minimal by design; the only issue is the **hardcoded palette ignores Eliza tokens** (cyan/emerald, not orange/blue) (`:2429-2432,2436,2518`). Align palette; otherwise leave. **Structurally identical to the Polymarket TUI** — extract one shared two-pane monospace frame.

## 3. Wallet chat-sidebar widget — `wallet.status` — `plugins/plugin-wallet-ui/src/widgets/wallet-status.tsx:168`

- **Real or stub?** **REAL** (`useApp`, lazy `loadBalances`). Light by widget standards: chain-badge row, 2 address rows + copy, divider + Assets/Value stat rows. Minor trim targets: `EVM_CHAIN_ORDER` lists 7 chains but inventory filters 5; divider border (`:306`); dual copy buttons. **This is already close to the "glanceable" ideal the full InventoryView should aspire to.**

## 4. Finances — `finances` / `FinancesView` — `plugins/plugin-finances/src/components/finances/FinancesView.tsx:576`

ViewDeclaration: `plugins/plugin-finances/src/plugin.ts:26-40` (single view, no XR/TUI).

- **Purpose:** Owner finance dashboard — balance summary, recent transactions, recurring charges.
- **Real or stub?** **REAL data wiring** to 4 live PA `/api/lifeops/money/*` routes (`:119-127`) with injectable fetcher seam; full loading/error/empty/populated state machine (`:571-695`). Caveat: `types.ts:1-9` self-describes as a "migration scaffold."
- **States:** loading (`:631`), error+Retry (`:640`), disconnected/no-source (`:666`), populated (`:685`).
- **Structure:** 1 h1 + subtitle (`:443-448`); 3 h2 card titles (`:479,504,535`); 3+ `cardStyle` panels (`1px solid` border + surface, `:321-329`); per-row `borderBottom` on every transaction/recurring row (`:355`); no tags/badges (good); buttons Refresh (`:393`), Connect-source (`:417`), Retry (`:648`); no inputs; transactions list (`:506`), recurring list (`:538`).

  **Heaviest offending JSX** — no-source empty state (`:666-683`): bordered card + bold heading + **3-line explanatory paragraph** ("Connect a bank, PayPal, or import a CSV so Eliza can track your balance, transactions, and recurring charges. Nothing is shown until a source is linked.") + button. Second: `BalanceCard` 4 stat rows (Net/in/out/As-of, `:480-492`) — the "As of" row is filler.
- **Heaviness / slop critique:** Dark `#0a0a0a` bg (`:299`, comment even says "dark theme" `:236`) — heaviest mismatch with the lighter direction. Over-explained empty/error copy (`:672-675`, long `Couldn't load finances` block `:644-657`). Per-row bottom borders add noise. Structurally a lighter clone of the wallet (3 bordered cards stacked).
- **Minimization recommendations:** Flip to light surface. Empty state → one line + button ("No source connected" + Connect); delete the 3-line paragraph. Balance card → flat header row (big net number, "+in/−out" pair in green/red, drop "As of"). Transactions/recurring → borderless rows, color the amount. Error → inline one-liner + Retry icon. Chat actions: refresh, connect-source, "what did I spend on X", "cancel <subscription>" (recurring list is the natural cancel surface). Proactive: "next recurring charge in N days" is the one line worth keeping.
- **Even-simpler note:** Won't merge with wallet (separate domains/services) but should share **one minimal "money list" visual primitive** (balance header + borderless amount-colored list).

## 5. Polymarket — `polymarket` / `PolymarketAppView` (desktop+XR) — `plugins/plugin-polymarket-app/src/PolymarketAppView.tsx:36`

ViewDeclaration: `plugins/plugin-polymarket-app/src/plugin.ts:105-145` (standard, XR, TUI→`PolymarketTuiView`).

- **Purpose:** Prediction-market discovery — readiness strip, market list, market detail with outcomes/odds.
- **Real or stub?** **REAL** — `usePolymarketState()` fetches live `polymarketStatus()` + `polymarketMarkets({limit:25})` (`usePolymarketState.ts:24-29`). Trading intentionally read-only (documented).
- **States:** loading skeletons (4 shimmer cards `:130-135`); empty `DisconnectedState` (`:273`); populated list (`:137-147`); market detail (`:118-122,:551`); error inside disconnected (`:318,328`).
- **Structure (already closest to target — light surface, icon+color forward):** 1 h1 (`:96`), detail h2 (`:613`), "Outcomes" sub-header (`:659`); 2 description paragraphs both in empty state (`:320-331,:360-366`); per-market `MarketCard` rounded-16 (`:461-547`), `MarketDetail` rounded-16 (`:558`), 3 `Metric` cards (`:774`), outcomes mini-table (`:642`); chips: `ReadinessStrip`→2 `CapabilityChip` w/ `StateDot`+"on/off" text (`:243-270`), per-card up to 3 `OutcomeChip` (`:387-437`), Vol/Liq/Category spans (`:541-545`).

  **Heaviest offending JSX** — `DisconnectedState` (`:273-369`): 96×96 glyph tile + h2 + ~2-line paragraph + **both CapabilityChips repeated** (already shown in `ReadinessStrip`) + a third paragraph with inline `<code>` listing missing env vars. Second: `CapabilityChip` (`:209-241`) dot + label + literal "on"/"off" word (the dot already encodes state).
- **Heaviness / slop critique:** Redundant readiness chips (shown on list view AND again in `DisconnectedState` `:341-351`). "on/off" text beside a state dot. Env-var `<code>` hint (`:360-366`) is developer-facing copy in a user view. `MarketDetail` 3 `Metric` cards each bordered — could be a single inline row.
- **Minimization recommendations:** Delete the duplicate chips + env-var hint in `DisconnectedState`; keep one short line + glyph. `CapabilityChip`→dot + label only. Collapse market-card footer to one muted line (or just Vol). MarketDetail metrics→one inline row. Keep the outcome progress-bar (on-brand, orange accent). Chat actions: refresh, select-market, "show me <topic> markets", "what are the odds on X" (already wired `useAgentElement` `:51-64,449-456`).
- **Even-simpler note:** Not mergeable, but it's the **reference look** for the other two views to copy. Its TUI (`:802`) shares the hardcoded cyan/slate palette with the wallet TUI — share a frame, adopt Eliza tokens.

### Part A cross-cutting

Theme split (make all 3 light like polymarket); two near-identical hardcoded-palette TUIs (`InventoryView.tsx:2424-2576`≈`PolymarketAppView.tsx:861-998`); wallet rail-vs-dashboard duplication is the single largest cut; badge/chip soup in the wallet header + duplicated polymarket readiness chips; over-explained empty/error states reducible to one line + chat; finances DTO is a self-declared scaffold.

---

# Part B — Hyperliquid · Shopify · Steward · Vincent

Each plugin declares **3 ViewDeclarations** but only **2 distinct components** — the `xr` variant reuses the same React component as the default web view; the 3rd is a hand-maintained `#020617`/cyan TUI. All four follow an identical pattern: full-screen `fixed inset-0 z-50` overlay shells with header (back + status pill + refresh), a polling hook, and the dark TUI clone. Each re-implements its own header and owns a manual Refresh button despite existing polling.

## 1. Hyperliquid — `hyperliquid` (web+xr) — `src/HyperliquidAppView.tsx:72-258`

ViewDeclaration: `src/plugin.ts:128-154`.

- **Purpose:** Read-only Hyperliquid perp markets dashboard — readiness, market list, position/order counts.
- **Real or stub?** **REAL.** `useHyperliquidState` (`:22`) calls `hyperliquidStatus/Markets/Positions/Orders`. Execution intentionally disabled (read-only by design); reads are live.
- **States:** loading (`:168`), error (`PagePanel.Notice` `:135`), populated, read-blocked (`publicReadReady=false` zeroes data, hook `:41-46`), credential-mode variants (`:59`), execution-blocked notice (`:155`), vault-not-ready guidance (`:162`).
- **Structure:** 1 h1 (`:114`) + 3 h2 ("Markets" `:178`, "Positions" `:207`, "Orders" `:231`); 0 description paragraphs (good); 3 `StatusTile` (`:138-152`) + Markets card + 2 stat cards + up-to-2 notices = ~6-8 bordered boxes; heavy `border border-border/24` + `border-b` + `divide-y divide-border/14` (`:183`); 2 `ReadinessPill` (`:209,232`); 2 buttons (back, refresh); market list up to 24 rows (`:184`) + 2 single-number stat blocks.

  **Heaviest offending JSX** — Markets section: bordered card with a bordered header row wrapping a `divide-y` 3-column grid capped at 24 (`:175-201`), showing `sz` decimals + `maxLeverage` for all rows (low-signal). Plus 3 `StatusTile`s — three bordered boxes each saying one word for one boolean.
- **Heaviness / slop critique:** **Positions and Orders are two separate full bordered cards each displaying a single integer** (`:203-251`) — two `<h2>`s, two `ReadinessPill`s, ~50 lines to show "0 positions / 0 orders." 3 StatusTiles for 3 booleans. `szDecimals`/`maxLeverage` noise across 24 rows.
- **Minimization recommendations:** Collapse 3 StatusTiles + Positions + Orders into **one thin status strip** (colored dots: `reads · signer · account · positions(n) · orders(n)`); delete `ReadinessPill` + both stat cards. Markets→flat list `NAME · 50x`, drop borders/dividers/`sz` noise, lazy scroll. Drop manual refresh (add polling; currently fetches once on mount `:65-67`). Funding/PnL alerts→floating chat.
- **Even-simpler note:** Because execution is permanently disabled, this is a **read-only ticker** — could be reduced to a one-line status strip + scrollable market list, or **replaced by chat** ("what are my Hyperliquid positions?").

**TUI** (`HyperliquidTuiView` `:260-477`, ViewDecl `:155-168`): REAL (`loadHyperliquidTuiState`); 2 bordered `#020617`/cyan `minHeight:420` sections, `data-view-state` JSON (`:317`). The double-near-black aesthetic is exactly what the redesign moves away from; candidate to generate from the view-state contract.

## 2. Shopify — `shopify` (web+xr) — `src/ShopifyAppView.tsx:385-772`

ViewDeclaration: `src/plugin.ts:115-141`. Panels: `ProductsPanel`/`OrdersPanel`/`InventoryLevelsPanel`/`CustomersPanel`/`StoreOverviewCard`.

- **Purpose:** Full Shopify dashboard — overview, products (create/search/paginate), orders (filter/expand), inventory (adjust ±1), customers (search).
- **Real or stub?** **REAL and most feature-complete of the four.** `useShopifyDashboard` polls 5 endpoints/30s; create-product (`ProductsPanel.tsx:117`) and inventory-adjust (`InventoryLevelsPanel.tsx:173`) are live POSTs.
- **States:** statusLoading skeleton (`:540`), statusError (`:530`), not-connected→`ShopifySetupCard` (`:536`), connected→5-tab dashboard; per-tab loading/empty/error/populated; inventory adjusting/adjustError; create-product submitting/submitError.
- **Structure (heaviest view in the set):** 5 tabs (`DASHBOARD_TABS` `:302-312`); paragraph-heavy disconnected `ShopifySetupCard`; Overview = `StoreOverviewCard` + 4 `OverviewTile` + 2 "recent" cards; pervasive `border border-border/24` + `rounded-xl/2xl/3xl`; OrdersPanel expanded row = 6-cell bordered grid (`OrdersPanel.tsx:127-176`); badges (product status dot, order Fulfillment+Financial dots, inventory Badge, 4 pills in `StoreOverviewCard` `:28-40`, 3 capability pills in setup); ~18 buttons; inputs: product/customer search, 4-input create-product dialog, order SegmentedControl, inventory location `<select>`.

  **Heaviest offending JSX** — `ShopifySetupCard` (`:111-160`, ~150 inline-styled lines): 84px icon tile + h2 + `<p>` + "Not connected" pill + **two `SetupField` cards each with label + description + env-var `<code>`** (`SHOPIFY_STORE_DOMAIN`, `SHOPIFY_ACCESS_TOKEN`) + 3 capability pills + CTA — marketing for "set 2 env vars." Runner-up: OrdersPanel expand = 6 bordered tiles re-stating the visible row.
- **Heaviness / slop critique:** Setup card is pure slop; uses off-brand `SH_ACCENT="#ff5800"` (`:37`, ≠ `#ff8a24`). `StoreOverviewCard` carries 4 pills (≥2 redundant with the header pill). OrdersPanel expand near-zero new info. Two badge components render as dots requiring a legend (color without label).
- **Minimization recommendations:** Setup card→one line + "Configure" button. Collapse 5 tabs→Overview-as-home (the 4 OverviewTiles are the real surface; entity lists reachable by tapping a tile or via chat). Kill OrdersPanel expand grid (labels inline; "more"=chat). `StoreOverviewCard`→shop name + one status dot. Badges→labels not dot+legend. Drop manual refresh. Use brand `#ff8a24`. Proactive: low-stock/new-order alerts→floating chat, not the two static "recent" cards.
- **Even-simpler note:** The one view that justifies staying a real surface (create-product + inventory-adjust are genuine writes), but 2-3× heavier than needed. Minimum: Overview (4 tiles + connection dot) as home, entity lists as flat lazy lists, writes from chat or a floating "+".

**TUI** (`ShopifyTuiView` `:774-966`): same `#020617` parallel impl, 2 `minHeight:420` sections, `data-view-state` JSON (`:822`).

## 3. Steward — `steward` (web+xr) — `src/StewardView.tsx:61-208`

ViewDeclaration: `src/plugin.ts:379-405`. Children: `ApprovalQueue.tsx`, `TransactionHistory.tsx`. (`StewardVaultOverview.tsx` — DEAD, see below.)

- **Purpose:** Steward vault management — pending-transaction **approval queue** + history. The human-in-the-loop authorization surface for agent-initiated wallet transactions.
- **Real or stub?** **REAL.** `getStewardStatus/Pending/History`, `approve/rejectStewardTx` (`:62`); ApprovalQueue polls 10s (`:35`); connection-gated.
- **States:** disconnected (`:97`)→empty panel + mono `STEWARD_API_URL + STEWARD_API_KEY` hint; connecting (`null`)→"Connecting…" (`:152`); connected→Approvals/History tabs; ApprovalQueue: loading/empty/populated/per-tx `actionInFlight`/inline reject dialog/toast on new approvals (`:251`); History: loading/empty/table/filters/pagination.
- **Structure:** h1 (`:133`), h2 disconnected (`:105`); header `PagePanel` + tablist + cards/table; heavy borders — tablist `border` (`:161`), **each approval card is `rounded-3xl border` w/ gradient bg + inset shadow** (`ApprovalQueue.tsx:436`), table `divide-y`; badges (connected pill, pending-count on tab + toolbar, chain pill, policy-reason boxes, `StatusBadge` per row); reject-reason input + status/chain `<select>`; history `<table>` 6 cols (`:334-401`).

  **Heaviest offending JSX** — the approval card wrapper (`ApprovalQueue.tsx:436`): `rounded-3xl` border + 2-stop `linear-gradient` + inset box-shadow (this exact recipe copy-pasted across Vincent too). Each card stacks time+clock+chain-pill, "To"/"Amount" labeled pair, policy-reason warning boxes, action buttons, inline reject form.
- **Heaviness / slop critique:** `2xs uppercase tracking-wider` micro-labels ("To"/"Amount"/"Policy reason" `:454/466/481`) above self-evident values. The gradient+inset-shadow card is exactly the heavy treatment to drop. Two redundant pending counters (tab + toolbar). `formatTime` hand-rolled in both `ApprovalQueue.tsx:349` and `TransactionHistory.tsx:234`.
- **Minimization recommendations:** **Most defensible view in the set** — transaction approval is a real security gate that should be deliberate. Flatten: approval card→flat row `{amount} → {to-short} · {chain} · {time}` + Approve/Reject (drop gradient/inset-shadow/micro-labels/card chrome). Reject reason→single optional inline field on Reject only. Policy-reason→one colored line. Disconnected→"Connect Steward"→settings (drop the dev-facing env string). History as secondary tab; status as colored text. **Big win: pending approvals should push INTO the floating chat** ("Approve transfer of 0.5 ETH to 0xabc…? [Approve] [Reject]") — the agent already toasts new approvals (`:251`).
- **Even-simpler note:** **Approvals are the strongest candidate to move into chat** (yes/no agent prompt). Then Steward collapses to just `TransactionHistory` — a single audit table — removing ApprovalQueue's 549 lines of nested card/dialog JSX.

**DEAD CODE — `StewardVaultOverview.tsx` (477 lines):** fully-built vault overview (addresses, per-chain balances, webhook events) but **never rendered** — `StewardView` mounts only `ApprovalQueue` + `TransactionHistory` (`:189-204`); grep finds only self + `.test.tsx`. Recommend deletion (or wire as a 3rd tab). Contains heavy `try/Promise.allSettled` chain-snapshot logic + the same gradient-card aesthetic.

**TUI** (`StewardTuiView` `:210-401`): same `#020617` parallel impl, 2 `minHeight:420` sections, `data-view-state` JSON (`:256`).

## 4. Vincent — `vincent` (web+xr) — `src/VincentAppView.tsx:33-191`

ViewDeclaration: `src/plugin.ts:110-136`. Children: `VincentConnectionCard`/`WalletStatusCard`/`TradingStrategyPanel`/`TradingProfileCard`.

- **Purpose:** Vincent trading-account OAuth + wallet/strategy/P&L overview (Hyperliquid/Polymarket via heyvincent.ai).
- **Real or stub?** **MOSTLY REAL, with one permanent-stub child.** `useVincentDashboard` (15s poll) drives connection/wallet/balances/strategy. **`TradingProfileCard` is a permanent stub:** `/api/vincent/trading-profile` always returns `profile: null` (`routes.ts:464-471`), so the P&L card only ever renders its empty dot state (`TradingProfileCard.tsx:50-62`); the full stat-tile + token-breakdown UI (`:67-108`) is dead in production.
- **States:** disconnected (`!vincentConnected`)→connection card + 3-tile "Vincent/Wallet/OAuth" teaser (`:157-184`); loading (`:132`); connected→ConnectionCard + WalletStatusCard + TradingStrategyPanel + TradingProfileCard (`:143-155`); error banner (`:129`); per-card states (login-busy/error, wallet loading/addresses/`$0.01+`, strategy configured/unset, profile null/full).
- **Structure:** h1 (`:84`); minimal prose (good); ConnectionCard + 3 data cards + disconnected teaser; **same `rounded-2xl border ... linear-gradient ... inset-shadow` recipe as Steward** (`VincentConnectionCard.tsx:74`, `WalletStatusCard.tsx:188/201`, `TradingStrategyPanel.tsx:41`, `TradingProfileCard.tsx:52/68`); ConnectionCard has a 2-3 col bordered chip grid (Connected/OAuth/Ready `:76-107`); badges (header pill, `StatusDot`, `StatusBadge`, strategy/token pills); buttons (back, refresh, connect/disconnect, copy EVM/Solana, "Open Vincent"); **no inputs** (no strategy editing in UI despite `POST /strategy` existing — endpoint-without-trigger violation).

  **Heaviest offending JSX** — disconnected feature teaser (`:158-184`): 3 bordered tiles each showing an icon + a single word ("Vincent"/"Wallet"/"OAuth"), conveying nothing actionable. Plus `TradingStrategyPanel` unset-state (`:57-72`): 3 placeholder tiles "Unset/0%/Idle."
- **Heaviness / slop critique:** Disconnected teaser is pure decoration (the only thing the user needs is the Connect button already in ConnectionCard above it). ConnectionCard's 3-chip grid — "OAuth" as a static chip is meaningless. `TradingProfileCard` ships a full P&L UI for data that never arrives. Gradient+inset-shadow recipe copy-pasted 6× here and across Steward. Strategy params shown as pills but no edit path (editing implied at heyvincent.ai via the external link).
- **Minimization recommendations:** **Delete the disconnected teaser** entirely (disconnected→just "Vincent" + Connect button); collapse ConnectionCard chip-grid to one dot + button. **Remove `TradingProfileCard`** until the route returns real data. `TradingStrategyPanel`→drop empty placeholder tiles; set state could be one line `DCA · 60s · Dry · 3 params`. `WalletStatusCard` good and real (dust-filtered totals) — flatten the shell, addresses as copyable mono text. Drop manual refresh (15s poll). Chat: "connect Vincent"/"disconnect"/"show my Vincent P&L"/"change strategy to DCA" — the missing strategy-edit is better served by chat.
- **Even-simpler note:** Lightest = a **single connection card** (dot + Connect/Disconnect) + WalletStatusCard when connected. Most of this view is chat-replaceable; its reason to exist is the OAuth button + a wallet-balance glance.

**TUI** (`VincentTuiView` `:193-393`): same `#020617` parallel impl, 2 `minHeight:420` sections, `data-view-state` JSON (`:253`); surfaces strategy fields the web UI can't edit either.

---

# Part C — Task-Coordinator · Screenshare · Model-Tester

Three plugins, **8 ViewDeclarations**, **4 real web components** (the rest are XR/TUI re-pointers or the authored-once spatial variant). The default+xr declarations ship the same DOM; the genuinely separate XR/TUI surface is the `*SpatialView.tsx` (terminal-only).

## VIEW 1 — `task-coordinator` (default/xr) — `CodingAgentTasksPanel` — `plugins/plugin-task-coordinator/src/CodingAgentTasksPanel.tsx`

- **Purpose:** List + read-only drill-down of coding-agent task threads (sessions, decisions, artifacts, transcripts, pending inputs). One of the two coding-agent surfaces.
- **Real or stub?** **REAL.** `client.listCodingAgentTaskThreads` (`:648`), `getCodingAgentTaskThread` (`:711`), 5s poll (`:689`), `archive`/`reopen` mutations (`:751,782`).
- **States:** loading list (`:926-931`), empty `TaskEmptyState` (`:933-941`), populated `threads.map(TaskCard)` (`:911-922`) + `SparseWatermark` when `<4` (`:924`), load/mutation error banners (`:894-906`), full-pane detail (`:813-845`), detail loading/error (`:576-579,819-826`).
- **Structure:** page header (medallion + title + count chips `:852`) + detail title block (`:566`) + ~6 `DetailList` sub-headers in detail (Sessions/Pending/Artifacts/Decisions/Events/Messages `:271-461`); each `TaskCard` bordered rounded-2xl (`TaskCardList.tsx:292`); **6 stacked bordered `DetailList` cards** (`:153`); transcript entries are cards-in-a-card (`:441`); chips (`TaskStatusChip`, meta chips, 1-3 `TaskCountChip` `:855-864`, 3 `EmptyStateTile` chips); 1 search input (`:869`) + archived toggle.

  **Heaviest offending JSX** — detail pane = a wall of 6 bordered `DetailList` boxes (`:271-461`), several with line-clamped prose; plus the 3-stat textual triple ("N sessions · N artifacts · N transcript entries" `:230`).
- **Heaviness / slop critique:** Detail is a vertical stack of 6 near-identical bordered boxes — pure card-in-card chrome. The text triple-count (`:230`) duplicates the chips. Empty state renders 3 fake placeholder tiles ("0 tasks"/"Agents idle"/"Timeline idle" `TaskCardList.tsx:404-406`) — decorative slop pretending to be data. `SparseWatermark` (44×44 glyph `:246`) is decoration.
- **Minimization recommendations:** Collapse the 6 `DetailList` boxes into ONE chat-style timeline (they're already chronological) — borderless, icon-prefixed rows. Keep title + status medallion + acceptance criteria + a single live activity stream. List: keep `TaskCard` (already minimal); drop the text triple. Delete the placeholder tiles + watermark ("No tasks — dispatch one from chat"). Delete/Reopen→chat-context actions or overflow. Proactive: "1 task waiting on you" as a glanceable chat prompt.
- **Even-simpler note:** **Overlaps heavily with `OrchestratorWorkbench`'s task list** (shared `TaskCard`/`TaskCardList` kit). This is read-only-lite; orchestrator is full read/write of the same data. **Strong merge candidate** — one task surface with progressive disclosure.

**TUI** (`TaskCoordinatorTuiView`/`OrchestratorTuiView` are thin `TerminalPluginView` wrappers `:947,963`; real TUI = `OrchestratorSpatialView.tsx`).

## VIEW 2 — `orchestrator` (default/xr) — `OrchestratorWorkbench` ⚠️ WORST OFFENDER — `plugins/plugin-task-coordinator/src/OrchestratorWorkbench.tsx` (4191 lines)

- **Purpose:** Full multi-agent orchestration workbench — task list + per-task room (live conversation stream) + right-side inspector/operator-drawer + create/add-agent forms + full read/write control.
- **Real or stub?** **REAL and fully wired.** `getOrchestratorStatus` + `listCodingAgentTaskThreads` (`:3336-3342`), detail+timeline (`:3377-3378`), **live SSE `streamOrchestratorTask`** (`:3470`), 1.5s active poll (`:3406`); 16+ real mutations (create/pause/resume/archive/reopen/delete/fork/restart/restartWithEditedPlan/validate/updatePriority/addAgent/stopAgent/retryTurn/rerunFromEvent); `useAgentElement` on nearly every control.
- **States:** loading-list (`:3844`), empty (`:3852`), populated (`:3863`), backend-absent calm hint (404→not error `:3779,:445`), loadError + actionError danger banners (can stack 3 `:3787,3792`), task-room loading (`:4010`), task detail (`:3890`), empty-conversation (`:3924`), streaming "Agent working…" bar (`:3971`), validating Approve/Reject (`:2034`), terminal/archived (`:2061`), drawer "no longer available" (`:2744`).
- **Structure (from full read):** ~14 headers; ~9 explanatory prose paragraphs (empty hint `:3856`, backend-absent `:3781`, footer "Use the overlay chat for follow-up instructions." `:4003`, 2× per-tool disclaimers `:2800-2806`, delete-dialog `:2196`, long placeholders `:1530,1570`); ~15 card patterns (`InspectorSection` ×10+ `:612`, `SubAgentCard` `:988`, `AddAgentForm` `:1736`, CreateTaskDialog `:1487`, `EventList` two-cards/item `:2656/2680`, drawer cards `:3068/3092`, bordered `JsonBlock`/`<pre>`); ~25+ borders/dividers (`HeaderDivider` hairlines ×4 in stat strip `:660-697`, inspector `border-l`, drawer `border-l`); ~9 badge types; ~40+ buttons; ~16 inputs; ~10 lists.

  **Heaviest offending JSX** — the inspector action toolbar (9-10 conditional icon buttons + bare priority `<select>` + AlertDialog Delete in ONE flex-wrap row `:2033-2215`). Also the stat strip (5 stats + 4 vertical hairlines + Gauge `:653-713`; comment at `:651` admits it replaced "a six-pill debug strip"). And the running-bar Stop button with THREE cues for one action (`<CircleStop/>` + "Stop" + `<kbd>Esc</kbd>` `:3992-3996`).
- **Heaviness / slop critique:** Inspector toolbar is the single worst region (button count shifts unpredictably on archived/terminal/paused/validating). Card-in-card nesting 3+ border levels deep (`:3058-3104`); the inspector is a column of ~8 stacked bordered `InspectorSection`s. **Two parallel inspectors** — `TaskInspector` (`:4087`) and `OperatorDetailDrawer` (`:4052`) occupy the same slot with near-identical chrome. `HeaderDivider` hairline overuse. Redundant icon+label+key. 3 stackable banners. `EventList` double-cards per timeline row. ~9 prose paragraphs.
- **Minimization recommendations:** **The task ROOM (conversation stream `:3931`) is the keeper and IS a chat** — make it the whole view; the floating overlay chat and this room should be the SAME surface. Collapse the inspector toolbar to ONE primary action (Pause/Resume) + `…` overflow. Flatten the inspector (kill the 8 stacked `InspectorSection`s; borderless icon-prefixed blocks). De-duplicate `TaskInspector` vs `OperatorDetailDrawer`. Kill the `HeaderDivider` hairlines (2-3 colored numbers + whitespace). Stop button: icon + `Esc` only. Collapse the 3 banners. Cut all 9 prose paragraphs. Keep the "Agent working…" running-bar as the only persistent status chrome.
- **Even-simpler note:** **Single largest, heaviest view in scope** and highest-impact target. (1) Merge with `CodingAgentTasksPanel`; (2) merge the task room with the floating chat. A candidate for a ground-up rewrite against the new direction, not a trim.

## VIEW 3 — task-coordinator/orchestrator (tui) — `OrchestratorSpatialView.tsx` (the minimalist reference)

- **Real or stub?** **REAL** — typed snapshot in, primitives out; same record types as web.
- **Structure:** **This is the minimalist reference already.** Detail uses `Divider label="…"` section separators (not bordered cards) — `awaiting you`/`plan`/`sessions (n)`/`decisions (n)`/`artifacts (n)`/`events (n)`/`transcript (n)` (`:456-672`); status is a 1-char mark + tone color (`STATUS_MARK` `:84`), not a chip; lists sliced; text-only buttons; no nested cards/badges/prose.
- **Recommendation:** Use this file as the **design template for the web redesign.** The web `OrchestratorWorkbench` should converge toward this density. The project already authored a minimalist orchestrator — the web view diverged into maximalism.

## VIEW 4 — `screenshare` (default/xr) — `ScreenshareOperatorSurface` — `plugins/plugin-screenshare/src/ui/ScreenshareOperatorSurface.tsx`

- **Purpose:** Operator surface to host a local desktop screen-share (start/rotate/stop/copy/open viewer) and connect to a remote one. Backed by real routes (`captureDesktopScreenshot`, `performDesktopClick/Keypress/Scroll`, viewer HTML `routes.ts:501`).
- **Real or stub?** **REAL.** `fetchJson` to `/api/apps/screenshare/*` (`:181,225,252`), clipboard copy (`:282`), opens viewer.
- **States:** `focus==="chat"`→empty (`:321-328`); host idle/active; capabilities loaded vs not (`:525`); busy start/stop (`:178`); error notices; TUI loading/ready/error (`:559`).
- **Structure:** 3 `SurfaceSection` titles (Host/Connect/Capabilities `:332,459,526`); **3 metric tiles in Host status row (`:333`) + 4 more when a session exists (Frames/Inputs/Last frame/Last input `:430-455`) + N capability tiles (`:528`)**, each bordered; 6 buttons; **3 inputs (remote URL/session/token `:461,471,481`)**; capability tile grid.

  **Heaviest offending JSX** — the metric tiles: up to 7 host tiles + N capability tiles, each a bordered dot+icon+value box (`:430-455`); plus the 3-field manual Connect form (`:461-490`).
- **Heaviness / slop critique:** Host shows 7 metric tiles — frame/input counters + last-frame timestamps are debug telemetry, not operator-essential. The 3-input remote-connect form is the heaviest input cluster (the copy-details button already produces one shareable URL; pasting that one URL should suffice). Capabilities grid is informational, not actionable.
- **Minimization recommendations:** Host→one status line (green=active/gray=idle) + Start/Stop toggle + one "Copy invite link." Drop the telemetry tiles. Connect→one "paste invite link" field. Capabilities→a single inline readiness dot, only when something is unavailable.
- **Even-simpler note:** Strong **chat-replaceable** candidate — "share my screen"/"connect to <link>" as chat actions + one live status pill.

**TUI** (`ScreenshareTuiView` `:559-752`): hardcoded dark terminal palette (`#020617` `:625-744`), 2 `minHeight:420` sections, same telemetry heaviness; a bespoke inline-styled outlier — fold into the `@elizaos/ui/spatial` pattern the other two plugins use.

## VIEW 6 — `model-tester` (default/xr) — `ModelTesterAppView` — `plugins/app-model-tester/src/ModelTesterAppView.tsx`

- **Purpose:** Developer surface to run live end-to-end probes against every Eliza model type (text/stream/embedding/tts/transcription/vad/vision/image-gen).
- **Real or stub?** **REAL.** `GET /api/model-tester/status` (`:263`) + `POST /run` (`:277`); backend makes real `runtime.useModel(...)` calls per probe; renders real audio/image outputs.
- **States:** status loading; per-probe idle/running/ok/failed; asset-load error (`:453`); image preview (`:458`); per-probe audio/image result (`:522,526`).
- **Structure:** 1 h1 (`:348`) + 8 per-probe h2 (`:487`); 0 prose (good); **8 probe `<section>` cards (`:477`) + per-result bordered `<pre>` (`:534`) + dashed-empty placeholder per probe (`:539`)**; badges (3 `MetricBadge` `:381-398`, per-probe `StatusPill` `:496`, 3 preset chips `:402`); ~16 buttons; prompt is 3 preset buttons not a textarea (`:402`) + 2 file inputs.

  **Heaviest offending JSX** — the per-probe card repeated 8× (`:477-544`): bordered section + medallion-icon + title + mono subtitle + StatusPill + Run + result block or dashed-empty placeholder.
- **Heaviness / slop critique:** 8 individually-bordered probe cards is a lot of repeated chrome; each empty probe renders a dashed box with a lone Sparkles icon (`:539`) — decorative filler. The 3-tile metric badge row (`:381`) duplicates what the rows convey. Both "Run all" + 8 per-probe Run (acceptable for a dev tool).
- **Minimization recommendations:** Replace 8 bordered cards with a **borderless list** of probe rows (icon + name + colored status dot + ms/result inline), expand `<pre>` on demand. Drop the dashed-empty boxes. Drop the 3 `MetricBadge` tiles. The `ModelTesterSpatialView` already does exactly this.
- **Even-simpler note:** A **developer diagnostic**, not an everyday surface — the most legitimately "tool-like," least in need of chat integration. Minimize chrome but it can stay standalone (invokable from chat: "test the voice model").

**TUI** (`ModelTesterSpatialView.tsx`): the minimalist reference for model-tester — one `Card`, 3-count caption, `Divider label`d sections, borderless `List` of probe rows (single-char `probeMark` by color `:88`). Already the target density.

### Part C summary

All REAL, no stubs. Worst: `OrchestratorWorkbench` (4191 lines) > `CodingAgentTasksPanel` detail (6 DetailLists) > screenshare (7 tiles + 3-input form) > model-tester (8 cards). Biggest wins: make the orchestrator task room = the floating chat; flatten every wall-of-boxes toward the in-repo `*SpatialView.tsx` template; merge `CodingAgentTasksPanel` + `OrchestratorWorkbench`; screenshare→chat actions + status pill.

---

# Part D — Vector-Browser · Trajectory-Logger · XR · Facewear

## 1. plugin-vector-browser — `vector-browser` — `plugins/plugin-vector-browser/src/VectorBrowserView.tsx` (1628 lines)

ViewDeclaration: `src/plugin.ts:16-30` (icon `ScatterChart`, `/vector-browser`, `desktopTabEnabled: true`).

- **Purpose:** Browse agent memory rows + visualize embeddings as list / 2D PCA canvas / 3D (three.js) point cloud.
- **Real or stub?** **REAL.** Live `client.getDatabaseTables()` / `executeDatabaseQuery()` with real SQL (JOINs `memories`↔`embeddings`, `::text` pgvector casts, paginates), real PCA, real interactive three.js.
- **States:** loading list/graph (`:1439-1442,1532-1533`); empty no-search vs no-records (`:1443-1452`), graph empty ≥2 (`:312-324,786-797`); error banner (`:1617-1621`), connection-error takeover (`:1589-1612`), 3D renderer-unavailable (`:799-815`); populated list/2D/3D with master+detail faces (`:1564-1582`).
- **Structure:** ~2 headers; `summaryHeader` + toolbar + `PagePanel` graph wrapper + `MemoryDetailPanel` + **3 `VectorMetric` stat cards** (`:1408-1433`) + per-row buttons; **pervasive borders** (metrics `:79`, rows `:1462-1466`, canvas `:334,826`, detail `:1541,1559,1578`, toolbar `:1335`); per-row `{N}D`+date chips (`:1477-1490`), 3D hover badge, 2D/3D legends; List/2D/3D toggle + Search/Prev/Next/Back/Retry (~8); table `Select` + search `Input`.

  **Heaviest offending JSX** — three near-identical 24-line segmented toggle buttons (`:1336-1380`), each with a 6-class conditional border/bg string; and the 3-up stat strip (`:1408-1433`) restating counts the header already shows (`stats.total` printed twice — header `:1291-1296` + metric `:1410-1415`).
- **Heaviness / slop critique:** **Three coexisting visualizations** for one dataset — tool maximalism; 3D drags in the whole three.js runtime for a novelty point-cloud most users never read. Redundant stats; "embed dims"/"unique" are dev trivia. Border-on-everything. **3 ways to show one record** (master face / detail face / inline `MemoryDetailPanel`). Canvas hand-draws its own grid/axis/tooltip/legend (`:151-260`) — a second mini-UI.
- **Minimization recommendations:** Collapse to ONE default view: the list. Make 2D/3D a single optional "map" toggle (icon only); strongly consider **dropping 3D** (kills the three.js bundle, renderer-unavailable state, ~530 lines of `VectorGraph3D`). Delete the 3-up stat strip. Row→single dim/`hasEmbedding` color dot; drop date chip. Flat hover-only rows. Chat: replace search + Prev/Next with chat query ("show me memories about X"); selecting a point pushes it into chat context.
- **Even-simpler note:** A **developer/debug inspector**, not a daily surface. List + "find similar in chat" covers 90%; 2D/3D are demo candy. Demote out of the primary tab set.

## 2. plugin-trajectory-logger — `trajectory-logger` (web) — `plugins/plugin-trajectory-logger/src/components/TrajectoryLoggerView.tsx`

ViewDeclaration: `src/index.ts:7-70` (3 surfaces under one id: web `TrajectoryLoggerView`, xr same component, tui `TrajectoryLoggerTuiView`; icon `Activity`).

- **Purpose:** Realtime dev inspector of the agent's current ("Now") + last ("Last") turn, split into HANDLE/PLAN/ACTION/EVALUATE phases with drilldowns. Polls `/api/trajectories*` at 700ms.
- **Real or stub?** **REAL.** Live polling, real phase classification, real drilldown bodies (LLM calls, provider accesses, tool events, evaluator decisions).
- **States:** loading first poll (`:62-64`); error (`:58-61`); ready idle vs recording (`LoggingStatusBadge` `:65,209-230`, `PhaseStrip` pulse ring `:148-152`); "no turn yet" (`:170-172`); phase idle/active/done/skipped/error (`PhaseChip` `:25-54`); phase selected→drilldown (`:98-102`).
- **Structure:** 1 sticky header (`:41-67`); 2 `PhaseStrip` cards (`:146-153`) + 1 drilldown card (`:99-101`); header border-b + strip/drilldown borders + progress rail + colored left-borders in drilldown (`PhaseDrilldown.tsx:122-126`); status badge + per-phase medallion ×8 (4 phases × 2 strips) + HANDLE provider chips; Back + 8 phase chips.

  **Heaviest offending JSX** — `PhaseChip` medallion (`PhaseChip.tsx:75-112`): a 9×9 ringed circle with status glow/pulse + uppercase tracked label + truncated summary line, ×8 on screen; plus the decorative progress rail (`TrajectoryLoggerView.tsx:178-187`) duplicating what the medallion colors convey.
- **Heaviness / slop critique:** Double-encoding of progress (rail + medallion colors). 2 full strips always on screen (8 status pills); "Last" rarely needs equal weight to "Now." Pulsing in 3 places. Dev tool, so density partly justified, but medallion styling heavier than warranted.
- **Minimization recommendations:** Drop the progress rail; let medallion color be the only progress signal. Demote "Last" to a collapsed line (4 tiny dots + "last turn 3s ago"), expand on tap. Shrink medallions to flat icon+color (no ring/glow/pulse). **Proactive chat:** when the agent is mid-turn the floating chat could surface "thinking… (PLAN)" and tapping opens this drilldown — the view becomes the *expansion* of the chat's own status.
- **Even-simpler note:** Strong replaceable-by-chat candidate after vector-browser. The Now-strip is essentially a verbose chat typing/status indicator.

**Spatial/TUI** (`TrajectoryLoggerSpatialView.tsx`, 468 lines): REAL, authored once in `@elizaos/ui/spatial`; ASCII status marks + ASCII progress bar (`:252-256`) — **already close to the lightest version** (borderless labeled sections, no medallions, no rail-vs-color duplication). The web view is the heavy outlier — converge toward this. Note: the 4 phase-body components (`HandleBody`/`PlanBody`/`ActionBody`/`EvaluateBody`) are duplicated in both `PhaseDrilldown.tsx` and this file — a consolidation opportunity.

## 3. plugin-xr — NO ViewDeclaration (server-side XR host chrome only)

`plugins/plugin-xr/src/index.ts:27-53` registers services/actions/providers/routes + `config:{XR_WS_PORT:31338}` — **no `views` array** (no `plugin.ts`). The only UI is `src/routes/xr-view-host.ts` — `GET /xr/view-host/:id` returns a self-contained HTML page (`buildHostPage` `:63-360`) loading *other* plugins' view bundles in an XR-optimized iframe shell.

- **Chrome states:** loader spinner (`:222-228`), load error + Retry (`:344-353`), mounted view, voice-listening indicator (`:135-153,290-293`), transcript toast (`:191-209,295-302`).
- **Chrome structure:** 1 header bar (title + voice indicator + close ✕ `:213-221`) + voice pill + transcript toast + close + spinner. Minimal by count.
- **Heaviness / slop critique:** **OFF-BRAND COLORS — the clearest violation in this part.** Inlined CSS hardcodes `--accent: #6366f1` (indigo/blue — forbidden) + `--bg:#0d0d0f` / `--surface:#18181b` (near-black) + `--border: rgba(255,255,255,0.08)` (`xr-view-host.ts:78-87`); voice indicator + transcript toast are indigo (`:139-145,196`). Self-contained inline `<style>` (~135 lines) doesn't inherit theme tokens — a parallel design system that will drift.
- **Fix recommendations:** Swap `--accent` to orange `#ff8a24` (or the real token), lighten `--bg`/`--surface`, kill the blue — near-mechanical, highest-value XR change. Header could drop the text title (icon + close only). The voice pill + transcript toast overlap the floating chat overlay — defer to it.
- **Even-simpler note:** Infrastructure, not a view to merge/remove — but its inline design system should be **deleted in favor of shared theme tokens**.

## 4. plugin-facewear — 2 real surfaces (+ XR variant)

ViewDeclarations: `src/index.ts:64-207` — `facewear` (gui/tui/xr)→`FacewearView`/`FacewearTuiView`/`FacewearView`; `smartglasses` (gui/tui/xr)→`SmartglassesView`/`SmartglassesTuiView`/`SmartglassesView`; plus `app.navTabs` for both (`:209-226`).

### 4a. `facewear` (gui) — `src/ui/FacewearView.tsx`

- **Purpose:** Device manager — list 4 headset/smartglasses profiles, show connected, launch connect/manage.
- **Real or stub?** **REAL but thin.** Polls `/api/facewear/status` every 5s; `DEVICE_PROFILES` is a hardcoded catalog of 4 (`:20-60`); Connect opens `/api/xr/connect` or routes to `/apps/smartglasses` (`:187-193`).
- **States:** loading (`:248-252`), error (`:254-258`), populated (summary card `:262-282` + 4 device cards + actions card).
- **Structure:** 1 page header + 1 "Actions" h2 (`:297`); summary card + 4× `DeviceCard` + Actions card (~6 cards); every card bordered; per-card Connected/Disconnected badge (`:127-135`), connection-type label, active-device chips; per-card Connect/Manage ×4 + Actions Connect/Status/Refresh = 7 buttons.

  **Heaviest offending JSX** — `DeviceCard` (`:101-155`, ~55 lines/device): icon tile + name + manufacturer + status badge + description line + connection-type row + Connect. **Status appears 3 ways at once** (green border tint `:104-106` + "Connected/Disconnected" badge `:127-135` + green icon tile `:111-119`). Plus a redundant Actions card (`:296-333`) whose Refresh is dead (auto-polls) and whose links duplicate per-device buttons.
- **Heaviness / slop critique:** Triple-encoded connection state per card. Redundant Actions card. Manufacturer + description + connection-type = 3 low-value text lines/card. The summary card restates the per-card badges + header pill = **connection state shown 4× on one screen**.
- **Minimization recommendations:** DeviceCard→icon (color-coded by state) + name + one connect/manage affordance; delete manufacturer/description/connection-type/status badge. Delete the summary card + Actions card. Chat: connecting is a guided conversational flow ("connect my Quest"); the agent already has `FACEWEAR_CONNECT`.
- **Even-simpler note:** Close to **replaceable by chat + a tiny status chip** — a 4-item static catalog + a status poll.

### 4b. `facewear` (xr) — `src/ui/FacewearXrView.tsx`

107 lines, REAL, thin. Polls status every 3s, lists connected devices (limit 6) or empty (`:95-103`). Light already (~3 rows + header). Minor: double-encoded again (`Active/Standby` pill + "Connected" text + green border `:53-62,74-85`). Keep as the lightest facewear surface; drop the redundant text. **Wiring inconsistency to flag owners:** the index.ts XR declaration wires `FacewearView` (heavy GUI) for `viewType:"xr"`, while this purpose-built lighter `FacewearXrView` exists unused.

### 4c. `smartglasses` (gui) — `src/ui/SmartglassesView.tsx` (1369 lines) — WORST OFFENDER IN PART D

- **Purpose:** Even Realities G1/G2 pairing, hardware self-test, side-tap/mic/audio validation, Wi-Fi config, copy/download diagnostics report.
- **Real or stub?** **REAL and deep.** Drives real BLE transports (`WebBluetoothG1Transport`, `EvenBridgeTransport`), encodes real G1 protocol packets, tracks 14 boolean test gates, runs a 60s guided validation loop. A genuine hardware bring-up console.
- **States:** lens idle/prompting/connected/failed (`LensStatus`); web-bluetooth-unavailable (`:815-819`); busy-per-action gating ~12 buttons; error banner (`:1118-1122`); `HeadsetStateHint` blocked/ready/unknown (`:1246-1298`); per-test pass/fail ×14; events empty/list; wifi not-checked/scanning/networks; report ok/incomplete.
- **Structure (the heavy one):** 1 page header + **6 `Panel` h2** (Setup/Platform/Test/Wi-Fi/Report/Events); **6 `Panel` cards (`:793,827,847,939,1027,1087`)** + nested cards (2 LensStatus, 8 CheckRow, 9 ReportRow, platform tab strip, event list); **30+ bordered boxes** on a connected screen; badges (StatusPill ×3, 3 HeadsetStateHint chips, 14 CheckRow dots, 3 display presets, wifi chips); **~18 buttons/toggles**; 2 Wi-Fi inputs + 1 dead `testText`; 14-gate grid + 9-row report table + event log.

  **Heaviest offending JSX** — the **14-row hardware-test gate grid** (`:925-936` rendering `CheckRow` `:1300-1331`), each a bordered box (colored dot + CheckCircle/Circle + label), capped at `VISIBLE_TEST_LIMIT=8` with "+N checks" overflow. Then the **Platform panel** (`:827-845`) — a 3-tab control whose only payload is 2 lines of static copy (`PLATFORM_COPY` `:70-89`); and the **9-row Report table** (`:1032-1062`) duplicating state shown elsewhere.
- **Heaviness / slop critique:** Six stacked bordered panels = a settings-page-of-panels, not a glanceable surface. Platform panel is near-pure slop (tabs for 2 sentences). Report panel duplicates Transport/Serial/Battery/Events the Setup panel + header already show. 14 test gates = debugging telemetry as primary UI (most are internal steps a user shouldn't see). 5 magic `VISIBLE_*` limits each add a "+N" overflow chip. Triple-encoded connect state again.
- **Minimization recommendations:** Collapse 6 panels→2 (Connect: lenses + Connect + ready/blocked hint; Diagnostics: Run Check + Copy/Download). Delete the Platform panel (pairing hint→inline helper or chat). Delete the Report table (keep only Copy/Download). Collapse 14 gates→one pass/fail meter ("11/14" + Details disclosure). Drop per-lens StatusPill text (color the icon). Chat: pairing/validation are guided/conversational (`guided-side-tap-audio-validation` already exists).
- **Even-simpler note:** A **hardware bring-up / QA console**, not a daily surface — should be **demoted out of primary nav** (currently a top-level navTab `:217-224`) into a "device setup" flow reached from FacewearView or chat.

### 4d. Smartglasses spatial/TUI — `src/components/SmartglassesSpatialView.tsx`

Snapshot-driven terminal render (via `registerSpatialTerminalView("smartglasses", …)`). Same convergence recommendation — the spatial vocabulary is the lighter target the GUI view should move toward.

### Part D cross-cutting

Spatial views are the lightest already (trajectory-logger, facewear both ship a flatter `@elizaos/ui/spatial` twin — converge the GUI toward them). Phase-body duplication is a real DRY target. Connection state over-encoded everywhere (pick one signal: color). XR host chrome off-brand (indigo + near-black, bypasses tokens) — mechanical high-value fix. Vector-browser, trajectory-logger, smartglasses are developer/hardware tools — demote out of the primary tab set.

---

# Part E — Games (chrome/HUD only)

**Architectural note (all 5):** the React views do NOT render the game canvas — the canvas is a fullscreen `<iframe>` served from each plugin's `routes.ts` (`GET /api/apps/<game>/viewer`) embedding a remote client. The iframe wrapper HTML is minimal and fine (`plugin-scape/src/routes.ts:218-272`). The reviewed `*OperatorSurface.tsx` files are the **operator/spectator dashboard chrome** beside the game — that's where all the slop lives. Two visual systems: scape/2004scape use `game-surface-shell.tsx` (token-aware but 34vh hero + 4-chip strip + many stacked cards); clawville/hyperscape/defense use a hand-rolled `HeroHeader`+`StatusStripCard`+`HeroFrame` trio copy-pasted ~250 lines into all three (only accent/emoji differ) + `GameOperatorShell`.

## 1. plugin-scape — `scape` — `plugins/plugin-scape/src/ui/ScapeOperatorSurface.tsx` (~1040 lines)

- **Purpose:** Operator dashboard for an autonomous OSRS-alike (xRSPS) agent. ViewDecl `index.ts:49-89`.
- **Real or stub?** **REAL.** `selectLatestRunForApp`, live `session.telemetry` parsed into agent/goal/journal/nearby/skills/inventory, `client.sendAppRunMessage`/`controlAppRun`. Game = real iframe (`routes.ts:245`).
- **States:** no-run "ready" (`:643-668`), live (`:700`), 8 connection sub-states via `connectionLabel`/`connectionTone` (`:417-453`: idle/connecting/auth-pending/spawn-pending/connected/reconnecting/closed/failed), paused.
- **Chrome/HUD:** `GameSurfaceHero` (34vh image banner + title + pulsing status pill + Pause/Resume CTA) → `GameSurfaceStrip` (4 chips) → `GameSurfaceZone` with a **badge row** (status + viewerAttachment + health + paused + "N active runs" `:730-745`) then up to **8 stacked `SurfaceSection`s** (Agent 4 cards / Controls / Active Goal / Steering / Journal / Nearby 4 cards / Skills badge cloud / Recent Actions).

  **Heaviest offending JSX** — the badge row (`:730-745`) duplicating the hero status (status + viewerAttachment + health + paused + "N active runs").
- **Heaviness / slop critique:** Hero status pill + badge row + "Agent→Bot SDK" card state run status **three times**. "Controls" duplicates the hero Pause/Resume. 8 connection states for what a glanceable UI needs as 3. ~⅓ of the file is defensive telemetry coercion (`asRecord`/`readString`/`extractX` `:148-390`). Box-in-box-in-box (cards inside sections inside a zone).
- **Minimization recommendations:** Delete the badge row + standalone Controls section (`:788-822`); fold Pause/Resume into the hero CTA only. Collapse Agent's 4 cards→one line (name · HP · location). Drop "N active runs", status-word repeats, the Skills cloud. Keep one status pill, one identity line, goal; let the floating chat own steering.

## 2. plugin-2004scape — `2004scape` — `plugins/plugin-2004scape/src/ui/TwoThousandFourScapeOperatorSurface.tsx`

- **Purpose:** Operator dashboard for an autonomous RS-2004 bot. ViewDecl `index.ts:15-55`.
- **Real or stub?** **REAL.** Same `game-surface-shell`; live telemetry (player/tutorial/nearbyTargets/combatStyle/gameMessages), `postAppRunCommand`. Game = real proxied iframe.
- **States:** no-run "ready" (`:850-875`), live (`:903`), runtime sub-states (`:723-734`), autoplay on/off, tutorial active/clear.
- **Chrome/HUD:** same hero + 4-chip strip + zone; badge row, then **Runtime** (4 cards: Login/Autoplay/Tutorial/Steering `:946-975`), **Live State** (5 cards Goal/Intent/Player/Viewer/Field Intel + 3 sub-lists), **Steering**.

  **Heaviest offending JSX** — the "Runtime" 4-card stack, all derived status strings (`:946-975`).
- **Heaviness / slop critique:** **Worst card-density of the five** — 9 `SurfaceCard`s + 3 sub-feeds + 4 chips + badge row, almost all derived English strings ("Live steering ready", "Waiting for the command bridge"). ~30 lines of label/tone derivation (`:704-786`). Login/Steering/Viewer/Runtime = infra plumbing as game HUD. Re-implements its own `Button` (`:47-70`) instead of importing `@elizaos/ui`.
- **Minimization recommendations:** Cut the entire Runtime section (→a connection dot). Reduce Live State to Goal + Player line. Keep at most one feed. Collapse derived-string helpers to one connection state. Import the shared `Button`.

## 3. plugin-clawville — `clawville` — `plugins/plugin-clawville/src/ui/ClawvilleOperatorSurface.tsx`

- **Purpose:** Operator panel for ClawVille (sea-themed 3D agent game). ViewDecl `index.ts:41-82`.
- **Real or stub?** **REAL.** `client.sendAppRunMessage`, live telemetry, optimistic event log, `GameOperatorShell`. Game = real iframe (clawville.world).
- **States:** no-run "empty" (`:507-546`), live (`:561`); status→live/attention/idle (`:62-66`); sending-command in flight.
- **Chrome/HUD:** hand-rolled `HeroHeader` (34vh + blur status chip + accent CTA `:185-273`) → 3 `StatusStripCard`s (Location/Relay/Goal) → `GameOperatorShell` (own title + statusLabel + objective + detailItems + actions + feed + composer); empty state adds a 🦀 waiting-zone (`:379-414`).

  **Heaviest offending JSX** — the `HeroHeader` (`:196-272`, ~80 inline-styled lines, **byte-identical to hyperscape + defense** except accent/emoji).
- **Heaviness / slop critique:** **Double-HUD** — bespoke hero+strip AND `GameOperatorShell` (which has its own status/objective/location), so status/objective/location render **twice**. 34vh marketing banner eats a third of the panel before any operational info. ~250 lines duplicated verbatim across this + hyperscape + defense. Emoji icons (🦀🏘💬⚡📍🎯) clash with the orange/blue/flat brand.
- **Minimization recommendations:** Delete the bespoke `HeroHeader`/`StatusStripCard`/`HeroFrame`; let `GameOperatorShell` be the sole chrome. If a banner stays, shrink to a thin title bar + status dot. Extract the one shared shell (stop triplicating). Replace emoji with brand icons + orange/blue.

## 4. plugin-hyperscape — `hyperscape` — `plugins/plugin-hyperscape/src/ui/HyperscapeOperatorSurface.tsx`

- **Purpose:** Spectate-and-steer host surface (follow an agent in a live world). ViewDecl `index.ts:14-53`.
- **Real or stub?** **REAL** (thin — no service/actions, pure app-manager). Live session via `selectLatestRunForApp` + `sendAppRunMessage`/`controlAppRun`; viewer auto-login via wallet auth. Game = real iframe.
- **States:** no-run "ready" (`:564-597`), live (`:600`); status→live/attention/idle (`:37-41`); pause/resume in flight.
- **Chrome/HUD:** same copy-pasted `HeroHeader` (34vh) + 4 `StatusStripCard`s + a badge row (status + viewerAttachment + health + "N active runs" `:650-667`) + **Host** section (4 cards: Auth/Follow/Runtime/Viewer `:671-701`) + **State** section (3 cards + activity feed) + **Operator Relay** (suggested prompts + Pause/Resume).

  **Heaviest offending JSX** — the "Host" section (`:671-701`): 4 cards of pure infra (auth bootstrap, follow target, background/foreground, viewer attachment + heartbeat), e.g. `formatViewerAuthLabel(run)` → "Viewer does not need app auth."
- **Heaviness / slop critique:** Triple status restatement (hero pill + 4 chips + badge row + Health card). The whole Host section is connection plumbing surfaced as game HUD — nothing a spectator needs. Mixes both visual systems in one file. Same ~250 duplicated hero lines.
- **Minimization recommendations:** Delete the Host section + badge row. Keep Follow target + Goal + a single connection dot; route steering to the floating chat. Drop "N active runs". Pick one visual system. De-duplicate the hero/strip.

## 5. plugin-defense-of-the-agents — `defense-of-the-agents` — `plugins/plugin-defense-of-the-agents/src/ui/DefenseAgentsOperatorSurface.tsx`

- **Purpose:** Spectator + tactical operator shell for a MOBA; agent auto-plays a lane heuristic. ViewDecl `index.ts:24-65`.
- **Real or stub?** **REAL.** Live telemetry (heroClass/heroLane/heroLevel/heroHp/autoPlay), `sendAppRunMessage`, optimistic event log, `GameOperatorShell`, tactical actions. Game = real proxied iframe (defenseoftheagents.com).
- **States:** no-run "empty" (`:543-576`), live (`:614`); status→live/attention/idle/respawning (`:343-354`); sending-command; rate-limit/unavailable cleaned (`cleanDefenseMessage` `:367-378`).
- **Chrome/HUD:** same copy-pasted `HeroHeader` (34vh) + 3 `StatusStripCard`s (Hero/Mode/Relay) + `GameOperatorShell` (title "Defense command" + statusLabel + objective + 2 detailItems + actions + feed + composer); empty state adds 🛡 waiting-zone.

  **Heaviest offending JSX** — the `HeroHeader` (`:74-150`, identical to clawville/hyperscape modulo accent `#ff5800` + emoji 🛡).
- **Heaviness / slop critique:** Same double-HUD as clawville (Hero line/Mode/status appear in both the strip AND the shell's detailItems). 34vh banner before tactical info. ~250 duplicated hero lines. Emoji HUD (🛡⚔▶⚡).
- **Minimization recommendations:** Delete bespoke `HeroHeader`/`StatusStripCard`/`HeroFrame`; let `GameOperatorShell` be the only chrome. Replace 34vh banner with a thin status bar. Extract the shared shell across the three clones. Brand icons + orange/blue over emoji.

### Part E cross-cutting (highest leverage)

1. **~250 lines of `HeroHeader`+`StatusStripCard`+`HeroFrame` copy-pasted byte-for-byte** across clawville/hyperscape/defense (only accent + emoji differ) — extract once / fold into `GameOperatorShell`.
2. **Double-HUD** (clawville & defense) — bespoke hero+strip on top of `GameOperatorShell` which already shows status/objective/detail.
3. **Triple status restatement** (scape/2004scape/hyperscape) — hero pill + 4-chip strip + `SurfaceBadge` row + often a Health card.
4. **34vh marketing hero banner** pushes operational HUD below the fold — a thin title + status-dot bar is enough.
5. **Card sprawl** surfaces connection/auth plumbing ("Viewer does not need app auth", "Waiting for the command bridge") as game HUD.
6. **Per-view Steering/suggested-prompt/Pause-Resume blocks** duplicate what the primary floating chat overlay should own.
7. **Emoji icon language + hardcoded `#ff5800`** (clawville/hyperscape/defense) conflict with brand orange `#ff8a24` / blue `#1d91e8`.
</content>
</invoke>
