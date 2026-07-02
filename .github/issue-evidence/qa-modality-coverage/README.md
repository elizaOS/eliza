# elizaOS App — automated UI/chat QA coverage (multi-modal, this Linux host)

A consolidated record of the automated QA now exercising the app UI + chat
across **web (real Chromium), a packaged Electrobun desktop app, an Android
emulator, and a physical Android device** — every-view render + per-view
interaction + full onboarding/journey e2e + property/fuzz + real scenario runs —
all run and verified on one Linux host.

**Coverage at a glance**

| modality | coverage | result |
| --- | --- | --- |
| Web — every view render (`audit:app`) | ~50 views × 4 viewports | **349 / 349**, 0 broken |
| Web — per-view interaction (#10719) | every control, all 33 views | **33 / 33** |
| Web — onboarding journeys | 6 first-run pathways (local/cloud/remote/…) | **all pass**, video |
| Web — isolated e2e fleet + fuzz | 16 runners + 6 fuzz suites | **17 / 19** + **136 / 136** fuzz |
| Desktop — Electrobun packaged (headless) | launch/render + bottom-bar | **2 / 2 core**, 1 env, 2 skip |
| Android — emulator + physical device | route-coverage + console-sweep | **47 / 47** each, 0 console |
| Scenario-runner — deterministic lane | 30 agent/UI scenarios | **29 / 30** |

Several real **test-infra bugs surfaced by this QA were fixed** (below); **zero
product UI/UX regressions** were found across any modality. Per-modality detail:
`web-journeys.md`, `desktop-electrobun.md`, `android-on-device.md`,
`scenario-runner.md`.

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

## 2. Web — per-view interaction + onboarding journeys

See `web-journeys.md`. `all-views-interaction.spec.ts` drives **every control on
all 33 views** ("exercise every control, no crash") → **33 / 33** (was 0/33
before the test-infra fixes in PR #10949). `onboarding-to-home.spec.ts` covers
**all six first-run pathways** (Local, Cloud connect+bind, Cloud-inference,
Other-provider→Settings, **Remote-connect**, Tutorial) — **all pass, video
recorded** — plus conversation-persistence and a full desktop+mobile
`full-walkthrough` (14-stage journey with per-stage capture).

## 3. Web — isolated real-Chromium e2e fleet (16 runners) + fuzz

An adversarial parallel sweep ran all 16 isolated `__e2e__` runners (each
self-bundles its fixture and drives **real pointer/keyboard input**, recording
screenshots + video) plus the property/fuzz suites, then re-verified every
failure to separate real bugs from flakes/env.

- **17 / 19 green** (2 unblocked by the fixes below) · **136 / 136 fuzz** (130
  existing + 6 new long-path adversarial walks) · **0 product regressions.**
- Passing surfaces (with artifacts): agent-surface, background (+webm),
  chat-ambient, chat-sheet-frame-glitch (+`transition.gif`), chatux-gesture
  (+webm), conversation-swipe (+`conversation-swipe-interleaving.webm`),
  ftu-home (+2 webm), home-screen (+`mobile-launcher-flow.webm`), launcher
  (+`launcher-walkthrough.webm`), orchestrator-accounts, tutorial (+webm),
  view-lifecycle (keep-alive/LRU/RAF-pause/render-storm/crash-recovery/memory
  slope, +webm+telemetry).
- Fuzz (136/136): chat-overlay detent state-machine + **6 new seeds × 150-step
  adversarial walks** (900 interactions, adversarial input corpus), shell
  controller lifecycle, parsers, genui validator, screen-background.

### Real test-infra bugs found + fixed
1. **`run-chat-sheet-e2e.mjs` stale header assertion** — required a
   `chat-full-copy-conversation` button PR #10713 removed → permanently red →
   fixed **PR #10824**.
2. **`bottombar` + `fused-wake` e2e import-crash** — `@tailwindcss/postcss` +
   `postcss` undeclared in `packages/ui` → fixed **PR #10833**.
3. **Per-view interaction 0/33** — 3 zero-key stub 501 pollers (avatar/vrm,
   lifeops/scheduled-tasks, /api/files) + a `type="color"` fill crash → fixed
   **PR #10949** → 33/33.

### Environment-blocked (not code)
`perf-gate-e2e` frame-budget assertions fail on this **software-GL, oversubscribed**
host — proven **identical on `origin/develop`**, so no branch regression.

## 4. Desktop — Electrobun packaged (headless on Linux)

See `desktop-electrobun.md`. The desktop shell was **built as a packaged app**
(`desktop-build.mjs build` → `build/dev-linux-x64/Eliza-dev/bin/launcher`) and
driven headless via WebKitGTK: **launch+render ✅** and **bottom-bar/tray window
✅** (the #10716 surface). The relaunch-persistence spec + 2 others are
env/creds-gated in the headless packaged run — no renderer regression.

## 5. Android — emulator + physical device (real WebView, CDP-over-adb)

See `android-on-device.md`. Route-coverage **47/47** render-safe on both the
`emulator-5554` AND the physical device `27051JEGR10034`; console-sweep **47
views, 0 console errors** on-device.

## 6. Scenario-runner

See `scenario-runner.md`. **29 / 30** deterministic scenarios pass through the
real AgentRuntime (view-switching, app-control, browser/computeruse, github, mcp,
lifeops, coding-tools, streaming, todos, workflow, xr, ocr, …). The 1 failure is a
stale-tree golden-text drift, not a regression.

## Session PRs (9)
Merged (5): #10711/#10740, #10717/#10750, #10712/#10760, #10722/#10766,
#10710/#10795. Open — all adversarial-QA test-infra fixes (4): #10824
(chat-sheet stale assertion), #10833 (ui e2e tailwind/postcss deps), #10844
(long-path fuzz + this evidence), #10949 (per-view interaction 33/33).
