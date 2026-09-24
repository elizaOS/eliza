# Claude Subscription Gateway

This package is the common model boundary for subscription-backed comparison
of the elizaOS, Hermes, and OpenClaw agent loops. It accepts OpenAI-compatible
chat-completion requests on loopback, serializes the complete message history
deterministically, and performs one fresh Claude Agent SDK query for each
request using validated Claude Code OAuth authentication.

The gateway is not an agent harness. Frameworks retain their own prompts,
planning loops, sessions, and tool execution. When the model proposes a tool
call, the gateway's temporary MCP handler records the name and arguments and
returns them to the calling framework; it never executes the benchmark tool.

## Supported request surface

- `POST /v1/chat/completions`
- Authenticated `GET /v1/models` with the pinned Claude chat-model catalog used
  by the benchmark profiles
- Text `system`, `developer`, `user`, `assistant`, and `tool` messages
- OpenAI function tools and `auto`, `none`, `required`, or named tool choice
- JSON responses for `stream:false` and OpenAI SSE for `stream:true`
- Optional `reasoning_effort`

SSE is a response adapter over the same completed SDK query, not a second model
request. It emits assistant text or indexed tool-call deltas, a finish chunk, a
usage chunk, and `[DONE]`. This matches OpenClaw's native
`openai-completions` transport while keeping all three harnesses on the same
queue and completion path.

Claude Code does not expose OpenAI temperature or output-token controls through
the Agent SDK. The gateway accepts those request fields, records their names as
unapplied provenance, and requires benchmark readiness checks to keep them
identical across harnesses.

## Security and observability

- Bind addresses are restricted to `127.0.0.1` and `::1`.
- A random 256-bit bearer token is generated unless the embedding process
  supplies one explicitly.
- The CLI refuses API-billing environment variables before binding or
  publishing readiness. The SDK subprocess also receives a scrubbed
  environment, its account control response must report a first-party Claude
  subscription, and its init envelope must report either OAuth or the bundled
  CLI's `none` sentinel for keychain-backed subscription auth. Every API-key
  source fails closed.
- The cohort orchestrator runs `claude auth status --json` with stderr
  suppressed before it starts this process. A logged-out account, a non-
  claude.ai auth method, malformed status, and an unavailable CLI are separate
  fixed error classifications; none may fall through to worker startup.
- `/health` is content-free and unauthenticated for local readiness probes;
  `/v1/chat/completions` requires the bearer token.
- Audit records contain hashes, counts, controlled identifiers, timing, the
  canonical reasoning-effort value actually applied (or explicit `null`), and
  transport provenance only. Prompts, tool arguments, tokens, account identity,
  and upstream error text are never retained.
- Publication requires one non-null effort within each lane. Three-agent cohort
  publication additionally requires Eliza, Hermes, and OpenClaw to share one
  identical observed value.
- SDK module, tool-configuration, query-start, account-initialization, and
  stream exceptions are translated to fixed gateway error codes. Their causes
  stay inside the process and never enter an HTTP response or audit artifact.
- Embeddings are intentionally unsupported. The gateway returns `not_found`
  rather than fabricating vectors or silently routing to another provider.

The library entrypoint is `startClaudeSubscriptionGateway()`. The returned
handle owns the ephemeral token and must pass it directly to child harnesses
without writing it to logs.

## Cohort process

Launch one gateway for one benchmark cohort. The launcher must remove
`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, Bedrock/Vertex/Foundry selection,
and raw cloud-provider credential variables from the child environment. The
`--no-env-file` flag prevents the repository dotenv files from reintroducing
them:

```bash
bun --no-env-file run --cwd suites/claude-subscription-gateway start -- \
  --ready-file /absolute/operator-workspace/cohort.gateway-ready.json \
  --audit-file /absolute/operator-workspace/cohort.gateway-audit.jsonl
```

The process binds `127.0.0.1` on an operating-system-selected port and writes
no success output. It atomically publishes a mode-`0600` readiness document:

```json
{
  "schema_version": 1,
  "status": "ready",
  "pid": 12345,
  "origin": "http://127.0.0.1:54321",
  "base_url": "http://127.0.0.1:54321/v1",
  "health_url": "http://127.0.0.1:54321/health",
  "transport": {
    "provider": "claude-agent-sdk",
    "sdk_version": "0.3.200",
    "credential_policy": "claude-code-oauth-only",
    "fresh_session_per_request": true,
    "tool_execution": "capture-only",
    "response_modes": ["json", "sse"]
  },
  "harness_tokens": {
    "eliza": "<ephemeral bearer>",
    "hermes": "<different ephemeral bearer>",
    "openclaw": "<different ephemeral bearer>"
  }
}
```

The orchestrator may securely parse and immediately unlink readiness. On
`SIGTERM` or `SIGINT`, the gateway stops accepting requests, atomically writes
the mode-`0600` redacted audit JSONL, tolerates an already-absent readiness
file, and exits. Every audit line keeps `queue_wait_ms` separate from
`service_ms` and contains only controlled identifiers, counts, timings,
provenance, and hashes.

For a harness named `<name>`, `handle.envForHarness(<name>)` emits:

| Variable | Value |
| --- | --- |
| `CLAUDE_SUBSCRIPTION_GATEWAY_URL` | readiness `origin` |
| `CLAUDE_SUBSCRIPTION_GATEWAY_TOKEN` | that harness's bearer token |
| `BENCHMARK_BASE_URL` | readiness `base_url` |
| `OPENAI_BASE_URL` | readiness `base_url` |
| `OPENAI_API_KEY` | that harness's bearer token |
| `BENCHMARK_MODEL_PROVIDER` | `claude-subscription` |
| `BENCHMARK_HARNESS` | `<name>` |
| `ELIZA_BENCH_HARNESS` | `<name>` |

## Offline verification

```bash
bun run test
bun run typecheck
```

Tests inject a fake Agent SDK module. They do not invoke Claude Code or spend
subscription usage.
