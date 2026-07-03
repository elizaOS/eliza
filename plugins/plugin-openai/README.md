# @elizaos/plugin-openai

OpenAI model-provider plugin for [elizaOS](https://github.com/elizaos/eliza). Adds text generation, embeddings, image generation, image description, audio transcription, text-to-speech, and deep research to any Eliza agent by registering handlers for the standard `ModelType.*` slots on the `AgentRuntime`.

## What this plugin does

- **Text generation** — multiple tiers (nano, small, medium, large, mega), plus dedicated response-handler and action-planner slots. Supports streaming and structured JSON output.
- **Text embeddings** — `text-embedding-3-small` by default; dimension configurable.
- **Image generation** — DALL-E 3 by default (`dall-e-3`).
- **Image description** — vision model analyzes an image URL and returns `{ title, description }`.
- **Audio transcription** — speech-to-text (`gpt-5-mini-transcribe` by default); accepts `Buffer`, `Blob`, `File`, or a URL.
- **Text-to-speech** — returns an `ArrayBuffer` of audio. Six voices; mp3/wav/flac/opus/aac/pcm output.
- **Deep research** — `ModelType.RESEARCH` via the OpenAI Responses API (`o3-deep-research` by default); returns annotated, multi-source research reports.
- **Tokenizer** — encode/decode using js-tiktoken (browser-safe, no network calls).

Works with any OpenAI-compatible endpoint: OpenAI, Cerebras, EvoLink, OpenRouter, local servers, etc.

## Enabling the plugin

Add `@elizaos/plugin-openai` to your character's plugin list:

```json
{
  "plugins": ["@elizaos/plugin-openai"]
}
```

The plugin auto-enables when `OPENAI_API_KEY`, `CEREBRAS_API_KEY`, or `EVOLINK_API_KEY` is present in the environment.

## Required configuration

```
OPENAI_API_KEY=sk-...
```

That is the only required setting. All other settings are optional overrides.

## Full configuration reference

Set these as environment variables or in your character's `settings` object.

### API endpoint

| Variable | Default | Description |
|---|---|---|
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | Override for compatible endpoints |
| `ELIZA_PROVIDER` | — | Set to `cerebras` or `evolink` to force a compatible-provider mode |
| `EVOLINK_API_KEY` | — | Auth for EvoLink's OpenAI-compatible endpoint |
| `EVOLINK_BASE_URL` | `https://direct.evolink.ai/v1` | EvoLink endpoint used when `EVOLINK_API_KEY` enables the plugin |
| `EVOLINK_MODEL` | `gpt-5.2` | Text model used by EvoLink mode |

### Text generation models

| Variable | Default | Description |
|---|---|---|
| `OPENAI_SMALL_MODEL` / `SMALL_MODEL` | `gpt-5.4-mini` | Fast, cost-effective responses |
| `OPENAI_NANO_MODEL` / `NANO_MODEL` | falls back to small | Fastest tier |
| `OPENAI_MEDIUM_MODEL` / `MEDIUM_MODEL` | falls back to small | Mid-tier |
| `OPENAI_LARGE_MODEL` / `LARGE_MODEL` | `gpt-5` | Complex reasoning |
| `OPENAI_MEGA_MODEL` / `MEGA_MODEL` | falls back to large | Highest tier |
| `OPENAI_RESPONSE_HANDLER_MODEL` | falls back to small | Response-handler slot |
| `OPENAI_ACTION_PLANNER_MODEL` | falls back to medium | Action-planner slot |
| `OPENAI_REASONING_EFFORT` | — | `minimal`/`low`/`medium`/`high` for o-series models |

### Embeddings

| Variable | Default | Description |
|---|---|---|
| `OPENAI_EMBEDDING_MODEL` | `text-embedding-3-small` | Embedding model |
| `OPENAI_EMBEDDING_URL` | `OPENAI_BASE_URL` | Separate endpoint for embeddings |
| `OPENAI_EMBEDDING_API_KEY` | `OPENAI_API_KEY` | Separate key for embeddings |
| `OPENAI_EMBEDDING_DIMENSIONS` | `1536` | Vector dimensions (must match model) |

### Image generation and description

| Variable | Default | Description |
|---|---|---|
| `OPENAI_IMAGE_MODEL` | `dall-e-3` | Image generation model |
| `OPENAI_IMAGE_DESCRIPTION_MODEL` | `gpt-5-mini` | Vision/description model |
| `OPENAI_IMAGE_DESCRIPTION_BASE_URL` | `OPENAI_BASE_URL` | Separate endpoint for vision |
| `OPENAI_IMAGE_DESCRIPTION_API_KEY` | `OPENAI_API_KEY` | Separate key for vision |
| `OPENAI_IMAGE_DESCRIPTION_MAX_TOKENS` | `8192` | Max tokens in description response |

### Audio

| Variable | Default | Description |
|---|---|---|
| `OPENAI_TRANSCRIPTION_MODEL` | `gpt-5-mini-transcribe` | Speech-to-text model |
| `OPENAI_TTS_MODEL` | `tts-1` | Text-to-speech model |
| `OPENAI_TTS_VOICE` | `nova` | Voice: alloy, echo, fable, onyx, nova, shimmer |
| `OPENAI_TTS_INSTRUCTIONS` | — | Style instructions for TTS |

### Deep research

| Variable | Default | Description |
|---|---|---|
| `OPENAI_RESEARCH_MODEL` | `o3-deep-research` | Research model (o3 or o4-mini variants) |
| `OPENAI_RESEARCH_TIMEOUT` | `3600000` (1 hr) | Request timeout in milliseconds |

### Browser and proxy

| Variable | Default | Description |
|---|---|---|
| `OPENAI_BROWSER_BASE_URL` | — | Proxy URL for browser builds (keeps key server-side) |
| `OPENAI_BROWSER_EMBEDDING_URL` | — | Proxy URL for browser embedding requests |
| `OPENAI_ALLOW_BROWSER_API_KEY` | `false` | Send auth header in browser builds (opt-in) |

### Other

| Variable | Default | Description |
|---|---|---|
| `OPENAI_EXPERIMENTAL_TELEMETRY` | `false` | Enable AI SDK experimental telemetry |

## Usage examples

```ts
import { ModelType } from "@elizaos/core";

// Text generation
const reply = await runtime.useModel(ModelType.TEXT_LARGE, {
  prompt: "Explain quantum entanglement in plain English.",
});

// Streaming text
const result = await runtime.useModel(ModelType.TEXT_LARGE, {
  prompt: "Count from 1 to 10.",
  stream: true,
  onStreamChunk: (chunk) => process.stdout.write(chunk),
});

// Structured JSON output
const data = await runtime.useModel(ModelType.TEXT_LARGE, {
  prompt: "Return a JSON object with name and age fields.",
  responseSchema: {
    type: "object",
    properties: { name: { type: "string" }, age: { type: "number" } },
    required: ["name", "age"],
  },
});

// Embedding
const vector = await runtime.useModel(ModelType.TEXT_EMBEDDING, {
  text: "text to embed",
});

// Image generation
const images = await runtime.useModel(ModelType.IMAGE, {
  prompt: "A sunset over mountains",
  count: 1,
  size: "1024x1024",
});

// Image description
const { title, description } = await runtime.useModel(
  ModelType.IMAGE_DESCRIPTION,
  "https://example.com/photo.jpg"
);

// Audio transcription (Buffer, Blob, File, or URL string all accepted)
const transcript = await runtime.useModel(ModelType.TRANSCRIPTION, audioBuffer);

// Text-to-speech
const audio = await runtime.useModel(ModelType.TEXT_TO_SPEECH, {
  text: "Hello, world.",
  voice: "nova",
  format: "mp3",
});

// Deep research (may take minutes)
const report = await runtime.useModel(ModelType.RESEARCH, {
  input: "What are the latest advances in fusion energy?",
  tools: [{ type: "web_search_preview" }],
});
console.log(report.text, report.annotations);
```

## Browser proxy setup

In browser builds this plugin does not send `Authorization` headers by default, to avoid exposing API keys in frontend bundles. Point `OPENAI_BROWSER_BASE_URL` at a server-side proxy that injects the key:

```ts
// Minimal Express proxy
import express from "express";
const app = express();
app.use(express.json());

app.all("/openai/*", async (req, res) => {
  const url = `https://api.openai.com/v1/${req.params[0]}`;
  const r = await fetch(url, {
    method: req.method,
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: req.method !== "GET" ? JSON.stringify(req.body) : undefined,
  });
  res.status(r.status).send(await r.text());
});

