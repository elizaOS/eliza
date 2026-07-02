# Issue #11353 - WKWebView Gesture Driver

Captured on 2026-07-02 from `/home/shaw/eliza-worktrees/11353-wkwebview-gesture-driver`
after rebasing `test/11353-wkwebview-gesture-driver` onto `origin/develop`.

## What changed

- Added `GestureSemanticsUITests.swift` to the iOS `AppUITests` target.
- The suite drives real XCUITest gestures against WKWebView for chat-sheet
  detents, home/launcher swipe thresholds, message edit touch affordance, and
  iOS text-selection callout suppression.
- Added sr-only accessibility probes for native test observability:
  `chat-detent:<pill|collapsed|half|full>` and
  `home-launcher-page:<home|launcher>`.
- Updated `ios-device-capture.mjs` so the default lane runs the whole
  `AppUITests` target rather than boot-only coverage.

## Validation run here

- PASS: `bun install`
- PASS: `bun run --cwd packages/shared build:i18n`
- PASS: `bun run --cwd packages/ui test:home-screen-e2e`
- PASS: `bun run --cwd packages/ui test:chat-sheet-e2e`
- PASS: `git diff --check origin/develop...HEAD`

Manual review notes:

- `test:chat-sheet-e2e` initially failed after the first probe insertion because
  the sr-only `chat-detent` span became the panel's first child, while the
  existing fixture intentionally reads `panel.firstElementChild` as the visual
  glass surface. I moved the probe after the glass layer and reran the full
  chat-sheet e2e successfully.
- `test:home-screen-e2e` passed after generating the required shared i18n data.
- `packages/ui typecheck` was attempted after install, but it still fails on
  existing generated-contract/type issues unrelated to this branch
  (`@elizaos/contracts`, missing generated keyword data before generation, and
  `AccountWithCredentialFlag` shape errors).

## Hardware-gated evidence not captured here

- N/A here: real iOS simulator/device XCUITest run. This host is Linux and
  `xcodebuild` is unavailable, so it cannot build or run the new WKWebView
  gesture suite.
- Required macOS command for final closure:

```bash
bun run --cwd packages/app capture:ios-sim:boot -- --only-testing AppUITests/GestureSemanticsUITests
```

Attach the resulting `.xcresult`, exported screenshots/accessibility snapshots,
runner log, and a short walkthrough video before closing #11353.
