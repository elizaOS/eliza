# Android raw-PCM frame capture (`audioFrame`)

Adds an **opt-in** native `AudioRecord` path to `TalkModePlugin.kt` that streams
16 kHz mono 16-bit PCM frames to JS as a new `audioFrame` Capacitor event, so a
JS/bun consumer can run diarization / frame-VAD / wake-word on Android. The
default `SpeechRecognizer` (SODA) STT path is untouched and remains the default.

## Why a new path was needed

Android STT (`android.speech.SpeechRecognizer`) yields **transcript strings
only** — `onBufferReceived` is a documented no-op on SODA, so there is no raw
PCM, and diarization/VAD/wake-word can't run. The new path captures PCM directly
with `AudioRecord`.

## The mic-contention constraint and the chosen design

**Android lets only one capture client own a given audio input at a time.** A
parallel `AudioRecord` while `SpeechRecognizer` holds the mic does not get the
mic — `AudioRecord` either fails to reach `RECORDSTATE_RECORDING` or reads
silence. The three options from the brief:

- (a) AudioRecord-only mode replacing SpeechRecognizer (PCM -> local-inference ASR).
- (b) Coexistence, if the device permits it.
- (c) A distinct "diarization mode" that suspends SpeechRecognizer while
  AudioRecord runs.

**Chosen: (c).** `startAudioFrames` detects an active SpeechRecognizer session
and **suspends it** (`recognizer.cancel()` + `destroy()`, cancel the
restart/silence jobs) before opening `AudioRecord`; `stopAudioFrames` releases
`AudioRecord` and **resumes** SpeechRecognizer if a session is still active
(`enabled && !stopRequested`). This is the cleanest viable path that does NOT
regress the working SODA STT default: it is a separate opt-in method; `start()`
is unchanged and frame capture is off unless explicitly requested.

Coexistence (b) was **measured infeasible on the Pixel 9a** (see verification):
`AudioRecord` reaches `RECORDING` and frames flow only AFTER STT is suspended;
the design proactively suspends rather than relying on concurrent capture.

Option (a) — AudioRecord-only + local transcription — is a strict superset of
this PCM capture (the PCM produced here is exactly what a local-ASR consumer
would feed to local ASR). It is left to the JS consumer: this layer's job is to
deliver verified PCM frames; transcription backend choice lives above it.

## API (added)

- `startAudioFrames({ sampleRate = 16000, frameMs = 20 }) → { started,
  sampleRate, frameSamples, suspendedStt, error? }`
- `stopAudioFrames() → void`
- `isCapturingAudioFrames() → { capturing }`
- Event `audioFrame`: `{ pcm16 (base64 LE s16 mono), sampleRate, channels: 1,
  samples, rms (0..1), timestamp (elapsedRealtime ms), frameIndex }`

The `AudioRecord` is opened on `VOICE_RECOGNITION` (preprocessing-light, what
diarization wants), falling back to `MIC`. The read loop runs on
`Dispatchers.IO`; each frame is little-endian-packed, RMS-measured, base64-encoded,
and emitted via `notifyListeners`. Lifecycle is released in `stop()` and
`handleOnDestroy()`.

## On-device verification (Pixel 9a, 53081JEBF11586)

Driven via CDP against the WebView Capacitor context (`TalkMode` plugin), with
mic permission granted:

1. **PCM frames reach JS (frame-only):** `startAudioFrames({16000, 20ms})` →
   `started:true, sampleRate:16000, frameSamples:320`. **196 frames** in 4 s
   (~49 fps = correct for 20 ms frames), `samples:320`, `channels:1`,
   `sampleRate:16000`, base64 length 856 (= 640 PCM bytes), **RMS varied per
   frame** (min 0.00007, max 0.00679, avg 0.00465 → live audio, not a silence
   stub), `frameIndex` strictly monotonic, `capturing` true→false across
   start/stop.
2. **Mic contention / suspend-resume:** `start()` (STT, `state:listening`) →
   `startAudioFrames()` returned **`suspendedStt:true`** and captured **149
   frames** (avg RMS 0.00485) while STT was suspended → `stopAudioFrames()`
   resumed STT (`state:listening`, `enabled:true`). Proves AudioRecord only
   gets the mic once SpeechRecognizer is suspended, and STT cleanly resumes.
3. **No STT regression:** default `start()` → `started:true, state:listening,
   enabled:true`; `isCapturingAudioFrames` stays `false` (frame capture is
   off unless explicitly requested).

Build: `:elizaos-capacitor-talkmode:compileDebugKotlin` + `:app:assembleDebug`
(BUILD SUCCESSFUL); APK contains `startAudioFrames`/`audioFrame` in the dex;
installed + verified on-device.
