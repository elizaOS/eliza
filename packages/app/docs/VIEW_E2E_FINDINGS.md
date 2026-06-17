# View-e2e fan-out — real bugs surfaced (and their status)

The per-plugin view-e2e fan-out (audit → feature-asserting tests → adversarial
verify) was built to make view coverage real, not larp. Writing tests that
assert each view's actual features (populated data + every control + the exact
ids/shapes the server accepts) surfaced real product bugs. Each is pinned by a
committed tripwire test so it is change-detected. Status below.

## View-type coverage (gui / tui / xr)

- **gui**: per-plugin component tests (this fan-out) render the real component
  with realistic data and assert populated data + every control + TUI dispatch;
  plus screenshot/interaction owners in `packages/app/test/ui-smoke`.
- **tui**: per-plugin `interact()` capability tests + the central terminal-parity
  gate (`packages/agent/src/__tests__/plugin-tui-view-coverage.test.ts`).
- **xr**: covered by the same central test — its
  `"can route-switch every bundled plugin view in gui, tui, and xr mode"` and
  `"can dispatch standard interactions ... in gui, tui, and xr mode"` cases
  register and exercise every declared xr view (23 plugins) through the real
  navigate route + interaction dispatch. XR views reuse the gui `componentExport`
  (e.g. `PolymarketAppView`), which the gui render tests already exercise, so the
  component IS tested; a headless *visual* XR screenshot is not meaningful (no
  WebXR/headset in jsdom/Playwright). Net: xr is covered for everything testable.

## Fixed

- **plugin-vincent — TUI read wrong wallet fields.** `VincentTuiView` read
  `walletAddresses.evm` / `.solana`, but the canonical `WalletAddresses` type
  (`@elizaos/shared`) and the GUI `WalletStatusCard` use `.evmAddress` /
  `.solanaAddress`, so the TUI always rendered null addresses. Fixed + locked by
  the new view tests. (commit: "fix(vincent): TUI view read canonical wallet
  address fields + tests".)

- **plugin-companion — EmotePicker grid diverged from the catalog.** The picker
  shipped a hardcoded 29-item grid where 17 ids were absent from `EMOTE_CATALOG`
  (clicking them → 400 "Unknown emote" at `POST /api/emote`) and 28 real catalog
  emotes were missing. Now derived from `EMOTE_CATALOG` via `emote-picker-grid.ts`;
  alignment locked by `emote-picker-grid.test.ts`. (commit: "fix(companion):
  derive EmotePicker grid from the emote catalog".)

- **app-model-tester — TUI capabilities not surfaced.** `ModelTesterTuiView`
  passed `commands={[]}` to `TerminalPluginView`, so its 5 registered capabilities
  never rendered. Fixed: export `MODEL_TESTER_TUI_CAPABILITIES` and wire
  `commands={[...MODEL_TESTER_TUI_CAPABILITIES]}`; `tui-capabilities.test.ts`
  asserts list==plugin.ts==interact() and guards the empty-list regression.
  (commit: "fix(app-model-tester): surface TUI capabilities".)

- **plugin-clawville — building ids stale vs the live API.** Fixed without
  guessing the full registry: `resolveBuildingIdFromText` is now perception-aware
  — it resolves move/visit targets to the REAL live ids (matching live
  `nearbyBuildings` + remapping a matched hardcoded building via shared
  label/alias tokens), falling back to the hardcoded id only when no live match.
  Tests assert the remap against recorded ground truth (squidward→memory-rag,
  patrick→agent-security). (commit: "fix(clawville): resolve building targets to
  REAL live ids via perception".)

## Open — deferred (needs a product decision / cross-package shared type)

- **plugin-feed — FeedAgentSummary type vs route envelope mismatch.** The
  canonical `FeedAgentSummary` type (`packages/ui/src/api/client-types-feed.ts`)
  is `{id,name,summary,recentActivity[]}`, but the `/agent/summary` proxy route
  (`plugins/plugin-feed/src/routes.ts`) and `FeedOperatorSurface.extractAgentSummary`
  consume a different envelope `{agent,portfolio,positions}`.
  `client.getFeedAgentSummary()` is typed `Promise<FeedAgentSummary>` yet the
  surface reads none of those fields. Reconciling requires a product decision on
  which envelope is canonical (shared type in `packages/ui`) — ASK the owner.
  Pinned by `plugin-feed/.../feed-data.contract.test.ts`.

## Pre-existing (not caused by this work; noted for the owner)

- **plugin-task-coordinator — NotesPanel.test.tsx: 18 failures** under bun+jsdom
  (`window.localStorage.clear is not a function`) on the untouched baseline. A
  jsdom localStorage shim in the shared test env would fix it.
- **plugin-clawville — biome formatting error** in `ClawvilleOperatorSurface.tsx`
  (~line 575, onClick arrow wrap), present before this work.
- **test:e2e:manual relative-config quirk** — some plugins' `test:e2e:manual`
  script's `../../vitest.config.ts` misresolves under bunx vitest v4; worked
  around by a package-local `vitest.config.ts` for the new `test` script.
