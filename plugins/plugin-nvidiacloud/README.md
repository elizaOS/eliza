# @elizaos/plugin-nvidiacloud

NVIDIA NIM cloud provider for elizaOS. It exposes OpenAI-compatible chat, object generation, and text embeddings through `https://integrate.api.nvidia.com/v1`.

The main reason to use this plugin right now is NVIDIA Build's hosted free inference. It is not anonymous: you still need to sign up for NVIDIA Build, generate an API key, and provide that key as `NVIDIA_API_KEY`. Once configured, it lets an Eliza agent run capable cloud LLMs and embeddings without operating local GPUs or immediately wiring in a paid inference provider. Availability, quotas, and model entitlements can change per NVIDIA account, so this plugin also includes the provider-specific diagnostics needed to tell free-tier limits apart from elizaOS runtime issues.

## Why This Plugin Exists

NVIDIA Build exposes many strong hosted NIM models behind an OpenAI-style API, including models that are currently usable through free hosted inference after you sign up and create an API key. That free access is useful for experimentation, agents, and development deployments, but the endpoints are not perfectly interchangeable with OpenAI:

- Some chat models listed by `/v1/models` can still return `404` or time out for a specific API key.
- Reasoning-oriented models may spend completion tokens before emitting visible text, which is risky for XML/control prompts.
- NVIDIA embeddings can require model-specific request fields such as `input_type`.
- NVCF errors often need `nvcf-reqid` for support and troubleshooting.

This plugin keeps those NVIDIA-specific details local to the provider instead of pushing workarounds into core elizaOS.

## Supported Capabilities

- `TEXT_SMALL`
- `TEXT_LARGE`
- `OBJECT_SMALL`
- `OBJECT_LARGE`
- `TEXT_EMBEDDING`

## Quick Start

Add the plugin to your character:

```ts
plugins: ['@elizaos/plugin-nvidiacloud'];
```

Sign up on NVIDIA Build, open the model you want to use, click **Get API Key**, then set that key:

```bash
NVIDIA_API_KEY=nvapi-...
```

The default base URL is:

```bash
NVIDIA_BASE_URL=https://integrate.api.nvidia.com/v1
```

## Default Models

The defaults are based on live probes against NVIDIA Build for reliable elizaOS XML/control output:

```bash
NVIDIA_SMALL_MODEL=meta/llama-3.1-8b-instruct
NVIDIA_LARGE_MODEL=meta/llama-3.1-405b-instruct
NVIDIA_EMBEDDING_MODEL=nvidia/nv-embedqa-e5-v5
NVIDIA_EMBEDDING_INPUT_TYPE=passage
NVIDIA_EMBEDDING_DIMENSIONS=1024
```

Why these defaults:

- `meta/llama-3.1-8b-instruct` is fast and reliable for `TEXT_SMALL` decisions such as `RESPOND | IGNORE | STOP`.
- `meta/llama-3.1-405b-instruct` is the high-power default for `TEXT_LARGE`.
- `nvidia/nv-embedqa-e5-v5` returns 1024-dimensional vectors and worked reliably where `baai/bge-m3` returned NVCF `500` for some keys.

## Configuration

