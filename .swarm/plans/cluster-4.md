# Cluster 4 — Guided structured decode + fused zero-copy streaming (research plan)

Scope (from `.swarm/TODO.md`): (A) the schema-driven deterministic-token fill
("narrow-to-singleton → auto-complete + advance"), riding on `buildResponseGrammar` →
GBNF → `grammar_lazy` + `prefill`/`responseSkeleton`/`grammar` + the dflash spec-decode
path; (B) the real `eliza_inference_{asr,tts}_stream_*` decoders + the zero-copy
ring hand-off + the within-turn `madvise(MADV_DONTNEED)` RSS trim + the weight-fusion
("one ggml graph") verdict. RESEARCH → plan; implementation is gated on cross-review.

---

## PART A — Guided structured decode

### A.1 Audit: does eliza-1 already do this?

**Partly. The *producer* and *plan* sides are complete; the *server fast-forward* is not.**

What exists (verified by reading the files):

- `packages/core/src/runtime/response-grammar.ts` — `buildResponseGrammar` /
  `buildPlannerActionGrammar` / `buildPlannerParamsSkeleton`: walk registered actions +
  Stage-1 field evaluators + context ids, emit a `ResponseSkeleton` (flat span list:
  `literal` / `enum` / `free-string` / `free-json`) **plus a precise GBNF string** (the
  `contexts` array-of-enum). Single-value string-enum fields already lower to `literal`
  spans (zero sampled tokens). Process-wide cache keyed on the structure signature.
- `packages/app-core/src/services/local-inference/structured-output.ts` —
  `collapseSkeleton` (≤1-value enums → literals), `compileSkeletonToGbnf` (lazy GBNF;
  trigger word = the leading literal), `resolveGrammarForParams` (precedence: explicit
  `grammar` > skeleton), `grammarRequestFields` (→ `grammar` / `grammar_lazy` /
  `grammar_triggers`). **Plus** the full deterministic-token plan: `PrefillRun` /
  `ElizaPrefillPlan` / `compilePrefillPlan` (walk spans, merge consecutive literals into
  runs anchored by *position* in the run/free-span alternation, leading run = the
  assistant-turn prefill), `prefillPlanRequestFields` (→ `eliza_prefill_plan`),
  `ElizaHarnessSchema` / `elizaHarnessSchemaFromSkeleton`, `resolveGuidedDecodeForParams`,
  short↔long-name maps. Tests + a static token-savings bench
  (`packages/inference/verify/guided_decode_token_bench.mjs`, ≈28% aggregate forced).
- `dflash-server.ts` `buildChatCompletionBody` already folds in `grammar` / `grammar_lazy`
  / `grammar_triggers`, an assistant-turn `prefill` (+ `continue_final_message` /
  `add_generation_prompt:false`), and `eliza_prefill_plan` — **only when an `elizaSchema`
  carried a plan**. `generateWithUsage` re-prepends the resolved prefill to the streamed
  tail via the same resolver so the two never diverge.
- `engine.ts` (node-llama-cpp path) — same grammar resolution + prefill seeding; the
  prefill plan is ignored there (no token-splice API).
- Off-by-default switch: `ensure-local-inference-handler.ts` builds the `ElizaHarnessSchema`
  only when `providerOptions.eliza.guidedDecode === true` or `MILADY_LOCAL_GUIDED_DECODE=1`.
- Build-time reporter: `packages/app-core/scripts/kernel-patches/server-structured-output.mjs`
  reports `eliza_prefill_plan` present/absent (item 7) — **absent in the current fork pin**.
- Design doc: `packages/inference/reports/porting/2026-05-11/guided-structured-decoding.md`.

What the fork actually does today (verified in `packages/inference/llama.cpp @ eae44e75`):

- `src/llama-grammar.cpp` is essentially stock llama.cpp GBNF: it maintains pushdown
  *stacks*, and `llama_grammar_apply_impl` *rejects candidate tokens* that the stacks
  forbid (a sampling **mask**). It does **not** detect "the allowed-token set is a
  singleton" and write that token without a forward pass — every forced scaffold token
  still costs one `decode()`. So GBNF "collapses singletons" only in the trivial sense
  that the *grammar* permits exactly one continuation; the *server* still runs a forward
  pass to sample it.
