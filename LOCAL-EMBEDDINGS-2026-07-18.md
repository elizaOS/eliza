# Local embeddings staging strike, 2026-07-18

Co-authored-by: wakesync

## Outcome

A CPU-only, node-local OpenAI-compatible embedding service is deployed on the two enabled staging container nodes. It runs Hugging Face Text Embeddings Inference (TEI) with `sentence-transformers/all-MiniLM-L6-v2`, 384 dimensions, a 1.2 GiB memory limit, and two CPU cores. It is reachable from agent containers at `http://172.18.0.1:8085/v1`.

Staging sandbox configuration is opt-in and production remains unchanged:

```env
EMBEDDING_BASE_URL=http://172.18.0.1:8085/v1
EMBEDDING_MODEL=all-MiniLM-L6-v2
EMBEDDING_DIMENSIONS=384
EMBEDDING_DIMENSION=384
ELIZAOS_CLOUD_USE_EMBEDDINGS=false
```

The code in this branch also adds an optional same-dimension remote fallback to `plugin-embeddings`:

```env
EMBEDDING_FALLBACK_BASE_URL=https://api-staging.elizacloud.ai/api/v1
EMBEDDING_FALLBACK_API_KEY=<agent cloud API key>
EMBEDDING_FALLBACK_MODEL=text-embedding-3-small
```

The fallback is only attempted after a primary network, HTTP, or response-shape failure. Its output is validated against the same `EMBEDDING_DIMENSIONS=384`; a mismatched vector is rejected rather than persisted.

## Current embedding map

All paths resolve through `runtime.useModel(ModelType.TEXT_EMBEDDING)` or `TEXT_EMBEDDING_BATCH`:

- Memory writes: `packages/core/src/runtime.ts:addEmbeddingToMemory`, plus the queued writer in `packages/core/src/services/embedding.ts`.
- Retrieval query embeddings: `packages/core/src/features/documents/recall-embed.ts`; failures degrade to keyword recall.
- Document and knowledge ingestion: `packages/core/src/features/documents/document-processor.ts` and the batch path in `documents/service.ts`.
- Knowledge/document query embeddings: `packages/core/src/features/documents/llm.ts`.
- Message semantic search: `packages/core/src/features/advanced-capabilities/actions/message.ts`.

Before this change, cloud agents route embeddings through `plugin-elizacloud`, posting to the eliza cloud embedding endpoint backed by OpenAI `text-embedding-3-small`. The existing generic `plugin-embeddings` already supports any OpenAI-compatible endpoint and auto-enables only when `EMBEDDING_BASE_URL` or `EMBEDDING_API_KEY` is configured. Therefore no new inference plugin was needed.

Existing local options found in-tree:

- `plugin-local-embedding`: Transformers.js/Xenova local inference, useful for single-process desktop use but duplicates model RAM in every cloud agent container.
- `plugin-ollama`: supports embedding models, but requires a heavier Ollama daemon/model stack.
- `plugin-embeddings`: lightweight OpenAI-compatible client, selected for a shared per-node TEI service.

The shared node service avoids loading the same model in every agent container.

## Database dimensions and migration

The SQL schema already uses one fixed pgvector column per supported width in `plugins/plugin-sql/src/schema/embedding.ts`: 384, 512, 768, 1024, 1536, 2048, and 3072 dimensions. Each embedding row populates exactly one dimension column.

Both staging agents previously had `EMBEDDING_DIMENSION=1536` and cloud embedding dimensions 1536. The new model is 384-dimensional. Existing 1536-dimensional vectors cannot be compared to 384-dimensional query vectors and must not be retained as active retrieval data.

The runtime already implements the safe migration:

1. `ensureEmbeddingDimension(384)` selects the `dim384` column.
2. `clearEmbeddingsOutsideActiveDimension()` deletes stale embedding rows for that agent whose active dimension column is null.
3. The returned memory IDs are queued for low-priority background re-embedding in chunks of 200.

Thus re-embedding existing memories is required. There is no OpenAI cost for the migration. At the measured short-input p50, raw inference is about 130 items/second before queue, storage, and batching overhead. Conservative planning is 25-75 memories/second per node. A 100,000-memory agent should take roughly 22-67 minutes if drained serially at low priority. Monitor queue depth and database write pressure during rollout.

