# @elizaos/plugin-elizacloud

Eliza Cloud plugin for elizaOS agents. The TypeScript package is backed by
`@elizaos/cloud-sdk`, so runtime Cloud API calls, auth helpers, route wrappers,
TTS, STT, image generation, containers, and gateway relay code use the same SDK
surface as other Eliza Cloud clients.

## Installation

```bash
npm install @elizaos/plugin-elizacloud
# or
bun add @elizaos/plugin-elizacloud
```

Register the plugin with your agent runtime:

```typescript
import { elizaOSCloudPlugin } from "@elizaos/plugin-elizacloud";

const agent = new Agent({
  plugins: [elizaOSCloudPlugin],
});
```

## SDK Contract

The TypeScript package has a hard dependency on `@elizaos/cloud-sdk`.
Development checkouts resolve it with `workspace:*`; published packages are
expected to consume the npm-published SDK version.

Runtime code must not build direct Eliza Cloud HTTP calls by hand. Use the SDK
helpers in `typescript/utils/sdk-client.ts`:

| Helper | Use |
| --- | --- |
| `createCloudApiClient(runtime)` | API-base requests such as `/responses`, `/embeddings`, `/models`, auth validation, containers, and relay JSON endpoints |
| `createCloudApiClient(runtime, true)` | Embedding requests that may use `ELIZAOS_CLOUD_EMBEDDING_URL` / `ELIZAOS_CLOUD_EMBEDDING_API_KEY` |
| `createElizaCloudClient(runtime)` | High-level SDK helpers and generated `client.routes.*` wrappers |
| `typescript/utils/cloud-api.ts` | Backwards-compatible re-export of SDK classes and types |

`ELIZAOS_CLOUD_BASE_URL` remains the API base URL and defaults to
`https://www.elizacloud.ai/api/v1`. `createElizaCloudClient` derives the site
root from that API URL when generated SDK route wrappers need `/api/v1/...`
paths.

`typescript/providers/openai.ts` is the one intentional transport adapter that
passes the configured base URL to the Vercel AI SDK's OpenAI-compatible client.
It is not a hand-rolled Cloud API fetch path.

## Runtime Coverage

| Plugin capability | SDK path |
| --- | --- |
| Text generation (`TEXT_NANO`, `TEXT_SMALL`, `TEXT_MEDIUM`, `TEXT_LARGE`, `TEXT_MEGA`, response handler, planner) | `CloudApiClient.requestRaw("POST", "/responses", ...)` |
| Structured object generation | `CloudApiClient.requestRaw("POST", "/responses", ...)` |
| Research generation | `CloudApiClient.requestRaw("POST", "/responses", ...)` |
| Text embeddings | `CloudApiClient.requestRaw("POST", "/embeddings", ...)` |
| Image generation | `ElizaCloudClient.generateImage(...)` |
| Image description | generated SDK route `client.routes.postApiV1ChatCompletionsRaw(...)` |
| Text-to-speech | generated SDK route `client.routes.postApiV1VoiceTts(...)` |
| Audio transcription | generated SDK route `client.routes.postApiV1VoiceSttRaw(...)` |
| Model registry and credit status | `CloudApiClient` |
| Device auth and API-key validation | `CloudApiClient` |
| Cloud containers | `CloudApiClient` supplied by `CloudAuthService` |
| Managed gateway relay | `CloudApiClient` |

The only remaining runtime-adjacent `fetch()` usage is in the plugin test block
for downloading a public audio fixture. It is not an Eliza Cloud API call.

## Configuration

