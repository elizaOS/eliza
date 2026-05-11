# Eliza‑1 Voice Assistant — Optimization Swarm Brief

> **Status:** active. Wave 1 launched. This file is the binding contract for every
> agent (Claude or otherwise) working on the Eliza‑1 low‑latency voice loop.
> Read this file, then your worker section, then your file list, then go.
>
> Companion reading you MUST skim before touching code in your area:
> - `packages/inference/AGENTS.md` — the local-inference / kernel contract (§1 mode classification, §3 required kernels, §4 fused voice graph).
> - `packages/inference/README.md` — kernel verification matrix + dispatch wiring status.
> - `packages/inference/reports/porting/2026-05-11/remaining-work-ledger.md` — the gap source-of-truth.
> - The repo‑root `CLAUDE.md` and `AGENTS.md` — git rules, scope discipline, naming.

---

## 1. Mission

Make Eliza‑1 the optimal local voice assistant. Concretely: minimize the latency
from "user stops speaking" to "agent's first audio plays", by

1. **Fusing the streaming I/O of every model** — ASR → LLM → TTS as token/feature
   streams, not string round‑trips. Use the DFlash drafter to draft tokens ahead
   of the autoregressive target.
2. **Pre‑caching everything that can be pre‑cached** — the moment a message
   arrives / STT starts, KV‑prefill the response‑handler prompt (system prompt +
   provider context + action/tool schema block + assistant‑turn start + the open
   tool call up to `"shouldRespond"`), preload the drafter, pre‑generate a first
   acknowledgement audio chunk.
3. **Forcing / in‑filling the response JSON structure** so the model never spends
   tokens on the envelope or the evaluator‑parameter scaffold:
   - When STT finishes, inject the user tokens, finish the prompt, let the model
     emit `shouldRespond`. As soon as `"I"` (IGNORE) or `"R"` (RESPOND) is
     detected, **shortcut**: splice in the rest of the enum word + the JSON up to
     `"replyText": "` and continue generation from there.
   - Whenever `",\n` (end of a value) is seen, **infill the next parameter key**
     (and its `": ` / `": "`), then the next, etc.
   - For any enum/option with exactly one possible value given current state,
     **skip generation** and infill straight to the next free position.
   - The property **after `replyText` is `contexts`**: if it does not contain
     `simple`, the agent goes into **planning** (start a thread, do work; the
     response handler can merge/stop threads).
   - The forced skeleton always carries **all the evaluators the response handler
     expects**, so post‑turn evaluators always have their fields.
4. **Streaming `replyText` into TTS** the instant the first chunk exists — token
   stream if the TTS engine supports it, else the first segment delimited by
   `, . ! ?` OR the first 30 words, whichever comes first.
5. **VAD‑driven turn‑taking**: a cheap always‑on volume gate + Silero ONNX VAD;
   on a speech *pause* start processing the response speculatively, abort if
   speech resumes; while the agent is speaking, a VAD voice hit pauses TTS — a
   blip resumes, parsed words hard‑stop (cancel TTS *and* abort in‑flight
   LLM/drafter generation).
6. **Tight memory management** — RAM‑budget‑driven admission control, memory‑
   pressure eviction, idle‑unload, concurrency caps, ref‑counted onload/offload
   of {text target, drafter, ASR, TTS, VAD, embedding, vision}.

Eliza‑1 is *our* model — designed to run in this harness — so we get to shape the
output schema, the action/evaluator registration, and the runtime decode loop to
match. There is no separate "Eliza‑1 response JSON contract" doc today; the model
is (will be) trained on `eliza_native_v1` trajectory rows, i.e. its output shape
*is* whatever this harness emits at the `generateText` boundary. Changing the
harness's response shape changes the training target — coordinate via W3.

---

## 2. Current state — the facts you need (no re‑deriving)

### Local text inference engine (`packages/app-core/src/services/local-inference/`)
- Two backends behind `BackendDispatcher` (`backend.ts`): `NodeLlamaCppBackend`
  (`engine.ts` — in‑process `node-llama-cpp`, **does NOT stream tokens** —
  `session.prompt()` fires `onTextChunk` once with the full text — no drafter, no
  grammar use) and `DflashLlamaServer` (`dflash-server.ts` — spawns the patched
  `llama-server` over loopback, **real SSE streaming**, real `-md <drafter>
  --spec-type dflash --draft-min/max --ctx-size-draft --n-gpu-layers-draft
  --metrics --jinja`, `--slot-save-path`, `--slot-prompt-similarity 0.7`,
  `--parallel N` (4, or 8 for ≥128k), `cache_prompt:true`, deterministic
  `slot_id`, per‑conversation KV save/restore on conv open/close, mtime+24h slot
  eviction).
- All Eliza‑1 catalog tiers set `runtime.preferredBackend:"llama-server"` and
  `runtime.optimizations.requiresKernel:["dflash","turbo3","turbo4","qjl_full",
  "polarquant",(+"turbo3_tcq" if ctx≥64k)]`, so they always route to the dflash
  server, and the dispatcher hard‑errors if `CAPABILITIES.json` doesn't advertise
  those kernels. Catalog is consolidated in `packages/shared/src/local-inference/
  catalog.ts` + `types.ts`; `FIRST_RUN_DEFAULT_MODEL_ID="eliza-1-1_7b"`.
- **No grammar / GBNF / `json_schema` / `response_format` / prefill is ever passed
  to llama‑server.** `GenerateTextParams` *has* `responseSchema?: JSONSchema`,
  `plugin-local-ai/structured-output.ts` *can* build a `LlamaJsonSchemaGrammar`,
  `plugin-mlx` does `jsonSchema(...)` — none of it is used on the local-inference
  path. Zero plumbing for prefill / token‑infill / enum‑skip / mid‑generation
  token injection.
