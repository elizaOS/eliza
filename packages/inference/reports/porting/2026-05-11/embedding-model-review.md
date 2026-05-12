# Eliza-1 embedding model — review + optimization (M-EMBED)

**Date:** 2026-05-11 (CUDA bench addendum 2026-05-12)
**Scope:** the embedding side of the Eliza-1 stack — the two-mode contract
(pooled-text on `0_6b` vs the dedicated `embedding/eliza-1-embedding.gguf` on
`1_7b`+), the Matryoshka-dim API on the local-embedding route, whether the
runtime's `TEXT_EMBEDDING` model slot actually reaches the bundle's embedding
region, and a CPU/Vulkan/CUDA latency+throughput bench. Implementation landed in
`packages/app-core/src/services/local-inference/voice/{embedding,embedding-server}.ts`,
the engine wiring in `engine.ts`, the runtime handler in
`runtime/ensure-local-inference-handler.ts`, and the harness in
`packages/inference/verify/embedding_bench.mjs`.

---

## 1. The two modes — verdict

Per `AGENTS.md` §1, the embedding model is bundled differently per tier. Both
paths are wired and verified by `voice/embedding.test.ts`:

| Tier | Embedding source | How it's resolved | Hard-fails if missing? |
| ---- | ---------------- | ----------------- | ---------------------- |
| `eliza-1-0_6b` | **the text backbone GGUF**, served `--embeddings --pooling last` (last-token pooling) — no separate weights | `resolveLocalEmbeddingSource` → `{ kind: "pooled-text", textModelPath, poolingType: "last" }` | yes — throws `VoiceStartupError("missing-bundle-root")` if the text GGUF is absent |
| `eliza-1-1_7b` / `9b` / `27b` / `27b-256k` / `27b-1m` | **a dedicated `embedding/<name>.gguf`** = Qwen3-Embedding-0.6B (Apache-2.0, 1024-dim Matryoshka, 32k ctx) | `resolveLocalEmbeddingSource` → first `.gguf` under `<bundleRoot>/embedding/` → `{ kind: "dedicated-region", embeddingModelPath, dimensions: 1024, poolingType: "last" }` | **yes** — throws `VoiceStartupError` with an explicit "do not fall back to pooled text" message. **It is NOT collapsed to pooled-text** — that would regress the dimension contract from a calibrated 1024-dim Matryoshka model to whatever an uncalibrated base model's last-token state happens to be (B1's verdict). |

**Why a sidecar:** `engine.embed()` lazily constructs an `EmbeddingServer`
(`voice/embedding-server.ts`) on the *first* `embed()` call — a separate
`llama-server --embeddings --pooling last` over whichever GGUF the route
resolved. The chat `llama-server` is left completions-only (it must not carry
`--embeddings`). On `0_6b` the sidecar mmaps the *same* text GGUF the chat
server already mapped, so the OS shares the page cache — no duplicate *bundle*
weights, just a second process view. On `1_7b`+ the sidecar mmaps the ~600 MB
`embedding/` GGUF, lazily, so a voice-off / RAG-off agent never pages it.

**Lazy acquisition:** the dedicated region is acquired through the same engine /
`SharedResourceRegistry` path as the other bundle regions; the `EmbeddingServer`
constructor `existsSync`-checks the GGUF and the `embed()` path does the spawn +
`/health` wait on first use. `unload()` / model-switch tears it down.

`POOLED_TEXT_EMBEDDING_TIERS` is a one-element set (`eliza-1-0_6b`) — explicit
so a future tier can't silently inherit pooled-text behavior.

---

## 2. Matryoshka dims — API + quality/size tradeoff

`buildLocalEmbeddingRoute` produces a `LocalEmbeddingRoute` carrying
`dimensions: 1024`, `defaultDim` (1024 unless overridden), and
`matryoshkaDims: [64, 128, 256, 512, 768, 1024]`. `engine.embed(input, dim)`
and `EmbeddingServer.embed(texts, dim)` take a `dim` parameter; both validate
against `EMBEDDING_MATRYOSHKA_DIMS` and route through `truncateMatryoshka(vec,
dim)` which **truncates to the leading slice and L2-renormalizes** (the leading
slice of a unit-norm 1024-vec is *not* unit-norm; cosine/dot retrieval assumes
unit vectors, so renorm is mandatory). Invalid `dim` or a too-short vector
throws — no silent truncation-to-whatever, no zero-pad (Commandment 8).

The `0_6b` text-GGUF Q8_0 proxy, 16-sentence heterogeneous corpus, pairwise
cosine-ranking preservation vs full 1024:

