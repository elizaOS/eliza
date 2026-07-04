# 12377 — Mobile-native launcher gesture loops (Android + iOS)

WI-8 of #12179. Two mobile-native launcher gesture-loop lanes plus a shared,
seeded, cross-platform-reproducible loop model.

## What ships

- **Android lane** — `packages/app/test/android/launcher-gesture-loop.android.spec.ts`.
  A ≥200-action seeded loop driven by real `adb shell input swipe`/`tap` on the
  on-device WebView (Playwright `_android`), asserting rail invariants after
  every action: `data-page`, the sr-only AX probe, exactly-one-page-half `inert`,
  and focus never inside `[inert]`. Rotates `adb screenrecord` segments under the
  180s cap; attaches every segment + logcat + WebView console + a summary JSON.
- **iOS lane** — `packages/app-core/platforms/ios/App/AppUITests/LauncherGestureLoopUITests.swift`.
  The same seeded stream as ≥200 real XCUITest gestures, asserting the
  `home-launcher-page:<home|launcher>` AX probe between actions (no stuck
  transition). Recorded via `xcrun simctl io recordVideo` (wired into
  `scripts/ios-device-capture.mjs`).
- **Shared model** — `packages/app/test/android/launcher-loop-model.ts`
  (SeededRandom LCG + weighted action alphabet + pure page-transition model).
  Dependency-free so the Swift lane mirrors the same LCG; `ELIZA_LOOP_SEED`
  reproduces the exact stream on both platforms.

## Evidence in this directory

| File | What it proves |
|------|----------------|
| `launcher-loop-model-unit.txt` | 16/16 unit tests green (`packages/app/test/android/launcher-loop-model.test.ts`) — seed determinism, transition correctness, seed reproduction, `ELIZA_LOOP_SEED` handling. |
| `seed-parity-ts.txt` / `seed-parity-swift.txt` | The first 20 action kinds for `ELIZA_LOOP_SEED=12345` from the TypeScript (Android) and Swift (iOS) LCG. **Byte-for-byte identical** — the cross-platform reproduction contract is real, not asserted-only. |

Reproduce the parity check:

```bash
node <ts LCG> ; swift <swift LCG>   # both print the same 20 lines for seed 12345
```

## Device-run artifacts — status

The loop specs are real (real device input, real invariants, real recording),
but a green run needs a booted Android emulator / iOS simulator with the app
installed. On this authoring host those device runs were **not** executed to
completion; the following rows are therefore N/A here and produced by CI /
a device run:

- `android-launcher-loop-*.mp4` (rotated screenrecord segments) — **N/A (needs a
  booted emulator + installed APK)**; produced by
  `bun run --cwd packages/app test:e2e:android:launcher-loop` and by the
  `android-device-e2e` workflow (`workflow_dispatch`).
- `logcat.txt`, `webview-console.log`, `android-launcher-loop-summary.json` —
  **N/A (same run)**; written by the Android spec.
- `ios-sim-recording.mp4` + XCUITest screenshot attachments — **N/A (needs a
  booted simulator + `build:ios:local:sim`)**; produced by
  `bun run --cwd packages/app capture:ios-sim:boot --only-testing AppUITests/LauncherGestureLoopUITests`.

What IS proven headlessly here: the loop model (determinism + correctness, 16
tests), the cross-platform seed parity, Swift `-parse` of the XCUITest file, and
`plutil -lint` of the edited `project.pbxproj`.
