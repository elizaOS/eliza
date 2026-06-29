# Android validation evidence

- Physical device: `53081JEBF11586` (`Pixel 9a`) had `ai.elizaos.app` installed.
- Launch command: `adb -s 53081JEBF11586 shell am start -W -n ai.elizaos.app/.MainActivity`.
- Result: cold launch succeeded (`Status: ok`, `TotalTime: 725`, `WaitTime: 732` on the recorded run).
- Screenshot: `pixel9a-mainactivity-15s.png` shows the app rendered after startup.
- Video: `pixel9a-mainactivity.mp4` records the same installed app foregrounded on the Pixel 9a.
- Logcat: `pixel9a-logcat.txt` was captured after launch and sanitized to remove bearer tokens.
- Crash scan: no `FATAL EXCEPTION`, `AndroidRuntime`, app process crash, or ANR was found in the captured log.
- Emulator: `emulator-5554` (`sdk_gphone64_x86_64`) was connected, but `ai.elizaos.app` was not installed. `packages/app test:sim:auth:android` also failed before device use because `packages/app/android/app/src/main/AndroidManifest.xml` is not generated in this worktree; the Android platform exists under `packages/app-core/platforms/android`.
