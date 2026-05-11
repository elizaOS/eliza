# Qwen-backbone unification — what can be shared across the Eliza-1 bundle

**Date:** 2026-05-11
**Scope:** research + concrete proposal + the mechanically-safe dedups. Anything
that touches weights, the GGUF graph, training recipes, or the runtime mmap
layout is flagged as a design decision for the runtime-fusion agent and the
training side — not implemented here.

## 0. The four (five) Qwen-lineage components, as shipped today

| Component | Upstream | Vocab / tokenizer | Token-embedding matrix | Where it lives in the bundle |
| --------- | -------- | ----------------- | ---------------------- | ---------------------------- |
| Text / vision | Qwen3.5 (Qwen3.6 27B) | Qwen2 BPE, 151 936 tokens | `token_embd.weight` inside the text GGUF | `text/eliza-1-<tier>-<ctx>.gguf` |
| DFlash drafter | smaller Qwen, fine-tuned to match the text checkpoint | same Qwen2 BPE vocab — **mandatory** (spec decoding requires identical token ids) | its own `token_embd.weight` | `dflash/drafter-<tier>.gguf` |
| TTS | OmniVoice (Qwen3-TTS lineage), `omnivoice.cpp` vendored | Qwen2 BPE **text** vocab **+** acoustic/codec token block | text side: own `token_embd.weight`; plus codec embeddings | `tts/omnivoice-<size>.gguf` **+** `tts/omnivoice-tokenizer-<size>.gguf` |
| ASR | `ggml-org/Qwen3-ASR-0.6B-GGUF` / `-1.7B-GGUF` | Qwen2 BPE text vocab — per AGENTS.md §1 "tokenizer fused with the Qwen3.5/3.6 text backbone (zero re-tokenization)" | own `token_embd.weight` for the text decoder; plus an audio encoder (Whisper-style) that has no token embedding | `asr/eliza-1-asr.gguf` (+ `asr/eliza-1-asr-mmproj.gguf`) |
| Embedding | Qwen3-Embedding-0.6B (1024-dim Matryoshka, 32k ctx) on `1_7b`/`9b`/`27b`; **on `0_6b` it IS the text backbone with `--pooling last`** | same Qwen2 BPE vocab | own `token_embd.weight` (the embedding fine-tune started from Qwen3-0.6B base) | `embedding/…` on `1_7b`+; absent on `0_6b` |

The repeated fact: every text-bearing component is a Qwen with the **same
151 936-token Qwen2 BPE vocabulary and the same merges table** — the runtime
already exploits this in `dflash-server.ts` (`resolveDflashDrafter` copies
`tokenizer.ggml.merges` from the target into the drafter at load time, so the
drafter ships *without* its own merges) and in `voice/shared-resources.ts`
(`SharedTokenizer` is explicitly one object refcounted by both text and voice).

`omnivoice-tokenizer-<size>.gguf` is the one component whose tokenizer GGUF is
genuinely different — it carries the acoustic/codec extension block on top of
the text vocab.

---

## 1. Tokenizer / vocab — do they share the same token-embedding matrix?

**True today:** all five share the same *vocabulary and merges*. They do **not**
share the same *token-embedding matrix tensor* — each GGUF carries its own
`token_embd.weight` (and, for tied-embedding models, that tensor is also the LM
head). Same vocab id-space; different learned vectors:

- Text vs drafter: different dims (drafter hidden size < target), so the matrices
  cannot be the same tensor even though the rows mean the same tokens.
- Text vs ASR text decoder: ASR-0.6B's decoder hidden size is 1024 vs the 9B/27B
  text models' larger hidden sizes — different tensor. On the `0_6b` tier (text
  hidden = 1024) the *shapes* match but the weights are different fine-tunes.
- Text vs OmniVoice text side: OmniVoice's text embedding is a separate, smaller
  block plus a codec-token block — not the text model's tensor.
- Text vs Qwen3-Embedding-0.6B: the embedding model is a contrastive fine-tune of
  Qwen3-0.6B base; on `0_6b` we already collapse it to "= text backbone"; on
  larger tiers it has its own 1024-wide embedding.

