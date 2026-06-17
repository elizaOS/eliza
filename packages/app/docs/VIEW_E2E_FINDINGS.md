# View-e2e fan-out — real bugs surfaced (and their status)

The per-plugin view-e2e fan-out (audit → feature-asserting tests → adversarial
verify) was built to make view coverage real, not larp. Writing tests that
assert each view's actual features (populated data + every control + the exact
ids/shapes the server accepts) surfaced real product bugs. Each is pinned by a
committed tripwire test so it is change-detected. Status below.

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

## Open — deferred (out of single-plugin isolation scope; pinned by a tripwire)

- **app-model-tester — TUI capabilities not surfaced.** `ModelTesterTuiView`
  passes `commands={[]}` to the shared `@elizaos/ui` `TerminalPluginView`, so the
  5 registered TUI capabilities (get-status, run-text-small, run-transcription,
  run-vision, run-vad) never render — the terminal shows the shared component's
  fallback buttons instead. Fix touches the shared `TerminalPluginView` contract.
  Pinned by `app-model-tester/src/tui-capabilities.test.ts`.

- **plugin-clawville — building ids stale vs the live API.** `BUILDINGS` in
  `src/routes.ts` (`tool-workshop`, `skill-forge`, `memory-vault`,
  `security-fortress`, …) no longer match the live `api.clawville.world` ids
  (`memory-rag`, `agent-security`, …); live `POST /move|/visit-building` reject
  the plugin's ids with "Unknown building", so NL-routed move/visit commands fail
  against production. Needs the `BUILDINGS` const re-synced to the live API
  (verify against live ids before changing). Pinned by the clawville contract test.

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
