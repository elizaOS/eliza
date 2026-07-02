# Plugin View, Launcher, and QA Hardening Evidence

Date: 2026-07-01

Issues covered:

- #8798: every app/plugin view must be swept with real rendered coverage.
- #10717: launcher view-to-view swipes need momentum; desktop/web needs visible edge paging controls hidden on touch.
- #10710: default/system/release surfaces need audit-backed visual review.
- #10719: default launcher/plugin inventory must be e2e-visible and screenshot/video-ready.
- #9950: app visual/e2e gates must be hard enough to catch real regressions.
- #8917: generated plugin views must use the ViewKind contract.
- #8916: load-from-directory must refresh visible plugin views after reload.
- #10722: QA specs must not pass by synthetic fallback or swallowed interaction failures.

## Issue Plans And Result

#8798 plan: replace static-only confidence with real app/plugin route coverage, ensure plugin-view interaction smoke is not deny-listed, and run the full app audit. Result: plugin-view interaction coverage is in CI lanes, `plugin-views-interaction.spec.ts` now records failures instead of swallowing them, cockpit is included in plugin inventory coverage, and `bun run --cwd packages/app audit:app` completed 349/349 with `broken=0`.

#10717 plan: make swipe release velocity-aware, expose desktop-only pager controls for mouse/trackpad users, and prove they are hidden for touch/phone-width layouts. Result: `useHorizontalPager` now uses velocity-aware settle timing plus explicit `goPrev/goNext`; `Launcher` and `HomeLauncherSurface` render fine-pointer desktop-width edge buttons only; unit tests cover coarse pointer and phone-width/fine-pointer audit cases.

#10710 plan: run the required app visual audit after shared UI changes and manually inspect the touched launcher/view-manager screenshots. Result: full audit generated fresh artifacts under `packages/app/aesthetic-audit-output`; mobile screenshots show no pager arrows, desktop screenshots show the subtle edge controls, and no touched route is blank/broken.

#10719 plan: make default launcher/plugin inventory reflect the real manifest set and add missing owner coverage. Result: cockpit is in the manager-visible inventory and visual fixture; stale hidden manager entries are removed; `view-interaction-coverage.test.ts` owns cockpit through `plugins/plugin-task-coordinator/src/CockpitRoute.test.tsx`.

#9950 plan: move coverage gates into CI and remove known bypasses/deny-list debt. Result: scenario/test workflows include route coverage, UI-smoke coverage, view-interaction coverage, and plugin-view browser coverage; the plugin-view interaction spec was removed from `.pr-deny-list.json`.

#8917 plan: put the ViewKind contract where both humans and subagents actually read it. Result: app-control create prompt, orchestrator goal prompt, build-monetized-app skill, and min-plugin scaffold now name `release`, `preview`, `developer`, and reserve `system` for built-ins; focused tests enforce each surface.

#8916 plan: make load-from-directory broadcast one typed reload event after a successful server-side reload, then refresh the View Manager from that event. Result: the agent route emits `plugin_reloaded`; `@elizaos/ui/events` exports the event API; View Manager listens and refetches `/api/views`; tests cover server broadcast and UI refresh.

#10722 plan: remove synthetic interaction fallbacks and fail on unexecuted interactions. Result: onboarding mobile swipe now uses CDP touch events and throws when the context is not touch-capable; plugin view interactions collect and assert action/API failures instead of hiding `.fill()`/`.click()` failures.

## Verification

