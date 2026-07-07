# @elizaos/plugin-embeddings

A provider-agnostic ("bring your own") `TEXT_EMBEDDING` provider for elizaOS agents. Point one set of `EMBEDDING_*` variables at **any** OpenAI-compatible `/embeddings` endpoint and get embeddings independently of your chat provider.

## Why

Embeddings power memory, recall, and semantic search — but they don't have to come from the same provider as the chat brain. If your agent runs on a provider that serves no good embeddings (e.g. **Claude**, which has no embeddings API, or **Cerebras**, which serves none), this plugin lets you keep your chat brain where it is and route embeddings to something that does it well:

- a personal **OpenAI** key (`text-embedding-3-small` / `-large`)
- **Eliza Cloud** embeddings
- **Voyage AI** (via an OpenAI-compatible proxy)
- a local **TEI**, **Infinity**, **vLLM**, or **LM Studio** server

## Purely additive

The plugin activates **only** when you set `EMBEDDING_BASE_URL` or `EMBEDDING_API_KEY`. With neither set it never loads, so dropping it into an existing deployment changes nothing until you opt in.

## What it registers

Only the embedding slots — nothing else (no text/image/audio, no actions/providers/services):

| Slot | Behavior |
|---|---|
| `TEXT_EMBEDDING` | Embed one text → one vector. |
| `TEXT_EMBEDDING_BATCH` | Embed many texts in one request → one vector each. |

Both use raw `fetch` (no `@ai-sdk` dependency) to POST to `${EMBEDDING_BASE_URL}/embeddings`.

### Priority

Registered at `priority: 1`:

```
local-inference @ 0  <  plugin-embeddings @ 1  <  Eliza Cloud @ 50
```

A bring-your-own endpoint beats a bare local embedder but yields to a paired Eliza Cloud. Override per-slot via runtime routing preferences if you want a different order.

### Fail loudly, never fabricate

On any HTTP / config / response-shape error the handler **throws** — it never returns a zero or garbage vector that would silently corrupt the embedding store. The only synthetic return is the boot dimension-probe (`null` input), where a correctly-sized marker vector is the expected, legitimate response.

## Configuration

All variables are read via `runtime.getSetting(key)` first, then `process.env`, so they are per-character overridable. They do **not** fall back to any chat provider's settings.

| Variable | Default | Description |
|---|---|---|
| `EMBEDDING_BASE_URL` | _(none)_ | OpenAI-compatible `/embeddings` base URL. **Required** for real embedding calls — no default endpoint. |
| `EMBEDDING_API_KEY` | _(none)_ | Bearer token. Omit for local servers that need no auth. |
| `EMBEDDING_MODEL` | `text-embedding-3-small` | Model id sent as the request `model` field. |
| `EMBEDDING_DIMENSIONS` | `1536` | Vector width (see below). Sent as the request `dimensions` field when explicitly set. |
| `EMBEDDING_BROWSER_URL` | _(none)_ | Browser-only server-side proxy URL. In a browser build the `Authorization` header is sent only when this is set, keeping the key off the client. |

Setting **either** `EMBEDDING_BASE_URL` or `EMBEDDING_API_KEY` activates the plugin.

### Supported dimensions

`EMBEDDING_DIMENSIONS` must be one of:

```
384, 512, 768, 1024, 1536, 2048, 3072
```

Any other value throws.

### ⚠️ Keep the dimension stable per database

The embedding dimension is baked into your database's vector schema. Changing `EMBEDDING_DIMENSIONS` (or the model's native width) invalidates old-width vectors until the active database adapter reclaims them and re-embeds those memories at the active width. SQL-backed agents run that cleanup at boot through `clearEmbeddingsOutsideActiveDimension()`; custom stores need an equivalent path.

## Example `.env`

Personal OpenAI key for embeddings, while chat stays on another provider:

```
EMBEDDING_BASE_URL=https://api.openai.com/v1
EMBEDDING_API_KEY=sk-...
EMBEDDING_MODEL=text-embedding-3-small
EMBEDDING_DIMENSIONS=1536
```

Local TEI / Infinity / vLLM server (no auth):

```
EMBEDDING_BASE_URL=http://localhost:8080/v1
EMBEDDING_MODEL=BAAI/bge-small-en-v1.5
EMBEDDING_DIMENSIONS=384
```

## Installation

The plugin is picked up automatically when `EMBEDDING_BASE_URL` or `EMBEDDING_API_KEY` is present. To reference it explicitly in a character file:

```json
{
  "plugins": ["@elizaos/plugin-embeddings"]
}
```
