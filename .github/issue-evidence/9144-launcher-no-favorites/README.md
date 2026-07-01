# #9144 Launcher No Default Favorites Row Evidence

## What Changed

The app launcher no longer seeds or renders a default favorites/dock row. Chat
and Settings are curated into the same normal launcher grid as Wallet,
Automations, and the rest of the apps.

## Manual Review

Reviewed after rebasing onto `origin/develop` and rerunning
`bun run --cwd packages/app audit:app` on July 1, 2026:

- `audit-mobile-portrait-apps.png`: Chat, Settings, Wallet, and Automations are
  normal first-row tiles; no favorites strip appears above the grid.
- `audit-mobile-landscape-apps.png`: same app-grid behavior in landscape.
- `audit-desktop-landscape-apps.png`: same app-grid behavior on desktop.
- `audit-ipad-portrait-apps.png`: same app-grid behavior on iPad portrait.
- `audit-mobile-portrait-views.png`: `/views` resolves to the same no-dock
  launcher surface.
- `home-mobile-launcher.png` and `home-desktop-launcher.png`: shell launcher
  fixture shows no default dock and keeps curated app tiles in the normal grid.

## Recordings And Traces

- `app-smoke-chat-settings-grid.webm` + `app-smoke-chat-settings-grid-trace.zip`:
  app Playwright recording for Chat/Settings as normal grid tiles and Chat
  launch.
- `app-smoke-no-default-dock.webm` + `app-smoke-no-default-dock-trace.zip`: app
  Playwright recording proving the curated launcher remains read-only and has no
  default dock.
- `app-smoke-tile-navigates.webm`: app Playwright recording proving a normal
  launcher tile navigates to its view.
- `app-smoke-paging-dots.webm`: app Playwright recording for page navigation.
- `ui-launcher-walkthrough.webm`: isolated launcher browser walkthrough,
  including desktop/mobile rest states, edit mode, page click, swipe, and tile
  launch.
- `home-mobile-launcher-flow.webm`: shell home-to-launcher mobile walkthrough.

## Verification Commands

- `bun install --frozen-lockfile`
  - Result: completed; postinstall synced the dev artifact bundle.
- `cd packages/ui && NODE_OPTIONS="${NODE_OPTIONS:-} --no-experimental-webstorage --disable-warning=ExperimentalWarning" ../../node_modules/.bin/vitest run --config ./vitest.config.ts --testTimeout=20000 --maxWorkers=1 src/state/launcher-layout.test.ts src/state/launcher-layout.property.test.ts src/components/pages/Launcher.test.tsx src/components/pages/Launcher.gestures.test.tsx src/components/pages/LauncherSurface.test.tsx src/components/pages/launcher-curation.test.ts`
  - Result: 6 files passed, 74 tests passed.
- `bun run --cwd packages/ui test:launcher-e2e`
  - Result: passed; assertions include no default favorites dock, Chat and
    Settings as normal tiles, desktop/mobile screenshots, edit-mode gestures,
    page navigation, swipe telemetry, and tile launch.
- `bun run --cwd packages/ui test:home-screen-e2e`
  - Result: passed; assertions include no default favorites dock, Chat/Settings
    on launcher page 0, hidden/removed IDs absent, read-only curated launcher,
    swipe-back home, and developer page navigation.
- `ELIZA_UI_SMOKE_PORT=2238 ELIZA_UI_SMOKE_API_PORT=32337 ELIZA_API_PORT=32337 bun run --cwd packages/app test:e2e:record -- test/ui-smoke/launcher-interaction.spec.ts`
  - Result: 4 tests passed; recordings/traces copied into this folder.
- `ELIZA_UI_SMOKE_PORT=2238 ELIZA_UI_SMOKE_API_PORT=32337 ELIZA_API_PORT=32337 bun run --cwd packages/app audit:app`
  - Result: 349 tests passed; `minimalism-budget-failures=0`.
- `bun run --cwd packages/ui typecheck`
  - Result: passed.
- `bun run --cwd packages/app lint`
  - Result: passed.
- `bun run --cwd packages/ui lint`
  - Result: passed.
- `cd packages/ui && NODE_OPTIONS="${NODE_OPTIONS:-} --no-experimental-webstorage --disable-warning=ExperimentalWarning" ../../node_modules/.bin/vitest run --config ./vitest.config.ts --testTimeout=20000 --maxWorkers=1 src/components/shell/ContinuousChatOverlay.test.tsx`
  - Result: 1 file passed, 103 tests passed.
- `bun run verify`
  - Result: failed before package lint/typecheck on the existing repo-wide
    type-safety ratchet: `as unknown as` 107/77 and `?? 0` 381/380.

## Evidence N/A

- Real-LLM trajectory: N/A. This change is launcher layout/curation only and
  does not change agent prompts, providers, model calls, or actions.
- Backend/domain artifacts: N/A. No database, memory, scheduler, wallet, chain,
  or file-domain writes are introduced by this layout change.
- Audio/native device capture: N/A. The affected surface is the web/app
  launcher grid; no voice, TTS/STT, or native bridge behavior changed.