- `common/common.h` / `common/chat.h` / `common/sampling.cpp` / `tools/server/*.cpp`
  carry `grammar_lazy` + `grammar_triggers` + `json_schema` + `response_format` — so the
  *lazy* trigger mechanism works. There is **no** `eliza_prefill_plan` / `forced_span` /
  fast-forward path anywhere in the fork (`grep -rn eliza_prefill|forced_span` → 0 hits).
- The speculative loop lives in `tools/server/server-context.cpp` (`spec`,
  `common_speculative_gen_draft`, `n_draft_max`, `n_draft_total`/`n_draft_accepted`) — a
  draft → batched-verify → accept-prefix loop. It is grammar-aware via the sampler chain
  but is **not** wired to "the grammar pins the next K tokens deterministically → skip
  draft/verify entirely for that run".

**Verdict:** the contract, the plan format, the runtime wiring, the off switch, and the
bench are all in tree and correct. The **gap** is the one piece that turns the ≈28%
"tokens the grammar forces" into ≈28% **fewer forward passes**: a fork-side
forced-token fast-forward in the server decode loop that consumes `eliza_prefill_plan`
(or, equivalently, *derives* the forced run from the grammar's allowed-token mask when it
narrows to a single byte/token sequence). Today the lazy GBNF still forces byte-identical
output — correctness is unaffected, only the latency win is unrealized.

### A.2 Design: fork-side forced-token fast-forward

Two complementary mechanisms; ship #1 (explicit plan, low blast radius) first, evaluate #2.

