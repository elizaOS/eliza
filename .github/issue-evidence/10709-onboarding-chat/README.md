# 10709 onboarding chat evidence

Final validation for moving first-run onboarding into chat and covering
cloud/local/remote adoption paths.

## Passing runs

- Browser desktop/mobile smoke:
  `ELIZA_UI_SMOKE_PORT=2152 ELIZA_UI_SMOKE_API_PORT=31352 ELIZA_API_PORT=31352 bunx playwright test --config packages/app/playwright.ui-smoke.config.ts packages/app/test/ui-smoke/onboarding-to-home.spec.ts packages/app/test/ui-smoke/onboarding-to-home-mobile.spec.ts --project=chromium`
  - Result: 10 passed.
- Android WebView deep-link smoke:
  `ANDROID_SERIAL=emulator-5554 ELIZA_ANDROID_BACKEND=host ELIZA_ANDROID_REQUIRE_AGENT=1 ELIZA_ANDROID_ALLOW_FIRST_RUN=1 ELIZA_ANDROID_CLEAR_APP_DATA=1 ELIZA_ANDROID_APK=packages/app-core/platforms/android/app/build/outputs/apk/debug/app-debug.apk bunx playwright test --config packages/app/playwright.android.config.ts packages/app/test/android/onboarding-to-home.android.spec.ts`
  - Result: 1 passed.
- Packaged Linux desktop build:
  `bun run --cwd packages/app-core/platforms/electrobun build`
  - Result: passed after adding the Discord subpath runtime shim and Linux
    screenshot fallback.
- Packaged Linux desktop launch/render smoke:
  `bunx playwright test --config packages/app/playwright.electrobun.packaged.config.ts packages/app/test/electrobun-packaged/desktop-launch-render.e2e.spec.ts`
  - Result: 1 passed.
- Focused first-run unit tests:
  `./node_modules/.bin/vitest run packages/ui/src/first-run/FirstRunRuntimeChooser.test.tsx packages/ui/src/first-run/first-run.test.ts packages/ui/src/first-run/adopt-remote-first-run.test.ts packages/ui/src/state/use-startup-shell-controller.confirm.test.ts`
  - Result: 4 files, 40 tests passed.
- UI typecheck:
  `bun run --cwd packages/ui typecheck`
  - Result: passed.
- Targeted Biome:
  `./node_modules/.bin/biome check packages/app/src/main.tsx packages/app/test/android/android-harness.ts packages/app/test/android/onboarding-to-home.android.spec.ts packages/app/test/ui-smoke/onboarding-to-home-mobile.spec.ts packages/app/test/ui-smoke/onboarding-to-home.shared.ts packages/app/test/ui-smoke/onboarding-to-home.spec.ts packages/ui/src/App.tsx packages/ui/src/state/use-startup-shell-controller.ts packages/ui/src/hooks/useRenderGuard.ts plugins/plugin-discord/build.ts packages/app-core/platforms/electrobun/src/native/screencapture.ts`
  - Result: passed.

## Artifacts

- `android-home-landing.png`
- `android-onboarding-to-home.mp4`
- `web-onboarding-chat-first.png`
- `web-remote-home.png`
- `mobile-cloud-home.png`
- `desktop-launch-render.png`

## Known gaps

- After the final rebase onto `origin/develop` (`98e0fecb9a`), a browser smoke
  rerun using ports `2153/31353` failed before tests started because
  `packages/app/scripts/verify-chunk-safety.mjs` detected the latest app build
  leaking the bn.js/crypto marker into `useWalletModal-CjdC_QEv.js`. This is a
  base app chunking failure, not an onboarding assertion failure.
- `bun run --cwd packages/app typecheck` and
  `bun run --cwd packages/app-core/platforms/electrobun typecheck` still fail on
  pre-existing workspace module/type resolution issues outside this onboarding
  change.
- A full `bun run --cwd packages/app audit:app` run had two transient failures
  (`builtin-camera`, `builtin-tasks` desktop landscape); both passed when rerun
  by grep.
