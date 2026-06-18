# Eliza-1 local inference — memory management + end-to-end latency review

Status: living document. Grounded in a code audit (file:line cited) of the
current `plugins/plugin-local-inference` + iOS bridge, not aspirational docs.

Goal: minimize model evictions, maximize parallelism/co-residency, and drive
voice-in → handled → voice-out to the lowest wall-clock on Mac and iOS across
the 8 / 12 / 16 / 20 / 24 / 48 / 128 GB device classes — with per-model and
overall telemetry and an on-device grind-all-models test that proves every
Eliza-1 model (text, ASR, TTS, VAD, embedding, vision) works.

---

## 1. The end-to-end voice waterfall (what actually happens today)

mic → VAD → ASR → (MTP drafter ∥ target verifier) → phrase chunker → TTS → ring buffer → speaker.
Source: `services/voice/pipeline.ts`, `scheduler.ts`, `phrase-chunker.ts`, `engine.ts`.

Instrumented checkpoints already exist (`services/latency-trace.ts:72-86`,
`voiceLatencyTracer`): `vad-trigger, vad-speech-start, prewarm-fired,
asr-first-partial, asr-final, llm-first-token, llm-first-replytext-char,
replyText-first-emotion-tag, phrase-1-to-tts, tts-first-audio-chunk,
audio-first-played`. Derived headline metrics: **TTFT** (vad→first token),
**TTFA** (vad→first audio chunk), **TTAP** (vad→audio played). Exposed at
`GET /api/dev/voice-latency`.

### Measured-today path (Mac, fused harness) — where time goes

Approx wall-clock for first audio (0.8B tier, from harness defaults + code):

| Stage | Span | Typical | Blocking? |
|---|---|---|---|
| VAD endpoint | mic → asr start | ~32 ms hop | gates ASR |
| **ASR** | `pipeline.ts:317-480` feed+flush | 100 ms (whisper) / ~300 ms (Qwen3-ASR) | **fully blocks** drafter |
| drafter round-1 | `pipeline.ts:350-358` | ~50–100 ms | awaited |
| verifier | `pipeline.ts:386` | ~50–100 ms | overlapped w/ next draft |
| phrase boundary | `phrase-chunker.ts:39-46` | 0–**700 ms** (time-budget flush) | **gates first TTS** |
| **TTS first chunk** | `scheduler.ts:588-700` | ~97 ms (Kokoro) / ~200 ms (OmniVoice) | streaming |
| ring → sink | `scheduler.ts:714-754` | <5 ms | sync |

**Headline: ~300–600 ms to first audio best-case; the two largest controllable
costs are (a) ASR fully blocking generation and (b) the phrase-chunker
time-budget flush (700 ms default).**

---

## 2. The biggest inefficiencies (ranked, with file:line)

### Voice-loop serialization
1. **ASR fully completes before the LM starts** (`pipeline.ts:317`,
   `transcriber.flush()` at `:475`). No streaming-ASR → incremental LM. Mitigated
   only by speculative-on-pause (`turn-controller.ts:276-284`) which runs off the
   *partial* transcript and is discarded if it changes.
2. **Phrase-chunker time-budget flush = up to 700 ms first-audio delay** on token
   streams without early punctuation (`phrase-chunker.ts:28-46`,
   `ELIZA_PHRASE_FLUSH_MS`; timeout-flush at `:131-135`). The 8-token cap helps but
   punctuation-sparse replies still wait.
3. **MTP reject → TTS rollback re-synthesis** (`pipeline.ts:398-410`,
   `scheduler.reject`). Speculatively-synthesized chunks are dropped when the
   verifier rejects the draft tail; the corrected tokens re-synthesize.
4. **Per-chunk `await` serializes token→TTS fanout** (`engine.ts:2277-2289`):
   each accepted token `await`s the previous scheduler push (a serial promise
   chain) before the next chunk is processed.

### Memory / eviction
5. **One model per role, unload-then-load on every modality swap** (`memory-arbiter.ts:505-526`,
   `engine.ts:515-527`). Text↔vision↔asr↔tts of the *same role* force a full
   unload+load (seconds), even when both fit RAM. Different roles can co-reside,
   but the conservative swap policy + `waitForRefcountZero` microtask poll
   (`memory-arbiter.ts:583-597`) stalls swaps.
