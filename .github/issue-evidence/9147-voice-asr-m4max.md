# #9147 / voice — whisper ASR on Apple M4 Max (Metal)

`whisper-cli` (`ggml-base.en`) on the M4 Max:
`whisper_default_buffer_type: using device Metal (Apple M4 Max)`, `use gpu = 1`.

- Canonical sample `jfk.wav` → **"And so my fellow Americans, ask not what your country can do for you, ask what you can do for your country."** (exact).
- **TTS→ASR round-trip**: the local-TTS-generated agent greeting (`tts-producer-reply-...-16k.wav`) → whisper transcribed it back as **"Hello there. I'm so excited to meet you. I'm always ready to chat, play games, or just share my thoughts. What's on your mind today?"** — the full local voice loop (TTS out → ASR in) works correctly on-device GPU.

Plus the offline e2e scorer gate landed in #9236 (respond/EOT/entity/voice-match). Real-audio diarization/self-rejection matrix stays blocked on the pending WeSpeaker/diarizer GGUFs.
