# plugin-rlm

RLM (Recursive Language Model) plugin for elizaOS.

## Overview

This plugin integrates **Recursive Language Models (RLMs)** into elizaOS, enabling LLMs to process arbitrarily long contexts through recursive self-calls in a REPL environment.

RLMs represent a breakthrough in long-context processing that:
- Handles inputs **up to 2 orders of magnitude beyond** standard model context windows
- Outperforms vanilla GPT-5 on long-context benchmarks using smaller models
- Uses strategies like **Peeking**, **Grepping**, **Partition+Map**, and **Summarization**

### Reference

- **Paper**: [Recursive Language Models](https://arxiv.org/abs/2512.24601) (arXiv:2512.24601)
- **Authors**: Alex L. Zhang, Tim Kraska, Omar Khattab (MIT CSAIL)
- **Official Implementation**: [github.com/alexzhang13/rlm](https://github.com/alexzhang13/rlm)

## Installation
# Optional: Install RLM backend
pip install git+https://github.com/alexzhang13/rlm.git
```

### TypeScript

```bash
cd plugins/plugin-rlm
npm install
npm run build
```
## Configuration

The plugin reads configuration from environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `ELIZA_RLM_BACKEND` | `gemini` | LLM backend (`openai`, `anthropic`, `gemini`, `groq`, `openrouter`) |
| `ELIZA_RLM_ENV` | `local` | Execution environment (`local`, `docker`, `modal`, `prime`) |
| `ELIZA_RLM_MAX_ITERATIONS` | `4` | Maximum REPL iterations |
| `ELIZA_RLM_MAX_DEPTH` | `1` | Maximum recursion depth |
| `ELIZA_RLM_VERBOSE` | `false` | Enable verbose logging |
| `ELIZA_RLM_PYTHON_PATH` | `python` | Python executable path (TypeScript/Rust IPC) |
| `ELIZA_RLM_MAX_RETRIES` | `3` | Maximum retry attempts for transient failures |
| `ELIZA_RLM_RETRY_DELAY` | `1000` | Base delay (ms) between retries |
| `ELIZA_RLM_RETRY_MAX_DELAY` | `30000` | Maximum delay (ms) between retries |

### Retry Logic

The plugin includes automatic retry with exponential backoff for transient failures. Retries are triggered for:
- Connection timeouts
- Rate limit errors (429)
- Temporary server errors (503)
- Network connection failures

**Assumptions and Limitations:**
- Retry detection uses substring matching on error messages (e.g., "timeout", "connection", "rate limit")
- Different LLM backends may use different error message formats
- Non-transient errors (e.g., authentication, validation) are NOT retried

### Metrics (TypeScript)

The TypeScript client provides metrics for monitoring:

```typescript
const client = new RLMClient();

// Get current metrics
const metrics = client.getMetrics();
console.log(metrics.totalRequests, metrics.successfulRequests);

// Register callback for real-time metrics
client.onMetrics((metrics) => {
  // Send to Prometheus, Datadog, etc.
  exporter.recordGauge('rlm_latency_p95', metrics.p95LatencyMs);
});
```

Available metrics:
- `totalRequests`, `successfulRequests`, `failedRequests`, `stubResponses`
- `totalRetries` - total retry attempts across all requests
- `averageLatencyMs`, `p95LatencyMs` - latency percentiles (rolling 1000 samples)
- `lastRequestTimestamp`, `lastErrorTimestamp`, `lastError`

### Backend API Keys

Depending on your chosen backend, set the appropriate API key:

```bash
# For OpenAI backend
export OPENAI_API_KEY=sk-...

# For Anthropic backend
export ANTHROPIC_API_KEY=sk-ant-...

# For Google Gemini backend
export GEMINI_API_KEY=...
```

## Usage
# The plugin is auto-loaded by elizaOS runtime
# Or use the client directly:
client = RLMClient()
result = await client.infer("Process this very long text...")
print(result.text)
```

### TypeScript

```typescript
import { rlmPlugin, RLMClient } from "@elizaos/plugin-rlm";

// Plugin is auto-registered when loaded
// Or use client directly:
const client = new RLMClient();
const result = await client.infer("Process this very long text...");
console.log(result.text);
```
## Model Types

The plugin registers handlers for the following model types:

| Model Type | Description |
|------------|-------------|
| `TEXT_SMALL` | Small text generation |
| `TEXT_LARGE` | Large text generation |
| `TEXT_REASONING_SMALL` | Small reasoning model |
| `TEXT_REASONING_LARGE` | Large reasoning model |
| `TEXT_COMPLETION` | Text completion |
| `TEXT_RLM_LARGE` | Explicit RLM mode |
| `TEXT_RLM_REASONING` | Explicit RLM with reasoning |

## Architecture

```
plugins/plugin-rlm/
├── README.md                    # This file
└── typescript/
    ├── package.json
    ├── types.ts                 # TypeScript types
    ├── client.ts                # RLMClient
    ├── index.ts                 # Plugin definition
    └── __tests__/
        ├── plugin.test.ts       # Unit tests
        └── integration.test.ts  # Integration tests
```

### Cross-Language Design

Since the official RLM library is Python-only:

1. **Python**: Direct integration with the `rlm` library
2. **TypeScript**: IPC via Python subprocess with JSON-RPC protocol
3. **Rust**: IPC via Python subprocess with JSON-RPC protocol

All implementations fall back to **stub mode** when the RLM backend is unavailable, returning safe placeholder responses without throwing errors.

## Stub Mode

When the RLM backend is not installed or unavailable, the plugin operates in stub mode:

This allows the plugin to be loaded and used without the RLM dependency for testing and development purposes.

## Testing
### TypeScript

```bash
cd plugins/plugin-rlm
npm install
npm test
```
## How RLM Works

RLMs treat long prompts as external objects stored in a Python REPL environment. Instead of feeding the entire input to the model, the LM:

1. **Peeks** at portions of the context
2. **Greps** for relevant information using regex
3. **Partitions** the context into manageable chunks
4. **Maps** recursive LM calls over chunks
5. **Summarizes** and aggregates results

This approach addresses "context rot" - the degradation of model performance as prompt length increases.

### Example: Long Context Processing

## Performance

Based on the original paper's benchmarks:

| Benchmark | GPT-5 | RLM(GPT-5-mini) | Improvement |
|-----------|-------|-----------------|-------------|
| OOLONG (132k) | 30% | 64% | +114% |
| OOLONG (263k) | 31% | 46% | +49% |
| BrowseComp-Plus | ~60% | 100% | +67% |

RLM using GPT-5-mini **outperforms vanilla GPT-5** while being cheaper per query.

## Limitations

- **Latency**: RLM calls take longer due to recursive processing
- **Cost**: Multiple LLM calls may increase API costs
- **Python Dependency**: TypeScript and Rust rely on Python IPC
- **No Streaming**: Streaming is not yet supported in RLM

## Contributing

Contributions are welcome! Please see the main elizaOS repository for contribution guidelines.

## License

MIT
