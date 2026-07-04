# #12185 sub-issue 5 + 6 — Android voice-input IME + AOSP assistant-role ROM glue

Evidence for the Android voice-input keyboard (voice-subtype `InputMethodService`,
FUTO Voice Input pattern) and the AOSP ROM glue that declares/pre-grants the new
voice surfaces. Captured on `emulator-5584` (Android 15 / API 35, Pixel-class AVD).

Stacked on PR #12291 (`feat/12185-android-assistant-role`) — includes its
VoiceInteractionService commits.

## Files

| File | What it proves |
|---|---|
| `01-build.txt` | `:app:assembleDebug` (`ELIZA_ANDROID_SKIP_FORK_LLAMA_LIB=1`) compiled the new IME Java + resources + manifest cleanly. Compile-verification APK (no renderer/engine), same lane as #12291's sub-4. |
| `02-aapt2-ime-manifest-and-method.txt` | `aapt2 dump` of the **packaged APK**: `ElizaVoiceInputMethodService` + `android.permission.BIND_INPUT_METHOD` + the `android.view.InputMethod` filter + `android.view.im` metadata → `res/xml/method.xml`, and the method.xml tree with `imeSubtypeMode="voice"` + `supportsSwitchingToNextInputMethod="true"`. |
| `03-ime-engine-off-state.png` | The Eliza voice keyboard rendered over the system contact editor. Shows the **honest ENGINE_OFF state** ("Eliza isn't running — tap to open the app"), the open-app button (orange ring), the switch-back keyboard icon (top-right), and the "Voice input by Eliza" hint. This is the real user-facing state — the compile-verification build has no running engine, so the loopback ASR probe fails and the keyboard says so rather than failing silently. |
| `05-ime-switched-back.png` | After tapping the switch-back icon, the IME switched to Gboard (LatinIME numeric pad on the focused Phone field) — the "switch back to your keyboard" affordance working end to end. |
| `06-logcat-ime.txt` | `[ElizaVoiceInputMethodService]` logs: `onStartInputView` → engine-status probe hits `Failed to connect to /127.0.0.1:31337` → ENGINE_OFF; then `switching back to previous keyboard`; plus the active-IME transition `ai.elizaos.app/.ElizaVoiceInputMethodService` → `com.google.android.inputmethod.latin/...LatinIME`. |

## How it was verified

1. `assembleDebug` compiled the IME service + layout + drawables + `method.xml`
   + manifest. `aapt2 dump` confirmed the service, `BIND_INPUT_METHOD`, the
   `android.view.InputMethod` filter, the `android.view.im` metadata, and the
   voice subtype in the packaged APK (`02`).
2. `adb install -r`, `adb shell ime enable ai.elizaos.app/.ElizaVoiceInputMethodService`
   + `ime set` → `settings get secure default_input_method` returned the Eliza IME.
   Three IMEs were enabled (Gboard, Google voice IME, Eliza), so the FUTO
   voice-subtype peer relationship + switch-back both have real targets.
3. Focused a text field (system contact editor) → the Eliza voice keyboard
   rendered (`03`). Its `refreshEngineStatus()` probe hit the loopback, got
   connection-refused, and showed the ENGINE_OFF state (`06`).
4. Tapping the open-app button launched `ai.elizaos.app/.MainActivity`
   (deep link `elizaos://voice?source=android-ime`, verified via
   `dumpsys activity … topResumedActivity`).
5. Tapping the switch-back icon called `switchToPreviousInputMethod()` and the
   active IME flipped to Gboard (`05`, `06`).

## Mic / ASR round-trip — honest status

The record → transcribe → commit path records real mic audio (`AudioRecord`,
16 kHz mono PCM16), wraps it as WAV, and `POST`s to the on-device engine's
loopback ASR route (`/api/asr/local-inference`). The compile-verification APK
ships **no on-device engine**, so the loopback is refused and the keyboard shows
the real ENGINE_OFF state instead of transcribing — captured in `03`/`06` rather
than faked. A full `bun run build:android` APK ships the engine + a staged ASR
bundle and completes the round-trip; that is the on-device/simulator capture lane.

## AOSP ROM glue (sub-issue 6)

`packages/os/android/vendor/eliza/` changes are ROM vendor-tree metadata copied
into the system image at build time. **ROM-image verification is a hardware/CI
lane (N/A here — no AOSP build host).** The JSON/XML were validated
syntactically (`node -e JSON.parse`, `xmllint --noout`) and kept consistent with
existing vendor-tree conventions:
- `manifests/aosp-assistant-full-control.json` — declares the `voiceInteraction`
  (VIS + session + recognition) and `inputMethod` (voice IME) capabilities;
  records that `config_defaultAssistant` → `ai.elizaos.app` now resolves
  ROLE_ASSISTANT to the VIS holder; extends the android-cloud strip inventory to
  match `run-mobile-build.mjs`; documents the hardware-key remap as a follow-up
  (no `.kl` mechanism exists in the vendor tree to extend).
- `permissions/default-permissions-*.xml` — documents that the pre-granted
  `RECORD_AUDIO` now also backs the assistant session + voice IME.
- `permissions/privapp-permissions-*.xml` — documents why
  `BIND_VOICE_INTERACTION` / `BIND_INPUT_METHOD` are intentionally absent
  (framework-held bind guards, not app-held perms).

## Role-reset-on-reinstall gotcha (dossier source [15])

Every `adb install -r` clears the enabled/selected IME (and the assistant-role
Secure Settings from #12291), so the IME must be re-`enable`d + `set` after each
reinstall — done before each capture here. Same platform behavior affects the
shipping app on sideload/dev loops; it is not a regression.