6. **Vision is a separate arbiter role but has no standalone model** (`service.ts:505-554`,
   role registration `:146`): vision-describe reuses the text bundle's projector and
   is co-resident with text. The separate `vision` role exists only for memory
   tracking/priority — it cannot load standalone (evicting text unloads the projector,
   leaving vision with nothing to run). Correctness note (verified): this is a role
   abstraction, **not** an independent-load bug; the win is to keep vision pinned to
   the text bundle's lifecycle rather than tracking it as if separately loadable.
7. **RAM budget re-derived per load** (`ram-budget.ts:158-179`): manifest read +
   KV synthesis on every load decision, uncached.

### iOS-specific
8. **ASR PCM shipped as a JSON number array over stdio** (`bridge.ts` — type
   `:191-194`, ASR handler `:2582-2585`): 1 s @ 16 kHz = 16k floats ≈ **~100 KB+
   JSON vs 64 KB binary**, plus parse cost. Should be base64 / binary.
9. **No token streaming across the JS↔native IPC** (`bridge.ts:1790-1819`):
   `llama_generate` returns the whole completion in one `host_result`, then passes
   it to onStreamChunk as a single chunk. TTS gets early-token fanout only on the
   desktop in-process path; iOS waits for the full text before the message handler acts.
10. **No KV-cache quantization default on iOS** (`LlamaBridgeImpl.swift:682-687`):
    f16 KV doubles per-model RAM vs q8_0, pushing the MTP/co-residency threshold up.
11. **No runtime memory arbiter on iOS** (`LlamaBridgeImpl.swift:1507-1565`,
    `hardwareInfo`/`availableMemoryGB`): a single ~3 GB free-RAM capability probe
    gates MTP; no per-request rebalance, no jetsam-warning handler. (The TS
    `MemoryArbiter` does not run in the iOS native bridge.)
12. **TTS round-trips through a temp WAV file** (`LlamaBridgeImpl.swift:1310-1315`).

### Streaming / engine
13. **No KV reuse across stateless turns** (`engine.ts:721-723`): the default
    session resets chat history each turn → full prompt re-prefill. Conversation-
    pinned `cacheKey` slots avoid this; voice partials do not.
14. **MTP is a runtime/engine concern, not catalog-gated** (`catalog.ts:493-506`):
    the catalog declares MTP support **uniformly** across tiers — 0.8B uses
    **same-file MTP** (`:494-495`), not a separate DFlash drafter (the `TIER_DRAFTERS`
    entries at `:595-609` are hidden, runtime-role-gated; `:458-460` confirms no
    separate drafter component for these tiers). Correctness note (verified): the
    "only the fused backend speculates" behavior lives in the engine/backend, **not**
    in `catalog.ts`; do not attribute the gating to the catalog.

---

## 3. Per-RAM-tier model load + co-residency policy (target design)

Today's tiers (`device-tier.ts:52-72`): MAX ≥24 GB eff, GOOD ≥12, OKAY ≥6, POOR <6.
Effective-model-RAM (`device-tier.ts:109-115`): Apple Silicon = total; dGPU =
max(vram, total·0.5); CPU = total·0.5. Reserve 1536 MB (`ram-budget.ts:45`).

The user asked specifically about 8/12/16/20/24/48/128 GB. Proposed resident set
(co-resident = loaded simultaneously, no swap) to **eliminate voice-loop evictions**:

| Device RAM | Text tier | Voice resident set (no evict) | Notes |
|---|---|---|---|
| **8 GB** (iPhone/base Mac) | 0.8B Q4 + DFlash drafter | ASR(0.6B) **xor** TTS resident; VAD(2 MB) always; embedding via text `--pooling last` | Tight: keep VAD+text hot; ASR and TTS alternate but pre-warm the next. q8_0 KV. **This is the eviction-sensitive tier.** |
| **12 GB** | 0.8B/2B | text + ASR + TTS(kokoro) + VAD all resident | GOOD: no per-turn swaps; vision projector co-resident with text. |
| **16 GB** | 2B/4B | + vision mmproj + OmniVoice co-resident | full multimodal hot. |
| **20–24 GB** | 4B (MAX) | + image-gen warm, larger KV / longer ctx | all models parallelized + resident. |
| **48 GB** | 9B | everything resident + multi-context (parallel rooms) | run drafter+target+voice with headroom. |
| **128 GB** | 27B / 27b-256k | full set + 256k ctx + concurrent agents | no memory pressure ever; maximize parallel slots. |

