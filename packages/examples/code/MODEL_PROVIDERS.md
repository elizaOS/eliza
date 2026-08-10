# eliza-code model providers

`eliza-code` (the `elizaos` coding sub-agent the orchestrator spawns over ACP)
runs the eliza runtime, so its coding model is whatever model **provider** the
runtime resolves at boot (`src/lib/model-provider.ts` → `resolveModelProvider`).
You select the provider with env vars — no code change. Any
**OpenAI-Chat-Completions-compatible** endpoint works out of the box.

## How provider resolution works

`resolveModelProvider(env)`:

1. Explicit override: `ELIZA_CODE_PROVIDER` (or its alias
   `ELIZA_CODE_MODEL_PROVIDER`) — `anthropic`/`claude` or `openai`/`codex`.
2. Else auto-detect: `OPENAI_API_KEY` → `openai`; `ELIZA_OPENCODE_API_KEY` →
   `openai`; `ANTHROPIC_API_KEY` → `anthropic`.

`applyOpencodeProviderEnv(env)` maps the `ELIZA_OPENCODE_*` knobs onto the
`OPENAI_*` ones the provider plugin reads (and pins
`ELIZA_CODE_PROVIDER=openai` when it inherits the opencode key), so the
orchestrator only has to forward `ELIZA_OPENCODE_*` to the spawned sub-agent
(the `ELIZA_` prefix is on the forward allow-list). Explicit `OPENAI_*` values
always win — the mapping only fills unset vars.

| `ELIZA_OPENCODE_*` | maps to | meaning |
|---|---|---|
| `ELIZA_OPENCODE_BASE_URL` | `OPENAI_BASE_URL` | the API endpoint |
| `ELIZA_OPENCODE_API_KEY` | `OPENAI_API_KEY` | bearer token |
| `ELIZA_OPENCODE_MODEL_POWERFUL` | `OPENAI_LARGE_MODEL` | the "large" model id |
| `ELIZA_OPENCODE_MODEL_FAST` | `OPENAI_SMALL_MODEL` / `OPENAI_MEDIUM_MODEL` | the "fast" model id |

## Examples

### Cerebras (fast, OpenAI-compatible)

```bash
ELIZA_OPENCODE_BASE_URL=https://api.cerebras.ai/v1
ELIZA_OPENCODE_API_KEY=${CEREBRAS_API_KEY}
ELIZA_OPENCODE_MODEL_POWERFUL=zai-glm-4.7
ELIZA_OPENCODE_MODEL_FAST=zai-glm-4.7
```

### Surplus Intelligence (Claude / GPT / others via one OpenAI-compatible endpoint)

[Surplus](https://surplusintelligence.ai) proxies many models (Claude Opus,
GPT-5.x, Gemini, GLM, DeepSeek, …) behind one OpenAI-Chat-Completions endpoint,
billed per-request via x402 micropayments. Because it speaks the OpenAI shape,
eliza-code uses it with zero code change — just point the `ELIZA_OPENCODE_*`
knobs at it:

```bash
ELIZA_OPENCODE_BASE_URL=https://api.surplusintelligence.ai/v1
ELIZA_OPENCODE_API_KEY=${SURPLUS_API_KEY}        # an inf_... key
ELIZA_OPENCODE_MODEL_POWERFUL=claude-opus-4.8     # e.g. claude-opus-4.8, gpt-5.5, …
ELIZA_OPENCODE_MODEL_FAST=claude-opus-4.8
```

List available models: `GET https://api.surplusintelligence.ai/v1/models`.

> Billing note: Surplus uses the **x402** payment protocol. A model call returns
> `insufficient_balance` until the account is funded **and** `insufficient_allowance`
> until the spending allowance is approved — both must be set in the Surplus
> dashboard before requests succeed. Rate limit and auth are separate (a valid
> `inf_` key still rate-limits independently of payment).

### Direct Anthropic API

```bash
ELIZA_CODE_PROVIDER=anthropic
ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}            # a real sk-ant-api... key
# (optional) ANTHROPIC_LARGE_MODEL / ANTHROPIC_SMALL_MODEL
```

### Direct OpenAI API

```bash
OPENAI_API_KEY=${OPENAI_API_KEY}
OPENAI_LARGE_MODEL=gpt-5.5
OPENAI_SMALL_MODEL=gpt-5.5-mini
```

## Choosing the coding backend at the orchestrator level

Which sub-agent the orchestrator spawns (and therefore whether eliza-code is
used at all) is the **agent type**, set by `ELIZA_ACP_DEFAULT_AGENT`
(`elizaos` = eliza-code, or `pi-agent` / `opencode` / `codex` / `claude`), or
per-task via the resolver in `@elizaos/plugin-agent-orchestrator`
(`src/services/task-agent-routing.ts`). The provider config above only applies
when the `elizaos` (eliza-code) agent type is selected.
