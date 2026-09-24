# @elizaos/plugin-embeddings

Provider-agnostic ("bring your own") `TEXT_EMBEDDING` provider for elizaOS agents.

Node ESM only. Enable with `EMBEDDING_BASE_URL` or `EMBEDDING_API_KEY`; configure `EMBEDDING_MODEL` and matching `EMBEDDING_DIMENSIONS`. Throw on transport or vector-shape failure rather than fabricating embeddings.

Build, test, and setup: [README.md](README.md).