- `bun run --cwd packages/ui test -- useHorizontalPager.test.ts useHorizontalPager.test.tsx PagerEdgeButtons.test.tsx Launcher.gestures.test.tsx HomeLauncherSurface.test.tsx HomeLauncherSurface.composed.test.tsx` passed after rebasing onto `origin/develop`: 6 files, 41 tests.
- `bun run --cwd packages/agent test -- src/api/plugin-directory-routes.test.ts src/api/plugin-reloaded-event.test.ts` passed: 2 files, 5 tests.
- `bun run --cwd packages/agent lint` passed after import ordering fix.
- `bun run --cwd plugins/plugin-app-control test -- src/actions/views-create.viewkind.test.ts src/views/ViewManagerView.render.test.tsx` passed after rebasing onto `origin/develop`: 2 files, 11 tests.
- `bun run --cwd plugins/plugin-app-control lint` passed.
- `bun run --cwd plugins/plugin-agent-orchestrator test -- src/__tests__/goal-prompt.test.ts` passed: 1 file, 10 tests.
- `bun run --cwd packages/elizaos test -- src/__tests__/min-plugin-viewkind-contract.test.ts` passed: 1 file, 1 test.
- `bun run --cwd packages/app test -- test/route-coverage.test.ts test/ui-smoke-coverage.test.ts test/view-interaction-coverage.test.ts` passed: 3 files, 20 tests.
- `bun run --cwd packages/app audit:app` passed: 349/349, `broken=0`, `minimalism-budget-failures=0`.
- `bun run --cwd packages/app audit:app` passed again after the shared chat overlay cleanup: 349/349, `broken=0`, `minimalism-budget-failures=0`.
- `bun run --cwd packages/app audit:app` passed again after fixing the health plugin mobile-landscape overlap found during manual screenshot review: 349/349, `broken=0`, `minimalism-budget-failures=0`.
- Manual review notes were filled in the ignored audit output for all 348 generated view/viewport screenshots after inspecting the four viewport contact sheets (`mobile-portrait`, `mobile-landscape`, `desktop-landscape`, `ipad-portrait`); all manual-review verdicts are `good`.
- Direct health plugin screenshots were opened and reviewed in all audit viewports (`mobile-portrait`, `mobile-landscape`, `desktop-landscape`, `ipad-portrait`) after the responsive layout fix; no remaining overlap, clipping, or app-shell back-button collision was observed.
- `node packages/app/scripts/run-ui-playwright.mjs --config playwright.ui-smoke.config.ts --project=audit-app --grep "plugin-health-gui mobile-landscape"` passed after the health responsive fix.
- `bunx @biomejs/biome check --write plugins/plugin-health/src/components/health/HealthSpatialView.tsx` passed.
- `bun run --cwd plugins/plugin-health test -- HealthView.test.tsx HealthSpatialView.test.tsx` passed: 2 files, 16 tests.
- `bun run --cwd plugins/plugin-health typecheck` passed.
- `bun run --cwd plugins/plugin-health lint` passed.
- `bun run --cwd plugins/plugin-health build` passed.
- Targeted Biome checks for changed UI/agent files passed.
- `bun run audit:type-safety-ratchet` passed: `as unknown as` reduced to 73/77; non-null assertions reduced to 518/547; `?? ""` reduced to 611/620; `?? []` reduced to 573/588; `?? {}` reduced to 374/377; `?? 0` reduced to 379/380.
- `bun run --cwd packages/ui lint` passed.
- `bun run --cwd packages/ui test -- ContinuousChatOverlay.test.tsx` passed: 104 tests.
- `bun run --cwd packages/ui typecheck` passed.
- `bun run --cwd packages/agent typecheck` passed.
- `bun run --cwd packages/app-core typecheck` passed.
- `bun run --cwd packages/app-core/platforms/electrobun typecheck` passed.
- `bun run --cwd plugins/plugin-capacitor-bridge typecheck` passed.
- `bun run --cwd packages/cloud/services/gateway-discord typecheck` passed.
- `bun run --cwd packages/feed/packages/mcp typecheck` passed.
- `bun run --cwd packages/feed typecheck` passed.
- `bun run verify` passed end to end after the final health responsive fix, including 477 Turbo tasks, audit build/typecheck consistency, turbo dependency audit, tee secret-leak audit, script audit, and 28 dist-path consumer configs. `tsconfig.dist-paths.json` is current with 195 aliases.
- `git diff --check` passed.