- **No pre‑warm / pre‑prefill of any prompt.** Slot pinning + `cache_prompt` exist;
  KV is populated lazily on the first real request. `openConversation` only
  *restores* a previously‑saved `.bin` (cross‑restart); it never issues a forward
  pass on the system prompt. The drafter is co‑resident only on the dflash path,
  **off by default on Metal** (`ELIZA_DFLASH_METAL_AUTO`).
- **Streaming out is not wired to the agent reply path** — only the internal
  `EngineVoiceBridge` consumes `onTextChunk`; `router-handler.ts` /
  `ensure-local-inference-handler.ts` never pass it; no SSE chat endpoint exists.
- Concurrency: `--parallel`; node pool 8 (`ELIZA_LOCAL_SESSION_POOL_SIZE`);
  generation serialized per backend; **exactly one model resident** (unload‑then‑
  load swap, no idle unload, no pressure eviction). `ram-budget.ts` is
  advisory‑only (Model Hub UI text), `minMb==recommendedMb` in catalog fallback,
  never gates load/unload/concurrency.
- Stale gating to reconcile: `dflash-server.ts:~285-313`
  (`assertCacheTypeSupportedOnBackend`) still refuses Metal turbo*/qjl/polar cache
  types calling the patch hooks "decorative‑only" — that's no longer true after
  the 2026-05-10/05-11 dispatch work; key the refusal off the real capability bit.
- `plugin-local-inference/src/` is a near‑complete mobile‑only **duplicate** of
  the desktop path with its own hardcoded catalog + downloader; `hf-search` route
  returns `{models:[]}`. AOSP dflash adapter is an explicit stopgap (no
  speculative C‑API, no caching).

### Voice pipeline (`.../local-inference/voice/*`, plugins)
- The whole `voice/` module is a **well‑typed scaffold with no engine behind it**:
  real data structures (`phrase-chunker.ts`, `ring-buffer.ts`, `rollback-queue.ts`,
  `lifecycle.ts` FSM, `ffi-bindings.ts` `bun:ffi` ABI‑v1 binding,
  `voice-preset-format.ts` full v1 binary reader/writer, `speaker-preset-cache.ts`,
  `phrase-cache.ts`) — but **no audio I/O, no real ASR/TTS model, no VAD**, and
  `engine.startVoice()` / `triggerBargeIn()` / `prewarmVoicePhrases()` are never
  called outside `*.test.ts`.
- ASR: `FfiOmniVoiceBackend.transcribe` → `eliza_inference_asr_transcribe` → stub
  `ELIZA_ERR_NOT_IMPLEMENTED` (`scripts/omnivoice-fuse/ffi-stub.c`). Batch‑only
  interface (`pcm → string`), no streaming partials. `TRANSCRIPTION` handler only
  behind `ELIZA_LOCAL_TRANSCRIPTION=1`. Working ASR exists *elsewhere* and is not
  wired to `voice/`: `plugin-local-ai` (whisper-node, batch), Electrobun
  `platforms/electrobun/src/native/{whisper,talkmode,swabble}.ts` (whisper.cpp,
  1.25 s overlapping windows — closest thing to streaming partials), `plugin-discord/voice.ts`.
- TTS: `FfiOmniVoiceBackend.synthesize` → stub. Only `StubOmniVoiceBackend` works
  → 100 ms of zeros per phrase. Renders a whole phrase per call (no streaming‑out).
  `cache/voice-preset-default.bin` is **not in the repo**. Working TTS *elsewhere*:
  `plugin-edge-tts` (cloud), `plugin-simple-voice`/`plugin-robot-voice` (SAM,
  `dist/`‑only — no `src/`), Electrobun ElevenLabs.
- VAD: **none**. No Silero ONNX, no onnxruntime, no volume gate in `voice/`.
  `BargeInController.onMicActive()` (`barge-in.ts`) is a bare boolean flip;
  nothing calls it. Volume VAD exists in `plugin-vision/src/audio-capture-stream.ts`
  (RMS 0.01) and `plugin-discord/voice.ts` (amplitude 0.05) — not wired to `voice/`.
- Barge‑in: `barge-in.ts` is a 33‑line toy (no blip/words distinction, no
  pause/resume). `scheduler.handleBargeIn()` does the mechanical TTS drain+cancel
  but **does not abort in‑flight LLM generation** — no cancel propagates into
  `dispatcher.generate`.
