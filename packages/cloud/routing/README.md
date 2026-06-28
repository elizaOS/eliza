# @elizaos/cloud-routing

Routing resolver for elizaOS plugins. Decides whether a call to an external AI service should use a locally configured API key, be proxied through Eliza Cloud, or be disabled when neither is available.

## What it does

elizaOS plugins need to call external services (LLMs, embeddings, TTS, etc.). Users may have their own API keys, or they may rely on Eliza Cloud as a managed proxy. This package centralises the logic that picks the right route so that every plugin doesn't have to reimplement it.

The three possible outcomes are:

- **`local-key`** — use the user's own API key directly against the upstream service.
- **`cloud-proxy`** — proxy the request through Eliza Cloud using `ELIZAOS_CLOUD_API_KEY`.
- **`disabled`** — neither route is available; the caller should surface a clear error.

In `auto` mode (the default), a local key takes precedence over cloud proxy.

## Installation

```bash
bun add @elizaos/cloud-routing
```

## Usage

```ts
import {
  resolveCloudRoute,
  toRuntimeSettings,
  type RouteSpec,
} from "@elizaos/cloud-routing";

const SPEC: RouteSpec = {
  service: "my-service",            // identifies this service in the cloud proxy path
  localKeySetting: "MY_API_KEY",    // env/setting name holding the user's own key
  upstreamBaseUrl: "https://api.example.com/v1",
  localKeyAuth: { kind: "bearer" }, // or { kind: "header", headerName: "x-api-key" }
};

// runtime is an elizaOS AgentRuntime (or anything with getSetting)
const route = resolveCloudRoute(toRuntimeSettings(runtime), SPEC);

if (route.source === "disabled") {
  throw new Error(`Service unavailable: ${route.reason}`);
}

// route.baseUrl and route.headers are ready to use
const response = await fetch(`${route.baseUrl}/completions`, {
  headers: route.headers,
});
```

## Per-feature routing policies

Users can pin individual feature categories to `local`, `cloud`, or `auto` via env vars:

| Feature | Env var |
|---|---|
| LLM calls | `ELIZAOS_CLOUD_ROUTING_LLM` |
| Blockchain RPC | `ELIZAOS_CLOUD_ROUTING_RPC` |
| Tool/function execution | `ELIZAOS_CLOUD_ROUTING_TOOL_USE` |
| Embeddings | `ELIZAOS_CLOUD_ROUTING_EMBEDDINGS` |
| Image/audio/video | `ELIZAOS_CLOUD_ROUTING_MEDIA` |
| Text-to-speech | `ELIZAOS_CLOUD_ROUTING_TTS` |
| Speech-to-text | `ELIZAOS_CLOUD_ROUTING_STT` |

Use `resolveFeatureCloudRoute` to respect these settings in a plugin:

```ts
import { resolveFeatureCloudRoute, toRuntimeSettings } from "@elizaos/cloud-routing";

const route = resolveFeatureCloudRoute(toRuntimeSettings(runtime), "llm", SPEC);
```

## Environment variables

| Var | Required | Description |
|---|---|---|
| `ELIZAOS_CLOUD_API_KEY` | for cloud proxy | Eliza Cloud API key |
| `ELIZAOS_CLOUD_ENABLED` | for cloud proxy | Must be `"true"` or `"1"` |
| `ELIZAOS_CLOUD_BASE_URL` | no | Override cloud base URL (default: `https://www.elizacloud.ai/api/v1`) |

## Building

```bash
bun run --cwd packages/cloud-routing build
bun run --cwd packages/cloud-routing typecheck
bun run --cwd packages/cloud-routing lint
```