**What's possible:** store the **merges table** (and the vocab strings) once per
bundle and reference it from each GGUF, instead of duplicating ~1–2 MB of merges
text inside every GGUF. The runtime already does the drafter half of this at load
time; generalising it to ASR/embedding would need (a) the publish script to strip
`tokenizer.ggml.merges`/`tokenizer.ggml.tokens` from the secondary GGUFs and (b)
the runtime to inject them from the text GGUF at load (same code path as
`resolveDflashDrafter`, parameterised over which secondary). The
`token_embd.weight` *tensors* cannot be deduplicated unless the architectures are
fused (see §3) — they are genuinely different weights.

**Byte savings:** merges-only dedup is ~1–2 MB per secondary GGUF. With 3
secondaries (drafter already does it; add ASR + embedding) that's ~2–4 MB/tier —
real on the `0_6b` mobile tier (a few % of the 500 MB bundle), negligible on 27B.
The token-embedding *tensor* dedup, if architectures were fused, would be the big
win — ~0.15B params (151 936 × 1024 × 2 bytes ≈ 300 MB at bf16, less at Q4) — but
that is not on the table without a fused-architecture GGUF (out of scope per
AGENTS.md §2 "literal single .gguf is not the deliverable").

**Risk:** low for merges dedup (the drafter path already proves it works);
high for tensor dedup (requires a custom GGUF graph).

**Recommendation (ranked):**
1. **HIGH** — add a manifest field documenting that all text-bearing GGUFs in a
   bundle share `tokenizerFamily: "eliza1"` (= the Qwen2 BPE 151 936 vocab) so the
   runtime can assert it and skip re-tokenization handoffs. *(implemented — see §6)*
2. **MEDIUM** — extend the `resolveDflashDrafter` merges-injection pattern to ASR
   and embedding GGUFs; have the publish script strip merges from secondaries.
   Hand to: training (publish script) + runtime-fusion (load-time injection).
3. **LOW / needs human** — fused-architecture GGUF that shares one
   `token_embd.weight` across components. Out of scope per AGENTS.md §2.

---

## 2. Embedding model — can it be `text-backbone + --pooling last` on ALL tiers?