**Mechanism 1 — consume `eliza_prefill_plan` (explicit, schema-driven).**
The runtime already sends `{ prefix, runs:[{after_free_span,text}], free_count, id }`.
Server changes (all in `packages/inference/llama.cpp` fork; surfaced as a `kernel-patches/`
patch + a submodule bump — *not* a regex `kernel-patches/` edit, that's unsafe here):

1. **Parse** `eliza_prefill_plan` in `server-task.cpp` (alongside `grammar` / `grammar_lazy`):
   tokenize each `run.text` once (cached by `id` — the runs are byte-stable across turns),
   store the ordered run list + `free_count` on the slot.
2. **Seed the leading run as prefill** (the runtime already also sends it as an
   assistant-turn message + `continue_final_message`; the server already prefills assistant
   text — so the leading run costs zero `decode()` for *generation* either way, just a
   prefill `decode()` over the prompt+prefix which the prompt-cache absorbs across turns).
3. **After the model samples a free span** (detected by: the grammar stack just finished a
   `free-string` / `free-json` / multi-value `enum` rule and re-entered the root rule's
   next literal): instead of sampling the next literal-run tokens one by one, **write the
   cached token ids for `run[after_free_span = currentFreeIdx]` directly into the sequence,
   advance `n_past`, advance the grammar stacks by feeding those bytes, and bump
   `currentFreeIdx`** — zero forward passes for that run. The output stream surfaces those
   tokens to the SSE/`content` exactly as if sampled (they go through `slot.add_token` so
   `completion_tokens` and the streamed chunks are unchanged).
4. **The tail run** (`after_free_span = free_count-1`, the closing braces) is written the
   same way; then the slot finishes (the grammar stack is at EOF).
5. **Robustness**: if the model's free-span output makes the grammar stack *not* land
   exactly at the expected literal run (shouldn't happen — the grammar already pins it —
   but a sampling bug or a stale plan `id` could), fall back to plain constrained sampling
   for the rest of the turn and log once. The plan is a hint; the grammar is the
   correctness floor (this is the AGENTS.md §4 "tolerant, never fails" contract for the
   structured-output HTTP surface).

**Mechanism 2 — derive the forced run from the grammar mask (no plan needed).**
Generalizes #1 to *any* GBNF, not just eliza-harness skeletons. After each accept, before
the next `decode()`: probe the grammar — does the union of all allowed next tokens, across
all live stacks, reduce to exactly one token (or a deterministic chain of single-token
steps)? llama.cpp's grammar already has `llama_grammar_apply_impl` over the full vocab;
add a `llama_grammar_next_forced_run(grammar, vocab) -> std::vector<llama_token>` that
walks the deterministic prefix (greedily: while exactly one token is accepted by every
stack, append it and advance). If non-empty, splice it in (same as #1 step 3) and skip the
forward passes. Cost: one vocab-sized mask eval per forced run boundary (cheap vs a
forward pass; and the eval is already done as part of sampling, so it's near-free if
hoisted). This is strictly better than #1 (works for `json_schema` callers, for the
`contexts` enum array, for action `parameters` schemas) but riskier (touches the core
grammar engine + the sampling fast-path). Plan: implement #2 behind
`ELIZA_GRAMMAR_FAST_FORWARD=1` (default on once verified), keep #1's `eliza_prefill_plan`
as the *explicit* path the runtime always sends (it lets the server skip the mask probe
entirely when the plan is present and trusted).

**Where it lands in the fork:**
- `src/llama-grammar.{h,cpp}` — `llama_grammar_next_forced_run` (Mechanism 2).
- `tools/server/server-task.{h,cpp}` — parse `eliza_prefill_plan`, store on the slot.
- `tools/server/server-context.cpp` — in the per-token generation loop (and the
  speculative loop), after `accept`, before the next `decode`: if a forced run is pending
  (from the plan) or `llama_grammar_next_forced_run` returns non-empty, splice + advance,
  emit tokens via `add_token`, skip the `decode`.
- `packages/app-core/scripts/kernel-patches/server-structured-output.mjs` — flip the
  `eliza_prefill_plan` report to "present" once the fork pin carries it; add a probe for
  `ELIZA_GRAMMAR_FAST_FORWARD`.
- `packages/inference/verify/guided_decode_token_bench.mjs` — the `--bin … --model …`
  live mode now measures the *real* wall-time delta (it already exists; just needs the
  fork build that consumes the plan). Add a `n_forced_runs_skipped` / `n_decode_calls`
  delta to the report.
- Submodule bump: `packages/inference/llama.cpp` gitlink → the commit with the above;
  `RELEASE_V1.md` + `needs-hardware-ledger.md` note the new fork capability.

### A.3 Composition with the dflash drafter

The §4 graph is: DFlash drafter proposes N tokens → target verifies → accepted tokens →
phrase chunker → TTS. Forced spans must **not** go through draft/verify at all:

- **Forced run = zero draft/verify cycles.** When the next K tokens are deterministically
  forced (plan run or grammar fast-forward), the server splices them and advances *before*
  asking the drafter for anything. The drafter is only invoked when the cursor is at a
  **free span** — and there it should draft the *value* tokens (the `replyText` prose, the
  `parameters` object, the `thought`), which is where acceptance rate matters. So: forced
  scaffold = 0 drafter calls + 0 target forward passes; free spans = normal spec-decode.
- **Concretely**, in `server-context.cpp`'s decode loop: `while (!done) { if
  (pending_forced_run) { splice + advance; continue; } if (can_speculate) { draft =
  spec.gen_draft(...); verify; accept_prefix; } else { single decode + sample; } /* after
  accept: check for a new forced run (plan boundary or grammar fast-forward) */ }`. The
  forced-run check runs once per loop iteration, right after `accept`.
- **Drafter + grammar**: the existing fork already constrains the drafter's proposals by
  the grammar mask before verifying (the sampler chain is shared) — so on the *value*
  spans the draft is already grammar-valid. No change needed there; the only change is
  that the scaffold spans short-circuit the loop entirely.
- **Rollback interaction (DFlash↔TTS)**: forced runs are never rolled back (they're
  deterministic) — so the chunker's rollback queue only ever has to drop *value*-span
  audio, which is the existing W7 design. Forced runs can be handed to the TTS chunker
  immediately (the scaffold is `{"replyText":"` etc. — not spoken; but the *opening of
  `replyText`* is the trigger for the chunker to start consuming). No new coupling.

### A.4 A-side cross-cluster deps

- **Cluster 3 (fine-tune corpus):** the 0.6b SFT corpus must include the `eliza_native_v1`
  trajectory shape *with the structured envelope* — i.e. trajectories whose assistant turn
  is the exact `{"shouldRespond":…,"thought":…,"replyText":…,"contexts":[…],…}` JSON the
  skeleton forces. Training on the forced shape makes the free spans the model *does*
  generate higher-quality and makes the grammar a no-op constraint (model already wants to
  emit it) — which is what makes the fast-forward a pure win, not a fight. Hand Cluster 3
  the canonical key order from `STAGE1_ENVELOPE_KEYS` + the field-registry compose order.
