# 10709 onboarding chat evidence

Final validation for moving first-run onboarding into chat and covering
cloud/local/remote adoption paths.

Latest validation was rerun after rebasing onto `origin/develop` at
`e8b6637f51`.

## Passing runs

- Browser desktop/mobile smoke:
  `ELIZA_UI_SMOKE_PORT=2170 ELIZA_UI_SMOKE_API_PORT=31370 ELIZA_API_PORT=31370 bunx playwright test --config packages/app/playwright.ui-smoke.config.ts packages/app/test/ui-smoke/onboarding-to-home.spec.ts packages/app/test/ui-smoke/onboarding-to-home-mobile.spec.ts --project=chromium`
  - Result: 10 passed after rebasing and preserving nested in-chat choice
    clicks inside the message bubble action-row behavior.
- Focused evidence recapture:
  `ELIZA_UI_SMOKE_PORT=2161 ELIZA_UI_SMOKE_API_PORT=31361 ELIZA_API_PORT=31361 bunx playwright test --config packages/app/playwright.ui-smoke.config.ts packages/app/test/ui-smoke/onboarding-to-home.spec.ts --project=chromium -g "Local onboarding lands"`
  - Result: 1 passed; refreshed desktop chat-first/home/launcher screenshots.
  `ELIZA_UI_SMOKE_PORT=2162 ELIZA_UI_SMOKE_API_PORT=31362 ELIZA_API_PORT=31362 bunx playwright test --config packages/app/playwright.ui-smoke.config.ts packages/app/test/ui-smoke/onboarding-to-home-mobile.spec.ts --project=chromium -g "first-run.*touch"`
  - Result: 3 passed; refreshed mobile home/cloud screenshots.
- Supporting first-run smoke:
  `ELIZA_UI_SMOKE_PORT=2159 ELIZA_UI_SMOKE_API_PORT=31359 ELIZA_API_PORT=31359 bunx playwright test --config packages/app/playwright.ui-smoke.config.ts packages/app/test/ui-smoke/first-run-startup.spec.ts packages/app/test/ui-smoke/runtime-configurability.spec.ts packages/app/test/ui-smoke/model-download-deferral.spec.ts packages/app/test/ui-smoke/computer-use.spec.ts packages/app/test/ui-smoke/reset-returns-to-onboarding.spec.ts --project=chromium`
  - Result: 8 passed; reset path initially exposed the already-mounted chat overlay not reopening for first-run.
  `ELIZA_UI_SMOKE_PORT=2160 ELIZA_UI_SMOKE_API_PORT=31360 ELIZA_API_PORT=31360 bunx playwright test --config packages/app/playwright.ui-smoke.config.ts packages/app/test/ui-smoke/reset-returns-to-onboarding.spec.ts --project=chromium`
  - Result: 2 passed after opening `ContinuousChatOverlay` whenever `firstRunOpen` becomes true.
- Android build:
  `ELIZA_ANDROID_SKIP_FORK_LLAMA_LIB=1 bun run --cwd packages/app build:android`
  - Result: passed; produced `packages/app-core/platforms/android/app/build/outputs/apk/debug/app-debug.apk`.
- Android WebView deep-link smoke:
  `ANDROID_SERIAL=emulator-5554 ELIZA_ANDROID_BACKEND=host ELIZA_ANDROID_REQUIRE_AGENT=1 ELIZA_ANDROID_ALLOW_FIRST_RUN=1 ELIZA_ANDROID_CLEAR_APP_DATA=1 ELIZA_ANDROID_APK=packages/app-core/platforms/android/app/build/outputs/apk/debug/app-debug.apk bunx playwright test --config packages/app/playwright.android.config.ts packages/app/test/android/onboarding-to-home.android.spec.ts`
  - Result: 1 passed.
- Android Chrome browser smoke:
  `ANDROID_SERIAL=emulator-5554 ELIZA_UI_SMOKE_PORT=2168 ELIZA_UI_SMOKE_API_PORT=31368 ELIZA_API_PORT=31368 bunx playwright test --config packages/app/playwright.android-browser.config.ts packages/app/test/android-browser/onboarding-to-home.android-browser.spec.ts`
  - Result: 1 passed. The harness runs Chrome on the emulator through
    Playwright Android, uses `adb reverse` to serve the web app at the browser's
    `127.0.0.1`, verifies the in-chat first-run transcript choices, completes
    Local → on-device → skip tutorial, and asserts the deleted chooser is absent.
- Packaged Linux desktop build:
  `bun run --cwd packages/app-core/platforms/electrobun build`
  - Result: passed on the rebuilt `@elizaos/ui` package.
- Packaged Linux desktop launch/render smoke:
  `bunx playwright test --config packages/app/playwright.electrobun.packaged.config.ts packages/app/test/electrobun-packaged/desktop-launch-render.e2e.spec.ts`
  - Result: 1 passed.
- Focused first-run unit tests:
  `./node_modules/.bin/vitest run packages/ui/src/first-run/first-run.test.ts packages/ui/src/first-run/adopt-remote-first-run.test.ts packages/ui/src/state/use-startup-shell-controller.confirm.test.ts packages/app/test/wallet-optimized-chunk-matcher.test.ts`
  - Result: 4 files / 39 tests passed after removing the standalone chooser component.
- Targeted Biome:
  `./node_modules/.bin/biome check <edited onboarding/app/ui files>`
  - Result: passed.

## Artifacts

- `android-home-landing.png`
- `android-onboarding-to-home.mp4`
- `android-browser-onboarding-chat-first.png`
- `android-browser-home.png`
- `android-browser-onboarding-to-home.mp4`
- `web-onboarding-chat-first.png`
- `web-home.png`
- `web-launcher.png`
- `web-remote-home.png`
- `mobile-home.png`
- `mobile-cloud-home.png`
- `desktop-launch-render.png`

## Known gaps

- A post-rebase browser smoke exposed a stale `dist/assets/useWalletModal*.js`
  file from an older build. `verify-chunk-safety.mjs` now scans only current
  reachable chunks from `dist/index.html`, and the browser desktop/mobile smoke
  passes again.
- Plain `bun run --cwd packages/app build:android` still requires the local
  fused inference native library. The smoke APK was built with
  `ELIZA_ANDROID_SKIP_FORK_LLAMA_LIB=1`, which is the same cloud/smoke mode
  used when local inference is unavailable.
- A full `bun run --cwd packages/app audit:app` run had two transient failures
  (`builtin-camera`, `builtin-tasks` desktop landscape); both passed when rerun
  by grep.
