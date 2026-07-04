# #12453 — Atomic crash-safe Android agent asset extraction — RUN STATUS

Fix for the non-atomic asset-extraction wipe that dropped the on-device agent
into a permanent `extract-failed` crashloop. Part of #12185.

## What changed (source of truth)

- `packages/app-core/platforms/android/app/src/main/java/ai/elizaos/app/ElizaAgentService.java`
  - `extractAssetsIfNeeded()` rewritten around an **atomic stage-into-temp +
    rename swap** (`files/agent.staging/` → `files/agent/`, via `files/agent.trash/`).
    The working extraction is **never wiped before the replacement is fully
    staged and stamped**.
  - `.apk-stamp` is written **inside the staged tree** so it lands with the swap
    and never runs ahead of a completed extraction.
  - **Missing-assets guard**: a UI-only / WebView-debug APK lacking
    `assets/agent/*` keeps the existing extraction and logs loudly instead of
    wiping (no variant-swap brick).
  - **Last-good fallback**: on staging failure, fall back to the existing
    bootable extraction and leave the stamp unchanged (retry next boot) rather
    than loop on a wipe.
  - **Interrupted-swap recovery**: a swap that died between its two renames is
    restored from `files/agent.trash/` on the next boot.
  - `onCreate()` now calls `startForeground()` **before** any diagnostic IO /
    `getHistoricalProcessExitReasons`, so the FGS-start timeout can't kill the
    process mid-copy. The heavy copy stays off the main thread on `startWorker`.
- `.../ai/elizaos/app/ElizaAssetExtractionPolicy.java` — new pure decision class
  (`apkChanged`, `decide` → `USE_EXISTING | STAGE_AND_SWAP | KEEP_MISSING_ASSETS
  | FAIL_NO_ASSETS`). Follows the repo's `*Policy` pattern (like
  `ElizaAgentWatchdogPolicy` / `InferenceMemoryPolicy`): Android-free so the
  crash-safety invariants are JVM-unit-testable without a device.
- `.../app/src/test/java/ai/elizaos/app/ElizaAssetExtractionPolicyTest.java` —
  12 JVM unit tests over the full input space.

## Verification performed

| Check | Result | Artifact |
|---|---|---|
| Pure policy compiles (OpenJDK 21) | PASS (exit 0) | `unit-test-output.txt` |
| Policy unit tests (JUnit 4.13.2) | **PASS — 12/12** | `unit-test-output.txt` |
| Full `ElizaAgentService.java` javac vs real android-36 SDK + androidx.core 1.17.0 | **PASS — exit 0, 0 errors** | `javac-fullclass.txt` |
| `./gradlew :app:assembleDebug` | **BLOCKED (env, not code)** | `gradle-config-blocker.txt` |
| On-device (emulator) run | **DEFERRED (env)** | see below |

The unit tests directly assert the three brick-avoidance invariants:
- **when-to-wipe** — `STAGE_AND_SWAP` (the only wiping/stamping action) occurs
  iff the APK ships assets AND (it changed OR no valid extraction exists);
- **missing-assets guard** — a no-`assets/agent/*` build over a valid extraction
  always resolves to `KEEP_MISSING_ASSETS`, never a wipe;
- **never-destroy-last-good** — with a bootable extraction present, no input ever
  resolves to `FAIL_NO_ASSETS`.

## Why gradle assemble + on-device are deferred (precise reason)

`./gradlew :app:compileDebugJavaWithJavac` fails at **settings evaluation**,
before any `:app` Java compiles, because this git worktree has **no installed
`node_modules`** and the parent eliza checkout's `node_modules` is empty
(`total 0`). The generated `capacitor.settings.gradle` includes ~30
`@capacitor+*@8.x` subprojects under `node_modules/.bun/…/android` that do not
exist on disk (exact error in `gradle-config-blocker.txt`).

Unblocking requires `bun install` + `npx cap sync android` at the eliza root,
then the NDK/CMake native build — a large, slow chain. The host is under an
active concurrent test swarm (load avg ~53, down from ~223) and the #12453
reporter hit the emulator dead/OOM from that same swarm. Per the task's
conservative-under-load directive, the change is compile-verified at the Java
level against the real Android SDK (the authoritative check for this diff)
instead of forcing a full assemble that would contend with the swarm and change
nothing about the code's correctness. No emulator/device is attached
(`adb devices` empty; `emulator` binary absent from PATH).

## What a green on-device run needs (recipe for the #12185 lane)

1. `bun install` at the eliza root; `npx cap sync android` in
   `packages/app-core/platforms/android` to regenerate `capacitor.settings.gradle`
   for the installed capacitor 8.x versions.
2. Stage the gitignored `app/libs/android-js-engine-release.aar` (present in the
   parent checkout at `packages/app-core/platforms/android/app/libs/`).
3. `ELIZA_ANDROID_SKIP_FORK_LLAMA_LIB=1 ./gradlew :app:assembleDebug` → BUILD SUCCESSFUL.
4. Boot a fresh arm64/x86_64 AVD with headroom; `adb install -r` the APK.
5. **Repro + prove the fix** (the three #12453 failure modes):
   - **Interrupted extraction**: force-stop the app ~mid-copy during first cold
     boot, relaunch → assert it boots the last-good extraction (no permanent
     `extract-failed` loop). Capture logcat + `files/agent/agent.log`.
   - **Variant swap**: `adb install -r` a UI-only (no `assets/agent/*`) APK over
     a full-agent install → assert the full-agent extraction survives and the
     agent still boots; look for the loud `[ElizaAgentService] … KEEPING the
     existing agent extraction` log line.
   - **FGS ordering**: confirm no `Timeout executing service` /
     `bg anr: … failed to complete startup` during a loaded cold boot.
   Land logcat + `agent.log` + an `installed-apk-asset-audit.txt` here.