Get an API key from
[https://www.elizacloud.ai/dashboard/api-keys](https://www.elizacloud.ai/dashboard/api-keys).

| Setting | Description | Default |
| --- | --- | --- |
| `ELIZAOS_CLOUD_API_KEY` | API key used for authenticated Cloud requests | Required |
| `ELIZAOS_CLOUD_BASE_URL` | Eliza Cloud API base URL | `https://www.elizacloud.ai/api/v1` |
| `ELIZAOS_CLOUD_ENABLED` | Enables container provisioning, device auth, bridge, and backup services | `false` |
| `ELIZAOS_CLOUD_NANO_MODEL` | Nano/cheapest model override | `NANO_MODEL` or `openai/gpt-oss-120b` |
| `ELIZAOS_CLOUD_SMALL_MODEL` | Small/fast model override | `SMALL_MODEL` or `openai/gpt-oss-120b` |
| `ELIZAOS_CLOUD_MEDIUM_MODEL` | Medium planning model override | `MEDIUM_MODEL` or small model |
| `ELIZAOS_CLOUD_LARGE_MODEL` | Large model override | `LARGE_MODEL` or `openai/gpt-oss-120b` |
| `ELIZAOS_CLOUD_MEGA_MODEL` | Mega model override | `MEGA_MODEL` or large model |
| `ELIZAOS_CLOUD_RESPONSE_HANDLER_MODEL` | Response handler model override | nano model |
| `ELIZAOS_CLOUD_ACTION_PLANNER_MODEL` | Action planner model override | medium model |
| `ELIZAOS_CLOUD_RESEARCH_MODEL` | Research model override | large model |
| `ELIZAOS_CLOUD_EMBEDDING_MODEL` | Embedding model | `text-embedding-3-small` |
| `ELIZAOS_CLOUD_EMBEDDING_URL` | Optional custom embedding API base URL | unset |
| `ELIZAOS_CLOUD_EMBEDDING_API_KEY` | Optional custom embedding API key | `ELIZAOS_CLOUD_API_KEY` |
| `ELIZAOS_CLOUD_EMBEDDING_DIMENSIONS` | Embedding vector size | `1536` |
| `ELIZAOS_CLOUD_IMAGE_DESCRIPTION_MODEL` | Vision model used for image descriptions | `gpt-5.4-mini` |
| `ELIZAOS_CLOUD_IMAGE_DESCRIPTION_MAX_TOKENS` | Max image-description response tokens | `8192` |
| `ELIZAOS_CLOUD_IMAGE_GENERATION_MODEL` | Image generation model override | service default |
| `ELIZAOS_CLOUD_TTS_MODEL` | Text-to-speech model | `gpt-5-mini-tts` |
| `ELIZAOS_CLOUD_TTS_VOICE` | Text-to-speech voice | `nova` |
| `ELIZAOS_CLOUD_TTS_INSTRUCTIONS` | Optional TTS style instructions | unset |
| `ELIZAOS_CLOUD_TRANSCRIPTION_MODEL` | Audio transcription model | service default |
| `ELIZAOS_CLOUD_EXPERIMENTAL_TELEMETRY` | Enables experimental telemetry metadata | `false` |

Browser builds must not receive secrets directly. Use
`ELIZAOS_CLOUD_BROWSER_BASE_URL` and `ELIZAOS_CLOUD_BROWSER_EMBEDDING_URL` for
browser-only proxy endpoints.

## Usage Examples

```typescript
import { ModelType } from "@elizaos/core";

const text = await runtime.useModel(ModelType.TEXT_LARGE, {
  prompt: "Summarize the current agent state.",
});

const object = await runtime.useModel(ModelType.OBJECT_LARGE, {
  prompt: "Return a JSON user profile with name and role.",
});

const embedding = await runtime.useModel(ModelType.TEXT_EMBEDDING, {
  text: "Hello, world!",
});

const speech = await runtime.useModel(ModelType.TEXT_TO_SPEECH, {
  text: "Cloud text to speech is active.",
});
```

## Adding Cloud Calls

1. Prefer an existing high-level SDK method when one exists.
2. Otherwise use a generated `createElizaCloudClient(runtime).routes.*` wrapper.
3. Use `createCloudApiClient(runtime)` for raw API-base endpoints that do not
   yet have a generated wrapper.
4. Keep all Eliza Cloud API auth/header/base-URL behavior inside the SDK helper
   layer.
5. Do not add direct `fetch()` calls for Eliza Cloud API routes in runtime code.

When the Cloud API adds or changes public routes, update the SDK first:

```bash
cd ../../cloud/packages/sdk
bun run generate:routes
bun run check:routes
bun run test:e2e
```

Then update this plugin to consume the new SDK route or helper.

## Development

From the TypeScript package:

```bash
cd typescript
bun run typecheck
bun run test
bun run build
npm pack --dry-run
```

From the SDK package:

```bash
cd ../../cloud/packages/sdk
bun run check:routes
bun run test:e2e
```

`bun run test:e2e` in the SDK runs public real API checks by default and skips
credentialed or destructive cases unless the required credentials and opt-in
environment flags are present.

## Publishing

The TypeScript package is published to npm as `@elizaos/plugin-elizacloud`.
Publishing must include a compatible `@elizaos/cloud-sdk` release because the
plugin depends on it directly.

The repository also contains legacy Python and Rust package directories. The
Eliza runtime integration and npm package are the TypeScript implementation
documented above.

## License

MIT
