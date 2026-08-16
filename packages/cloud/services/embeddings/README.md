# embeddings (self-hosted 384-dim TEI sidecar)

Self-hosted text-embeddings service behind the cloud Worker's
`LOCAL_EMBEDDINGS_BASE_URL` routing branch
(`packages/cloud/shared/src/lib/providers/language-model.ts`). It wraps the
upstream [text-embeddings-inference](https://github.com/huggingface/text-embeddings-inference)
(TEI) image serving `BAAI/bge-small-en-v1.5` (384 dimensions) over TEI's native
OpenAI-compatible surface, so shared/dedicated agents get parity embeddings
without an OpenAI dependency or per-request upstream invoice.

## Contract (do not break — the Worker routing depends on it)

| Method | Path | Request | Response |
|---|---|---|---|
| `POST` | `/v1/embeddings` | JSON `{ input, model }` (OpenAI-compatible) | embedding list, 384-dim vectors |
| `GET` | `/health` | — | `200` once the model is loaded |

The cloud model id is the bare `bge-small-en-v1.5`; the Worker always sends
that id upstream and TEI embeds with its one loaded model regardless of the
requested spelling (this is what makes `ELIZA_EMBEDDINGS_FORCE_LOCAL` aliasing
safe). The dimension is pinned in `KNOWN_EMBEDDING_DIMENSIONS`
(`packages/cloud/shared/src/lib/cache/edge-runtime-cache.ts`: 384) and the
platform price row lives in
`packages/cloud/shared/src/lib/services/ai-pricing/providers/bitrouter.ts`
($0.005/1M input tokens, billingSource `selfhosted`).

## Deploy (owner action)

The service is pinned in-repo (`Dockerfile` + `railway.toml`):

```bash
railway up . --path-as-root --service embeddings  # from packages/cloud/services/embeddings
```

Railway assigns a deployment-specific `PORT`; TEI's router reads the `PORT`
env natively so `/health` and public traffic share the socket. A cold
container downloads the model (~130MB) from the HuggingFace hub into `/data`
before `/health` reports ready — `railway.toml` budgets the healthcheck for
that, and attaching a Railway volume at `/data` skips the re-download on
restarts.

CUDA variant on a GPU-backed plan:

```bash
railway up . --path-as-root --service embeddings \
  --build-arg TEI_IMAGE=ghcr.io/huggingface/text-embeddings-inference:1.8
```

## Worker wiring

After deploy, set on the cloud Worker (`wrangler secret` / vars):

- `LOCAL_EMBEDDINGS_BASE_URL` — the public URL of this service (with or
  without a `/v1` suffix; the Worker normalizes it). Setting it routes the
  `bge-small-en-v1.5` model id here.
- `ELIZA_EMBEDDINGS_FORCE_LOCAL=true` — optional: routes EVERY embedding id
  to this sidecar (all ids alias onto `bge-small-en-v1.5`).
- `LOCAL_EMBEDDINGS_API_KEY` — optional: only when this service sets TEI's
  `API_KEY` env to gate its public URL; the Worker sends it as the bearer
  token.

Without `LOCAL_EMBEDDINGS_BASE_URL` the Worker's OpenAI embedding path is
unchanged, and a request for the local id fails as a configuration error
naming the missing variable.
