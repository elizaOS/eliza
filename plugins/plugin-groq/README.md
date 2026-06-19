# @elizaos/plugin-groq

Groq LLM plugin for elizaOS — fast inference for text generation, audio transcription, and text-to-speech synthesis via Groq's API.

## What it does

Registers model handlers so any Eliza agent can use Groq as its inference backend. The plugin auto-enables itself whenever `GROQ_API_KEY` is present — no manual registration required.

Supported capabilities:

- **Text generation** across five size tiers (nano, small, medium, large, mega) with native tool-calling and structured JSON output
- **Audio transcription** via `whisper-large-v3-turbo`
- **Text-to-speech** synthesis (returns `Uint8Array` audio)
- **Response handler** and **action planner** model roles with tier-appropriate defaults

## Installation

```bash
bun add @elizaos/plugin-groq
# or
npm install @elizaos/plugin-groq
```

## Quick start

```typescript
import { groqPlugin } from "@elizaos/plugin-groq";

// Pass to your agent's plugin list — or set GROQ_API_KEY and let auto-enable handle it.
const agent = new AgentRuntime({
  plugins: [groqPlugin],
  // ...
});
```

## Configuration

| Variable | Required | Default | Description |
|---|---|---|---|
| `GROQ_API_KEY` | **Yes** | — | Groq API key; also triggers auto-enable |
| `GROQ_BASE_URL` | No | `https://api.groq.com/openai/v1` | Override for proxies |
| `GROQ_SMALL_MODEL` | No | `openai/gpt-oss-120b` | Model for small/nano/medium tiers |
| `GROQ_LARGE_MODEL` | No | `openai/gpt-oss-120b` | Model for large/mega tiers |
| `GROQ_NANO_MODEL` | No | falls back to small | Explicit nano-tier model |
| `GROQ_MEDIUM_MODEL` | No | falls back to small | Explicit medium-tier model |
| `GROQ_MEGA_MODEL` | No | falls back to large | Explicit mega-tier model |
| `GROQ_RESPONSE_HANDLER_MODEL` | No | nano tier | Model for response-handler role |
| `GROQ_ACTION_PLANNER_MODEL` | No | large tier | Model for action-planner role |
| `GROQ_TTS_MODEL` | No | `canopylabs/orpheus-v1-english` | Text-to-speech model |
| `GROQ_TTS_VOICE` | No | `troy` | TTS voice |
| `GROQ_TTS_RESPONSE_FORMAT` | No | `wav` | TTS audio format |

All settings can also be passed via `agentConfig.pluginParameters` in your agent's character file.

## Model types registered

| elizaOS model type | Notes |
|---|---|
| `TEXT_NANO` | Fastest/cheapest text generation |
| `TEXT_SMALL` | Small-tier text; supports tools + structured output |
| `TEXT_MEDIUM` | Medium-tier text |
| `TEXT_LARGE` | Large-tier text; supports tools + structured output |
| `TEXT_MEGA` | Mega-tier text |
| `RESPONSE_HANDLER` | Defaults to nano for low-latency response routing |
| `ACTION_PLANNER` | Defaults to large for reasoning-heavy planning |
| `TRANSCRIPTION` | Whisper transcription (Node only) |
| `TEXT_TO_SPEECH` | Speech synthesis (Node only) |

## Browser support

Text generation works in browser contexts when `GROQ_BASE_URL` points to a server-side proxy. `TRANSCRIPTION` and `TEXT_TO_SPEECH` are Node-only and will throw in browser environments. Set `GROQ_ALLOW_BROWSER_API_KEY=true` only if you intentionally want to expose the API key from browser code.

## Development

```bash
bun run --cwd plugins/plugin-groq build    # compile
bun run --cwd plugins/plugin-groq test     # unit tests
bun run --cwd plugins/plugin-groq typecheck
bun run --cwd plugins/plugin-groq lint
```