**Policy changes to get there:**
- Co-resident roles by RAM headroom, not the blanket one-per-role swap. The arbiter
  already supports multi-role residency; the fix is to **stop evicting on
  modality change when the resident-set fits the budget** (`memory-arbiter.ts:505-526`).
- Keep VAD + the active text model **pinned** (never evictable) in voice mode.
- **Pre-warm the next stage's model** during the current stage (ASR running → warm
  TTS; LM generating → keep ASR warm for barge-in re-ASR) instead of fire-and-forget
  evicting ASR (`pipeline.ts:326-328`).
- Default **q8_0 KV on memory-constrained tiers** (8/12 GB, iOS) to fit the resident set.
- Cache the resolved RAM budget per (modelKey, ctx) instead of re-deriving (`ram-budget.ts`).

---

## 4. Optimization plan (ranked by expected wall-clock / eviction win)

High confidence (implement + verify):
1. **Co-residency instead of swap** when the resident set fits budget — kills the
   seconds-scale ASR↔TTS↔vision reload on GOOD+ tiers. (`memory-arbiter.ts`)
2. **iOS PCM IPC: base64/binary, not JSON array** — removes ~100 KB JSON encode/parse
   per ASR call. (`bridge.ts` ASR route + Swift `handleAsrTranscribe`)
3. **q8_0 KV default on iOS + 8/12 GB tiers** — halves KV RAM, enables co-residency
   + MTP on more devices. (`LlamaBridgeImpl.swift`, load-args resolution)
4. **Pin VAD + active text model in voice mode; pre-warm next stage** — removes
   cold-load stalls between ASR and TTS. (`pipeline.ts`, `memory-arbiter.ts`)
5. **Lower/condition the phrase-flush budget + flush on first clause** — cut up to
   ~700 ms off TTFA. (`phrase-chunker.ts`) — ✅ **done.** The first phrase of each
   reply now flushes on a shorter `firstPhraseMaxAccumulationMs` budget (derived =
   `min(350, maxAccumulationMs/2)`, env `ELIZA_PHRASE_FLUSH_FIRST_MS`, reset per
   reply); later phrases keep the full 700 ms so the bulk is not fragmented.
   Clause-boundary flush (`, : ;`) already shipped. The scheduler picks the
   shorter window up automatically via `msUntilTimeBudget()`.

Medium:
6. KV reuse for voice partials (don't reset history when the prefix is stable). (`engine.ts:721`)
7. Verify-before-TTS-dispatch for the last K draft tokens to cut rollback re-synth. (`pipeline.ts`)
8. iOS token streaming over IPC (incremental `host_result` frames) so the message
   handler + TTS act on first tokens. (`bridge.ts`, `FullBunEngineHost.swift`)
9. Cache RAM-budget resolution. (`ram-budget.ts`) — ✅ **done.**
   `defaultManifestLoader` now memoizes the manifest read+parse+validate keyed on
   `modelId + manifestSha256`, so the recommender (scores the whole catalog per
   refresh) and the load gate stop re-hitting disk. The SHA is the validated
   manifest's content hash → a re-downloaded bundle self-invalidates (no stale
   budgets); the legacy no-SHA path reads through unchanged. Tests 4/4.

---

## 5. On-device grind-all-models telemetry test (the deliverable)

A self-test that, on the phone, loads + exercises EVERY Eliza-1 model and emits
per-model + overall timing/telemetry until we are confident they all work. Built on
the existing hooks (`latency-trace.ts`, `e2e-harness.ts` scoring, the iOS bridge
diagnostics) — see `docs/ondevice-model-grind.md` (companion) for the route + runner.

Per-model metrics: load ms, first-token/first-audio/first-result ms, throughput
(tok/s or RTF), peak RSS delta, WER (ASR round-trip), VAD boundary MAE, pass/fail.
Overall: e2e voice loop TTAP, 30-turn endurance, peak RSS, eviction count.

---

## 6. Open builds blocking live measurement

- **Mac fused loop** needs `libelizainference.dylib` for `darwin-arm64-metal-fused`
  (only the stub exists, `omnivoice-fuse/libelizainference_stub.dylib`; no darwin-fused
  target in `build-llama-cpp-mtp.mjs`). Until built, `voice-duet`/`voice-e2e-hardware`
  reject the silent stub.
- **iOS** already has the fused lib (`ios-arm64-metal-fused`) — on-device grind is the
  faster route to real numbers. CoreML Kokoro (this branch) adds the ANE TTS path.
