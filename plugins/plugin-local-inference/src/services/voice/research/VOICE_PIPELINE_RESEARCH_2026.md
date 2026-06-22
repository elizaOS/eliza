# Voice-Assistant Pipeline Research Brief (2026)

Turn-taking, VAD, barge-in, speaker ID, on-device models, latency. Citation-backed engineering reference for the elizaOS voice pipeline (issue #8785). Vendor self-benchmarks are flagged; peer-reviewed and API-documentation numbers are treated as solid.

> This brief is the evidence base behind the numeric defaults and gating budgets in the Voice Workbench. Where a recommended default differs from what the pipeline currently ships, that is called out in [VOICE_8785_ASSESSMENT.md](./VOICE_8785_ASSESSMENT.md).

## 1. Pause / silence lengths for end-of-turn detection

**The linguistics baseline.** The canonical "~200 ms" figure comes from Stivers et al. 2009 (PNAS), a 10-language corpus of question→answer transitions. The actual statistics: cross-linguistic **mode ≈ 0 ms, median ≈ +100 ms, mean ≈ +208 ms** (the mean is pulled right by a long tail) — [PNAS / PMC](https://pmc.ncbi.nlm.nih.gov/articles/PMC2705608/). Per-language means span +7 ms (Japanese) to +469 ms (Danish); every language is unimodal with its modal gap between 0 and +200 ms — [PNAS](https://www.pnas.org/doi/10.1073/pnas.0903616106).

**The hard problem for VAD.** Minimal human response latency is ~200 ms; acoustic silence below ~120–180 ms isn't reliably perceived as a gap — [Heldner & Edlund 2010](https://www.sciencedirect.com/science/article/pii/S0095447010000628). Crucially, **intra-turn pauses (thinking mid-sentence) and inter-turn gaps (a real handoff) overlap heavily in the 200–500 ms band** — a fixed silence timer cannot tell them apart. Humans hit ~200 ms gaps despite >600 ms production latency, so they must be *predicting* turn ends — [PMC](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC4464110/). This is what semantic end-of-turn (EOT) models replicate.

**What production systems do** (fixed-VAD silence thresholds cluster around 500 ms):
- **OpenAI Realtime** `server_vad`: `silence_duration_ms` **500 ms**, `prefix_padding_ms` **300 ms**, `threshold` **0.5**; `semantic_vad` adds an `eagerness` knob — [OpenAI VAD docs](https://developers.openai.com/api/docs/guides/realtime-vad).
- **LiveKit** turn-detector: `min_endpointing_delay` **500 ms**, `max_endpointing_delay` **3000 ms**; semantic model (Qwen2.5-0.5B) ~50–160 ms on CPU — [LiveKit](https://docs.livekit.io/agents/build/turns/turn-detector/).
- **Pipecat smart-turn-v2**: upstream VAD `stop_secs` set **short (0.2 s)** because the 94.8M-param model makes the real decision; inference 12 ms (GPU) – 410 ms (CPU) — [smart-turn-v2](https://huggingface.co/pipecat-ai/smart-turn-v2).
- **Deepgram**: `utterance_end_ms` recommended **≥ 1000 ms** — [Deepgram](https://developers.deepgram.com/docs/endpointing).

**The latency↔false-cutoff frontier** (LiveKit self-benchmark, 14 languages): holding premature cutoffs at **10%** costs ~295 ms mean latency; **5%** costs ~543 ms — [LiveKit](https://livekit.com/blog/solving-end-of-turn-detection). Roughly each halving of the cutoff rate costs ~250 ms.

**Recommended.** Minimum end-of-utterance silence: **200 ms with a semantic model in front, 500 ms for fixed-VAD only.** Semantic-EOT early-commit at **P(complete) ≥ 0.7**. Max-wait fallback **3000 ms**.

## 2. On-device VAD + wake-word

**Silero VAD**: ~1–2 MB JIT model, **<1 ms / 30 ms chunk** on one CPU thread, MIT, language-agnostic. Defaults: `threshold` **0.5**, `min_speech_duration_ms` **250**, `min_silence_duration_ms` **100**, `speech_pad_ms` **30**, window **512 samples @16 kHz** — [GitHub](https://github.com/snakers4/silero-vad), [PyTorch Hub](https://pytorch.org/hub/snakers4_silero-vad_vad/).

**Wake-word engines** (all accuracy numbers vendor/author-published; no neutral head-to-head exists):
- **openWakeWord**: frozen Google speech-embedding backbone + tiny per-word DNN head (~200 KB ONNX), trains from synthetic Piper TTS, design target **<0.5 false-accepts/hr, <5% false-reject**. Code Apache-2.0 but **pretrained models CC-BY-NC-SA** — [GitHub](https://github.com/dscripka/openWakeWord).
- **Porcupine** (Picovoice): ~1 MB, **97.1% detection at 1 FA/10 hr @ 10 dB SNR**, custom phrase trained in-console; proprietary/paid — [FAQ](https://picovoice.ai/docs/faq/porcupine/).
- **microWakeWord**: fully-Apache code + models, ~26–240 KB int8 TFLite, ~1 FA/hr — [GitHub](https://github.com/kahrendt/microWakeWord).

For "hey eliza": all train from synthetic TTS. Target **<0.5 FA/hr, <5% FRR**.

## 3. Acoustic echo cancellation + barge-in

**WebRTC AEC3** is the production choice: linear partitioned-block frequency-domain adaptive filter (64-sample / 4 ms blocks) + nonlinear residual suppressor. Removes **20–40 dB** of echo; handles 20–200 ms device delay + 100–300 ms reverb tails; double-talk halts adaptation; convergence 1–2 s; ~150 ms filter is the sweet spot — [AEC3 explainer](https://switchboard.audio/hub/how-webrtc-aec3-works/). **Speex** is linear-only and fails if delay exceeds the tail — AEC3 is strictly more robust.

**The reference signal is everything.** The #1 barge-in failure is a non-time-aligned playback reference — `getUserMedia({echoCancellation:true})` is blind to PCM played through a custom AudioContext (WebSocket TTS), so "the agent hears itself" — [dev.to case study](https://dev.to/remi_etien/i-built-a-voice-ai-with-sub-500ms-latency-heres-the-echo-cancellation-problem-nobody-talks-about-14la). Wake/interrupt detection must run off the *linear* filter output.

**Production strategies, increasing robustness:** half-duplex mic muting → **effective half-duplex via an `agentSpeaking` flag + ~1.5 s post-TTS cooldown with a raised RMS gate** → full-duplex AEC + reference cancellation → speaker-embedding / textual self-voice rejection (Google Textual Echo Cancellation) — [USPTO 11,482,244](https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/11482244).

**Framework knobs:** LiveKit `min_interruption_duration` **0.5 s** + adaptive backchannel cooldown (1.0 s / 3.5 s); OpenAI `server_vad` threshold 0.5 / prefix 300 ms / silence 500 ms. **Latency budget:** ICASSP AEC Challenge caps algorithmic latency at **≤40 ms** — [AEC Challenge](https://arxiv.org/pdf/2009.04972).

## 4. Speaker diarization + recognition on-device

**Embedding models** (EER on VoxCeleb1-O cleaned):
- **ECAPA-TDNN** (SpeechBrain): 192-dim, **0.80% EER** — [HF](https://huggingface.co/speechbrain/spkrec-ecapa-voxceleb).
- **WeSpeaker ResNet34-LM**: 256-dim, 6.63M params, **0.72% EER** — [HF](https://huggingface.co/Wespeaker/wespeaker-voxceleb-resnet34-LM). *(This is what elizaOS uses.)*
- **TitaNet-Large** (NeMo): **0.66% EER**.

**pyannote diarization 3.1** = segmentation-3.0 (10 s window, powerset up to 3 overlapping) + WeSpeaker embeddings + agglomerative clustering at cosine ≈ **0.705**. Offline DER: VoxConverse **11.3%**, AMI **18.8%**, DIHARD-3 **21.7%** — [pyannote 3.1](https://github.com/pyannote/hf-speaker-diarization-3.1). **Streaming** (DIART, 5 s buffer / 500 ms hops) costs roughly **+4–9 pp DER** — [DIART](https://github.com/juanmc2005/diart).

**Cosine thresholds are model-specific** — NeMo default **0.7**, pyannote clustering ~0.705. **On-device:** ResNet34 (6.6M) and ECAPA fit on phones; 8-bit quantization halves size with +0.07% EER.

## 5. Owner enrollment + verification

**Enrollment:** enroll once with **multiple utterances of ≥3 s each, pooled** — sub-3 s enrollment destabilizes the centroid — [Aalto](https://speechprocessingbook.aalto.fi/Recognition/Speaker_Recognition_and_Verification.html). **Short utterances kill EER:** clean SOTA ~0.7–0.9%, but at 1 s of test audio EER jumps to **~16.4%** vs ~2.7% at 3 s — [arXiv](https://arxiv.org/pdf/1810.10884).

**Open-set "owner vs stranger"** = argmax cosine over enrolled owner centroids, then **reject as stranger if even the best match < θ**. **Threshold tradeoff:** at EER, impostor false-accept = owner false-reject; banking targets **FAR < 0.01%**, convenience tolerates **FAR ~1%** — [ConversaLabs](https://www.conversailabs.com/blog/secure-voice-authentication-for-banking-applications). For an owner gate, set θ above EER for sensitive actions, near EER for low-friction recognition.

**Anti-spoofing/liveness** (ASVspoof-5 2024): SOTA countermeasures **2.59% EER (open) / 8.61% (closed)** — helps but is not airtight; pair with the verification threshold for high-value actions — [ASVspoof 5](https://arxiv.org/html/2408.08739v1).

## 6. On-device model landscape (2025–2026)

| Capability | Realistic on-device pick | Footprint / latency |
|---|---|---|
| STT baseline | Whisper tiny/base | 39M/74M, 75–142 MB, ~10–15× realtime, non-streaming |
| STT streaming | Moonshine v2 Tiny | 33.6M, **~50 ms on M3**, 80 ms lookahead, 12% WER |
| STT native iOS | Apple SpeechTranscriber (iOS 26) | offline, 4.6–6.2× realtime; WhisperKit +1.3–1.8× ANE |
| TTS | **Kokoro-82M** | 80–170 MB, ~0.7 RTFx on ANE, Apache-2.0 *(elizaOS mobile default)* |
| Multimodal audio-in | Gemma 3n E2B | ~2.5 GB, USM audio encoder, ~6 tok/s |
| Qwen3-ASR 0.6B | borderline (Mac / high-end phone) | ~0.6–1.2 GB quantized *(elizaOS ASR)* |
| Qwen3-Omni 30B-A3B | **cloud only** | 78–107 GB GPU |

Accelerators: Pixel **Tensor G5** runs a 3B real-time speech model on-device; Apple ANE runs WhisperKit and Kokoro faster than realtime. **STT → Whisper/Moonshine (or Apple SpeechTranscriber on iOS); TTS → Kokoro-82M; full audio understanding → Gemma 3n E2B; omni models stay cloud.**

## 7. Mixing local + cloud — latency math

**Targets:** **<800 ms voice-to-voice "good", <500 ms "great", <300 ms "instant", >1.2–1.5 s "broken"** — [LiveKit](https://livekit.com/blog/voice-agent-architecture-stt-llm-tts-pipelines-explained), [Hamming](https://hamming.ai/resources/voice-ai-latency-whats-fast-whats-slow-how-to-fix-it). Real-world shipped P50 is **1.4–1.7 s**, so the budget is aspirational.

**Cerebras LLM TTFT** (third-party, Artificial Analysis): **170 ms (Llama 70B) / 240 ms (405B)**, >2,100 tok/s — after first token the rest of the first sentence is effectively free for TTS.

**The hybrid math (local STT + Cerebras LLM + local TTS), from end-of-speech detection:**

```
Local STT finalize (last chunk + endpoint)  ~50  ms   (mostly overlaps live speech)
Network RTT to Cerebras                      ~50–100 ms
Cerebras LLM TTFT                            ~170 ms
Local TTS first-audio (Kokoro)              ~30–80 ms   (no network leg)
──────────────────────────────────────────────────────
Time-to-first-audio ≈ 300–400 ms  (excluding endpoint silence wait)
+ ~250 ms typical endpoint wait    ≈ 550–650 ms total
```

Structural wins: STT partials stream *during* speech; TTS starts on the first LLM sentence; Cerebras collapses the LLM term; local STT + local TTS each drop a network leg. **The dominant residual cost is the endpoint/turn-detection silence wait (200–800 ms)** — the single biggest tunable knob, and the one absent from every vendor TTFA headline.

## Recommended numeric defaults

| Parameter | Recommended | Range | Basis |
|---|---|---|---|
| VAD speech-onset threshold | **0.5** | 0.5–0.7 (raise in noise) | Silero / OpenAI / Pipecat |
| VAD onset confirm | **200 ms** | 100–250 ms | Pipecat `start_secs` |
| VAD offset / end-hangover (with semantic EOT) | **200 ms** | 200–300 ms | Pipecat `stop_secs` |
| VAD offset / end-hangover (fixed-VAD only) | **500 ms** | 500–700 ms | OpenAI / LiveKit |
| Semantic-EOT early-commit | **P ≥ 0.7** | 0.5–0.7 | smart-turn / open-set θ |
| Max-wait fallback | **3000 ms** | 3000–5000 ms | LiveKit / Pipecat |
| Barge-in min-interruption | **500 ms** | 300–500 ms | LiveKit |
| Barge-in grace / post-TTS cooldown | **400 ms** (+adaptive) | 300–1500 ms | dev.to / LiveKit |
| AEC filter (tail) length | **150 ms** | 100–200 ms | AEC3 |
| AEC algorithmic latency cap | **≤40 ms** | ≤40 ms | ICASSP AEC Challenge |
| Speaker-verification cosine threshold | **0.7** (recalibrate per model) | 0.65–0.75 | NeMo / pyannote |
| Owner-accept threshold (sensitive) | **above EER, FAR ≤ 0.1%** | FAR 0.01–1% | banking vs convenience |
| Min verification utterance | **≥3 s** | 3 s+ | EER 2.7%@3s vs 16.4%@1s |
| Wake-word false-accept target | **<0.5 FA/hr, <5% FRR** | — | openWakeWord |
| Time-to-first-audio budget | **≤500 ms great / ≤800 ms good** | 300–800 ms | LiveKit / Hamming |

**Caveats.** Cross-engine wake-word accuracy and turn-detection "improvement" percentages are vendor self-benchmarks. TTS latency headlines are inference-only and run 2–4× higher in production. Cosine thresholds are embedding-model-specific — recalibrate on a per-device dev set. The single largest lever on perceived latency is the endpoint silence wait, so invest in a semantic EOT model before optimizing STT/TTS milliseconds.