- LLM→TTS streaming: `PhraseChunker` flushes on `.!?` (**no comma**, contra spec)
  or `maxTokensPerPhrase` default **8** (contra "30 words") or N phonemes (needs a
  `PhonemeTokenizer` — only `CharacterPhonemeStub`, logs a "production must NOT see
  this" warning). The wired path `engine.voiceStreamingArgs()` →
  `bridge.pushAcceptedToken` → `scheduler.accept` → chunker → `backend.synthesize`
  → `PcmRingBuffer` is exercised only by `engine.voice.test.ts`. There IS a first‑
  sentence‑to‑TTS path in `packages/core/src/services/message.ts:~7612-7708`
  (extract first sentence → `useModel(TEXT_TO_SPEECH)`), but it's on the
  `dynamicPromptExecFromState` streaming path that the primary reply paths don't use.
- Speculative‑response‑on‑pause + abort: **not implemented at all**. `RollbackQueue`
  handles a *different* speculation (drafter‑token rejection → drop overlapping
  audio chunks), driven by accept/reject events the JS layer currently *synthesizes*
  from SSE deltas (the native DFlash verifier event stream is not exposed).
- FFI: `ffi-bindings.ts` is a real `bun:ffi` binding (ABI v1, all `eliza_inference_*`
  symbols, structured errors, Bun‑only) — but the only loadable lib is
  `libelizainference_stub.dylib` (all voice ops not implemented). The fused
  `omnivoice-fuse` build (`scripts/omnivoice-fuse/{ffi.h,prepare.mjs}`) is not
  exercised here.

### Response handler / planner / structured output (`packages/agent`, `packages/core`, `packages/prompts`)
- The Stage‑1 response is **not** the brief's `{shouldRespond, replyText, contexts,
  ...}` envelope. Today: `HANDLE_RESPONSE` tool call (`packages/core/src/actions/
  to-tool.ts` `HANDLE_RESPONSE_SCHEMA`, `messageHandlerTemplate` in
  `packages/prompts/src/index.ts`) → `{processMessage: enum[RESPOND,IGNORE,STOP]
  (dropped in DM/VOICE_DM/API/SELF channels via HANDLE_RESPONSE_DIRECT_SCHEMA),
  plan:{contexts:string[] required, contextSlices?, candidateActions?(≤12),
  parentActionHints?(≤6), reply?, requiresTool?, simple?}, thought,
  extract?{facts?,relationships?,addressedTo?}}`. `maxTokens:1024`,
  `toolChoice:"required"`. No `replyText`. Reply text comes from `plan.reply`
  (simple path) **or** a 2nd `generateDirectReplyOnce` `TEXT_SMALL` call when
  `plan.reply` is empty (`message.ts:~2542`) **or** the planner's `finalMessage` —
  three paths. Stage‑2 planner uses `PLAN_ACTIONS` → `{action:string,
  parameters:object, thought:string}`.
- `simple`/`contexts` gating is **real**: `SIMPLE_CONTEXT_ID="simple"`;
  `routeMessageHandlerOutput` (`message-handler.ts`) — `contexts:["simple"]` or
  empty → `final_reply` (no planner); `requiresTool`/non‑simple → `planning_needed`
  against `["general"]`; mixed → drop `simple`, plan against the rest. No literal
  "thread" object in core — "planning" = `packages/core/src/runtime/planner-loop.ts`
  (iterative tool‑chaining, sub‑planners, compaction, terminal sentinels
  `REPLY`/`IGNORE`/`STOP`). Threads/sub‑agents = `plugin-agent-orchestrator` (separate).
  Two overlapping "simple" signals exist (`plan.simple` vs `plan.contexts:["simple"]`)
  — unify (W3).
- Actions: `Action.parameters?: ActionParameter[]` with `schema` incl.
  `enum`/`enumValues`/`options`/`oneOf`/`anyOf`/`pattern` — **but no `outputSchema`**.
  `actionToJsonSchema` (`packages/core/src/actions/action-schema.ts`) /
  `actionToTool({strict:true})` exist; per‑action defs render into a *prompt text
  block*, not the tool‑calling API. The model only ever sees the fixed pair
  `HANDLE_RESPONSE` + `PLAN_ACTIONS` (kept fixed for byte‑stable prompt‑cache keys).
- Evaluators: two systems — `ResponseHandlerEvaluator` (`packages/core/src/runtime/
  response-handler-evaluators.ts` — sync, code‑only, run after Stage‑1 parse before
  routing, emit `ResponseHandlerPatch`) and classic `Evaluator` (`packages/core/src/
  types/evaluator.ts` has `schema:JSONSchema` — run post‑turn, batched into one
  structured model call). Neither is a field in the Stage‑1 JSON.
- Parsing: **batch** for Stage‑1 and planner. Incremental parsing exists only via
  `runtime.dynamicPromptExecFromState` + `StructuredFieldStreamExtractor`
  (`packages/core/src/utils/streaming.ts:~229` — line‑by‑line, per‑field deltas,
  `streamField:true`), used for first‑sentence‑TTS, not the response envelope.
- Structured output: `GenerateTextParams.responseSchema?` exists; planner uses it
  when no tools. **No token‑level infill / forced‑continuation / enum‑skip / prefill
  anywhere.**

### Kernels / native / build (`packages/inference/`, `packages/app-core/scripts/`)
- **Metal is the only fully‑wired path**: all five KV kernels
  (turbo3/turbo4/turbo3_tcq/qjl/polar) are hardware‑verified 8/8 on M4 Max AND
  graph‑dispatched + numerically smoke‑tested in the built fork (new ops
  `GGML_OP_ATTN_SCORE_QJL/TBQ/POLAR`, `_multi` entrypoints, multi‑block routing).
- Vulkan: 5/5 standalone verified (MoltenVK + Intel/lavapipe turbo* + Pixel 6a
  Mali standalone) but **built‑fork dispatch is source‑patched only, never run on
  native Vulkan HW**. CUDA/ROCm: needs‑hardware (CUDA only passes
  `cuda-preprocess-check`; ROCm has no fixture harness). iOS: symbols shipped,
  physical‑device XCTest passes (symbol resolution + xcframework structure only —
  no weights, no numeric generation). CPU: C‑reference parity only; AVX2/NEON
  paths in `packages/native-plugins/{qjl-cpu,polarquant-cpu}` are real working C
  libs but unbenched and **not imported by the runtime TS** (verification refs /
  fork‑port source).
- Build hooks `packages/app-core/scripts/kernel-patches/{metal,vulkan}-kernels.mjs`
  **do real work now** (the old `ELIZA_DFLASH_PATCH_*` decorative no‑ops were
  removed 2026‑05‑10). One stale comment in `dflash-server.ts` still says
  "decorative‑only".
- DFlash is a **genuine fork capability** (`general.architecture="dflash-draft"`,
  drafter tensors `dflash_fc.weight`/`dflash_hidden_norm.weight`, metadata
  `dflash-draft.dflash.{block_size,mask_token_id,target_layer_ids,n_target_features}`,
  `--spec-type dflash`, Prometheus drafted/accepted counters). `maybeRepairDflashDrafter`
  (`dflash-server.ts`) = a Python `gguf` script grafting the target's tokenizer
  merges into the drafter GGUF. `verify/dflash_drafter_runtime_smoke.mjs` is a
  runnable harness with **no passing‑on‑hardware evidence recorded** and
  **no speedup number anywhere** — `kernel-contract.json` marks `dflash`
  runtime‑ready by fiat.
- All Eliza‑1 weights are **stand‑ins** (`releaseState=local-standin`,
  `publishEligible=false`; `text/`/`dflash/` are hardlinks from upstream Qwen
  repos; 0.6B/1.7B drafters don't exist; no fine‑tuned eliza‑1 checkpoint exists).
  Build/verify *plumbing* against stubs/stand‑ins; gate "real" behavior behind a
  "real backend present" check.

### Caching / memory
- KV reuse cache‑key precedence (`cache-bridge.ts`): `conv:<conversationId>` →
  `seg:<hashStablePrefix(promptSegments)>` (longest run of `stable:true` segments,
  stops at first unstable) → `pfx:<prefixHash>` → `v5:<prefixHash>`. Model
  fingerprint = sha256(target+drafter+cache‑types+ctx+parallel)[:16], one slot dir
  per fingerprint. Depends on the runtime emitting `providerOptions.eliza.
  {conversationId,promptSegments,prefixHash}` via `buildProviderCachePlan` in
  `@elizaos/core` — **verify it actually does on the voice/response path**.
- `OptimizedPromptService` (`packages/core/src/services/optimized-prompt.ts`):
  loads MIPRO/GEPA/bootstrap artifacts from `~/.milady/optimized-prompts/<task>/`;
  zero coupling to the local‑inference KV (only indirectly helps cache stability by
  keeping prompt text stable). Tasks: `should_respond | context_routing |
  action_planner | response | media_description`.
- `__stress__/*` + `dflash-cache-flow.test.ts` exercise an in‑process HTTP mock of
  llama‑server, never the real binary.

---

## 3. The wishlist — itemized (every worker owns a subset)

**A. Audio front‑end / VAD / wake / barge‑in** — A1 real VAD (RMS gate → Silero
ONNX `vad/silero-vad-int8.onnx`); A2 volume‑gate → wake the response pipeline
early; A3 mic capture streaming PCM into `PcmRingBuffer`; A4 speculative‑on‑pause
→ abort‑on‑resume; A5 barge‑in (pause TTS on voice, resume on blip, hard‑stop on
words — cancel TTS *and* abort LLM/drafter); A6 blip‑vs‑words classifier.

**B. ASR / STT** — B1 real on‑device ASR (Qwen3‑ASR GGUF / whisper.cpp interim);
B2 streaming partial transcripts; B3 STT‑finish → inject user tokens into the
already‑started prompt; B4 ASR concurrent with the response‑handler precache.

**C. Response‑handler precache + prefill + in‑fill / structure forcing** — C1
KV‑prefill the response prompt while STT runs; C2 shouldRespond shortcut on
`"I"`/`"R"`; C3 infill the next param key on `",\n`; C4 single‑value enum/option
skip; C5 forced skeleton carries all expected evaluators; C6 `contexts` after
`replyText` gates simple‑vs‑planning; C7 fire first `replyText` chunk to TTS
immediately; C8 stream `replyText` into TTS (token stream, else `, . ! ?` / 30
words).

**D. Tool‑calling / action & evaluator schema registration** — D1 every action
registers an output schema (or its `parameters` schema is authoritative); D2
surface all actions as a real tool array / generate per‑turn GBNF; D3 evaluators'
params reflected in the forced output schema; D4 `actionToJsonSchema`/`actionToTool`/
`HANDLE_RESPONSE_SCHEMA`/`PLAN_ACTIONS` become the single grammar source.

**E. DFlash speculative decoding** — E1 confirm/finish hot‑path wiring; E2
pre‑cache the drafter on load (decide `ELIZA_DFLASH_METAL_AUTO` default); E3
forced spans injected without spending draft/verify cycles; E4 measure dflash
speedup (acceptance rate, tok/s with/without); E5 rollback‑safe TTS via the native
verifier event stream.

**F. Fused streaming model→model / in‑process inference** — F1 stream one model's
output into the next (ASR→LLM, LLM→TTS); F2 fused `libelizainference` server (one
process: text + dflash + `/v1/audio/speech` + ASR), real GGUF TTS/ASR, native
verifier events; F3 in‑process FFI text path for mobile/AOSP; F4 decide
desktop hot path (recommend: `llama-server`+streaming/grammar for desktop now,
FFI for mobile + the unified voice server).

**G. Streaming LLM → TTS** — G1 wire the agent reply path to pass `onTextChunk`;
G2 chunker flushes on `, . ! ?` OR 30 words; G3 real phoneme tokenizer; G4 TTS
consumes a stream / sub‑phrase granularity with backpressure into a real audio
sink; G5 unify the first‑sentence‑TTS path.

**H. Audio pre‑generation / phrase + speaker preset caching** — H1 ship
`cache/voice-preset-default.bin` + a real phrase‑cache seed; H2 idle‑time
auto‑prewarm of common phrases; H3 real LRU + multi‑voice in `SpeakerPresetCache`;
H4 pre‑generate the first‑audio filler on VAD fire.

**I. Caching & precaching (text‑side)** — I1 `prewarmConversation(systemPrompt,
toolDefs, assistantTurnStart)` → `max_tokens:1`/`n_predict:0` against the pinned
slot; I2 verify `buildProviderCachePlan` emits `conversationId`/`promptSegments`/
`prefixHash` on the voice path; I3 keep‑alive / warm‑on‑load; I4 honor per‑key
TTL in slot eviction; I5 a precache‑strategy doc.

**J. Memory / resource management** — J1 RAM‑budget admission control; J2
memory‑pressure eviction; J3 idle‑unload timer; J4 RAM/HW‑derived concurrency
caps, auto‑resize `--parallel`; J5 ref‑counted onload/offload of all model roles
via `SharedResourceRegistry`.

**K. Instrumentation / benchmarks / gates** — K1 end‑to‑end span tracing
(VAD‑trigger → ASR‑partial → ASR‑final → first‑LLM‑token → first‑replyText‑char →
first‑TTS‑audio → first‑audio‑played); K2 dflash acceptance/tok‑s benchmark; K3
barge‑in latency, 30‑turn endurance, mobile peak RSS/thermal; K4 feed real numbers
into `packages/training/benchmarks/eliza1_gates.yaml` + manifest `evals`.

**L. Cross‑cutting cleanup** — L1 reconcile stale Metal gating in `dflash-server.ts`;
L2 unify the two "simple" signals; L3 reconcile `LocalRuntimeKernel` vs
`Eliza1Kernel` enums (or document); L4 desktop default backend story; L5
regenerate stale `ios-physical-device-smoke.md`; **migration**: `elizaOS/llama.cpp`
→ `elizaOS/llama.cpp` in all refs (code/docs done in the bootstrap commit; the
GitHub repo transfer + CI secret update is a manual org‑admin follow‑up — see §6).

---

## 4. Worker definitions

> Each worker: **research first** (deep‑read your files + the open questions in
> your section), **write a critical assessment** of your area into your final
> report, **implement the final version** (no stepping stones, no stubs you don't
> have to ship), **verify** with `bun run verify` + your area's tests, leave a
> concise report. Mark your worker section "DONE — <branch>" when finished.

### WAVE 1 (launched)

**W1 — Audio front‑end: mic capture + VAD + wake + barge‑in core**
- Owns: `voice/vad.ts` (new), `voice/mic-source.ts` (new) + one connector hook,
  `voice/barge-in.ts` (rewrite), Silero ONNX loader, the `VadEvent` stream.
- Build: (a) cheap always‑on RMS energy gate; (b) Silero int8 ONNX VAD via a
  minimal onnxruntime binding (reuse `plugin-vision/src/audio-capture-stream.ts`
  patterns; the `vad/silero-vad-int8.onnx` artifact is in the bundle layout —
  download/stage it if missing); (c) `VadEvent` stream `{speechStart, speechActive,
  speechPause(ms), speechEnd, blip}`; (d) real `onMicActive`/`onMicWords` feeding
  `BargeInController`; (e) blip‑vs‑words classifier (energy‑duration now;
  ASR‑token‑confirm gate once W2's partials land — define the interface);
  (f) a `MicSource` that streams PCM frames into a `PcmRingBuffer` from one real
  source — pick **desktop/Electrobun mic** as the first target (`platforms/
  electrobun/src/native/`), expose a documented `MicSource` interface so
  Discord/Telegram/mobile plug in later.
- Deliverables: subscribable VAD event stream; barge‑in controller with blip/words
  distinction; documented `MicSource` interface; tests.
- Depends on: nothing to start. Coordinates the `VadEvent`/`MicSource` contract
  with W9 (Wave 2) — put those types in `voice/types.ts`.

**W2 — ASR/STT: real transcription + streaming partials**
- Owns: `voice/transcriber.ts` (new `StreamingTranscriber` interface),
  `voice/engine-bridge.ts` transcribe path, `runtime/ensure-local-inference-handler.ts`
  `TRANSCRIPTION` handler, an interim whisper.cpp adapter, the fused‑path ASR stub
  (W7 fills the real impl).
- Build: (a) `StreamingTranscriber`: `feed(pcmFrame) → emits {partial, isFinal,
  tokens}`; (b) interim impl reusing the Electrobun `whisper.ts`/`talkmode.ts`
  overlapping‑window logic (1.25 s windows) — download a whisper GGUF if needed;
  (c) the fused impl coded against the future `eliza_inference_asr_*` streaming API
  (W7 owns the C side; coordinate the ABI in `scripts/omnivoice-fuse/ffi.h`);
  (d) wire `TRANSCRIPTION` model handler to it (drop the `ELIZA_LOCAL_TRANSCRIPTION`
  gate — default‑on when a voice bridge is armed); (e) partials feed W1's classifier
  and W9's speculative‑on‑pause.
- Depends on: W1 (`VadEvent` to gate ASR), W7 (fused ASR ABI — stub OK in Wave 1).

**W3 — Response envelope unification + streaming structured Stage‑1 + prefill/grammar contract**
- Owns: `packages/prompts/src/index.ts` (`messageHandlerTemplate`),
  `packages/core/src/services/message.ts` (Stage‑1 call site + routing),
  `packages/core/src/types/model.ts` (`GenerateTextParams`),
  `packages/core/src/utils/streaming.ts` (`StructuredFieldStreamExtractor`),
  `packages/core/src/actions/to-tool.ts`, `packages/core/src/runtime/message-handler.ts`.
- Build: (a) **define and thread the contract** that W4/W6/W8 consume — extend
  `GenerateTextParams` with `prefill?: string` (assistant‑turn continuation),
  `forcedSpans?` / `responseSkeleton?` (the JSON envelope skeleton to infill),
  `grammar?: GBNF`, `streamStructured?: boolean`; thread through `useModel` →
  router‑handler → local handler (W4/W6) → engine (W4); cloud adapters ignore the
  new fields (no fallback sludge, just an unused param). (b) Make the Stage‑1
  `HANDLE_RESPONSE` call `streamStructured:true`, parse incrementally, route
  `processMessage`/`contexts` the moment they're known, fire the first `reply`/
  `replyText` chunk to TTS as soon as that field opens (reuse/extend the
  `message.ts:~7612` first‑sentence path). (c) Unify reply‑text origin to one
  streamed structured generation — Stage‑1 emits the user‑facing text inline; kill
  the 2nd `generateDirectReplyOnce` `TEXT_SMALL` call. (d) Decide the envelope: a
  single ordered object `{processMessage/shouldRespond, thought?, replyText,
  contexts, <evaluator params...>, actions?, extract?}` — keep `contexts` directly
  after `replyText` per the brief, keep the prompt prefix byte‑stable so the
  precache key holds (the per‑turn variation lives in the *grammar*, not the prompt
  text). (e) Extend `StructuredFieldStreamExtractor` to emit per‑field
  "start"/"done" events (detect `"replyText": "` start, `",\n` boundaries) so the
  forced‑skeleton emitter (W8) and the TTS handoff (W9) hook in. (f) L2: unify
  `plan.simple` vs `plan.contexts:["simple"]` — pick `contexts`.
- Deliverables: the `prefill`/`grammar`/`forcedSpans`/`streamStructured` contract
  (documented in `model.ts`); the unified streamed Stage‑1; per‑field events; tests.
  **Coordinate the envelope change with the training side** — note it in your
  report so `packages/training/scripts/format_for_training.py` and the prompt
  registry stay aligned.
- Depends on: nothing to start (it defines the contract). W4, W8, W6, W9 read it.

**W4 — DFlash llama‑server engine: grammar + prefill + token‑level forced‑span decode + streaming‑out + drafter preload + benchmark**
- Owns: `local-inference/dflash-server.ts`, `local-inference/engine.ts`,
  `local-inference/backend.ts`, `local-inference/router-handler.ts`,
  `runtime/ensure-local-inference-handler.ts` (the generate plumbing),
  `dflash-doctor.ts`, `verify/dflash_drafter_runtime_smoke.mjs`,
  `voice/rollback-queue.ts` wiring, `voice/shared-resources.ts` `DflashDrafterHandle`,
  and a fork patch in `packages/app-core/scripts/build-llama-cpp-dflash.mjs` /
  `kernel-patches/` if `llama-server` lacks the needed features.
- Build: (a) **Research the fork's `llama-server` capability**: does
  `/v1/chat/completions` + `/completion` support `grammar` / `grammar_lazy` /
  `json_schema` / `response_format`, and an assistant‑turn prefill (continue a
  partial assistant message)? Does `/completion` accept `n_predict:0`? Is there a
  `/tokenize` + raw `/completion` path for token‑level span injection? If features
  are missing, patch the fork (the build script already patches `server.cpp`).
  (b) Implement `prefill` (send the partial assistant turn so generation continues
  it). (c) Implement **forced‑span infill**: when `forcedSpans`/`responseSkeleton`
  is set, prefer expressing the whole skeleton as a *lazy GBNF* so the model only
  samples free positions (single‑value enums collapse to literals — C4); the
  multi‑call loop (`/completion` until a span boundary, inject forced tokens, continue)
  is the fallback. (d) Make the **agent reply path pass `onTextChunk`** end‑to‑end
  (it currently doesn't). (e) Add `prewarmConversation()` primitive (W6 calls it):
  `max_tokens:1`/`n_predict:0` against the pinned slot with `cache_prompt:true`.
  (f) Make drafter‑preload explicit on model load; decide `ELIZA_DFLASH_METAL_AUTO`
  default once the Metal kernel‑dispatch story is confirmed runtime‑ready. (g)
  Reconcile L1 (the stale `assertCacheTypeSupportedOnBackend` gating — key off the
  real capability bit). (h) Expose the **native DFlash accept/reject verifier event
  stream** from `llama-server` (Prometheus counters → an SSE side‑channel or parse
  the stream) and feed `RollbackQueue` (replace the JS‑synthesized accept/reject).
  Forced spans must not consume draft/verify cycles. (i) **Measure dflash speedup**:
  wire `dflash_drafter_runtime_smoke.mjs` to record acceptance‑rate + tok/s
  (with vs without) to a report JSON; add to the CI matrix where hardware allows.
- Depends on: W3's `GenerateTextParams` contract. Provides `prewarmConversation`
  to W6, the verifier stream to W9, the grammar transport to W8.

> NOTE: W4 is the heaviest worker. If the forced‑span/grammar work and the
> verifier‑stream/benchmark work diverge enough to parallelize, split into W4a
> (engine: grammar/prefill/forced‑span/streaming/prewarm) and W4b (dflash: drafter
> preload/verifier stream/rollback/benchmark) — but W4a owns `dflash-server.ts`
> writes, W4b's `dflash-server.ts` changes go through W4a.

### WAVE 2 (specced; launches after Wave 1 lands its contracts)

**W6 — Caching/precache: `prewarmConversation`, cache‑plan verification, keep‑alive, TTL.**
Owns `cache-bridge.ts`, `conversation-registry.ts`, `router-handler.ts`,
`ensure-local-inference-handler.ts`, `@elizaos/core` `buildProviderCachePlan`,
`packages/inference/PRECACHE.md` (new — I5). Calls W4's `prewarmConversation`; verify
the cache plan emits `conversationId`/`promptSegments`/`prefixHash` on the voice +
response‑handler path; warm‑on‑load + keep‑alive timer; honor per‑key TTL in slot
eviction. Items I1–I5, C1 mechanism, L3 (enum doc).

**W7 — Fused `libelizainference`: real GGUF TTS + ASR + verifier events in one process.**
Owns `scripts/omnivoice-fuse/*` (replace `ffi-stub.c` with a real build — pull in
`github.com/ServeurpersoCom/omnivoice.cpp`), `voice/ffi-bindings.ts`,
`voice/engine-bridge.ts` FFI backend, `build-llama-cpp-dflash.mjs` omnivoice‑fuse
target. Real `eliza_inference_tts_synthesize` (streaming‑out PCM chunks),
`eliza_inference_asr_transcribe` (streaming partials), `mmap_acquire/evict`, the
native DFlash verifier callback. Keep `llama-server` loopback as the desktop text
fallback; fused = mobile + the unified voice server. If `omnivoice.cpp` source is
unavailable, scope to defining + stubbing the real ABI so W2/W5/W9 integrate
against it, and flag the fused build as a follow‑up. Items B1, F1, F2, G4, H (engine).

**W8 — Action/evaluator schema registration + per‑turn grammar generation.**
Owns `packages/core/src/types/components.ts` (`Action`), `action-schema.ts`,
`to-tool.ts`, `packages/core/src/types/evaluator.ts`, new
`buildResponseGrammar(actions, evaluators, contexts)`. Add `outputSchema?` to
`Action` (or formalize `parameters` as authoritative); make `actionToJsonSchema`/
`actionToTool` the single source of truth; `buildResponseGrammar()` composes the
Stage‑1 skeleton (envelope keys in fixed order + `replyText` free + `contexts`
enum from registered context ids + per‑action params for `PLAN_ACTIONS` +
evaluator params) into a lazy GBNF — single‑value enums collapse to literals.
Keep the *prompt text* byte‑stable (grammar varies per turn, not the prompt).
Items C3, C4, C5, D1–D4. Depends on W3 (envelope), W4 (grammar transport).

**W9 — Voice scheduler: speculative‑on‑pause + abort, LLM↔TTS streaming, chunking spec, rollback.**
Owns `voice/scheduler.ts`, `voice/phrase-chunker.ts`, `voice/rollback-queue.ts`,
`voice/engine-bridge.ts`, `engine.ts` `voiceStreamingArgs`/`triggerBargeIn`, new
`voice/turn-controller.ts`. Turn controller: on `speechPause(ms>thr)` → kick a
speculative response off W2's partial transcript (calls W6 prewarm + W4 generate
with a `CancelSignal`); on `speechActive`/`speechEnd` re‑trigger → abort it (cancel
propagates into `dispatcher.generate`, not just TTS); on `speechEnd` no‑new‑speech
→ promote/finalize. Barge‑in: agent speaking + VAD voice → pause TTS; blip → resume;
W1 "words" → hard‑stop TTS *and* abort LLM/drafter. Fix `phrase-chunker.ts`: flush
on `, . ! ?` OR 30 words. Wire token‑level LLM→TTS from W3/W4 streaming output into
the chunker. Consume W4's rollback/verifier events. Items A4, A5, A6 completion,
C7/C8, G2, E5. Depends on W1, W2, W3, W4, W7.

**W10 — Memory / resource management.**
Owns `ram-budget.ts`, `active-model.ts`, `hardware.ts`, `assignments.ts`,
`conversation-registry.ts`, `voice/shared-resources.ts`, new `local-inference/
memory-monitor.ts`. Wire `ram-budget.ts` into `ActiveModelCoordinator.activate()`
(refuse / pick smaller tier; pick the largest context variant that fits);
`memory-monitor.ts` watches `os.freemem()` and drops lowest‑priority resident
weights (drafter < vision < ASR < TTS < text‑target) under pressure (`evictPages()`
for voice); idle‑unload timer; RAM/HW‑derived concurrency caps + auto‑resize
`--parallel`; `SharedResourceRegistry` becomes the general onload/offload
coordinator for all model roles. Items J1–J6, I3 partial.

**W11 — Instrumentation, latency budget, benchmarks, gates.**
Owns new `local-inference/latency-trace.ts`, `llama-server-metrics.ts`,
`verify/dflash_drafter_runtime_smoke.mjs` (with W4), `packages/training/benchmarks/
eliza1_gates.yaml`, manifest `evals` writers. End‑to‑end span tracing
(VAD‑trigger → ASR‑partial → ASR‑final → first‑LLM‑token → first‑replyText‑char →
first‑TTS‑audio → first‑audio‑played), per‑stage histograms, `/api/dev/...` + CLI
surface; dflash acceptance/tok‑s benchmark; barge‑in latency, 30‑turn endurance,
mobile peak RSS/thermal harnesses; feed real numbers into `eliza1_gates.yaml` +
manifest `evals`. Items K1–K4, E4. Depends on W3/W4/W9 hooks for full traces.

**W12 — Native/kernel follow‑through + stale‑gating cleanup.**
Owns `dflash-server.ts` gating (with W4), `kernel-patches/*`,
`packages/inference/verify/*`, `kernel-contract.json`,
`packages/inference/reports/.../ios-physical-device-smoke.md`. Reconcile L1
(capability‑bit gating); extend the Vulkan fixture harness to cover the staged
fallback entrypoints (`qjl_get_rows`, `qjl_mul_mv`, `polar_get_rows`); scope (don't
necessarily execute) the native‑HW gaps (Vulkan native graph‑dispatch evidence,
CUDA/ROCm runs, iOS weight‑backed bundle smoke) into a clear "needs HW X" ledger;
evaluate the `GGML_OP_FUSED_ATTN_QJL_TBQ` fused attn kernel on Metal (highest‑
leverage perf item per `kernel-optimization-review.md`); regenerate the stale
`ios-physical-device-smoke.md` (L5). Items L1, L4, L5, K3 partial, kernel backlog.

**W13 — Audio assets + phrase/preset cache content + voice plugin consolidation.**
Owns `voice/phrase-cache.ts`, `voice/speaker-preset-cache.ts`, `cache/voice-preset-default.bin`
(produce via `writeVoicePresetFile`), `plugin-simple-voice`/`plugin-robot-voice`
(`src/` is missing — restore or remove). Seed the phrase cache with common
openers/acks ("one sec", "got it", "hmm", "okay so…"); idle‑time auto‑prewarm
(gate behind "real backend present"); pre‑generate the first‑audio filler on VAD
fire (calls W9 + cache); real LRU + multi‑voice in `SpeakerPresetCache`; decide the
fate of `plugin-simple-voice`/`plugin-robot-voice` (restore `src/` or delete).
Items H1–H4, G3 partial.

---

## 5. Dependency graph

```
W3 (envelope + GenerateTextParams contract) ──┬─> W4 (engine: grammar/prefill/forced-span/prewarm/dflash)
                                              ├─> W8 (action grammar)
                                              ├─> W6 (prewarmConversation, cache plan)
                                              └─> W9 (LLM→TTS streaming, turn controller)
W4 ──┬─> W6 (prewarmConversation primitive)   ├─> W9 (rollback/verifier events, cancel)   └─> W11 (dflash benchmark)
W1 (VAD/mic contract) ──┬─> W2 (ASR confirm-words gate)   └─> W9 (speculative-on-pause / barge-in)
W2 ──> W9
W7 (fused ABI) ──┬─> W2 (fused ASR impl)   ├─> W4/W9 (verifier events)   └─> W9/W13 (streaming TTS)
W10, W12: largely independent. W11 needs W3/W4/W9 hooks for full traces. W13 needs W7 for non-trivial audio.
```

Shared‑type ownership: `voice/types.ts` is the meeting point for `VadEvent`,
`MicSource`, `StreamingTranscriber`, `CancelSignal` flow. `packages/core/src/types/
model.ts` is the meeting point for `prefill`/`grammar`/`forcedSpans`/`streamStructured`.
`scripts/omnivoice-fuse/ffi.h` is the meeting point for the fused ABI.

---

## 6. Git workflow + the llama.cpp migration

**Git rules (from the repo `AGENTS.md` — non‑negotiable):** commit to the branch
you're on, in the worktree you're in. Never `git stash`. Never switch branches.
Many small WIP commits over uncommitted work. Push proactively. Worktree‑isolated
workers: each produces a branch; the orchestrator merges. When you finish, leave a
short report and mark your §4 section "DONE — <branch>".

**Verification:** `bun run verify` (typecheck + lint) + your area's tests
(`engine.voice.test.ts`, `cache-bridge.test.ts`, `dflash-server.test.ts`,
`__stress__/*`, `manifest.test.ts`, `voice/*.test.ts`, plus new tests for new
behavior). W4/W6 should add at least one test against a real `llama-server` binary
if one is buildable. Use `/phase-review` at wave boundaries.

**`elizaOS/llama.cpp` → `elizaOS/llama.cpp` migration:**
- The bootstrap commit migrates **all code/doc string references** from
  `elizaOS/llama.cpp` to `elizaOS/llama.cpp` (default `ELIZA_DFLASH_LLAMA_CPP_REMOTE`
  value, prose, comments, manifests). Existing `vX.Y.Z-milady` tag names are kept
  (they are real git refs on the fork; they transfer with the repo).
- **Manual org‑admin follow‑up (cannot be done from here):** transfer the GitHub
  repo `github.com/elizaOS/llama.cpp` → `github.com/elizaOS/llama.cpp` (GitHub
  "Transfer ownership"), update any CI secrets / org settings that reference the old
  path, then delete/redirect the `milady-ai` repo. Until that transfer happens,
  `ELIZA_DFLASH_LLAMA_CPP_REMOTE` must be set to the old URL to build, OR push a
  mirror to `elizaOS/llama.cpp` first. Track this in `packages/inference/AGENTS.md`.
- Out of scope for the migration: `milady-ai/eliza.git` (the elizaOS app repo) and
  the historical `reports/porting/2026-05-10/milady-ai-repos/` artifact dir — leave
  those.

---

## 7. Hard rules

- **Final version, no stepping stones.** Don't ship a stub you don't have to.
  Where the real engine doesn't exist yet (fused TTS/ASR, trained weights), build
  the *final plumbing* and gate the real behavior behind a "real backend present"
  check — don't fake the behavior.
- **No fallback sludge.** New `GenerateTextParams` fields are simply unused by
  adapters that can't honor them — no `if (!supported) return baseline()` branches
  that hide failures.
- **Keep the response prompt prefix byte‑stable.** Per‑turn variation lives in the
  grammar, not the prompt text — the precache key depends on this.
- **Don't break cloud adapters.** The infill/forcing path is local‑model‑only; the
  cloud path keeps working unchanged.
- **Respect `packages/inference/AGENTS.md` §3** — required kernels are required; no
  quiet `if (!available) return baseline()`.
- **Scope discipline (repo `CLAUDE.md`)** — don't invent product behaviors; when
  unsure about product semantics, ask.
