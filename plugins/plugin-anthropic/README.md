# @elizaos/plugin-anthropic

Anthropic Claude model provider for [elizaOS](https://github.com/elizaos/eliza). Adds Claude text generation, streaming, image description, and structured JSON output to any Eliza agent.

## What it does

This plugin registers Claude model handlers into the elizaOS model dispatch layer. Once loaded, calls to `runtime.useModel()` for any text, reasoning, or image-description model type are routed to the Anthropic API (or Claude Code CLI, or OAuth subscription, depending on your auth mode).

Capabilities added:

- **Text generation** — all ModelType tiers: `TEXT_NANO`, `TEXT_SMALL`, `TEXT_MEDIUM`, `TEXT_LARGE`, `TEXT_MEGA`, `RESPONSE_HANDLER`, `ACTION_PLANNER`
- **Reasoning** — `TEXT_REASONING_SMALL` and `TEXT_REASONING_LARGE` with configurable chain-of-thought token budget
- **Image description** — `IMAGE_DESCRIPTION` returns `{ title, description }` from an image URL
- **Streaming** — all text handlers support `stream: true`, returning an async `TextStreamResult`
- **Structured output** — pass `responseSchema` (JSON Schema) to any text handler to receive parsed JSON
- **Tool calling** — pass `tools`, `toolChoice` to any text handler for native Anthropic tool use
- **Prompt caching** — `cache_control: ephemeral` applied automatically to system prompts and stable prompt segments

## Auto-enable

The plugin is automatically enabled when `ANTHROPIC_API_KEY` or `CLAUDE_API_KEY` is present in the environment. No manual plugin registration is needed in that case.

To register manually:

```typescript
import { anthropicPlugin } from "@elizaos/plugin-anthropic";
import { AgentRuntime } from "@elizaos/core";

const runtime = new AgentRuntime({
  plugins: [anthropicPlugin],
  // ...
});
```

## Usage

```typescript
import { ModelType } from "@elizaos/core";

// Text generation
const text = await runtime.useModel(ModelType.TEXT_LARGE, {
  prompt: "Explain quantum computing in simple terms",
});

// Streaming
const result = await runtime.useModel(ModelType.TEXT_LARGE, {
  prompt: "Count from 1 to 5.",
  stream: true,
  onStreamChunk: (chunk) => process.stdout.write(chunk),
});

// Structured output
const obj = await runtime.useModel(ModelType.TEXT_SMALL, {
  prompt: "Return a JSON object with a greeting field.",
  responseSchema: {
    type: "object",
    properties: { greeting: { type: "string" } },
    required: ["greeting"],
  },
});

// Image description
const { title, description } = await runtime.useModel(ModelType.IMAGE_DESCRIPTION, {
  imageUrl: "https://example.com/photo.jpg",
});
```

## Configuration

| Env var | Required | Default | Description |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | Yes* | — | Anthropic API key (`sk-ant-...`) |
| `CLAUDE_API_KEY` | Alt | — | Alias accepted alongside `ANTHROPIC_API_KEY` |
| `ANTHROPIC_AUTH_MODE` | No | `apikey` | Auth mode: `apikey`, `oauth`, or `claude-cli` |
| `ANTHROPIC_SMALL_MODEL` | No | `claude-haiku-4-5-20251001` | Model for small-tier calls |
| `ANTHROPIC_LARGE_MODEL` | No | `claude-opus-4-7` | Model for large-tier calls |
| `ANTHROPIC_NANO_MODEL` | No | (small fallback) | Model for TEXT_NANO |
| `ANTHROPIC_MEDIUM_MODEL` | No | (small fallback) | Model for TEXT_MEDIUM |
| `ANTHROPIC_MEGA_MODEL` | No | (large fallback) | Model for TEXT_MEGA |
| `ANTHROPIC_REASONING_SMALL_MODEL` | No | (small fallback) | Model for TEXT_REASONING_SMALL |
| `ANTHROPIC_REASONING_LARGE_MODEL` | No | (large fallback) | Model for TEXT_REASONING_LARGE |
| `ANTHROPIC_BASE_URL` | No | `https://api.anthropic.com/v1` | API base URL override |
| `ANTHROPIC_BROWSER_BASE_URL` | No | — | Proxy URL for browser builds |
| `ANTHROPIC_COT_BUDGET` | No | `0` | Chain-of-thought token budget (0 = disabled) |
| `ANTHROPIC_COT_BUDGET_SMALL` | No | — | CoT budget for small-size models |
| `ANTHROPIC_COT_BUDGET_LARGE` | No | — | CoT budget for large-size models |
| `ANTHROPIC_PROMPT_CACHE_TTL` | No | `5m` | Prompt cache TTL: `"5m"` or `"1h"` |
| `ANTHROPIC_EXPERIMENTAL_TELEMETRY` | No | `false` | Enable Vercel AI SDK telemetry |

\* Required unless `ANTHROPIC_AUTH_MODE=oauth` or `ANTHROPIC_AUTH_MODE=claude-cli`.

### OAuth mode

Set `ANTHROPIC_AUTH_MODE=oauth`. Token is read from (in order):

1. `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_OAUTH_TOKEN` env var
2. macOS keychain (`Claude Code-credentials`)
3. `~/.claude/.credentials.json` (or `$CLAUDE_CONFIG_DIR/.credentials.json`)

Run `claude auth login` (Claude Code CLI) to populate the credential store.

### CLI mode

Set `ANTHROPIC_AUTH_MODE=claude-cli`. Requires the `claude` binary on `PATH` (install from [code.claude.com](https://code.claude.com)). Invokes `claude -p` for each model call. Does not support `messages`, `tools`, `toolChoice`, or `responseSchema`.

## Caveats

- **Opus 4.x models** only accept `temperature=1`. The plugin enforces this automatically.
- **`temperature` and `topP` are mutually exclusive** in the Anthropic API. Supplying both logs a warning and drops `topP`.
- **`maxTokens` is capped** at 32k (Opus 4) or 64k (all others) to avoid API 400 errors.
- **Browser builds** (`exports.browser`) never access `process.env`. Set `ANTHROPIC_BROWSER_BASE_URL` to a server-side proxy; do not expose your API key in client-side code.

## Development

```bash
bun run --cwd plugins/plugin-anthropic build
bun run --cwd plugins/plugin-anthropic test
bun run --cwd plugins/plugin-anthropic typecheck
```

For agent-facing documentation (file layout, how to add handlers, extension steps), see [CLAUDE.md](CLAUDE.md).