app.listen(3000);
```

Then set `OPENAI_BROWSER_BASE_URL=http://localhost:3000/openai`.

## Cerebras compatibility

Point `OPENAI_BASE_URL` at a Cerebras endpoint or set `ELIZA_PROVIDER=cerebras` and the plugin automatically adapts: structured output uses `json_object` mode, `reasoning_effort` defaults to `"low"` for reasoning-capable models (to prevent empty responses), and `CEREBRAS_API_KEY` is accepted as an alias for `OPENAI_API_KEY`. Embeddings fall back to a deterministic local hash when no explicit embedding URL is set, since Cerebras does not provide an embeddings endpoint.

## EvoLink compatibility

Set `EVOLINK_API_KEY` to use EvoLink through its OpenAI-compatible endpoint. The plugin defaults to `https://direct.evolink.ai/v1` and `gpt-5.2`; set `EVOLINK_BASE_URL` or `EVOLINK_MODEL` to override either value.

## Prompt caching

Pass `providerOptions.openai.promptCacheKey` and `promptCacheRetention` on any `GenerateTextParams` call to enable OpenAI prompt caching:

```ts
await runtime.useModel(ModelType.TEXT_LARGE, {
  prompt: "...",
  providerOptions: {
    openai: { promptCacheKey: "my-key", promptCacheRetention: "24h" },
  },
});
```

## Free-form record/map tool arguments degrade under strict schema

A tool parameter that declares a free-form record/map — `additionalProperties: true` or a value schema (e.g. a contact `customFields: { type: "object", additionalProperties: { type: "string" } }`) — **cannot round-trip today**. The plugin's single schema choke point forces `additionalProperties: false` on every object before it reaches the wire, because strict-grammar backends (Cerebras / Eliza Cloud) reject open maps with a hard 400 and provider strictness is proxy-blind (an agent pointed at `api.elizacloud.ai` with `OPENAI_API_KEY` looks like plain OpenAI but may still route to strict Cerebras — see #11123 / #11156). With the object closed, the model can emit no arbitrary keys, so the map arg arrives **empty**.

This is a known limitation, not a silent one: the declared intent is folded into the property `description`, and when a tool's parameters contain such a record the plugin emits **one structured `logger.warn` per tool** (`[OpenAI] Tool "…" declares N free-form record/map argument(s) …`) listing each offending path so the degradation is observable in logs. The warning is scoped to **tool parameters only** — `response_format` is intentionally excluded.

Making these args actually emittable requires a product decision tracked in [#12150](https://github.com/elizaOS/eliza/issues/12150): option **A** (preserve open records for known non-strict providers, which first needs a reliable strictness signal) or option **B** (a two-sided transform that rewrites records into a strict-safe key/value shape and reverse-maps returned tool-call arguments). This plugin currently ships option **C** (accept the limitation, but make it observable + documented) as the safe stopgap.
