# Inference-pipeline deep-audit — larp / stub / placeholder / dead-code inventory

_Audit run: 2026-05-12. Branch `develop`. Auditor: inference deep-audit + fix agent._

## Scope covered

- `packages/app-core/src/services/local-inference/**` (engine, dflash-server, backend,
  router-handler, cache-bridge, conversation-registry, ram-budget, memory-monitor,
  active-model, recommendation, catalog, mlx-server, manifest/*, voice/*, __stress__/*,
  structured-output.ts)
- `packages/core/src/runtime/` (response-grammar.ts, response-handler-field-*.ts,
  planner-loop.ts, message-handler.ts, planner-*.ts)
- `packages/inference/` (verify/* harnesses, kernel-contract.json, reference/*, PLATFORM_MATRIX,
  reports/porting/*)
- `packages/app-core/scripts/` (build-llama-cpp-dflash.mjs, omnivoice-fuse/*, voice-interactive.mjs,
  voice-duet.mjs, aosp/*)
- `packages/training/scripts/` (quant recipes, distill_dflash_drafter.py, eval suite, bench harnesses,
  manifest/platform-plan scripts, train_local.py)
- the fork `packages/inference/llama.cpp` — inspect-only (dirty in worktree; the finalize agent owns fork edits)

## Headline finding (honest)

The Eliza-1 inference pipeline is in **good shape**. Nearly every marker that looks like
larp on a `grep` is in fact an **honestly-documented stub** for work that is genuinely
hardware- or upstream-dependency-gated (the `*-fused` GPU builds, the W7 streaming
decoders inside `libelizainference`, the W9 assembled-voice-loop harness wiring, the
fork's `convert_hf_to_gguf.py` `--outtype q4_polar` support, the Apple/Android/Windows
build hosts). Those are out of scope for this agent (hardware-gated) and/or owned by the
concurrent finalize agent. The set of *real, actionable, non-hardware-gated* improvements
is small and listed below.

`madge --circular` over `packages/app-core/src/services/local-inference` reports 0 cycles
inside the inference tree (the 5 cycles it surfaces are all `agent/` ↔ `dist/*.d.ts` API
barrels, out of scope). `knip` OOMs on this repo (4 GB heap) — could not run cleanly.

---

## Findings, ranked

### F1 — `voice/transcriber.ts` `LiveAsrTranscriber` dead/contract-only adapter. — MED conf / LOW impact — **DEFERRED**

`packages/app-core/src/services/local-inference/voice/transcriber.ts:401` — the comment
says it "is the contract-clean" adapter "until [the real fused ASR] lands". The streaming
ASR symbols (`asr_stream_supported() == 0`) are honest stubs in the fused build. This is W4
territory (the finalize agent / WS-4 owns the W7 ABI). **Deferred: the adapter is not dead
— it's the integration seam the streaming decoder will fill; removing it would just have to
be re-added. No change.**

### F2 — `mobile_peak_rss_harness.mjs` literal "STUB". — HIGH conf / LOW impact — **DEFERRED (hardware-gated)**

`packages/inference/verify/mobile_peak_rss_harness.mjs:3` — `STUB (needs a real iOS/Android
device)`. Per the task instructions, Android-device / iOS items are explicitly out of scope.
**Deferred: hardware-gated, tracked elsewhere.**

### F3 — `bargein_latency_harness.mjs` / `thirty_turn_endurance_harness.mjs` say "pending W9" but the assembled scheduler path exists. — MED conf / MED impact — **PARTIAL / DEFERRED**

`packages/inference/verify/bargein_latency_harness.mjs:108` and
`thirty_turn_endurance_harness.mjs:175` both record `available: false` with reason
"assembled voice path (engine.startVoice + turn controller) not yet wired to this harness —
pending W9". `engine.startVoice` *does* exist now, but it **rejects the `StubOmniVoiceBackend`**
(it emits silence — `engine.ts:1399-1403`), so a real barge-in / 30-turn latency measurement
genuinely needs a real TTS backend, which needs the GPU `*-fused` build (WS-2/WS-4, finalize
agent / cloud). The harnesses *could* be made to drive the bare `TurnController + AssistantScheduler
+ BargeInController` with the stub backend (as `voice-duet.test.ts` does for wiring) to get a
harness-level exercise of the assembled scheduler path — but that would measure scheduler
overhead, not the real ASR→LLM→TTS round-trip the gate cares about, and would risk
mis-reading as a true e2e pass (the harnesses go to lengths to set `voiceLoopExercised: false`
to avoid exactly that). **Deferred: the honest `available: false` is correct for the gate's
purpose; a stub-backend exercise would be a different metric. The real fix is the GPU build,
which is the finalize agent's lane.**

### F4 — `e2e_loop_bench.mjs` rejects `--json` (every sibling bench accepts it). — HIGH conf / LOW impact — **FIXED**

`packages/inference/verify/e2e_loop_bench.mjs:131` — `parseArgs` throws `unknown argument:
--json` while `embedding_bench.mjs`, `guided_decode_token_bench.mjs`, `bargein_latency_harness.mjs`,
`thirty_turn_endurance_harness.mjs`, `dflash_drafter_runtime_smoke.mjs` all support `--json` for
machine-readable output (which the gates collector and CI consumers expect). Inconsistent CLI
surface; trips up `eliza1_gates_collect.mjs` if it ever passes `--json`. **Fix: accept `--json`
in `parseArgs` and print the report JSON to stdout when set.**

### F5 — `gguf_eliza1_apply.py` `--outtype q4_polar` path is sidecar-only until the fork converter lands. — HIGH conf / MED impact — **REVIEWED — already correct + complete**

The quant-recipe AUDIT_2026-05-10 finding asked: do the recipes emit real quantized output
or just sidecars, and are the sidecars §3-complete? Answer after review:
- `turboquant_apply.py` / `fused_turboquant_apply.py` — quantization is **runtime-only** (the
  `turbokv` PyPI package / Triton kernels apply it at inference time); the recipe ships
  unmodified weights + a sidecar. This is the documented design (AUDIT §1, "NO QUANTIZED
  OUTPUT TO COMPARE"). The §3 sidecar `kernel_manifest` fragment (kernel target / block-layout
  version / codebook hash / tolerance) **is** present via `_common.kernel_manifest_fragment(...)`,
  enforced by `test_recipe_sidecar_manifest_fragment_complete`. ✓ complete.
- `polarquant_apply.py` — emits real per-block int8 codes + fp16 norms + QJL signs in a
  `polarquant_artifacts.safetensors` sidecar, byte-faithful-repackable into the C `block_q4_polar`
  82-byte struct (AUDIT finding 2 RESOLVED — xorshift32 PRNG bit-exact to the C kernel, parity
  test `test_polarquant_full_block_parity_against_c_ref`). ✓ real output.
- `qjl_apply.py` — emits Π in `(head_dim, proj_dim)` row-major, byte-compatible with the
  qjl-cpu / Metal / Vulkan / CUDA kernels (AUDIT finding 3 RESOLVED, parity test
  `test_qjl_projection_layout_matches_c_ref`). ✓ real output.
- `gguf_eliza1_apply.py` — the converter wrapper. It reads the polar/qjl/turboquant sidecars,
  emits a `<file>.eliza1.json` extension-metadata block (QJL geometry + TurboQuant calibration +
  the GGML type slots) **and** falls back from `--outtype q4_polar` → `q8_0`/`f16` when the
  fork's `convert_hf_to_gguf.py` doesn't yet support emitting `Q4_POLAR` tensor blocks (it
  greps the convert script for the `Q4_POLAR` marker). The fallback is **honest** — it records
  `weight_quant.deferred: true` + `deferral_reason` + keeps the polar sidecar path so the
  runtime can apply it once the converter lands — and it's the right design: the converter is
  in the fork, the fork is owned by the finalize agent, and the python side is complete and
  correct so it works the moment the fork type lands. **No change — this is exactly the
  "make the python side complete + correct so it works the moment the fork type lands" the
  task asked for, and it's done.**

  One genuine gap: `_build_ext_metadata` does **not** record a `tolerance` field on the
  per-quant sub-blocks (it records geometry/calibration but not the per-block expected MSE
  for a future cross-check, even though `polar_sidecar.get("average_block_mse")` is read for
  `polarquant`). **Minor — added `tolerance_block_mse` passthrough where the sidecar carries
  it (polarquant `average_block_mse`); turboquant/qjl don't compute one, left null.** See
  implemented changes.

### F6 — `distill_dflash_drafter.py` KD recipe is real (not a stub). — HIGH conf / no-impact — **REVIEWED — no change**

`packages/training/scripts/distill_dflash_drafter.py:422-470` — full top-k forward-KL +
cross-entropy-floor distillation loop with `AdamW`, grad-accum, grad-clip, the documented
`loss = (1-ce_weight)·T²·KL(softmax(z_t/T)||softmax(z_s/T)) + ce_weight·CE(z_s,y)` objective,
tokenizer-byte-identity assertion, and the `dflash-draft.target_checkpoint_sha256` GGUF
metadata write the publish gate + runtime doctor read. `--synthetic-smoke` exercises the
pipeline without a model/GPU. **Real recipe — no change.**

### F7 — `phoneme-tokenizer.ts` `CharacterPhonemeStub`. — HIGH conf / LOW impact — **DEFERRED**

`packages/app-core/src/services/local-inference/voice/phoneme-tokenizer.ts:50-67` — a
placeholder phoneme tokenizer (one phoneme per input char) that **loudly warns** the first
time it's used and is **only used when the caller explicitly passes it** (the `PhraseChunker`
throws if `chunkOn='phoneme-stream'` and no tokenizer is supplied — `phrase-chunker.ts:49`).
Replacing it with a real IPA tokenizer (espeak-ng / phonemizer.js / ipa-translate-rs) is a
real follow-up but pulls in a native dep / WASM blob and is its own workstream (AGENTS.md §6.4).
**Deferred: needs-dependency; the stub is gated, warned, and never silently active.**

### F8 — `voice/wake-word.ts` `OPENWAKEWORD_PLACEHOLDER_HEADS`. — HIGH conf / no-impact — **REVIEWED — no change**

`packages/app-core/src/services/local-inference/voice/wake-word.ts:84-90` — the upstream
openWakeWord "hey jarvis" head, renamed, used as a placeholder until an Eliza-1-wake-phrase
head is trained. The runtime **loudly warns** any session that enables a placeholder head
(`engine.ts:1466-1470`) and wake-word is opt-in/local-only anyway. Honest — no change.

### F9 — `omnivoice-fuse/prepare.mjs` "stub-only fusion" refusal + the streaming-session decoder. — HIGH conf / no-impact — **REVIEWED — no change**

`packages/app-core/scripts/omnivoice-fuse/prepare.mjs:1082,1104` — the grafter **refuses to
build a header-only or stub-only graft** (checks for required implementation symbols). Line 778
notes "the windowed streaming-session decoder is not yet wired" — that's the W7 streaming work
(finalize agent's lane). The non-streaming `eliza_inference_tts_synthesize` / `/v1/audio/speech`
path is real. Honest — no change. (`prepare.mjs` is *not* the `compile-libllama.mjs` graft the
finalize agent owns; left untouched anyway since the only gap is W7-scoped.)

### F10 — `dflash-server.ts` `extractCompletionText` / dual prefill paths. — LOW conf — **REVIEWED — no change**

`dflash-server.ts:2595-2645` — there are two prefill code paths (the W7 server-task prefill via
the fork's `continue_final_message`, and the node-llama-cpp re-prepend path). Both are live (the
runtime supports both backends — `llama-server` spawn AND in-process node-llama-cpp). Not a
legacy-vs-new split; a backend-shape split. No change.

### F11 — top-level scripts: `e2e_loop_bench.mjs` `--json`, plus a tiny consistency sweep over the harness CLIs. — see F4.

### F12 — `structured-output.ts` `resolveGuidedDecodeForParams` / the singleton fast-forward. — HIGH conf / no-impact — **REVIEWED — already implemented**

The "narrow-to-singleton → auto-complete + advance" guided-decode behavior the task asks
about (Cluster 4's headline) is **already in tree**: `collapseSkeleton` collapses single-value
enum spans to literals (`structured-output.ts:117-130`), `isFreeSpan` only marks
multi-value-enum / free-string / free-json spans as sampled, the GBNF compiler emits the
collapsed grammar (so the server's grammar engine spends no tokens on the scaffold), and the
`ElizaPrefillPlan` / `eliza_prefill_plan` runs feed the deterministic-token short-circuit. The
runtime-side wiring is complete; the only remaining piece is the fork's server consuming
`eliza_prefill_plan` natively (a fork commit — finalize agent / WS-4). `guided_decode_token_bench.mjs`
measures the token-reduction % (estimate mode works; live mode needs `--bin --model`). No change.

---

## Summary by category / confidence / impact

| # | Finding | Conf | Impact | Disposition |
|---|---------|------|--------|-------------|
| F1 | `LiveAsrTranscriber` contract-only adapter | MED | LOW | DEFERRED (W4 seam) |
| F2 | `mobile_peak_rss_harness.mjs` STUB | HIGH | LOW | DEFERRED (hardware) |
| F3 | bargein/30-turn harnesses "pending W9" | MED | MED | DEFERRED (needs GPU build) |
| F4 | `e2e_loop_bench.mjs` rejects `--json` | HIGH | LOW | **FIXED** |
| F5 | `gguf_eliza1_apply.py` ext-metadata tolerance gap | HIGH | LOW | **FIXED (passthrough)** |
| F5 | quant recipes sidecar-vs-real-output | HIGH | MED | reviewed — already correct/complete |
| F6 | distill drafter KD recipe | HIGH | — | reviewed — real, no change |
| F7 | `CharacterPhonemeStub` | HIGH | LOW | DEFERRED (needs dep) |
| F8 | `OPENWAKEWORD_PLACEHOLDER_HEADS` | HIGH | — | reviewed — honest, no change |
| F9 | `prepare.mjs` streaming-session decoder | HIGH | — | reviewed — W7 scope, no change |
| F10 | dual prefill paths | LOW | — | reviewed — backend-shape split, no change |
| F12 | guided-decode singleton fast-forward | HIGH | — | reviewed — already implemented |

**Implemented:** F4, F5-tolerance-passthrough. Everything else is either honest/correct as-is,
hardware-gated (out of scope), or owned by the concurrent finalize agent.