| dim | fp32 bytes/vec | fp16 bytes/vec | storage vs 1024 | pairwise-ranking Pearson vs full | guidance |
| --- | -------------- | -------------- | --------------- | -------------------------------- | -------- |
| 1024 | 4096 | 2048 | 100 % | 1.000 | default; archival / high-recall RAG |
| 768 | 3072 | 1536 | 75 % | 0.998 | near-lossless; safe default if you want 25 % off |
| 512 | 2048 | 1024 | 50 % | 0.993 | strong; good general RAG sweet spot |
| 256 | 1024 | 512 | 25 % | 0.968 | noticeable but usable; large corpora, coarse recall |
| 128 | 512 | 256 | 12.5 % | 0.956 | aggressive; dedup / clustering, not fine ranking |
| 64 | 256 | 128 | 6.3 % | 0.925 | extreme; only when storage dominates and recall is loose |

Notes:
- These numbers are a **conservative lower bound** — they were measured on the
  raw Qwen3-0.6B base GGUF (the pooled-text proxy). The *dedicated*
  Qwen3-Embedding-0.6B is contrastively trained for exactly these truncation
  points, so its real 64/128/256 numbers should be at or above these.
- `pairwise-ranking Pearson` = Pearson correlation between the corpus's
  pairwise-cosine matrix at the truncated width and at 1024 — a cheap offline
  retrieval-ranking-preservation proxy when an MTEB run isn't available.
- The knee is between 512 and 256: 512 keeps ~99 % of ranking fidelity at half
  the storage; below 256 the loss compounds.

---

## 3. Vector-store / RAG integration — does anything call it?

**Yes — wired and verified.** elizaOS's memory/RAG layer embeds via
`runtime.useModel(ModelType.TEXT_EMBEDDING, …)`. `ensure-local-inference-handler.ts`
registers a `TEXT_EMBEDDING` handler at the local-inference priority:

- If a `localInferenceLoader` service with `embed()` is present (AOSP / device
  bridge) → `makeEmbeddingHandler()` routes to that loader.
- Otherwise, when the provider is the desktop/server `LocalInferenceEngine` →
  `makeEngineEmbeddingHandler()` → `localInferenceEngine.embed(text)` → the
  bundle's embedding sidecar (pooled-text on `0_6b`, dedicated region on
  `1_7b`+).
- If `localInferenceEngine.canEmbed()` is false (no Eliza-1 bundle active) the
  handler **throws** — the runtime then falls through to the operator-configured
  provider (Eliza Cloud / OpenAI). No silent zero-vector (Commandment 8). This
  is what gives the AGENTS.md §1 embedding region a real runtime caller
  (Commandment 10 — it was previously a descriptor with no consumer).