- **Cluster 5 (emotion field):** the `replyText` schema may grow an `emotion` tag /
  SSML-ish markup field (Cluster 5's emotion sub-agent). If it's a *closed enum* (`{joy,
  sad, neutral, …}`) it becomes an `enum` span → the grammar pins it → the fast-forward
  fills the rest after enough prefix → ≈0 tokens spent on the emotion label. If it's
  free-form markup inside `replyText`, it's just part of the `free-string` span. Plan:
  expose the emotion field to `buildResponseGrammar` the same way Stage-1 field evaluators
  are exposed (a registered field evaluator with an enum schema) so it auto-flows into the
  skeleton + grammar + prefill plan with no special-casing.
- **Cluster 5 (e2e duet):** the duet harness runs with guided decode **on**
  (`providerOptions.eliza.guidedDecode = true`) so the token-savings % is in the latency
  report. The "one-line set next to the `responseSkeleton` assignment in
  `planner-loop.ts` / `message.ts`" that the guided-decode design doc left for "the W8
  owner" — do that here (it's a Cluster 4 deliverable, not a Cluster 5 one).

---

## PART B — Fused / zero-copy streaming text↔audio↔text

### B.1 Audit: state today

- `packages/app-core/scripts/omnivoice-fuse/{prepare.mjs,ffi.h,README.md}` — the fused
  build: graft omnivoice.cpp's `src/`/`tools/`/`examples/` into the `elizaOS/llama.cpp`
  tree (discard omnivoice's own ggml submodule — one ggml ABI), emit `omnivoice-core`
  static archive + `llama-omnivoice-server` smoke + the product `llama-server` speech
  route + a fused `libelizainference.{so,dylib,dll}` exporting both `llama_*` and
  `omnivoice_*` symbol families. ABI v3 in `ffi.h`: lifecycle (`create`/`destroy`),
  mmap acquire/evict per region (`tts`/`asr`/`text`/`dflash`/`vad`), batch
  `tts_synthesize` / `asr_transcribe`, streaming `tts_synthesize_stream` +
  `cancel_tts` + `tts_stream_supported`, streaming ASR `asr_stream_{open,feed,partial,
  finish,close}` + `asr_stream_supported`, the DFlash verifier callback
  (`set_verifier_callback` + `EliVerifierEvent`), native Silero VAD (`vad_*`).
- **The streaming symbols are honest stubs** in `prepare.mjs`: `asr_stream_supported()`
  returns `0`, `tts_stream_supported()` returns `0`, `vad_supported()` returns `0`, and
  the streaming entry points return `ELIZA_ERR_NOT_IMPLEMENTED`. `prepare.mjs` *does*
  hard-refuse a "stub-only fusion" — it requires the real `omnivoice_*` *batch* impl
  symbols to be present (line ~1104) — so the batch path is real, the streaming path is
  not.
- JS side (`voice/transcriber.ts`) has `FfiStreamingTranscriber` (gated on
  `eliza_inference_asr_stream_supported() == 1` — currently false → never used),
  `FfiBatchTranscriber` (the real path today via `asr_transcribe`), and a
  `WhisperCppStreamingTranscriber` interim adapter. `voice/scheduler.ts` /
  `voice/pipeline*.ts` / `voice/ring-buffer.ts` (`PcmRingBuffer`) / `voice/engine-bridge.ts`
  are the JS scheduler the §4 graph runs through.
- **No `madvise(MADV_DONTNEED)` RSS trim** anywhere — `grep -rn MADV_DONTNEED|madvise` →
  0 hits. The `mmap_evict` ABI entry exists (voice-off) but there's no *within-turn* trim
  (drop the ASR encoder's scratch after ASR-final, drop the TTS codec scratch after the
  utterance) and the implementation behind `mmap_evict` is a stub too.
- The `EliVerifierEvent` callback ABI exists but is unwired (the fused build's speculative
  loop doesn't call it; the JS scheduler synthesizes accept/reject from SSE deltas today).

### B.2 Implementation plan — the real streaming decoders ("W7 ABI")

**B.2.1 Streaming TTS (`eliza_inference_tts_synthesize_stream`).**
OmniVoice (the TTS model) is an autoregressive codec-token generator + a codec decoder.
The batch `tts_synthesize` already runs the full thing. The streaming variant:
- Run the AR codec-token generation a frame at a time (the model's natural step). After
  every `K` codec frames (configurable per tier — e.g. 8 frames ≈ ~100ms at 24kHz), run
  the codec decoder over *that* frame window, get PCM, and call `on_chunk(pcm, n, 0,
  user_data)`. On the last window, call `on_chunk(tail, n, 1, user_data)`.
- `on_chunk` returning non-zero → stop AR generation at the next frame boundary, return
  `ELIZA_ERR_CANCELLED`, still call `on_chunk(NULL/0, 1, user_data)` once for cleanup
  (barge-in path — AGENTS.md §4).
- `cancel_tts` sets an atomic flag the AR loop checks each frame (cross-thread cancel).
- Implement in a new `omnivoice/src/omnivoice-stream.cpp` (added to `omnivoice-core` by
  `prepare.mjs`'s graft block) wrapping omnivoice's existing AR + decoder; flip
  `tts_stream_supported()` to return `1`.
- `prepare.mjs` change: require the new streaming impl symbols in the
  `missingImplSymbols` check (same pattern as the batch symbols today) so a build that
  *says* it streams but doesn't is refused.

**B.2.2 Streaming ASR (`eliza_inference_asr_stream_{open,feed,partial,finish,close}`).**
Qwen3-ASR (the ASR model) is an encoder + an AR text decoder. Streaming:
- `open` allocates a session: a growable PCM ring (16kHz mono fp32), the encoder's
  rolling state, the text-decoder's KV. `feed(pcm, n)` appends to the ring (returns
  samples consumed). `partial(out_text, max, out_tokens, io_n_tokens)` runs a windowed
  decode pass over the audio buffered since the last pass (chunked attention / a sliding
  encoder window — Qwen3-ASR supports streaming/chunked inference) and returns the running
  transcript; **and**, since the fused build shares the text-model vocabulary, optionally
  writes the *text-model token ids* for the current transcript into `out_tokens` (so
  STT-finish token injection feeds the LLM without re-tokenizing — this is the zero-copy
  text hand-off). `finish` drains the tail, last pass, final transcript. `close` frees.
- Implement in `omnivoice/src/omnivoice-asr-stream.cpp` (or wherever the Qwen3-ASR impl
  lives in the omnivoice graft); flip `asr_stream_supported()` to `1`. The JS
  `FfiStreamingTranscriber` then becomes the live path (it's already written).
- **Partial-emission cadence**: `partial` is *pulled* by the JS scheduler (it calls it
  between `feed`s). The decoder should be cheap enough to run on every pull (windowed,
  not full re-decode) — that's the whole point of streaming. Document the per-tier window
  size in the manifest.

**B.2.3 The DFlash verifier callback (`eliza_inference_set_verifier_callback`).**
Wire the fused build's speculative loop (the same `tools/server/server-context.cpp` loop
from Part A.3, but here in the *in-process* `libelizainference` not the spawned server) to
fire `EliVerifierEvent` on every accept/reject step (accepted ids, rejected range,
corrected ids — token-index domain = the output stream). The JS scheduler
(`voice/scheduler.ts`) then drives phrase-chunking + rollback off *exact* native events
instead of synthesized SSE deltas. This is what makes the DFlash↔TTS rollback precise (a
rejected draft tail → drop exactly those not-yet-spoken audio chunks).

### B.3 The zero-copy ring hand-off

The §4 graph is a chain: mic PCM → VAD → ASR → text tokens → DFlash+target → accepted
text tokens → phrase chunker → TTS → PCM → audio out. "Stage N's output ring IS stage
N+1's input ring":

- **mic → VAD → ASR**: already a `PcmRingBuffer` (`voice/ring-buffer.ts` /
  `voice/mic-source.ts`). The VAD reads 512-sample windows out of the ring; the gated
  segments feed `asr_stream_feed` *by pointer into the same ring* (the FFI call takes a
  `const float*` + `n_samples` — pass the ring's slice, no copy). The one unavoidable
  copy is the FFI boundary if the native side buffers it internally; mitigate by having
  `asr_stream_feed` consume eagerly (windowed decode on each feed) so it doesn't need to
  retain.
- **ASR → LLM (text)**: `asr_stream_partial`/`finish` write *text-model token ids*
  straight into a caller buffer (`out_tokens` in the ABI). The JS scheduler hands those
  token ids to the dflash text runner's prompt-extension API — **no string round-trip, no
  re-tokenization** (the fused build shares the vocab; that's the design intent baked into
  the ABI comment). For the spawned-server desktop path (no shared in-process vocab), the
  hand-off is the transcript *string* over the HTTP `/completion` body — still no file,
  still frame-granular partials, just one tokenization on the server side.
- **LLM → TTS (text)**: accepted text tokens → detokenize incrementally → the phrase
  chunker (`voice/phrase-chunker.ts`) accumulates to a punctuation/max-N boundary → hands
  the sub-phrase *string* to `tts_synthesize_stream` (TTS needs grapheme/phoneme input,
  not raw token ids — the codec doesn't share the text vocab). This is the one place a
  string crosses; it's sub-phrase-granular (not full-buffer), zero file writes.
- **TTS → audio out**: `tts_synthesize_stream`'s `on_chunk` PCM → written directly into
  the playback `PcmRingBuffer` (`voice/system-audio-sink.ts`) — the `on_chunk` callback
  copies `pcm` into the ring (the ABI says `pcm` is only valid during the call, so one
  copy here is unavoidable; it's a `memcpy` of ~100ms of fp32, ~10KB — negligible). The
  ring *is* the audio device's source buffer.
- **`mmap`'d shared region**: where two *native* stages are in the same process (the fused
  `libelizainference` — desktop fused build, iOS/Android in-process), the inter-stage
  buffers can be plain heap (same address space — no mmap needed, no IPC). The `mmap` is
  only relevant for the *weights* (shared mmap of the GGUF, already done) and for the
  voice-off eviction. So: zero file writes (today already true — the batch path keeps PCM
  in memory), zero IPC for the fused build, one HTTP body for the spawned-server desktop
  path (which is the §4-permitted "desktop / server" runtime path).

### B.4 Within-turn `madvise(MADV_DONTNEED)` RSS trim

- After **ASR-final** for a turn: the ASR encoder's per-utterance scratch + the partial
  decoder KV are dead. `madvise(MADV_DONTNEED)` (Linux/Android) / `VirtualUnlock` +
  `DiscardVirtualMemory` (Windows) / `madvise(MADV_FREE)` (macOS/iOS) those pages. The
  *weights* mmap stays (hot for the next turn — the `text`/`dflash` regions are always
  hot per the ABI; `asr` weights can stay or be re-`MADV_DONTNEED`'d if voice is bursty).
- After **the TTS utterance finishes**: the codec decoder's scratch + the AR KV for that
  utterance are dead — trim them.
- Implement as a new internal `eliza_inference_turn_trim(ctx)` (or fold into
  `asr_stream_close` / the `on_chunk(is_final)` path so it happens automatically) — the JS
  scheduler doesn't need to call anything new; it's part of finishing a turn. Add a
  capability probe so a build without it is a no-op (don't fail).
- Measure: the latency report (Cluster 5) tracks RSS over a long duet run; the trim should
  flatten the RSS sawtooth without adding per-turn latency (madvise is cheap; the page
  fault on the *next* turn's scratch is the cost, paid lazily on a cold page — acceptable,
  and the scratch is small vs the weights which never get trimmed).

### B.5 Weight-fusion verdict — "one ggml graph for ASR-encoder → text-decoder → TTS-decoder"

**Verdict: research-only / not tractable as one graph for v1. Tractable now: one process,
one llama.cpp build, one ggml pin, three contexts (the current design).**

Reasoning:
- The three models have *incompatible architectures*: Qwen3-ASR is an audio
  encoder + text decoder (different layer count, conv frontend, cross-attention); the text
  model is a decoder-only transformer; OmniVoice is an AR codec-token model + a
  non-transformer codec decoder (residual VQ / a vocoder-ish stack). They don't share KV
  head configs, layer counts, or even op sets (the codec decoder has convs/upsampling the
  text model never uses). AGENTS.md §4 already says this explicitly: "Shared KV cache
  *scheduling*, not shared KV memory. Text and voice have their own KV caches… What they
  share is the scheduler, the mmap region for weights, the kernel set, and the
  memory-budget policy." That is the correct decomposition.
- "One ggml graph" would mean a single `ggml_cgraph` spanning all three — but ggml graphs
  are *per forward pass*, and these three run at different cadences (ASR: windowed per
  feed; text: per token / per spec-batch; TTS: per codec frame) with data dependencies
  that are *streaming*, not a single DAG. You can't express "ASR partial → 12 LLM tokens →
  2 TTS phrases" as one static graph; it's a pipeline of three graphs orchestrated by the
  scheduler.
- What *is* tractable and worth doing (and is the plan above): (a) one process, one
  llama.cpp lib, one ggml ABI (the fused `libelizainference` — done for the batch path,
  this plan finishes the streaming path); (b) shared weight `mmap` (done); (c) shared
  kernel set + memory budget (done); (d) the verifier callback so the spec loop and the
  TTS chunker are coupled in-process (this plan wires it); (e) zero IPC / zero file writes
  in the fused build (this plan's ring hand-off). That captures ~all of the "no
  inter-process anything" win without the (intractable, low-value) "fuse the model graphs"
  step.
- **Research-only follow-up** (document, don't build for v1): if a future Eliza-1 model
  *trains* the ASR encoder and the text decoder to share a backbone (a single model that
  consumes audio tokens and emits text tokens — an "omni" model), *then* ASR-encoder →
  text-decoder collapses into one llama.cpp model + one KV. That's a *model-architecture*
  decision (Cluster 3 territory), not an inference-stack one — flag it as a future
  direction in `packages/inference/AGENTS.md` §4 and `RELEASE_V1.md`, don't gate v1 on it.

### B.6 B-side cross-cluster deps

- **Cluster 2 (the fused build per platform):** the real streaming decoders ship inside
  `libelizainference`, so they need the `*-fused` build targets to actually build:
  `darwin-arm64-metal-fused`, `ios-arm64-metal-fused` (the Capacitor `LlamaCpp.xcframework`
  otherwise carries the `omnivoice_*` symbols), `android-arm64-{cpu,vulkan}-fused`,
  `android-x86_64-{cpu,vulkan}-fused` (if it's a real target). Cluster 2 owns
  `build-llama-cpp-dflash.mjs` + `aosp/compile-libllama.mjs` +
  `ios-xcframework/build-xcframework.mjs`; Cluster 4 hands them the new
  `omnivoice/src/omnivoice-{stream,asr-stream}.cpp` + the updated `prepare.mjs` graft
  block + the `missingImplSymbols` additions. The fused builds need Xcode / Android-Studio
  hosts — Cluster 2's `--dry-run` + host-needed documentation applies.
- **Cluster 2 (kernel parity):** the streaming TTS/ASR decoders dispatch the same
  TurboQuant/QJL/Polar kernels as the batch path (the weights are the same GGUFs) — no new
  kernels, but the per-backend dispatch-verify must cover the streaming entry points too
  (a `verify/` smoke that calls `tts_synthesize_stream` / `asr_stream_*` on each backend).
- **Cluster 3 (the GGUFs):** the streaming decoders need the OmniVoice TTS GGUF + the
  Qwen3-ASR GGUF (+ mmproj) per tier — Cluster 3 builds those; Cluster 4's streaming code
  is gated on them existing (until then, `*_stream_supported()` returns 0 honestly and the
  JS falls back to the batch / whisper.cpp interim path — no faking).
- **Cluster 5 (the duet + latency report + emotion):** the streaming decoders are what
  make the duet's TTFT-from-last-utterance number good (partial ASR → first LLM token
  before the user stops talking; first TTS PCM chunk before the LLM finishes). Cluster 5
  consumes the `EliVerifierEvent` callback for the dflash-acceptance metric and the
  `madvise` trim for the RSS-over-time metric. Emotion (Cluster 5's sub-agent): OmniVoice
  / omnivoice-singing's emotion/singing tags are a *parameter* to `tts_synthesize_stream`
  (extend the ABI with an optional `emotion_spec` string param, or thread it via
  `speaker_preset_id` — TBD with Cluster 5's emotion schema); the streaming path must
  carry it through frame-by-frame (the emotion is set once per utterance, so it's just a
  field on the session — cheap).

---

## Cross-review notes (after reading cluster-2/3/5 plans)

- **Cluster 3** flags the 0.6b corpus has `format_pct` 0.0% — *zero* structured-envelope
  rows in the smoke task mix. So the fast-forward win is currently untested against a model
  that *wants* to emit the envelope. A.4 dep stands; additionally hand Cluster 3 a small
  generator that emits well-formed Stage-1-envelope assistant turns (use
  `buildResponseGrammar` on a synthetic action set + `compilePrefillPlan` to get the exact
  byte-stream) so the `structured_decode` task it adds is byte-accurate, not approximate.
  Note: Cluster 3 calls it the "TOON envelope" — confirm with them whether the on-wire
  form is TOON or JSON; `buildResponseGrammar` currently emits JSON, so if the runtime
  decodes a TOON envelope there's a serializer mismatch to reconcile (the skeleton/grammar
  would need a TOON mode). **Action item: verify the actual on-wire envelope format before
  implementing — if it's TOON, the GBNF generator in `response-grammar.ts` needs a TOON
  branch and `compilePrefillPlan` follows it.**
- **Cluster 5** wants *both* an inline-tag emotion path (`[happy]` in `replyText`) *and*
  possibly a Stage-1 envelope `emotion` enum field. A.4's "register the emotion field as a
  Stage-1 field evaluator with an enum schema" covers the envelope case (auto-flows into
  skeleton + grammar + prefill plan, zero special-casing); the inline-tag case is just part
  of the `free-string` `replyText` span — no grammar change. So Cluster 4 supports
  whichever (or both) Cluster 5 + Cluster 3 settle on; the only Cluster-4 work is the
  one-line field-evaluator registration if they pick the envelope field.
- **Cluster 5** confirms the duet harness sink-→-ring-→-peer-micSource design (B.3) using
  the *existing* `InMemoryAudioSink` + `PushMicSource` + `PcmRingBuffer` — so the JS-side
  ring hand-off is already there; B.2/B.3's work is the *native* streaming decoders feeding
  those rings chunk-by-chunk instead of one batch buffer at end-of-turn.
- **Cluster 2** owns the fork pin + the `*-fused` build matrix and is the natural owner of
  the Part-A fork commit + the B.2 streaming-decoder source graft. Coordinate the
  `packages/inference/llama.cpp` submodule bump through them (they already track it as a
  blocker). `linux-x64-cpu-fused` + `linux-x64-vulkan-fused` build here → that's where the
  streaming decoders get unit-tested before the gated Apple/Android targets.

## Blockers / risks

- **Fork edits + submodule bump**: Part A.2 and B.2.3 touch `packages/inference/llama.cpp`
  (the submodule) — that's a separate repo (`elizaOS/llama.cpp @ eliza/main`). The change
  has to land *there* first (a branch + a tag), then the gitlink bumps here. Coordinate
  with whoever owns the fork (Cluster 2 owns the build matrix and is the natural owner of
  the fork pin). A regex `kernel-patches/` patch is *not* safe for the decode-loop changes
  (they're structural) — it must be a real fork commit.
- **No Apple / Android hardware here**: the `*-fused` builds (B.6) are `--dry-run` +
  host-needed on this box; the streaming decoders can be *built* + *unit-tested* on Linux
  (the fused Linux build works), but the iOS/Android in-process path can't be verified
  here. Document the host needed (Cluster 2's ledger).
- **Qwen3-ASR / OmniVoice streaming support**: the plan assumes both support chunked /
  incremental inference (Qwen3-ASR does; OmniVoice's AR codec model naturally does). If
  OmniVoice's codec decoder needs a minimum lookahead (some neural vocoders do), the TTS
  chunk size has a floor — that floor is the first-PCM-byte latency lower bound; measure
  and document it, don't pretend it's zero.
- **The `eliza_prefill_plan` fast-forward correctness**: the plan is a hint, the grammar
  is the floor — but the *test* of equivalence (runs + sampled values reassemble to the
  byte-identical GBNF output) already exists (`dflash-structured.test.ts`); extend it with
  a *fork-level* test (run a real model with the plan vs without, assert identical
  output + fewer `decode()` calls) once the fork build consumes it. Don't ship the
  fast-forward without that test.
- **Order**: A.2 (the fast-forward) and B.2 (the streaming decoders) are independent — can
  be implemented in parallel. Both depend on Cluster 3's GGUFs for *live* verification and
  Cluster 2's fork pin / build matrix for *shipping*. The off-by-default flags
  (`MILADY_LOCAL_GUIDED_DECODE`, `*_stream_supported()` probes) mean nothing regresses
  while they're in flight.
