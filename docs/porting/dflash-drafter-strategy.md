# DFlash drafter strategy on AOSP

## Verified tokenizer state

Vocab and tokenizer family for the two relevant catalog entries:

| Model | Source | Tokenizer family | Vocab size | Special tokens |
| --- | --- | --- | --- | --- |
| `bonsai-8b-1bit-dflash` (target) | `apothic/bonsai-8B-1bit-turboquant` (Qwen3-8B base, 1-bit g128 weight quant) | Qwen3 BPE (gpt2 model + qwen2 pre-tokenizer) | **151,936** | Qwen3 `<|im_start|>`/`<|im_end|>`/`<|endoftext|>` ids |
| `smol-lm2-360m-instruct` (drafter — currently paired) | `bartowski/SmolLM2-360M-Instruct-GGUF` (HuggingFaceTB SmolLM2 base) | GPT-2 BPE (SmolLM-specific merges) | **49,152** | `<|im_start|>`/`<|im_end|>` literally same strings, **different ids** |

These tokenizers do **not** match. Vocab sizes differ by ~3x and the BPE
merges tables are unrelated. The `<|im_start|>`/`<|im_end|>` strings are
literally identical, but the underlying BPE token ids that llama.cpp emits
from each model are completely different.

`maybeRepairDflashDrafter` in `packages/app-core/src/services/local-inference/dflash-server.ts`
uses the Python `gguf` package to inject `tokenizer.ggml.merges` from the
target into the drafter GGUF when the drafter has no merges metadata. This
is enough to get llama-server to **load** the drafter alongside a target
without erroring out, but it does not change the drafter's actual
weights/embedding table — the drafter still emits SmolLM2-vocab token ids
(0..49,151), and the target rejects every speculated id ≥ 49,152 silently
or refuses to verify them. Net effect: ~zero acceptance and (per the
upstream llama.cpp speculative path) a hard `failed to create draft
context` when llama-server detects the vocab mismatch at startup.

This is consistent with the upstream guidance for llama.cpp speculative
decoding: the drafter and target **must** share a vocabulary. The
"copy tokenizer files into the drafter directory" workaround mentioned
in some HF discussions only works when the underlying vocabulary already
matches and only the metadata sidecar files are missing — it does not
bridge two genuinely different vocabularies.

Independent confirmation:

- Bonsai-8B is documented as a Qwen3-8B 1-bit quant (PrismML "Bonsai 1bit"
  release, vocab 151,936, 36-block Qwen3 architecture).
- SmolLM2-360M is documented as a GPT-2-class tokenizer with
  `vocab_size=49,152` (HF tokenizer_config.json).
- Qwen3-family small models (`Qwen/Qwen3-0.6B`, `Qwen/Qwen3-1.7B`) all
  use the same Qwen3 tokenizer with vocab 151,936 — these are the
  architectural drafter candidates for any Qwen3-derived target.

## Picked option: (c) — same-tokenizer drafter, with a different drafter model

The current pairing (Bonsai 8B target + SmolLM2-360M drafter) is
**fundamentally incompatible** and cannot be made to work by any amount of
metadata repair. The fix is to swap the drafter for a Qwen3-vocab model.

The smallest viable drafter is **`Qwen3-0.6B` Q4_K_M from
`bartowski/Qwen_Qwen3-0.6B-GGUF`** (~484 MB on disk). It shares the
Qwen3-8B tokenizer exactly (same vocab, same merges, same special tokens),
loads cleanly under llama-server `--spec-type dflash`, and runs CPU-only
on phone-class ABIs.

Rationale (3 sentences):

1. The catalog's prior pair was unbuildable by construction — vocab size
   mismatch is a hard blocker for speculative decoding, not a soft
   degradation, so options (a) and (b) cannot rescue it.
2. A Qwen3-tokenizer drafter already exists on Hugging Face at the right
   size class, so we get a working pair with zero on-device repair, zero
   Python dependency, and zero new TS code.
3. With option (c) we can also drop the `maybeRepairDflashDrafter` call
   from the AOSP code path for this specific pair, since matched vocab
   tokenizers don't need merge injection.

## Implementation plan

**Effort: small. Single session. No multi-day work required.**

### A. Catalog: replace SmolLM2 drafter with a paired Qwen3-0.6B drafter

File: `packages/app-core/src/services/local-inference/catalog.ts`

1. Add a hidden catalog entry `bonsai-8b-dflash-drafter` pointing at
   `bartowski/Qwen_Qwen3-0.6B-GGUF` / `Qwen_Qwen3-0.6B-Q4_K_M.gguf`,
   `runtimeRole: "dflash-drafter"`, `companionForModelId:
   "bonsai-8b-1bit-dflash"`, `hiddenFromCatalog: true`. ~485 MB on disk,
   minRamGb 2.
