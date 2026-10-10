# Browser voice capture

Generic recording and PCM conversion for browser hosts, used with `../browser-speech`.

- `BrowserAudioCapture` runs one MediaRecorder session at a time. Each session owns its
  microphone stream, deadline timer and stop promise, so cancelling or replacing a recording
  can never finish, keep or report an earlier one. Host inputs: `openMicrophone(onLost)`
  (the host's own microphone policy, returning the admitted stream and its release),
  `stopped(event)`, an optional `meter`, `hidden`, `maxDurationMs`, `maxBytes` and
  `retainedClips`. Clips stay in memory; nothing is uploaded or saved here.
- `decodeRecordingPcm` decodes a clip to bounded mono samples (default 16 kHz, 60 s, 16 MB).
  `encodePcm16Wav` and `recordingPcmWav` produce mono PCM16 WAV for speech services.

Exported as `@elizaos/voice/browser-capture`.