| Variable                         | Default                               | Why It Exists                                                                                        |
| -------------------------------- | ------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `NVIDIA_API_KEY`                 | required                              | Primary NVIDIA Build / NGC key.                                                                      |
| `NVIDIA_CLOUD_API_KEY`           | unset                                 | Alias if you prefer a cloud-specific key name.                                                       |
| `NVIDIA_BASE_URL`                | `https://integrate.api.nvidia.com/v1` | Chat/object base URL.                                                                                |
| `NVIDIA_BROWSER_BASE_URL`        | unset                                 | Browser proxy URL so API keys are not exposed client-side.                                           |
| `NVIDIA_EMBEDDING_BASE_URL`      | `NVIDIA_BASE_URL`                     | Separate embedding host if NVIDIA changes routing for a model.                                       |
| `NVIDIA_SMALL_MODEL`             | `meta/llama-3.1-8b-instruct`          | Low-latency control/XML model.                                                                       |
| `NVIDIA_LARGE_MODEL`             | `meta/llama-3.1-405b-instruct`        | High-power generation model.                                                                         |
| `SMALL_MODEL`                    | unset                                 | Generic fallback when `NVIDIA_SMALL_MODEL` is unset.                                                 |
| `LARGE_MODEL`                    | unset                                 | Generic fallback when `NVIDIA_LARGE_MODEL` is unset.                                                 |
| `NVIDIA_TEXT_TIMEOUT_MS`         | `180000`                              | Prevents hanging NIM text calls from blocking message handling indefinitely.                         |
| `NVIDIA_SMALL_MAX_OUTPUT_TOKENS` | `1024`                                | Provider-local cap for small calls; leaves enough room for models that emit hidden/reasoning tokens. |
| `NVIDIA_LARGE_MAX_OUTPUT_TOKENS` | `4096`                                | Provider-local cap for large calls.                                                                  |
| `NVIDIA_EMBEDDING_MODEL`         | `nvidia/nv-embedqa-e5-v5`             | Embedding model used by memory indexing.                                                             |
| `EMBEDDING_MODEL`                | unset                                 | Generic fallback when `NVIDIA_EMBEDDING_MODEL` is unset.                                             |
| `NVIDIA_EMBEDDING_INPUT_TYPE`    | `passage`                             | Required by `nv-embed` / `nv-embedqa`; `passage` is correct for memory indexing.                     |
| `NVIDIA_EMBEDDING_DIMENSIONS`    | `1024`                                | Must match the model output and an elizaOS vector dimension.                                         |
| `EMBEDDING_DIMENSIONS`           | unset                                 | Generic fallback when `NVIDIA_EMBEDDING_DIMENSIONS` is unset.                                        |
| `NVIDIA_EMBEDDING_DEBUG`         | `false`                               | Logs sanitized embedding request shapes and NVCF headers.                                            |

## Testing NVIDIA Directly

Use direct `curl` when debugging so you can separate NVIDIA/API-key behavior from elizaOS runtime behavior.

Chat:

```bash
set -a
source ../../.env
set +a

curl -sS https://integrate.api.nvidia.com/v1/chat/completions \
  -H "Authorization: Bearer ${NVIDIA_API_KEY:-$NVIDIA_CLOUD_API_KEY}" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json" \
  -d '{
    "model": "meta/llama-3.1-8b-instruct",
    "messages": [{"role": "user", "content": "Reply with exactly: ok"}],
    "temperature": 0,
    "max_tokens": 32
  }'
```

Embeddings:

```bash
curl -sS https://integrate.api.nvidia.com/v1/embeddings \
  -H "Authorization: Bearer ${NVIDIA_API_KEY:-$NVIDIA_CLOUD_API_KEY}" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json" \
  -d '{
    "model": "nvidia/nv-embedqa-e5-v5",
    "input": ["hello from curl"],
    "input_type": "passage",
    "encoding_format": "float"
  }'
```

## Troubleshooting

### `Validation: Stop sequences array cannot be empty`

NVIDIA rejects `stop: []`. The plugin omits stop sequences unless at least one non-empty value is present.

### Chat works with one model but another model times out

This can happen even when both models appear in `/v1/models`. Choose a known-good model via `NVIDIA_SMALL_MODEL` or `NVIDIA_LARGE_MODEL`.

Known reliable choices from local probes:

- `meta/llama-3.1-8b-instruct`
- `meta/llama-3.1-70b-instruct`
- `meta/llama-3.1-405b-instruct`
- `meta/llama-3.3-70b-instruct`
- `meta/llama-4-maverick-17b-128e-instruct`
- `nvidia/llama-3.1-nemotron-nano-8b-v1`
- `nvidia/llama-3.3-nemotron-super-49b-v1`
- `mistralai/mistral-nemotron`
- `qwen/qwen3-next-80b-a3b-instruct`

Avoid for XML/control prompts unless you have tested them with your key:

- `deepseek-ai/deepseek-v4-flash` timed out in local probes.
- `z-ai/glm4.7` can work, but small output budgets produced empty visible text.
- Thinking models can burn output tokens before returning the XML elizaOS expects.

### Embeddings return NVCF `500`

Chat and embeddings can differ in entitlement. Open the exact embedding model on NVIDIA Build, use **Get API Key**, and confirm that key is used as `NVIDIA_API_KEY`.

Enable debug logging:

```bash
NVIDIA_EMBEDDING_DEBUG=1
```

Then send NVIDIA support the `nvcf-reqid` from the logs.

### Embedding dimension mismatch

`NVIDIA_EMBEDDING_DIMENSIONS` must match the model output and an elizaOS `VECTOR_DIMS` value. The default `nvidia/nv-embedqa-e5-v5` returns `1024`.

## Development

Build:

```bash
bun run build
```

Format:

```bash
bun run format
```

The plugin builds a single Node ESM entrypoint and TypeScript declarations.
