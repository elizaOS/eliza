# Voice fixtures — provenance

All fixtures are synthetic speech generated locally with `espeak-ng` and
transcoded to the exact wire format Deepgram Flux ingests. They are REAL audio
waveforms (not silence, not white noise): a real speech synthesizer produced
real formant/phoneme audio, which Deepgram Flux transcribes for real. No
copyrighted or human-recorded audio is committed.

## Format (matches `DEEPGRAM_FLUX_*` constants in the merged adapter)

- Codec: `pcm_s16le` (linear16)
- Sample rate: `16000` Hz
- Channels: `1` (mono)

This is exactly `encoding=linear16&sample_rate=16000&channels=1`, so the harness
streams the PCM body in 80 ms / 2560-byte chunks with zero transcode, exactly as
`validateDeepgramFluxAudioChunk` requires.

## Generation command (reproducible)

```bash
espeak-ng -v en-us -s 155 -p 45 "<text>" --stdout \
  | ffmpeg -y -i - -ac 1 -ar 16000 -acodec pcm_s16le -f wav <out>.wav
```

| file | spoken text | role |
| --- | --- | --- |
| `turn_weather.wav` | "Hello. What is the weather like in Denver today?" | baseline full-turn |
| `turn_bargein.wav` | "Tell me a very long story about a dragon who learns to code and builds a startup and then." | barge-in (long utterance so the agent is mid-speech when the user interrupts) |
| `turn_error.wav` | "This is a short utterance for the error path scenario test." | error-path (provider auth failure) |

## Why synthetic is acceptable here

The DoD requires *real audio* through the *real providers*. The audio IS real
(a synthesizer output waveform, transcribed by live Deepgram Flux → real
transcript). To also cover a human-voice fixture, drop a mono 16 kHz PCM WAV of
your own recording at `fixtures/turn_human.wav` and pass
`--fixture=fixtures/turn_human.wav`; the harness treats any conformant WAV
identically. Provenance for any added human recording must be noted here.
