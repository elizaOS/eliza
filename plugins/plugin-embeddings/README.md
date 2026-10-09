# @elizaos/plugin-embeddings

Provider-agnostic ("bring your own") `TEXT_EMBEDDING` provider for elizaOS agents.

Set `EMBEDDING_BASE_URL` to an OpenAI-compatible API base and `EMBEDDING_API_KEY` if
authentication is required. Either setting activates the plugin, but real requests
require the base URL. Optional `EMBEDDING_MODEL` and `EMBEDDING_DIMENSIONS` select the
model and vector width (default 1536). Supported widths are 384, 512, 768, 1024, 1536,
2048, and 3072. Changing widths requires database re-embedding.
`EMBEDDING_FALLBACK_BASE_URL`, `_API_KEY`, and `_MODEL` configure one fallback that must
return the same dimensions. Confidential-host requests retain host authority. Import
from the single Node entry `@elizaos/plugin-embeddings`.

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd plugins/plugin-embeddings build  # build
bun run --cwd plugins/plugin-embeddings test   # tests
```
