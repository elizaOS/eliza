# Android lane — run status (#12185)

Honest status of the Android device-lifecycle lane as of this PR.

**Lane code:** committed and ready — `test/android/lifecycle.android.spec.ts`
(app switch home/recents/other-app, camera, mute, battery + saver, forced doze,
force-stop process death) and `test/android/lifecycle-reboot.android.spec.ts`
(`adb reboot` → `ElizaBootReceiver` autostart). Same harness/config as the rest
of the Android e2e lane (`playwright.android.config.ts`, `android-harness.ts`).

**Green end-to-end run:** NOT captured this session. The lane's standard
assertions require a healthy on-device agent on `127.0.0.1:31337`, and on the
available emulator (`emulator-5584`, arm64 AOSP) the agent could not stay up:

1. A sibling worktree's **UI-only** WebView-debug APK (0 `assets/agent/*`) was
   installed over the **full-agent** APK, triggering the non-atomic
   "APK changed → wipe extracted agent" path and an `extract-failed` loop.
2. Reinstalling the correct full-agent APK did not recover it: the host was under
   `load average: 223` (a large concurrent test swarm), so the ~170 MB asset copy
   ANR'd during foreground-service startup, and finally the **emulator itself
   OOM-crashed** (adb device dropped, no qemu process).

Both are captured and root-caused in `AGENT-BOOT-BLOCKER.md` and filed as a
distinct product bug: **elizaOS/eliza#12453** (non-atomic asset-extraction wipe →
permanent `extract-failed` crashloop). That bug is the substantive finding from
driving the real lane; it must be fixed before this lane can go green on-device.

**What did run (real, committed):** the drivable iOS-simulator subset — see
`../ios/ios-lifecycle-report.json` and screenshots/recording. Note the iOS run
also shows `agent-loopback-health: skipped` (that sim build is in cloud/onboarding
mode), so the WebView-lifecycle events are proven on iOS but the local-agent
loopback assertion is unproven on both platforms pending a healthy local-agent
build on a device that can host it.

**To green the Android lane** (device runner, not a loaded shared box):
`bun run --cwd packages/app test:e2e:android:lifecycle` after
`test:sim:local-chat:android:live` brings up a healthy on-device agent, then
`…:lifecycle:reboot` last. Requires elizaOS/eliza#12453 fixed (or a clean
full-agent APK install that is never overwritten by a UI-only build) and enough
headroom for the on-device agent to complete its cold boot.
