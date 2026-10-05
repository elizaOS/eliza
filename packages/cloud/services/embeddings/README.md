# Embeddings service

Pinned TEI image serving `BAAI/bge-small-en-v1.5` as 384-dimensional embeddings.
The Worker routes `LOCAL_EMBEDDINGS_BASE_URL` here. Preserve the
OpenAI-compatible `POST /v1/embeddings` contract and `/health` readiness.

Build from this directory:

```bash
docker build -t eliza-embeddings .
```

No standalone test suite is defined. Before changing the pinned image or model,
verify an authenticated request returns 384-dimensional vectors in staging.
