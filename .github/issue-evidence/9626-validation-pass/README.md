# Issue #9626 validation pass

Date: 2026-06-28

## Scope Validated

Focused validation for the current guarded-cleanup/build-process slices in:

- `packages/ui/src/services/local-inference/registry.ts`
- `plugins/plugin-local-inference/src/services/registry.ts`
- `plugins/plugin-aosp-local-inference/src/aosp-local-inference-bootstrap.ts`
- `plugins/plugin-edge-tts/src/index.ts`
- `packages/plugin-sub-agent-claude-code/src/session-recorder.ts`
- `plugins/plugin-social-alpha/package.json`
- `packages/app/vite/wallet-chunk-matcher.ts`
- `packages/app/test/wallet-optimized-chunk-matcher.test.ts`

## Commands Run

- `bun run --cwd packages/ui test src/services/local-inference/registry.test.ts`
  - 1 file passed, 3 tests passed.
- `bun run --cwd plugins/plugin-local-inference test src/services/registry.test.ts`
  - 1 file passed, 3 tests passed.
- `bun run --cwd plugins/plugin-aosp-local-inference test __tests__/aosp-local-inference-bootstrap.test.ts`
  - 70 tests passed across the package test invocation.
- `bun run --cwd packages/plugin-sub-agent-claude-code test src/session-recorder.test.ts`
  - 25 tests passed across the package test invocation.
- `bun run --cwd plugins/plugin-edge-tts test`
  - 1 file passed, 8 tests passed.
- `bun run --cwd packages/ui typecheck`
- `bun run --cwd plugins/plugin-local-inference typecheck`
- `bun run --cwd plugins/plugin-aosp-local-inference typecheck`
- `bun run --cwd plugins/plugin-edge-tts typecheck`
- `bun run --cwd packages/plugin-sub-agent-claude-code typecheck`
- `git diff --check -- packages/ui/src/services/local-inference/registry.ts packages/ui/src/services/local-inference/registry.test.ts plugins/plugin-local-inference/src/services/registry.ts plugins/plugin-local-inference/src/services/registry.test.ts plugins/plugin-aosp-local-inference/src/aosp-local-inference-bootstrap.ts plugins/plugin-aosp-local-inference/__tests__/aosp-local-inference-bootstrap.test.ts plugins/plugin-edge-tts/src/index.ts plugins/plugin-edge-tts/__tests__/smoke.test.ts packages/plugin-sub-agent-claude-code/src/session-recorder.ts packages/plugin-sub-agent-claude-code/src/session-recorder.test.ts`
- `bun run --cwd plugins/plugin-social-alpha typecheck`
  - Passed after routing the typecheck through the package build lock for `packages/ui`.
- `bun run --cwd packages/app test test/wallet-optimized-chunk-matcher.test.ts`
  - 1 file passed, 5 tests passed.
- `bun run --cwd packages/app build:web`
  - Passed; `verify-chunk-safety` reported `OK: bn.js/crypto graph is confined to lazy vendor chunks`.
- `bun run --cwd packages/app audit:app`
  - Passed; `185 passed`.
  - Follow-up manual review files closed the two post-run `needs-work` entries as `good` after screenshot inspection:
    - `packages/app/aesthetic-audit-output/manual-review/plugin-documents-gui-mobile.md`
    - `packages/app/aesthetic-audit-output/manual-review/plugin-inbox-gui-mobile.md`
- `bun run verify`
  - Final pass: `root-verify-final-4.log`.
  - Passed; Turbo reported `512 successful, 512 total`, the build/typecheck compiler-model audit passed, the turbo dependency audit passed, the script inventory guard passed, and the log ended with `[typecheck:dist] checked 30 dist-path consumer config(s)`.
  - Earlier full-verify attempts exposed and fixed three repo-wide gate issues:
    - `plugins/plugin-feed/src/components/FeedView.tsx` import ordering; confirmed by `plugin-feed-lint.log`.
    - `packages/steward/package.json` web typecheck script using `tsc --noEmit` instead of `tsgo`; confirmed by `audit-build-model-after-steward-fix.log`.
    - `packages/app/test/android/native-plugin-view-bridge.android.spec.ts` formatting; confirmed by `app-lint-after-native-bridge-format.log`.
- `bun run --cwd packages/app build:android`
  - Passed; Gradle `BUILD SUCCESSFUL`, and sideload artifact audit passed for `packages/app-core/platforms/android/app/build/outputs/apk/debug/app-debug.apk`.
- `ANDROID_SERIAL=emulator-5554 bun run --cwd packages/app test:e2e:android:local`
  - APK install succeeded on the emulator.
  - The local-chat path failed during smoke-model staging because the emulator reported `No space left on device`; `android-emulator-df-after-local-chat-failure.log` shows `/data` at 99% with 161 MB available.
- `ANDROID_SERIAL=emulator-5554 bun run --cwd packages/app test:e2e:android:routes`
  - APK launched on the emulator.
  - The on-device agent health endpoint did not become healthy within 180 seconds; logcat is saved as `android-e2e-logcat-emulator-5554.txt`.
- `ANDROID_SERIAL=emulator-5554 ELIZA_ANDROID_REQUIRE_AGENT=0 bun run --cwd packages/app test:e2e:android:webview`
  - Real WebView route coverage passed 51 route cases on the emulator before local-runtime/voice/onboarding assumptions and one late route failed after the page closed.
- `adb -s 53081JEBF11586 install -r packages/app-core/platforms/android/app/build/outputs/apk/debug/app-debug.apk`
  - Passed on the connected physical Pixel 9a.

## Notes

- `bunx @biomejs/biome check ...` returned exit code 0 for these files and reported one existing fixable warning in `plugins/plugin-aosp-local-inference/src/aosp-local-inference-bootstrap.ts` (`useOptionalChain`). No formatting errors were reported.
- Android artifacts:
  - Emulator: `android-emulator-eliza-launch.png`, `android-emulator-eliza-launch-dismissed.png`, `android-emulator-eliza-launch.mp4`.
  - Physical Pixel 9a: `android-device-pixel9a-eliza-launch.png`, `android-device-pixel9a-eliza-launch.mp4`.
  - Device identity/install logs: `android-device-model-pixel9a.log`, `android-emulator-model.log`, `android-device-install-pixel9a.log`.
- The emulator route/local-agent failures are retained as real evidence, not hidden: the APK installs and route coverage partially passes, but the attached emulator did not have enough `/data` space for the local model lane and later did not expose a healthy local agent for the route lane.