**True today:** only on `0_6b` (text hidden = 1024 = embedding output dim; the
manifest schema's `files.embedding` is intentionally empty there). On `1_7b`/`9b`/
`27b`/`27b-256k` the bundle ships a dedicated `Qwen3-Embedding-0.6B` GGUF
(~600 MB at fp16, ~350–400 MB at Q4_K_M, ~120–150 MB if quantised hard).

**What's possible:** technically yes — `llama-server --pooling last` on the text
GGUF produces a sentence embedding on every tier. But:

- **Dimension mismatch.** Qwen3-Embedding-0.6B emits 1024-dim with Matryoshka
  truncation points (32 / 64 / 128 / 256 / 512 / 768 / 1024). The text backbones
  on 1_7b (2048), 9b (~3584), 27b (~5120) emit *much wider, un-normalised* last
  hidden states. Downstream consumers (the agent's `TEXT_EMBEDDING` slot, vector
  store) assume 1024-dim Matryoshka vectors. Switching to "pool the chat model"
  changes the embedding dimension per tier — that breaks vector-store portability
  and is a product-level decision, not a dedup.
- **Quality.** The dedicated model is a contrastive fine-tune (InfoNCE on
  retrieval pairs) — it is materially better at retrieval/clustering than raw
  last-token pooling of a chat model (the gap is large on MTEB; chat-model pooling
  is typically 5–15 MTEB points worse). On the `0_6b` tier we already accept that
  trade-off because the RAM ceiling forbids a second model; on 1_7b+ we have the
  headroom and the quality matters for the agent's memory/RAG.

**Byte savings if we did it anyway:** drop the `embedding/` GGUF on 4 tiers →
~350–400 MB saved on 1_7b, larger on bigger tiers (the dedicated model is the same
~0.6B regardless of tier, so the *relative* saving shrinks as the tier grows).

**Risk:** **high** — embedding-dimension change is a breaking contract change for
the vector store and the agent's `TEXT_EMBEDDING` consumers; quality regression on
RAG. Not a safe dedup.

**Recommendation:**
- **Keep the dedicated `Qwen3-Embedding-0.6B` on 1_7b+.** The 0.6B-pooling
  collapse is a forced compromise on the smallest tier, not a model we want to
  generalise. *Do not* implement.
- **MEDIUM (if a future RAM-pinch forces it):** a single shared
  `Qwen3-Embedding-0.6B` GGUF *across* tiers (it's tier-independent — same 0.6B
  model) hosted once and symlinked/referenced from every `eliza-1-<tier>` repo,
  rather than re-uploaded per repo. That's a publishing-layout dedup with zero
  quality cost. Hand to: training (publish script).

---

## 3. Shared transformer layers / graph code between text, TTS-text, ASR-text

**Architecturally possible:**
- **LM head / tied embeddings.** Qwen3 chat models tie the LM head to
  `token_embd.weight`. The drafter, ASR text decoder, and OmniVoice text decoder
  each have their *own* tied head — same *shape family*, different weights. No
  weight sharing without retraining all of them as one model. **Not on the table.**
- **llama.cpp graph code reuse.** This is the realistic win. The ASR text decoder
  and the OmniVoice text decoder are both "Qwen3 decoder blocks" (RMSNorm + GQA +
  SwiGLU). llama.cpp already builds the Qwen3 decoder graph once; the audio
  encoder (ASR) and the acoustic decoder (OmniVoice) are the parts that need
  bespoke graph code (Whisper-style conv front-end for ASR; codec/flow-matching
  head for OmniVoice). So the *text-side* graph is already shared at the
  llama.cpp-build level — that's exactly the "one llama.cpp build, one GGML pin"
  contract in AGENTS.md §4. omnivoice.cpp being *vendored into the same build*
  (not a sidecar) is what makes the text-decoder graph code physically shared.
- **What is wishful:** "the ASR/TTS text decoder and the chat model are the same
  weights." They are not. They are independently fine-tuned. Sharing weights would
  require co-training (a single multi-task Qwen) — a model-architecture decision
  far outside an inference-side cleanup.

**Byte / memory savings:** graph-code reuse is a code-size and maintenance win,
not a runtime-memory win — each component still mmaps its own weights.

**Risk:** none (it's already true at the build level); the only "risk" is
forgetting it and letting omnivoice.cpp drift to a different GGML pin (the build
already fails on that, per AGENTS.md §4).

**Recommendation:**
1. **HIGH (already done)** — keep omnivoice.cpp vendored into the same llama.cpp
   build; the build gate already enforces the shared GGML pin. No action.
2. **LOW / needs human** — a co-trained multi-task Qwen (text + ASR-text +
   TTS-text in one backbone) would let the text-decoder *weights* be shared. This
   is a training-architecture proposal, not an inference cleanup. Hand to: training,
   as a future-direction note only.

---

## 4. One tokenizer service / one mmap region — is the vocab actually shared today?

**True today:**
- **Tokenizer service:** yes — `voice/shared-resources.ts` defines a single
  `SharedTokenizer` refcounted by both text and voice surfaces; `voice/index.ts`
  comments "tokenizer (Eliza-1/OmniVoice share a vocabulary)". The runtime contract
  in AGENTS.md §4 says text+voice share "the scheduler, the mmap region for
  weights, the kernel set". So the *tokenizer object* is shared.
- **mmap region:** the `MmapRegionHandle` is deduplicated **by absolute file
  path** (`SharedResourceRegistry.acquire` keys on resource id). That means *if*
  two components were the same file on disk, they'd share one mmap. But text, TTS,
  ASR, embedding, and the drafter are **separate files** — so the *weights* are
  separate mmap regions; only same-file reuse is deduplicated. The vocab embedding
  matrix is therefore **duplicated on disk and in mmap today**, once per GGUF.
- **What "share the mmap region for weights" means in practice:** today it means
  "when voice mode loads, it doesn't re-mmap the *text* GGUF — it reuses the
  text engine's handle" (text+vision are in one GGUF; OmniVoice's text decoder is
  *not* — it's in `tts/omnivoice-<size>.gguf`). So the shared-mmap claim is honest
  for text↔vision but the OmniVoice text decoder weights are a separate region.

**What it would take to truly share the vocab embedding in mmap:** the
`token_embd.weight` tensors would have to be (a) bit-identical across components
(they're not — different fine-tunes, often different dims) and (b) laid out so a
GGUF can reference an external tensor (GGUF has no such mechanism today). So:
not possible without either co-training (→ identical weights) **and** a custom
container format (→ external tensor refs). Both are out of scope per AGENTS.md §2.

**Byte / memory savings if it were possible:** ~300 MB at bf16 on the larger
tiers (one 151 936×hidden matrix instead of 4–5), less at Q4. Significant — but
gated on two large prerequisites.

**Risk:** high (requires both co-training and a container format).

**Recommendation:**
- **HIGH** — document in AGENTS.md §4 / the manifest that "shared mmap region" is
  *per-file* dedup, not vocab-tensor dedup, so nobody assumes a saving that isn't
  there. *(implemented — see §6: catalog/manifest note)*
- **LOW / needs human** — vocab-tensor dedup via an `.eliza` container + co-trained
  weights. Two big projects; not a cleanup. Hand to: runtime-fusion (container
  format) + training (co-training), as a flagged future direction.

---

## 5. DFlash drafter — can drafter and target share the embedding table?

**True today:** the drafter and target **must** share the *vocabulary* (spec
decoding only works if token ids match) — and they do. They do **not** share the
*embedding tensor*: the drafter is a smaller Qwen with a narrower hidden size, so
`token_embd.weight` has a different shape. The runtime already exploits the
vocab-sharing in `dflash-server.ts` — `resolveDflashDrafter()` strips/repairs the
drafter so it carries no `tokenizer.ggml.merges` of its own and inherits the
target's at load time (the drafter GGUF ships *without* merges; the runtime copies
them in). That's the merges half of "share the vocab once". The catalog already
models the relationship explicitly: every drafter is `tokenizerFamily: "eliza1"`,
`runtimeRole: "dflash-drafter"`, `companionForModelId: <tier>`.

**What's possible:** nothing more on the *embedding tensor* (different dims). On
the merges/vocab strings, it's already done. If a future tier shipped a drafter
with the *same* hidden size as the target (it doesn't — the whole point is the
drafter is smaller), the tensor could be shared, but that defeats the speed-up.

**Byte savings:** the merges-strip already saves ~1–2 MB per drafter GGUF — it's
done. No further saving available without changing the drafter architecture.

**Risk:** none — this is the status quo.

**Recommendation:**
1. **HIGH (done)** — keep the drafter merges-repair path; it's the canonical
   "share the vocab once" mechanism. No action.
2. **MEDIUM** — generalise that exact path to ASR + embedding GGUFs (= the §1
   recommendation #2). Hand to: training + runtime-fusion.

---

## 6. Top 3 unification opportunities, ranked by memory-savings × safety

| # | Opportunity | Memory saving | Safety | Status |
| - | ----------- | ------------- | ------ | ------ |
| 1 | **Manifest/catalog: assert all text-bearing GGUFs in a bundle share the `eliza1` vocab + merges** (lets the runtime skip re-tokenization handoffs and skip shipping merges in secondaries) | ~1–2 MB per stripped secondary GGUF (drafter already stripped; +ASR +embedding ≈ 2–4 MB/tier) once the strip is wired | **high** — drafter path already proves the mechanism; manifest field is descriptive | **partially implemented** (manifest schema field + catalog note added below); the strip-from-secondaries half handed to training/runtime-fusion |
| 2 | **Publish-layout dedup: host `Qwen3-Embedding-0.6B` once, reference it from every `eliza-1-<tier>` repo** (it's tier-independent — same 0.6B model on every non-lite tier) | ~350–400 MB **upload/hosting**, not on-device (each device still downloads it once) — but cuts HF storage 4× and guarantees the embedding model can't drift per tier | **high** — pure publishing-layout change, zero quality/runtime impact | handed to training (publish script) |
| 3 | **Keep omnivoice.cpp vendored in the one llama.cpp build → the Qwen3 text-decoder *graph code* is shared by text, ASR-text, and TTS-text** | code-size + maintenance, not runtime memory | **high** — already true; the build gate enforces the shared GGML pin | no action (status quo); documented |

Explicitly **rejected** as unsafe: collapsing the dedicated embedding model into
`text + --pooling last` on 1_7b+ (breaks the 1024-dim Matryoshka contract and
regresses RAG quality — §2); deduplicating `token_embd.weight` *tensors* across
components (requires co-training + a custom container — §1, §4).

---

## 7. What I implemented (mechanically safe, already-true)

1. **`packages/app-core/src/services/local-inference/manifest/schema.ts`** — added
   a `tokenizerFamily` const + a `TOKENIZER_FAMILY_ELIZA1_VOCAB_SIZE` constant and
   documented in the schema header that *every text-bearing GGUF in an Eliza-1
   bundle (text, drafter, ASR text decoder, embedding) shares the same Qwen2 BPE
   151 936-token vocabulary and merges table* — this is the fact that makes the
   `dflash-server.ts` merges-repair path correct and that the runtime relies on for
   zero re-tokenization between ASR output and text input. No behavioural change;
   it makes an already-true invariant explicit and assertable.
2. **`packages/shared/src/local-inference/catalog.ts`** — added a comment block on
   the `MODEL_CATALOG` explaining that `tokenizerFamily: "eliza1"` on the text
   entries *and* the drafter companions is the same vocab, that the drafter GGUFs
   ship *without* `tokenizer.ggml.merges` (repaired at load by
   `resolveDflashDrafter`), and that "shared mmap region" in AGENTS.md §4 is
   per-file dedup — the vocab-embedding *tensor* is duplicated per GGUF and cannot
   be deduplicated without a fused-architecture GGUF (out of scope per AGENTS.md
   §2).

Nothing that touches kernels, `build-llama-cpp-dflash.mjs`, the `voice/` runtime,
weights, or training recipes was edited.

## 8. Handed to the runtime-fusion agent

- **Generalise the drafter merges-repair to ASR + embedding GGUFs.** Same code
  shape as `resolveDflashDrafter()` in `dflash-server.ts`: at load time, copy
  `tokenizer.ggml.merges` / `tokenizer.ggml.tokens` from the text GGUF into the
  secondary if it lacks them. Needs the publish script to strip them first (see §9).
- **Document, in AGENTS.md §4, that "shared mmap region for weights" = per-file
  dedup**, not a shared vocab-embedding tensor. Today text↔vision share one mmap
  (one GGUF); OmniVoice text decoder, ASR, embedding, drafter are separate files →
  separate regions. A truly-shared vocab tensor needs an `.eliza` container with
  external-tensor refs (AGENTS.md §2 explicitly defers this).
- **(Future, flagged not actioned)** `.eliza` container format with one
  `token_embd.weight` referenced by all components — the only path to the ~300 MB
  saving — gated on co-trained weights (see §9).

## 9. Handed to the training side

- **Publish script: strip `tokenizer.ggml.merges` (+ optionally `tokenizer.ggml.tokens`) from secondary GGUFs** (ASR text decoder, embedding) the same way the
  drafter is already stripped, so the runtime injects them from the text GGUF. ~2–4 MB/tier on disk; biggest relative win on `0_6b`.
- **Host `Qwen3-Embedding-0.6B` once** (it's tier-independent) and reference it from
  every `eliza-1-<tier>` repo rather than re-uploading per repo — publishing-layout
  dedup, zero quality cost (§6 #2).
- **Do NOT replace the dedicated embedding model with `text + --pooling last` on
  1_7b+** — it changes the embedding dimension (breaks the 1024-dim Matryoshka
  contract for the vector store) and regresses RAG/MTEB. The `0_6b` pooling
  collapse is a forced compromise on the smallest tier, not a pattern to generalise.
- **(Future, flagged not actioned)** A co-trained multi-task Qwen (text + ASR-text
  + TTS-text in one backbone) would make the text-decoder *weights* shareable — the
  prerequisite for the §4/§1 vocab-tensor dedup. This is a model-architecture
  decision, not an inference cleanup; recorded here only so it isn't lost.