## Benchmark

Measured from inside a real healthy staging agent container on `eliza-core-9d2c43db`, through the same Docker bridge/gateway used in deployment. Thirty sequential warm requests per class. Service limits: 2 CPU, 1.2 GiB RAM. Long input was 500 whitespace-delimited words and was accepted/truncated to the model's 512-token maximum.

| Path/model | Input | Samples | p50 | p95 | Min | Max |
|---|---:|---:|---:|---:|---:|---:|
| Local TEI / all-MiniLM-L6-v2 | ~10 tokens | 30 | 7.7 ms | 12.0 ms | 5.4 ms | 13.8 ms |
| Local TEI / all-MiniLM-L6-v2 | ~500 tokens | 30 | 56.6 ms | 74.7 ms | 37.0 ms | 79.1 ms |
| Eliza Cloud / OpenAI path | short | 5 | 1,489 ms | 3,591 ms | 1,113 ms | 3,591 ms |

Cold behavior:

- Service/model startup to ready: approximately 10-15 seconds after container start with a warm model cache.
- First request after ready: 43.8 ms.
- Subsequent warm short p95: 12.0 ms.

A BGE-small-v1.5 trial was also measured. Short input was fast, but the 500-token p95 was 157.5 ms on four allocated CPU cores and 238.7 ms on the actual two-core staging allocation. MiniLM-L6 was selected because it met the sub-100 ms long-input requirement under the real allocation.

## Retrieval sanity check

A four-document synthetic memory corpus was queried from the staging node. Known query-to-document matches were 4/4 top-1:

- workout query -> gym memory
- RWA deal query -> Strata memory
- mountain riding query -> snowboard memory
- dinner query -> cooking memory

This is a smoke check, not a full relevance evaluation. Before production, run an offline comparison over sampled real agent memories and report recall@5 / MRR against the existing OpenAI vectors.

## Code changes

`plugins/plugin-embeddings` now supports:

- `EMBEDDING_FALLBACK_BASE_URL`
- `EMBEDDING_FALLBACK_API_KEY`
- `EMBEDDING_FALLBACK_MODEL`
- one retry after primary network/HTTP/shape failure
- strict same-dimension validation on primary and fallback responses
- combined error context if both endpoints fail
- fallback-only configuration remains inert, preserving default-off behavior

Focused tests cover primary success without fallback, primary failure followed by fallback success, fallback dimension mismatch, both endpoints failing, malformed input, and fallback-only auto-enable behavior. Formatting and Biome checks pass. The checkout lacks installed Vitest/tsgo dependencies, so the full targeted test and typecheck commands could not execute in this worktree and remain a CI gate.

## Staging deployment details

- TEI image: `ghcr.io/huggingface/text-embeddings-inference:cpu-1.6`
- Model: `sentence-transformers/all-MiniLM-L6-v2`
- Nodes: `eliza-core-9d2c43db` and `eliza-core-95ea703e`
- Container: `tei-embeddings`, restart policy `unless-stopped`
- Resource limit per node: 2 CPU / 1.2 GiB
- Model cache: `/opt/tei-data`
- Listener: Docker bridge gateway `172.18.0.1:8085`, not publicly exposed
- Staging environment backup table: `local_embedding_env_backup_20260718`

## Rollout recommendation

1. Keep production default off.
2. Complete CI for the fallback patch and ship it in a staging image.
3. Let the two staging agents complete 1536 -> 384 re-embedding and monitor failures, queue depth, RSS, CPU contention, and retrieval metrics for 24-48 hours.
4. Add TEI as managed node bootstrap infrastructure before production. A bare manually-created container is not sufficient for autoscaled/new nodes.
5. Canary a small production cohort by node, never by a random mix on nodes without TEI.
6. Keep both dimension settings explicitly pinned to 384. Never change only one of `EMBEDDING_DIMENSION` and `EMBEDDING_DIMENSIONS`.
7. Remote fallback must request 384-dimensional OpenAI vectors. If the remote endpoint cannot guarantee 384 dimensions, fail closed and use keyword recall rather than mixing widths.
8. Promote only if real-corpus retrieval quality is comparable and warm p95 remains below 100 ms under concurrent agent load.
