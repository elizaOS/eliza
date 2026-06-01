# @elizaos/plugin-rlm

RLM (Recursive Language Model) plugin for elizaOS. Enables Eliza agents to process arbitrarily long contexts through recursive self-calls in a Python REPL environment.

## What it does

Standard LLMs degrade on long inputs ("context rot"). This plugin integrates the RLM technique ([arXiv:2512.24601](https://arxiv.org/abs/2512.24601)) which processes long prompts by:

1. Storing the full input in a Python REPL environment.
2. Letting the model **Peek**, **Grep**, **Partition**, **Map**, and **Summarize** over the data in multiple iterations.
3. Returning a final answer once the model is satisfied.

This allows processing of inputs far beyond a model's native context window using smaller, cheaper models.

When the Python backend is not installed the plugin falls back to stub mode — it loads cleanly and returns placeholder responses rather than crashing.

## Capabilities added

The plugin registers model handlers for:

- `ModelType.TEXT_SMALL`
- `ModelType.TEXT_LARGE`
- `ModelType.TEXT_REASONING_SMALL`
- `ModelType.TEXT_REASONING_LARGE`
- `ModelType.TEXT_COMPLETION`

Any `runtime.useModel(...)` call for these types is routed through the RLM backend.

## Installation

```bash
# Install the TypeScript plugin
bun add @elizaos/plugin-rlm

# Install the Python backend (required for real inference; stub mode works without it)
pip install git+https://github.com/alexzhang13/rlm.git
```

## Enable the plugin

Add `@elizaos/plugin-rlm` to your character's plugin list. No other registration is required.

## Configuration

All settings are read from environment variables.

| Variable | Default | Description |
|---|---|---|
| `ELIZA_RLM_BACKEND` | `gemini` | LLM backend: `openai`, `anthropic`, `gemini`, `groq`, `openrouter` |
| `ELIZA_RLM_ENV` | `local` | Execution environment: `local`, `docker`, `modal`, `prime` |
| `ELIZA_RLM_MAX_ITERATIONS` | `4` | Maximum REPL iterations per call |
| `ELIZA_RLM_MAX_DEPTH` | `1` | Maximum recursion depth |
| `ELIZA_RLM_VERBOSE` | `false` | Enable verbose logging |
| `ELIZA_RLM_PYTHON_PATH` | `python` | Python executable path |
| `ELIZA_RLM_MAX_RETRIES` | `3` | Retry attempts for transient failures |
| `ELIZA_RLM_RETRY_BASE_DELAY` | `1000` | Base retry delay (ms, exponential backoff) |
| `ELIZA_RLM_RETRY_MAX_DELAY` | `30000` | Maximum retry delay (ms) |
| `ELIZA_RLM_PRICING_JSON` | _(unset)_ | JSON override for model pricing (per 1M tokens) |

Backend API keys are forwarded to the Python subprocess via the environment. Set whichever key matches your chosen backend:

```bash
export GEMINI_API_KEY=...        # default backend
export OPENAI_API_KEY=sk-...
export ANTHROPIC_API_KEY=sk-ant-...
```

## Stub mode

When the Python backend is unavailable (not installed, wrong `ELIZA_RLM_PYTHON_PATH`, startup failure), the plugin operates in stub mode. All inference calls return:

```
[RLM STUB] RLM backend not available
```

with `result.metadata.stub === true`. No error is thrown.

## Metrics

```typescript
import { RLMClient } from "@elizaos/plugin-rlm";

const client = new RLMClient();
const metrics = client.getMetrics();
// metrics.totalRequests, .successfulRequests, .failedRequests,
// .stubResponses, .totalRetries, .averageLatencyMs, .p95LatencyMs

client.onMetrics((m) => {
  // called after every request
});
```

## Trajectory logging

```typescript
import { RLMClient, RLMTrajectoryIntegration } from "@elizaos/plugin-rlm";

const client = new RLMClient();
const integration = new RLMTrajectoryIntegration({ client });
const result = await integration.infer("Analyze this long document...");
const costs = integration.getCostSummary(integration.getTrajectoryIds()[0]);
```

Pass an optional `logger` implementing `TrajectoryLogger` to integrate with `plugin-trajectory-logger`.

## Architecture

```
plugins/plugin-rlm/
├── index.ts                  # Plugin definition and singleton client management
├── client.ts                 # RLMClient — Python IPC, retry, metrics
├── server.ts                 # RLMServer — TCP IPC server (wraps RLMClient)
├── cost.ts                   # Cost estimation, pricing table, strategy detection
├── types.ts                  # All shared types and ENV_VARS constants
└── trajectory-integration.ts # Step-level cost + trajectory logging
```

## Limitations

- **Python dependency:** Real inference requires a Python process with the `rlm` library installed.
- **No streaming:** All inference is synchronous (returns full text).
- **Latency:** Multiple recursive LLM calls are slower than a single call.
- **Token counting:** Uses a `text.length / 4` approximation; inaccurate for non-ASCII.
- **Node only:** Does not run in browser or mobile runtimes.

## Reference

- Paper: [Recursive Language Models](https://arxiv.org/abs/2512.24601) — Zhang, Kraska, Khattab (MIT CSAIL)
- Official Python library: [github.com/alexzhang13/rlm](https://github.com/alexzhang13/rlm)

## License

MIT
