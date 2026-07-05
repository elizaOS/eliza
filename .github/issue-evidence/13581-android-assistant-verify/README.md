# #13581 — Automated Android assistant-role / voice-IME / assist-key verification lane

Before this change the Android assistant surface (VoiceInteractionService default-assistant role, the voice-input IME, the assist-key glue) had **manual-only** adb verification, the one coded instrumented test (`ElizaOsInstrumentedTest`) `assumeSystemEliza()`-gated itself off every non-AOSP APK (vacuously green), and `:app:connectedDebugAndroidTest` ran in no CI job. This adds an automated, repeatable lane plus a retail-path instrumented test and wires both into CI.

## What was added

| File | Role |
|---|---|
| `packages/app/scripts/lib/android-assistant-verify-lib.mjs` | Pure `dumpsys`/`cmd`/`logcat`/`settings` parsers → typed decisions. No I/O, no device. |
| `packages/app/scripts/lib/android-assistant-verify-lib.test.mjs` | `node --test` coverage of the parsers (14 cases, real-shaped fixtures). |
| `packages/app/scripts/android-assistant-verify.mjs` | adb-driven lane: assert surfaces registered → re-apply role+IME → assert secure settings → fire `cmd voiceinteraction show` / `KEYCODE_ASSIST` / IME deep-link → assert landing in MainActivity → classify IME ASR outcome. |
| `packages/app-core/platforms/android/app/src/androidTest/.../ElizaAssistantSurfaceInstrumentedTest.java` | Retail-path (non-`assumeSystemEliza`) androidTest asserting the assistant/IME/assist surfaces are declared, bind-guarded, and intent-resolvable on ANY debug APK. |
| `.github/workflows/android-device-e2e.yml` | `native-plugin-androidtest` now runs `:app:connectedDebugAndroidTest` AND the adb lane on the emulator. |
| `packages/app/package.json` | `test:e2e:android:assistant` script. |

## What the lane asserts (issue done-when → mechanism)

1. **VIS/IME registered** — `dumpsys package ai.elizaos.app` → `parseAssistantSurfaces` (VIS + session + recognition + IME + assist activity all present; a renamed/dropped surface reads ABSENT, boundary-matched so `…ServiceRENAMED` ≠ `…Service`).
2. **Role + IME re-applied after reinstall, secure settings asserted** — `cmd role add-role-holder android.app.role.ASSISTANT`, `ime enable`+`ime set`, then read back `voice_interaction_service` / `default_input_method` / `cmd role holders` / `ime list -s`.
3. **Assistant/IME invocation reaches the Eliza entry point** — fire `cmd voiceinteraction show`, `input keyevent KEYCODE_ASSIST`, and the IME `elizaos://voice?source=android-ime` deep-link; assert MainActivity resumed **and** the expected `source=` tag via `dumpsys activity activities` + logcat (both required — a coincidental foreground MainActivity can't pass).
4. **IME ASR round-trip** — `classifyImeAsrOutcome` distinguishes `committed` (full engine) from the designed `engineOff` state — asserted, never skipped silently.

## Honest device gating — never green-by-skip

Two **independent** gates:

- `--require-device` / `ELIZA_ANDROID_REQUIRE_AGENT=1`: a required-but-missing **device** is a hard failure.
- `--require-engine` / `ELIZA_ANDROID_REQUIRE_ENGINE=1`: only then does an `engineOff` ASR outcome fail (kept separate because the emulator has no on-device engine).

With no device attached and no require flag, the lane prints an N/A verdict and exits 0. See `device-gating-exit-paths.txt`:

```
$ node scripts/android-assistant-verify.mjs                       → N/A, exit 0
$ node scripts/android-assistant-verify.mjs --require-device      → FAIL, exit 1
$ ELIZA_ANDROID_REQUIRE_AGENT=1 node scripts/android-assistant-verify.mjs → FAIL, exit 1
```

## Evidence in this directory

- `parser-node-test.txt` — `node --test` run, 14/14 pass. **Runnable here (no device).**
- `device-gating-exit-paths.txt` — the three device-gating exit paths on a host with no device. **Runnable here.**
- `regression-canary.txt` — deliberate regression (rename the VIS) flips the parser + lane verdict RED (done-when "regression canary turns the lane red", proven at the parser level; the on-device flip needs a device).

## N/A here — needs an Android device/emulator

The **on-device** run of `android-assistant-verify.mjs` and the CI `:app:connectedDebugAndroidTest` + adb lane were **not** executed in this worktree — **no Android device or emulator is attached**, and this host is macOS (the CI emulator lane is a KVM Linux runner). This is the honest N/A the lane is designed to surface (exit 0 without a require flag). To run for real:

```bash
# device/emulator attached, app APK installed:
bun run --cwd packages/app test:e2e:android:assistant
# CI: android-device-e2e.yml → native-plugin-androidtest (label ci:device or workflow_dispatch)
```

The lane and the retail-path instrumented test are wired correctly (YAML parses; `:app:connectedDebugAndroidTest` and the adb lane are in the emulator script); the CI-run link with a non-skipped assistant/IME test is the remaining artifact to attach once the labeled/dispatched run executes.

## #12393 hardware assistant-key remap — re-tracked, not silently closed

The `input keyevent KEYCODE_ASSIST` path (software-injectable) is now covered. The **hardware** key remap (a physical key → `KEYCODE_ASSIST` via a `.kl` keylayout overlay in the AOSP vendor tree) is not implementable here — no `.kl` mechanism exists under `packages/scripts/distro-android/` and there is no AOSP build host. Per the done-when, this is re-tracked on #12393 rather than left closed-but-unimplemented (see the issue comment linking this PR).
