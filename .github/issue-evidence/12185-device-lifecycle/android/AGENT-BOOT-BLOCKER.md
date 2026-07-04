# Android on-device agent cold-boot blocker (device-lifecycle lane, #12185)

Captured 2026-07-03 on `emulator-5584` (arm64-v8a AOSP image, root + SELinux
permissive) while driving the #12185 device-lifecycle lane against the real
installed app.

## What happened

The Android lane's standard assertions require the on-device agent loopback
(`127.0.0.1:31337/api/health`, fetched from inside the WebView). On this
emulator the agent could not stay up: `ElizaAgentService` starts as a foreground
service but the bun agent process never binds :31337 because asset extraction is
stuck in an `extract-failed` loop.

The same agent bundle **did** boot fully earlier the same day on this emulator
(`files/agent/agent.log` → `[eliza-boot] deferred:complete: 35ms (t+53155ms)`),
so the runtime itself runs on this arm64 image. The failure is in the native
cold-boot asset-extraction path, and it is triggered by two things that both
happened here:

1. A concurrent worktree reinstalled a **UI-only** WebView-debug APK (89 MB, 0
   `assets/agent/*` entries) over the **full-agent** APK (592 MB, 19
   `assets/agent/*` entries). Reinstall bumps the APK mtime.
2. The machine was under extreme load (host `load average: 223`), so the
   ~170 MB asset copy (72 MB `agent-bundle.js` + ~83 MB `bun` + pglite/wasm/tar)
   could not finish inside Android's foreground-service startup window.

## Root cause (read from `ElizaAgentService.java`)

`extractAssetsIfNeeded()` compares the APK's mtime against `files/agent/.apk-stamp`.
On any change it **wipes** the previously-extracted agent (bundle, launch.sh,
bun + abi binaries, pglite assets) at the *start*, then re-copies everything from
`assets/`. `.apk-stamp` is written **only after a fully successful extraction**.

Consequences observed:

- **Non-atomic refresh.** The working extraction is destroyed before the
  replacement is staged. If the copy is interrupted (ANR/kill/crash) the on-disk
  state is left partial (observed `agent-bundle.js` truncated to 31–68 MB of
  72 MB; `arm64-v8a/bun` 0 bytes). Because `.apk-stamp` was never updated, every
  subsequent launch re-detects the "stale" stamp, re-wipes, and re-copies — a
  permanent crashloop with no atomic staging (temp dir + rename) and no fallback
  to the last-good extraction.
- **FGS-startup ANR under load.** The copy plus `onCreate`'s synchronous
  `getHistoricalProcessExitReasons` + diagnostic file IO run during
  foreground-service startup. On a slow/loaded device this exceeds the FGS start
  timeout (`Timeout executing service`, observed `startForegroundDelayMs:15786`,
  `bg anr: … failed to complete startup`), killing the process mid-copy and
  feeding the loop above.
- **Variant-swap brick.** With the UI-only APK installed, the wipe runs and then
  `copyAssetIfMissing("agent/agent-bundle.js")` throws (asset absent) →
  `currentStatus="extract-failed"`, permanently bricking the previously-working
  local agent with no recovery path.

## Evidence in this directory

- `extract-failed-logcat.txt` — the extraction exception + APK-change wipe + FGS
  ANR lines.
- `agent-restart-diagnostics-tail.jsonl` — the `service-onStartCommand` →
  `extract-failed` loop from `files/agent/agent-restart-diagnostics.jsonl`.
- `installed-apk-asset-audit.txt` — full-agent (592 MB, 19 agent assets) vs the
  UI-only APK (89 MB, 0 agent assets) that overwrote it.

Filed as a distinct product bug (see PR body for the issue link). The lane code
lands with the on-device agent-loopback assertions marked blocked-on-that-issue;
the drivable WebView-lifecycle + no-FATAL/ANR assertions and the iOS-sim subset
are unaffected.
