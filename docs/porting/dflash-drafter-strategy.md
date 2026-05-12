# Eliza-1 DFlash Drafter Strategy On AOSP

## Current Decision

The AOSP local inference path is Eliza-1 only. Runtime catalogs,
download staging, bundled defaults, and DFlash companion selection must
point at `elizaos/eliza-1-*` GGUF artifacts produced by the Eliza-1
publish pipeline.

DFlash target and drafter artifacts must share the Eliza-1 tokenizer
family. The runner should never repair or reinterpret another model
family's tokenizer metadata at load time; mismatched vocabularies fail
speculative decoding by construction and produce zero useful acceptance.

## Retired Pairing

Older notes proposed external target/drafter combinations and tokenizer
repair. That plan is superseded. The accepted path is:

- Target: an Eliza-1 fused GGUF for the device tier.
- Drafter: an Eliza-1 drafter GGUF generated and published with the same
  tokenizer family.
- Source: Hugging Face repos under `elizaos/eliza-1-*`.
- Runtime: the custom `elizaOS/llama.cpp` fork with the shipped DFlash
  and fused KV-cache support.

## Catalog Rules

Every visible local model catalog entry should be an Eliza-1 tier. Any
hidden DFlash companion entry must be an Eliza-1 companion for a visible
Eliza-1 target and must resolve through the same catalog, download, and
bundled-model paths as the target.

The catalog test should continue to enforce:

- Every `runtime.dflash.drafterModelId` resolves to a real catalog entry.
- Target and drafter share the same tokenizer family.
- Non-Eliza-1 HF search results are not promoted into the default local
  model catalog.

## AOSP Behavior

AOSP staging should download only the selected Eliza-1 tier artifacts and
their declared companions. Model-specific KV-cache behavior comes from
catalog runtime metadata or explicit environment overrides, not filename
heuristics for retired external model names.

The smoke path remains:

1. Cross-compile the unified `llama-server`/`libllama` artifacts for the
   target ABI.
2. Stage the Eliza-1 target GGUF and any Eliza-1 DFlash companion GGUF.
3. Start local inference with `ELIZA_DFLASH=1`.
4. Verify `/health`, one chat-completion round trip, and non-zero
   `n_drafted_total` plus a useful accepted/drafted ratio.

## Publishing Dependency

This strategy depends on the Eliza-1 publish pipeline producing the
device-tier GGUF bundles first. Until those repos exist on Hugging Face,
the app should fail fast with a clear missing-artifact/download error
rather than silently falling back to another model family.

## Drafter Distillation Recipe

The drafter is **knowledge-distilled from the exact text checkpoint it
ships with** — not trained from scratch. Acceptance rate (and therefore
the speed-up) is a function of how closely the drafter's next-token
distribution tracks the target's; logit KD is the direct way to optimize
for that. `packages/training/scripts/distill_dflash_drafter.py` implements
the recipe:

- **Student base:** a small Qwen3.x model from the same family as the text
  backbone, so the tokenizers are byte-identical (the script asserts this;
  the runtime `dflash-doctor` enforces the catalog-level version via
  `tokenizerFamily`). Sizes: `drafter-0_6b`/`drafter-1_7b` ≈ 0.6B base
  (quantized to ~0.15–0.35 GB), `drafter-9b`/`drafter-27b` ≈ 1.7B base.
  Pick the smallest student whose measured acceptance window stays above
  the tier's gate (`ACCEPTANCE_GATE` in the script: 0.45 for `0_6b`, 0.50
  for `1_7b`, 0.55 for `9b`/`27b`).
- **Objective:** top-k forward KL on the target's logits plus a small
  ground-truth cross-entropy floor (`ce_weight` default 0.1):
  `loss = (1−ce_w)·T²·KL(p_t‖p_s) + ce_w·CE(z_s, y)`, restricted to the
  target's top-k tokens so the student spends capacity where acceptance is
  decided.
- **Corpus:** reuse the text model's SFT corpus — the drafter only needs
  to match the target over the prompt distribution it was tuned on.
- **Shared embedding table:** the backbone-unification work owns whether
  the drafter reuses the target's embedding/unembedding weights directly
  (saves RAM, guarantees vocab parity). This script does not assume a
  shared table; if one lands, the converter step should drop the
  drafter's own `token_embd.weight`/`output.weight` and the runtime should
  map them onto the target's.
- **Output contract:** the drafter GGUF records
  `dflash-draft.target_checkpoint_sha256` = sha256 of the final shipped
  text GGUF. The publish path and `dflash-doctor` refuse a drafter whose
  recorded hash does not match the text GGUF in the same bundle (see
  `dflash/target-meta.json` `drafter.matchesTargetCheckpoint`). Use
  `--stamp-only --drafter-gguf … --target-gguf …` to (re-)stamp an
  existing drafter GGUF.
- **Synthetic smoke:** `--synthetic-smoke` runs the whole pipeline shape
  (GGUF write + metadata stamp + run manifest) with no torch/models/GPU,
  for CI.

When the text backbone version bumps, the drafter MUST be re-distilled
against the new checkpoint and re-stamped (training/AGENTS.md §2).

## DFlash vs. the Alternatives