Three-mode rule (`AGENTS.md` §1/§5): in **local** mode the local handler is at
the local-inference priority and wins; in **cloud**/**remote** mode there is no
active Eliza-1 bundle so `canEmbed()` is false, the handler throws, and the
cloud/remote embedding provider serves the slot. The separate
`plugin-local-embedding` (node-llama-cpp, downloads its own Qwen3-Embedding
GGUF) remains the path for installs that don't have a full Eliza-1 *bundle* but
do want local embeddings — it registers `TEXT_EMBEDDING` at priority 10. The two
don't conflict: the bundle path is only active when a bundle is loaded.

Tests: `voice/embedding.test.ts` (route resolution + truncation) and
`voice/embedding-server.test.ts` (sidecar dim validation, empty-input
short-circuit, `embeddingServerForRoute` GGUF selection per mode, missing-GGUF
hard-fail).

---

## 4. Latency / throughput / cold-load / peak-RSS — CPU / Vulkan / CUDA

Host: Intel Core Ultra 9 275HX (24 logical cores, 31 GB RAM) + NVIDIA GeForce
RTX 5080 Laptop (16 GB, CC 12.0). Model: Qwen3-0.6B-Q8_0 (the 0_6b text backbone
in pooled-text mode and the same 0.6B lineage as the dedicated
Qwen3-Embedding-0.6B). Server: `llama-server --embeddings --pooling last
--batch-size 4096 --ubatch-size 4096 --parallel 16 --ctx-size 8192
--n-gpu-layers 99`. Single-text = median of 24 runs after warmup; throughput =
batch / wall. Full JSON: `verify/bench_results/embedding_2026-05-11.json`.

| backend | cold-load (ms) | peak RSS (MB) | single-text median (ms) | batch_1 (texts/s) | batch_4 | batch_8 | batch_16 |
| ------- | -------------- | ------------- | ----------------------- | ----------------- | ------- | ------- | -------- |
| CPU (24 thr, quiescent) | 1 398 | 1 635 | 122 | 16.2 | 43.6 | 95.9 | 97.5 |
| CPU (24 thr, dflash chat server contending) | 1 555 | 1 636 | 131 | 22.1 | 29.0 | 36.1 | 41.5 |
| Vulkan (NVIDIA Vulkan ICD on the 5080) | 3 549 | 504 | 17.3 | 184.7 | 397.8 | 504.3 | 513.8 |
| CUDA (RTX 5080, ngl 99) | 21 139 | 2 154 | 13.8 | 174.1 | 403.4 | 577.0 | **684.1** |

Reading it:
- **CUDA wins** on both single-text latency (~14 ms vs ~17 ms Vulkan vs ~122 ms
  CPU) and big-batch throughput (~684 texts/s at batch 16). The 21 s cold-load
  is CUDA-context + cuBLAS warmup on first launch; the runtime amortizes it —
  the sidecar is started once per bundle and reused for the agent's lifetime.
- **Vulkan** tracks CUDA on single-text and small batches; it falls behind at
  batch 16 because the Vulkan backend doesn't fuse the pooling matmuls as
  tightly as cuBLAS. Lower RSS (it doesn't pin a CUDA context).
- **CPU** is fine for occasional embeds (~120 ms) but throughput collapses under
  contention with the chat `llama-server` — the `cpu_contended` row is left in
  to document the realistic shared-host case. On a quiescent host the `-b/-ub`
  4096 + `--parallel 16` tuning gets it to ~98 texts/s.
- **0_6b pooled-text vs the dedicated `1_7b` embedding model:** *speed* is
  identical — same 0.6B arch, same `llama-server` flags; the only delta is the
  extra ~600 MB to mmap on first `embed()` for the dedicated region (lazy). On
  *quality*, the dedicated model is the one carrying Qwen's contrastive
  embedding head and the calibrated Matryoshka behavior; pooled-text last-token
  states from a raw base model are usable for short-text similarity but were
  never calibrated for the truncated widths — which is exactly why `1_7b`+ MUST
  use the dedicated region (AGENTS.md §1).

---

## 5. Optimizations landed

- **`-ub == -b == 4096`** on the embedding server: a multi-input
  `/v1/embeddings` call is one ubatch, not chunked at the 512-token default
  (which silently caps batching). The 0.6B model is tiny enough that a
  4096-token batch is comfortable.
- **`--parallel 16`**: with `--pooling last` each input runs on its own
  sequence; `--parallel N` lets up to N ride the same forward pass instead of
  being serialized. 16 covers a typical RAG batch; each slot's KV is tiny at
  0.6B / 8k ctx. (Throughput at batch 16 went from serialized-baseline to the
  numbers above.)
- **`--pooling last`** (not `mean`) in both modes: matches the Qwen3-Embedding
  contrastive head's training and pins the read so `llama-server` doesn't fall
  back to a base GGUF's `mean` metadata default.
- **Lazy sidecar**: the embedding `llama-server` is not started at bundle load —
  only on the first `embed()`. A voice-off / RAG-off agent never pages the
  embedding weights or pays the cold-load.
- **GPU offload `--n-gpu-layers 99`** by default (`"auto"` in the engine config)
  so CUDA/Vulkan hosts get the GPU path without per-host tuning; `gpuLayers: 0`
  forces CPU.
- **`--ctx-size 8192`**: Qwen3-Embedding-0.6B is 32k-ctx but 8k is plenty for
  embedding inputs and keeps the KV pool small across 16 parallel slots.
- **Engine-level reuse**: one `EmbeddingServer` per activated bundle; subsequent
  `embed()` calls reuse the process. (Per-text embedding *result* caching is a
  RAG-layer concern, not the model adapter's — the runtime's memory layer
  already dedups by content hash before calling `useModel`.)

---

## 6. What's left / not done

- **Real dedicated-region bench**: the numbers above use the Qwen3-0.6B base
  GGUF as a proxy because no staged Eliza-1 bundle on this box ships a real
  `embedding/eliza-1-embedding.gguf` yet. When one is staged, re-run
  `node packages/inference/verify/embedding_bench.mjs --model
  <bundle>/embedding/eliza-1-embedding.gguf` and update the matryoshka table
  with the *trained* model's numbers (expected ≥ the proxy's at 64/128/256).
- **MTEB**: the pairwise-ranking-Pearson proxy is what's runnable offline. A
  proper MTEB-retrieval slice would tighten the dim guidance but needs the
  datasets pulled.
- **`--ubatch-size` sweep on CUDA**: 4096 is a safe default; a sweep
  (2048/4096/8192) on the 5080 might squeeze a bit more batch-16 throughput. Not
  load-bearing.
- **`dim` plumbed end-to-end to RAG**: the route/engine/sidecar all take `dim`,
  but the runtime's `TEXT_EMBEDDING` contract is `(text) -> number[]` with no
  dim — so today every runtime embed is 1024-dim. Exposing a per-agent default
  dim (env or settings) would let large-corpus deployments opt into 512-dim
  storage; flagged as a small follow-up, not implemented (out of scope: changing
  the core model contract).
