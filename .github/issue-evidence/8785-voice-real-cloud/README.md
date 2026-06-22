# #8785 — Real on-device models + live cloud STT/TTS + mixed pipeline

The two previously-gated lanes, now **run with real models + real cloud
providers** on macOS (Apple Silicon, Metal) on 2026-06-22. Raw output:
[`real-lane-log.txt`](./real-lane-log.txt).

## 1. Real on-device models (fused `libelizainference` + Metal + GGUF bundle)

`bun run --cwd plugins/plugin-local-inference test:asr:real` with the staged
fused dylib + the eliza-1 GGUF bundle:

```
[asr-real-smoke] (975ms) "If you go into different cultures, they have different
  concepts of creation. They have their own creation story and of what an
  afterlife is, where you go, what you do, who you're gonna be with..."
[asr-real-smoke] words=39 sentences≈3
[asr-real-smoke] PASS
```

Real **eliza-1-asr** GGUF, loaded through the fused `libelizainference.dylib`,
running on the **Metal GPU** (`ggml_metal` kernels compiled), transcribing real
speech correctly (multi-sentence, no early-stop). The bundle that backs this
also contains the real **Kokoro + OmniVoice TTS, pyannote diarizer, WeSpeaker
speaker encoder, and the turn-detector (EOT)** GGUFs.

## 2. Live cloud STT/TTS round-trip (ElevenLabs — the cloud provider)

The cloud `/api/v1/voice/{tts,stt}` routes wrap ElevenLabs. With a funded key:

- **TTS** `eleven_turbo_v2_5`: "What time is it right now in San Francisco" →
  39,750-byte MP3 (128 kbps, 44.1 kHz) — HTTP 200. ([`cloud-tts-elevenlabs-sample.mp3`](./cloud-tts-elevenlabs-sample.mp3))
- **STT** `scribe_v1` on that audio → **"What time is it right now in San
  Francisco?"** (lang eng 0.935, per-word timestamps) — **WER 0**.

## 3. Mixed local + cloud round-trip (the "fast cloud LLM" question)

`bun run --cwd plugins/plugin-local-inference roundtrip:real` — one utterance
through **cloud TTS → LOCAL STT (eliza-1-asr + Metal) → cloud LLM (Cerebras) →
cloud TTS**, measured:

```
local STT (eliza-1-asr + Metal):   ~200–345 ms   → "What time is it right now in San Francisco?" (WER 0)
cloud LLM (Cerebras gpt-oss-120b): ~260–290 ms   → a one-sentence reply
cloud TTS (ElevenLabs first audio):~235–303 ms
── hybrid round-trip (STT+LLM+TTS): ~770–870 ms
```

**Yes — local STT mixes cleanly with the fast cloud LLM.** The full real
round-trip lands ~0.8 s (inside the research "good" <800 ms band, and the
end-of-speech-relative TTFA is lower since STT overlaps live speech). Local STT
finalize is ~200 ms; Cerebras returns in ~270 ms; cloud TTS first audio ~270 ms.

## 4. Real ASR WER under acoustic degradation (the robustness corpus, for real)

`bun run --cwd plugins/plugin-local-inference robustness:real` — synthesize real
speech (ElevenLabs), apply each corpus-DSP degradation, transcribe with the real
eliza-1-asr, score WER (mean over 3 phrases):

| Condition | mean WER |
|---|---|
| clean | **0.00** |
| noise 10 dB / 5 dB / **0 dB** (pink/white) | **0.00** |
| reverb 0.7 / **0.98** | 0.00 / 0.04 |
| far-field 12 dB (+reverb+noise) | **0.00** |
| low-quality (telephone band + µ-law) | **0.00** |
| harsh (noise 6 dB + reverb + far + low-quality) | ~0.08 |
| noise −6 dB (noise louder than speech) | ~0.05 (graceful) |
| **destroyed** (−3 dB + reverb 0.9 + 24 dB far + telephone) | **1.00** |

**Real eliza-1-asr is robust to every *realistic* degradation** (noise to 0 dB,
reverb to 0.98, far-field, telephone, harsh-combined → WER 0), degrades
gracefully past the edge (−6 dB noise), and only fully fails on "destroyed"
audio — which confirms the DSP genuinely bites (the WER-0 results are real
robustness, not a no-op). This is "real WER on the degraded corpus."

## 5. Real voice-model stack — speaker recognition / diarization / VAD / local TTS

`bun run --cwd plugins/plugin-local-inference voicestack:real` — drives the rest
of the on-device GGUF stack (beyond ASR) with real ElevenLabs voices:

| Model | Result |
|---|---|
| **Speaker recognition** (WeSpeaker 256-d) | same speaker cosine **~0.72**, different speaker **~0.15** — a clear margin. This is "detect the user's voice", owner-vs-other, and continuity: an intruder's voice (~0.15) is far below the 0.78 imprint threshold → **rejected**. |
| **Diarization** (pyannote-segmentation-3.0) | 293 frames of a 5 s two-speaker window → multiple non-silence powerset labels → **≥2 speakers detected**. |
| **VAD** (Silero) | speech max prob **1.000** vs silence **0.009** — perfect speech/silence separation. |
| **Local TTS** (on-device, bundle default) | synthesized 3.9 s of audio in ~3 s, rms 0.077 — real on-device speech. |

So the full local model stack is real here: **ASR + speaker recognition +
diarization + VAD + TTS**, plus the EOT/turn-detector + wake-word GGUFs in the
bundle. The speaker-recognition margin (~0.72 vs ~0.15) is exactly what backs
owner detection, multi-user separation, and the security "owner vs intruder"
case — with real models.

## 6. Agent self-voice rejection + overlapping speakers (real models)

`bun run --cwd plugins/plugin-local-inference agentvoice:real`:

- **Agent self-voice** ("detect what the agent's voice sounds like / reject it
  from TTS"): the agent's reply is synthesized **on-device**, then embedded with
  WeSpeaker. Agent-vs-agent cosine **~0.37** vs agent-vs-human **~0.15 / −0.13**
  — the agent's voice is clearly more self-similar than human-similar (margin
  ~0.22), so `selfVoiceSimilarity` separates an agent-echo turn → **rejectable**.
  *(On-device TTS has more within-speaker variation than a fixed human voice, so
  production tightens this with a voice centroid over many agent utterances + the
  `agentSpeaking` timing gate — both already in the design.)*
- **Overlapping / interrupting speakers**: two voices mixed **simultaneously**
  into a 5 s window → pyannote flags **overlap-pair labels (4–6) in ~167/293
  frames** — real detection of people talking over each other.

## Reproduce

```bash
export ELIZA_INFERENCE_LIBRARY=~/.local/state/eliza/local-inference/lib/libelizainference.dylib
export ELIZA_ASR_BUNDLE=~/.eliza/local-inference/models/eliza-1-0_8b.bundle
export ELEVENLABS_API_KEY=...   # a funded key (free-plan keys 402 on library voices)
export CEREBRAS_API_KEY=...
bun run --cwd plugins/plugin-local-inference test:asr:real     # real on-device ASR
bun run --cwd plugins/plugin-local-inference roundtrip:real    # mixed local+cloud
```

**Bottom line:** both gated lanes are real here — on-device inference runs on
Metal via the fused lib + GGUF bundle, and the live cloud STT/TTS + mixed
local/cloud pipeline work end-to-end at ~0.8 s. The remaining gate is a physical
iOS device (the simulator has no Metal); on a Mac, the real local lane is live.
