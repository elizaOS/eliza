# Issue 10197 Android agent restart e2e evidence

Branch: `fix/10197-android-agent-restart-e2e`

## What was validated

- Added a debug-only Android `Agent.debugCrashAndRestart` Capacitor method.
- The method is rejected in non-debug builds and routes through
  `ElizaAgentService.scheduleRestart()` rather than adding another restart
  mechanism.
- Added `bun run --cwd packages/app test:e2e:android:agent-restart`.
- Built and installed a fresh WebView-debuggable debug APK on the attached Pixel
  6a.

## Commands run

```bash
bunx @biomejs/biome check packages/app/test/android/agent-restart.android.spec.ts packages/app/test/android/README.md packages/app/package.json
bun run --cwd packages/app typecheck
ELIZA_MOBILE_REPO_ROOT=/home/shaw/milady/eliza-local-integration ELIZA_WEBVIEW_DEBUG=1 ELIZA_BUN_RISCV64_OPTIONAL=1 ELIZA_ANDROID_SKIP_FORK_LLAMA_LIB=1 bun run --cwd packages/app build:android
adb -s 27051JEGR10034 install -r -d packages/app-core/platforms/android/app/build/outputs/apk/debug/app-debug.apk
ANDROID_SERIAL=27051JEGR10034 bun run --cwd packages/app test:e2e:android:agent-restart
```

## Attached Pixel result

The attached device did not reach the crash-injection step because the embedded
local agent never became healthy on this stock Pixel 6a install. The WebView and
Capacitor bridge were active, and `Agent.request` repeatedly reached the native
bridge, but `/api/health` returned:

```json
{"error":"local_agent_unavailable","message":"Local agent request failed"}
```

`ps.txt` shows the detached `libeliza_ld_musl_aarch64.so` agent process alive,
and `services-dump.txt` shows `ElizaAgentService` running foreground. The
logcat includes SELinux denials for the agent process under `untrusted_app`.

## Files

- `device-and-build.txt` — APK sha256, APK size, Pixel model/build.
- `logcat-local-agent-unavailable.txt` — WebView/native bridge requests and
  repeated `503 local_agent_unavailable` responses.
- `services-dump.txt` — Android foreground service state.
- `ps.txt` — running app and detached agent process list.
- `package-dump.txt` — installed package metadata.
- `device-screen.png` — attached device screenshot.
- `device-screenrecord.mp4` — attached device recording.
