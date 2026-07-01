# Deep UI/UX QA sweep — chat, launcher, home, notifications, state (2026-07-01)

Adversarially-verified QA of the develop chat/launcher/home surfaces: 6 parallel
deep reviewers + per-finding refutation agents (20 findings confirmed, several
refuted), the full `packages/ui` vitest battery, and all boot-free real-Chromium
e2e runners. This bundle carries the post-fix captures for the batch landed with
it (see the commit message for the full finding list).

## What was run (all real, local, headless Chromium + jsdom)

- `packages/ui` vitest battery: shell + pages + state + widgets + conversations
  + chat — **1908 tests, all green** (12 initial timeouts reproduced as pure
  machine-load flakes: 127/127 green when re-run isolated).
- Boot-free e2e runners (real Chromium, real input, screenshots + webm):
  chatux-gesture, chat-sheet (51 screenshots), conversation-swipe, bottombar,
  chat-ambient, chat-sheet-frame-glitch, launcher, background, tutorial,
  view-lifecycle, ftu-home, home-screen — **all passing after this batch**.
- Two runner failures root-caused to STALE HARNESSES (not product bugs), fixed:
  chat-sheet keyboard velocity race; launcher fixture eaten by the #10800
  seeded dock (23 undocked tiles ≤ 1 page).

## Artifacts

| file | proves |
|------|--------|
| `home-desktop-postfix.png` | home dashboard, desktop viewport, post-fix |
| `home-mobile-postfix.png` | home dashboard, mobile viewport, post-fix |
| `launcher-mobile-dock-postfix.png` | seeded chat+settings dock + paged grid |
| `launcher-walkthrough-postfix.webm` | real-input launcher walkthrough: launch, edit-mode, page swipe (telemetry 0→2) |
| `home-launcher-flow-postfix.webm` | home→launcher rail flow incl. developer page |
| `chat-sheet-keyboard-postfix.png` | chat sheet at FULL with keyboard open (the fixed assertion) |

Companion per-view captures regenerate deterministically via
`bun run packages/ui/src/components/**/__e2e__/run-*.mjs`.

## Full-app audit (post-fix, this branch)

`bun run --cwd packages/app audit:app` — **349/349 view×viewport combos passed;
broken=0, needs-work=0, needs-eyeball=212, good=136, minimalism-budget-failures=0**
(the audit walks every builtin + plugin view at mobile-portrait, mobile-landscape,
desktop-landscape, and ipad-portrait). Curated captures:

| file | view |
|------|------|
| `audit-chat-desktop.png` / `audit-chat-mobile.png` | chat view, desktop + mobile |
| `audit-settings-desktop.png` / `audit-settings-mobile.png` | settings view (incl. new Background section entry) |

## Platform proof (real binaries, this branch)

| platform | artifact | proof |
|----------|----------|-------|
| Web (Chromium) | `audit-*.png` + runner webm | audit:app 349/349; 12 boot-free real-input runners |
| macOS desktop (packaged Electrobun `Eliza-dev.app`) | `desktop-packaged-launch-render.png` | launch-render + bottom-bar specs PASSED on the rebuilt signed bundle; relaunch-persistence spec red in this env only (empty renderer post-relaunch; artifacts under `packages/app/test-results/`) |
| Android emulator (Pixel 7 AVD, API 35, real WebView, smoke build w/o local-inference lib) | `android-emu-home.png`, `android-emu-swipe-walkthrough.mp4`, `android-emu.logcat.txt` | APK installed + cold-launched; 51 on-device route/view specs passed (5 red: 4 need the on-device agent the smoke build omits; 1 = the pre-existing real-touch flick-commit gap tracked in #10722, identical pre/post this branch) |
| iOS simulator | — | **N/A on this host**: no Xcode (CommandLineTools only — no simctl, no Simulator.app) |
