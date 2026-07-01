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
- Manual review notes were filled in the ignored audit output for the touched routes: `builtin-apps`, `builtin-views`, `plugin-views-manager-gui`, and `plugin-cockpit-gui` across mobile portrait, mobile landscape, desktop landscape, and iPad portrait.
- Targeted Biome checks for changed UI/agent files passed.
- `git diff --check` passed.

Known repo-wide verification limits:

- `bun run verify` currently stops at `audit:type-safety-ratchet` before typecheck/lint: `as unknown as` is 107 current vs 77 baseline and `?? 0` is 381 current vs 380 baseline. The production files changed here do not add those patterns.
- Running the direct turbo typecheck/lint lane after the ratchet stop reached `@elizaos/ui#lint`; the remaining failures are existing unrelated `ContinuousChatOverlay.test.tsx` formatting and `ContinuousChatOverlay.tsx` formatting/a11y issues. The touched UI files pass targeted Biome checks.