The fork (the in-repo submodule `packages/inference/llama.cpp`, or the
standalone clone at `~/.cache/eliza-dflash/eliza-llama-cpp` when the build
scripts' override forces one) exposes several speculative paths via
`--spec-type`: `draft` (vanilla draft model),
`dflash` (the spiritbuun-branded draft path — *functionally identical to
`draft`*, it just preserves the AOSP CLI spelling; see
`common/speculative.cpp`), `eagle3`, and a family of `ngram_*` paths
(`ngram_simple`, `ngram_map_k`, `ngram_cache`, …) plus a `--lookahead`
self-speculative mode. The question: is DFlash (draft-model speculation
with a KD'd small drafter) the right default for the fused voice loop?

| Approach | Extra weights | Acceptance on chat/voice | Verdict for Eliza-1 |
| --- | --- | --- | --- |
| **DFlash / draft model (KD'd drafter)** | yes (~0.15–1.7 GB) | high (0.5–0.7 with a well-distilled drafter that shares vocab) | **Default.** Best acceptance, the drafter is part of the bundle anyway, KD is what we control. |
| `lookahead` (Jacobi self-speculation) | none | moderate; sensitive to n-gram window; degrades on diverse text | Keep as the env-overridable fallback (`ELIZA_LOCAL_LOOKAHEAD=N`) for devices where the drafter doesn't fit RAM. Not the default — weaker on the dialog distribution. |
| `ngram_*` (prompt/cache n-gram drafter) | none | only helps on repetitive output (code, copy-paste, structured tool calls); ~0 on free-form chat | Useful niche (`ELIZA_LOCAL_NGRAM=on`). Mutually exclusive with DFlash. Not a voice default — voice replies are low-repetition. |
| EAGLE / EAGLE3 (`--spec-type eagle3`) | yes (a small MLP head on the target's last hidden state) | very high (often >0.7) on the *same* model it was trained against | Strong candidate, but: (a) it needs an EAGLE head trained on the target's hidden states — more training-side machinery than a KD'd drafter; (b) it couples tighter to the target architecture (re-train on every backbone bump, same as the drafter, but harder to convert to GGUF); (c) the fork's `eagle3` path is less battle-tested than `draft`. **Worth revisiting** once the drafter pipeline is stable — it's the most plausible upgrade. |
| Medusa-style (multiple decode heads) | yes | high | Not in the fork. Same training-coupling concerns as EAGLE, plus tree-attention complexity. Out of scope. |

Decision: **DFlash (KD'd draft model) stays the default.** It has the
best acceptance on the dialog/voice distribution, the drafter is already
a required bundle artifact, and the KD recipe is the lever we control end
to end. `lookahead` and `ngram_*` remain as documented env overrides for
RAM-constrained or repetition-heavy cases. EAGLE3 is the documented
future upgrade path — re-evaluate after the drafter pipeline ships with
measured acceptance numbers in `dflash/target-meta.json`.

(Measured acceptance numbers: pending real Eliza-1 weights. On this
machine, the DFlash runtime smoke against the local stand-in `qwen3.5-4b`
target + repaired drafter runs end-to-end —
`packages/inference/verify/dflash_drafter_runtime_smoke.mjs` reports
`generation_attempt_completed` on `linux-x64-cpu` — but the stand-in
drafter is not a KD'd Eliza-1 drafter so its acceptance rate is not
representative. The eval harness writes the real numbers into the
bundle's `target-meta.json` at publish time.)

## DFlash↔TTS Rollback Coupling — Interface (DFlash side)

Per inference/AGENTS.md §4, when the target rejects a range of
DFlash-proposed text tokens, the not-yet-spoken audio chunks built from
those tokens must be dropped. The DFlash side emits **reject-range
events**; the phrase chunker (runtime-fusion agent) consumes them.

**Wire type** (`packages/app-core/src/services/local-inference/voice/types.ts`,
already present — do not change the shape without coordinating):

```ts
interface TextToken { index: number; text: string }
interface VerifierStreamEvent {
  kind: "accept" | "reject";
  tokens: TextToken[];   // for "reject", the contiguous rejected token
                         // indices in target output order; first/last
                         // index define the range [fromIndex, toIndex].
}
```

**Producer** (`DflashLlamaServer.generateWithUsage` →
`onVerifierEvent`): today the backend synthesizes `kind: "accept"`
events from the OpenAI streaming deltas (no native verifier-range stream
yet). When the fused native runtime exposes exact accepted/rejected token
ranges, the backend emits `{ kind: "reject", tokens: [...] }` for each
rejected span **before** emitting the corrected `accept` for the
re-decoded tokens. The contract for consumers:

- A `reject` event for indices `[a..b]` means: every accepted text token
  with index in `[a..b]` is retracted. Any phrase whose `[fromIndex,
  toIndex]` overlaps `[a..b]` must have its in-flight TTS forward pass
  cancelled and its queued/ring-buffered (but not yet played) audio
  dropped. Audio already past the ring buffer is gone — the chunker is
  sized small (default 8 tokens/phrase) so this is rare and cheap.
- `reject` events are monotone in `a` within a turn: once `[a..b]` is
  rejected, later events never reference indices `< a` (the verifier
  re-decodes forward from the rejection point).
- An empty `tokens` array is a no-op (callers may filter unconditionally).

**Consumer path** (already wired): `engine.pushVerifierEvent()` →
`EngineVoiceBridge.pushRejectedRange({ fromIndex, toIndex })` →
`VoiceScheduler.reject(range)` → `RollbackQueue.onRejected(range)` (emits
one `RollbackEvent` per overlapping non-played phrase) → scheduler
cancels the phrase's `cancelSignal` and drops it from the ring buffer.
The runtime-fusion agent owns everything from `pushRejectedRange` inward
(the chunker/scheduler); the DFlash side owns producing the `reject`
events on `onVerifierEvent`.

Until the native verifier-range stream lands, the rollback path is
exercised by tests (`engine.voice.test.ts` injects `reject` events
through `onVerifierEvent`) and by the synthesized accept-only stream in
production. No code path drops the `reject` branch — the interface is
stable; only the producer is currently incomplete.
