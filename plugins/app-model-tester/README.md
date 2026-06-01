# @elizaos/app-model-tester

A developer tool for elizaOS that lets you run live end-to-end probes against every model type registered in an Eliza agent — text generation, embeddings, speech synthesis, transcription, voice activity detection, image description, and image generation.

## What it adds

Once loaded, the plugin mounts:

- A standalone static HTML tester at `GET /model-tester` — works without any frontend build.
- JSON API endpoints at `/api/model-tester/status` (model availability) and `/api/model-tester/run` (run a probe).
- A React overlay app (`ModelTesterAppView`) registered in the elizaOS app shell, visible in the apps grid under the **system** category.
- A TUI view at `/model-tester/tui` for terminal-based use.

## Probes

| Probe | Description |
|---|---|
| `text-small` | Non-streaming `TEXT_SMALL` generation |
| `text-large` | Streaming `TEXT_LARGE` generation with chunk capture |
| `embedding` | Embedding vector dimensions and preview |
| `text-to-speech` | Synthesise speech from the prompt, returned as base64 audio |
| `transcription` | Transcribe an uploaded audio file (or a TTS loopback if none is provided) |
| `vad` | Voice activity detection on PCM samples — pure JS, always available |
| `image-description` | Describe an uploaded image in text |
| `image` | Generate an image from the prompt |

Each probe tries local inference first (via `@elizaos/plugin-local-inference` if installed), then falls through to configured cloud providers. All attempts and errors are surfaced in the JSON response.

## How to enable

Add `modelTesterPlugin` to the agent's plugin array:

```ts
import { modelTesterPlugin } from "@elizaos/app-model-tester/plugin";

const agent = new AgentRuntime({
  plugins: [modelTesterPlugin, /* other plugins */],
});
```

The plugin is opt-in. There is no default-enable path.

## Required configuration

No plugin-specific environment variables are required. Model provider credentials (Anthropic, OpenAI, etc.) are resolved by the elizaOS runtime through the normal model registry. Local inference uses `@elizaos/plugin-local-inference` and requires at least one `eliza-1-*` model bundle to be installed.

## E2E script

```bash
bun run --cwd plugins/app-model-tester test:e2e
```

Requires a live agent server. Reads `MODEL_TESTER_BASE_URL` (default `http://127.0.0.1:31337`). Set `MODEL_TESTER_REQUIRE_ALL=1` to fail if the server is unreachable.

Probes that fail with a known-unavailable backend message (no TTS, missing vision model, low credit balance, etc.) are reported as skipped rather than failures unless `MODEL_TESTER_REQUIRE_ALL=1`. The `text-small`, `text-large`, `embedding`, and `vad` probes are always required to pass.