2. Update the existing `bonsai-8b-1bit-dflash` entry:
   - `companionModelIds: ["bonsai-8b-dflash-drafter"]`
   - `runtime.dflash.drafterModelId: "bonsai-8b-dflash-drafter"`
   - Update the comment block to reflect the matched-vocab decision and
     point at this doc.

The existing entry currently references `smol-lm2-360m-instruct`, which is
**not even an existing catalog id** (the SmolLM2-360M entry is keyed
`smollm2-360m`). So today the runtime fails fast at the
`installed.find((m) => m.id === dflash.drafterModelId)` step in
`dflash-server.ts:554` and `engine.ts:452`. Fixing the id while also
swapping to the right tokenizer family is a single-line correctness win.

### B. AOSP adapter: skip merge-repair for this pair

File: `packages/agent/src/runtime/aosp-dflash-adapter.ts`

The adapter currently never calls `maybeRepairDflashDrafter` at all
(that lives in the host-side `dflash-server.ts`). Once the drafter is
swapped to Qwen3-0.6B the host-side repair becomes a no-op for this pair
too (drafter already has Qwen3 merges baked in), so no AOSP change is
needed beyond accepting the new drafter path.

No code change to `aosp-dflash-adapter.ts` for option (c). Leave the
file as-is.

### C. Tests

File: `packages/app-core/src/services/local-inference/catalog.test.ts`

The existing `forEach` test (`catalog.test.ts:27`) walks every entry's
`runtime.dflash.drafterModelId` and asserts the id resolves to a real
catalog entry. This test currently **passes** only because the
`bonsai-8b-1bit-dflash` entry is unreachable in the assertion logic, or
because the test was added before the broken pairing was introduced.
After the fix, run `bun run test packages/app-core` to confirm this test
catches future drafter-id typos.

Add a stronger assertion to the same test: for every entry with a
`runtime.dflash` block, the resolved drafter's `params` must indicate the
**same tokenizer family** as the target. Trivial implementation: assert
that target and drafter share the same `params.startsWith` family prefix
(`"Qwen3"`, `"Llama-3"`, etc.) or — better — extend `CatalogModel.runtime`
with an explicit `tokenizerFamily: "qwen3" | "llama3" | "smol" | ...`
field and assert that target.runtime.tokenizerFamily ===
drafter.runtime.tokenizerFamily for every paired entry. This stops the
class of bug from recurring at catalog-edit time.

### D. Documentation

This file. Linked from the comment block on the
`bonsai-8b-1bit-dflash` catalog entry.

## What the other options would have cost (and why they lose)

**(a) Pre-repaired drafter GGUFs:** does not work because merge injection
does not bridge vocab sizes. A "pre-repaired" SmolLM2-with-Qwen3-merges
GGUF would still emit 49k-vocab token ids and still fail llama.cpp's
speculative-decoding vocab assertion. Dead end for this pair regardless
of where the repair runs.

**(b) Port merge injection to TypeScript:** same problem as (a) — solving
the wrong layer. Would only be worth doing if we had a target+drafter
pair that genuinely shared a vocabulary but had a missing/broken merges
sidecar in the drafter GGUF. The current SmolLM2-360M release already
has merges, so even in that hypothetical case we wouldn't need to repair
this particular drafter — we'd just need to find one that's actually
broken in that specific way. Defer until we hit such a pair.

**(c) Same-tokenizer drafter:** the right answer for this pair, available
today off the shelf, no engineering beyond a catalog edit.

## Estimated next-session effort to make DFlash usable on AOSP for this pair

After landing the catalog change in this session:

- Cross-compile `llama-server` for `arm64-v8a` via
  `packages/app-core/scripts/aosp/compile-libllama.mjs` (already exists,
  the script already targets the DFlash-capable upstream fork). One CI
  run.
- Stage the `bonsai-8b-dflash-drafter` GGUF (~485 MB) and Bonsai-8B
  target (~1.2 GB) into the AOSP image alongside the `llama-server`
  binary. Mechanism already exists in `stage-models-dfm.mjs` /
  `stage-default-models.mjs`.
- Run `bun run packages/app-core/scripts/aosp/avd-test.mjs` against the
  paired models with `ELIZA_DFLASH=1` set in the agent env. Expected
  outcome: `aosp-dflash-adapter` spawns llama-server, `/health` becomes
  ready, a sample prompt round-trips through `/v1/chat/completions`, and
  the stderr `eval time` line shows non-zero `n_decoded` plus a
  `n_drafted` count above ~50%.

Total: ~1 session of validation work, gated only on the catalog change
landing and CI publishing the cross-compiled `llama-server` artifact.
