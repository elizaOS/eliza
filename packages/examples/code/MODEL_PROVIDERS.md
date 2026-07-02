# eliza-code Model Providers

`eliza-code` (the `elizaos` coding sub-agent the orchestrator spawns over ACP)
runs the elizaOS runtime, so its coding model is whatever model provider the
runtime resolves at boot (`src/lib/model-provider.ts` -> `resolveModelProvider`).
You select the provider with environment variables. Any OpenAI Chat
Completions-compatible endpoint works out of the box.

## How Provider Resolution Works

`resolveModelProvider(env)`:

1. Explicit override: `ELIZA_CODE_PROVIDER` (or its alias
   `ELIZA_CODE_MODEL_PROVIDER`) with `anthropic` / `claude` or `openai` /
   `codex`.
2. Auto-detect: `OPENAI_API_KEY` -> `openai`; `ELIZA_OPENCODE_API_KEY` ->
   `openai`; `ANTHROPIC_API_KEY` -> `anthropic`.

`applyOpencodeProviderEnv(env)` maps the `ELIZA_OPENCODE_*` knobs onto the
`OPENAI_*` variables the provider plugin reads, and pins
`ELIZA_CODE_PROVIDER=openai` when it inherits the opencode key. The orchestrator
only has to forward `ELIZA_OPENCODE_*` to the spawned sub-agent because the
`ELIZA_` prefix is on the forward allow-list. Explicit `OPENAI_*` values always
win; the mapping only fills unset vars.

| `ELIZA_OPENCODE_*` | Maps To | Meaning |
| --- | --- | --- |
| `ELIZA_OPENCODE_BASE_URL` | `OPENAI_BASE_URL` | API endpoint |
| `ELIZA_OPENCODE_API_KEY` | `OPENAI_API_KEY` | Bearer token |
| `ELIZA_OPENCODE_MODEL_POWERFUL` | `OPENAI_LARGE_MODEL` | Large model id |
| `ELIZA_OPENCODE_MODEL_FAST` | `OPENAI_SMALL_MODEL` / `OPENAI_MEDIUM_MODEL` | Fast model id |

## Examples

### Cerebras

```bash
ELIZA_OPENCODE_BASE_URL=https://api.cerebras.ai/v1
ELIZA_OPENCODE_API_KEY=${CEREBRAS_API_KEY}
ELIZA_OPENCODE_MODEL_POWERFUL=zai-glm-4.7
ELIZA_OPENCODE_MODEL_FAST=zai-glm-4.7
```

### Surplus Intelligence

[Surplus](https://surplusintelligence.ai) proxies many models behind one
OpenAI Chat Completions-compatible endpoint, billed per request through x402.
Because it speaks the OpenAI shape, eliza-code uses it without a code change:

```bash
ELIZA_OPENCODE_BASE_URL=https://api.surplusintelligence.ai/v1
ELIZA_OPENCODE_API_KEY=${SURPLUS_API_KEY}
ELIZA_OPENCODE_MODEL_POWERFUL=claude-opus-4.8
ELIZA_OPENCODE_MODEL_FAST=claude-opus-4.8
```

List available models:

```bash
curl https://api.surplusintelligence.ai/v1/models
```

Surplus billing returns `insufficient_balance` until the account is funded and
`insufficient_allowance` until spending allowance is approved. Both must be set
in the Surplus dashboard before requests succeed. Rate limits and auth are
separate from payment state.

### Direct Anthropic API

```bash
ELIZA_CODE_PROVIDER=anthropic
ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}
# Optional:
# ANTHROPIC_LARGE_MODEL=claude-sonnet-5-20260229
# ANTHROPIC_SMALL_MODEL=claude-haiku-5-20260229
```

### Direct OpenAI API

```bash
OPENAI_API_KEY=${OPENAI_API_KEY}
OPENAI_LARGE_MODEL=gpt-5.5
OPENAI_SMALL_MODEL=gpt-5.5-mini
```

## Choosing the Coding Backend

Which sub-agent the orchestrator spawns is the agent type, set by
`ELIZA_ACP_DEFAULT_AGENT` (`elizaos`, `pi-agent`, `opencode`, `codex`, or
`claude`) or per task through the resolver in
`@elizaos/plugin-agent-orchestrator`
(`src/services/task-agent-routing.ts`). The provider config above only applies
when the `elizaos` / eliza-code agent type is selected.
