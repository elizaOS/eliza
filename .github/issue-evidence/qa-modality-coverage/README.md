# elizaOS App — automated UI/chat QA coverage (multi-modal, this Linux host)

A consolidated record of the automated QA now exercising the app UI + chat
across **web (real Chromium), Android emulator, and a physical Android device**,
plus property/fuzz and every-view aesthetic gating — run and verified on one
Linux host. Two real test-infra bugs surfaced by the sweep were fixed (below).

## 1. Web — every default view, real Chromium (`audit:app`)

`bun run --cwd packages/app audit:app` boots a live stack (API stub + built app)
and walks **~50 views × 4 viewports = 349 tests** in real headless Chromium,
screenshotting each + scoring blank/broken/console-error/blue/hover/radius.

- Result: **349 passed, 0 broken, 0 needs-work** (after the audit-gate fix below).
- Before the fix: **236 / 348 view-combos were falsely `needs-work`** — every one
  from a single mis-classified colour (the overlay's near-black scrim
  `rgba(10,10,12,0.5)` read as "blue"). Fixed in **#10710 → merged #10795** with
  an absolute-chroma floor; re-ran the full audit before/after to prove
  `needs-work 236 → 0`, `flagged-blue 236 → 0`.

## 2. Web — isolated real-Chromium e2e fleet (16 runners) + fuzz

An adversarial parallel sweep ran all 16 isolated `__e2e__` runners (each
self-bundles its fixture and drives **real pointer/keyboard input**, recording
screenshots + video) plus the property/fuzz suites, then re-verified every
failure to separate real bugs from flakes/env.

- **15 / 19 green · 130 / 130 fuzz · 0 product UI/UX regressions.**
- Passing surfaces (with artifacts): agent-surface, background (+webm),
  chat-ambient, chat-sheet-frame-glitch (+`transition.gif`), chatux-gesture
  (+webm), conversation-swipe (+`conversation-swipe-interleaving.webm`),
  ftu-home (+2 webm), home-screen (+`mobile-launcher-flow.webm`), launcher
  (+`launcher-walkthrough.webm`), orchestrator-accounts, tutorial (+webm),
  view-lifecycle (keep-alive/LRU/RAF-pause/render-storm/crash-recovery/memory
  slope, +webm+telemetry).
- Fuzz suites (130/130): chat-overlay detent state-machine (invariants after
  every step), shell-controller send/voice/new-chat lifecycle, message parsers,
  genui validator, screen-background.

### Real bugs found + fixed by the sweep
1. **`run-chat-sheet-e2e.mjs` stale header assertion** — required a
   `chat-full-copy-conversation` button that PR #10713 (#10749) removed, so the
   chat-sheet gesture/parity lane was permanently red. Fixed (drop the clause) →
   **PR #10824**; verified `CHAT-SHEET E2E PASSED`.
2. **`bottombar` + `fused-wake` e2e import-crash** — `@tailwindcss/postcss` +
   `postcss` were undeclared deps of `packages/ui`, so both runners crashed at
   import before any test. Declared them → **PR #10833**; `bottombar` now PASSES,
   `fused-wake` imports and skips gracefully.

### Environment-blocked (not code)
`perf-gate-e2e` frame-budget assertions fail on this **software-GL, oversubscribed
(load ~42 on 24 cores)** host — proven **identical on `origin/develop`** (develop
marginally worse: CLS 5.04 vs 4.41), so no branch regression. Needs a real GPU
compositor host. See `android-on-device.md` for the host-backend Android specs.

## 3. Android — emulator + physical device (real WebView, CDP-over-adb)

See `android-on-device.md`. Route-coverage **47/47** render-safe on both the
`emulator-5554` AND the physical device `27051JEGR10034`; console-sweep **47
views, 0 console errors** on-device.

## 4. Scenario-runner

Built + functional (CLI → scenario discovery → deterministic proxy mode). Runs in
the main tree; blocked in a fresh worktree only by the documented cross-plugin
subpath cascade (`plugin-*/subpath` not built) — infra, not a scenario defect.

## Session PRs (7)
Merged: #10711/#10740, #10717/#10750, #10712/#10760, #10722/#10766, #10710/#10795.
Open (adversarial-QA bug fixes): #10824 (chat-sheet stale assertion),
#10833 (ui e2e tailwind/postcss deps).
