# Issue #9144 — Default Launcher Dock

## What Was Verified

- Fresh `/views` launch seeds the dock with `chat` and `settings`.
- Docked apps are not duplicated on launcher page 1.
- Pointer-swipe paging advances to the next launcher page while the dock stays pinned.
- Clicking Chat from the dock navigates to `/chat` and leaves the chat composer visible.
- Desktop and mobile viewport screenshots plus Playwright videos were manually reviewed.

## Commands

```bash
bun run --cwd packages/ui test -- src/state/launcher-layout.test.ts src/state/launcher-layout.property.test.ts src/components/pages/Launcher.test.tsx src/components/pages/Launcher.gestures.test.tsx src/components/pages/LauncherSurface.test.tsx src/components/pages/launcher-curation.test.ts --coverage.enabled=false
bun run --cwd packages/ui typecheck
bunx biome check packages/ui/src/state/launcher-layout.ts packages/ui/src/state/launcher-layout.test.ts packages/ui/src/components/pages/launcher-curation.ts packages/ui/src/components/pages/launcher-curation.test.ts packages/ui/src/components/pages/Launcher.tsx packages/ui/src/components/pages/Launcher.test.tsx packages/ui/src/components/pages/LauncherSurface.test.tsx packages/app/test/ui-smoke/launcher-interaction.spec.ts
E2E_RECORD=1 ELIZA_UI_SMOKE_PORT=2183 ELIZA_UI_SMOKE_API_PORT=31383 ELIZA_API_PORT=31383 bunx playwright test --config packages/app/playwright.ui-smoke.config.ts packages/app/test/ui-smoke/launcher-interaction.spec.ts --project=chromium
ELIZA_UI_SMOKE_PORT=2187 ELIZA_UI_SMOKE_API_PORT=31387 ELIZA_API_PORT=31387 bunx playwright test --config packages/app/playwright.ui-smoke.config.ts packages/app/test/ui-smoke/all-views-aesthetic-audit.spec.ts --project=audit-app --grep "builtin-(apps|views|phone) mobile-(portrait|landscape)"
ELIZA_UI_SMOKE_PORT=2186 ELIZA_UI_SMOKE_API_PORT=31386 ELIZA_API_PORT=31386 bun run --cwd packages/app audit:app
```

## Results

- Focused UI tests: 73 passed.
- Focused launcher smoke: 2 passed, desktop + mobile, with Playwright video.
- Targeted audit for `apps` / `views` / `phone` mobile portrait+landscape: 6 passed, zero minimalism budget failures.
- Full app audit: 349 passed, zero minimalism budget failures.
- Manual review filled for `apps`, `views`, and `phone` launcher captures. Portrait/desktop/ipad are `good`; mobile landscape is `needs-eyeball` because the short viewport leaves limited room between the dock and continuous composer, while dock behavior and audit metrics pass.

## Artifacts

- `desktop-launcher-default-dock.png`
- `desktop-launcher-after-swipe.png`
- `desktop-dock-chat-launched.png`
- `desktop-launcher-walkthrough.webm`
- `desktop-launcher-walkthrough-contact.png`
- `desktop-launcher-trace.zip`
- `desktop-launcher-observations.json`
- `mobile-launcher-default-dock.png`
- `mobile-launcher-after-swipe.png`
- `mobile-dock-chat-launched.png`
- `mobile-launcher-walkthrough.webm`
- `mobile-launcher-walkthrough-contact.png`
- `mobile-launcher-trace.zip`
- `mobile-launcher-observations.json`

## N/A

- Real-LLM trajectories: N/A - launcher layout/navigation only; no model, prompt, action, or provider behavior changed.
