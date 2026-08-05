# Matching elizaOS runtime conventions

This package’s agents and sibling plugins follow the elizaOS patterns from:

- [Multi-Step Action Planning](https://docs.elizaos.ai/guides/multi-step-action-planning)
- [Bootstrap plugin](https://docs.elizaos.ai/plugins/bootstrap) (message pipeline)
- Core types: `ActionResult`, `ActionPlan`, `ActionContext` in `@elizaos/core`

## Plugin order

```text
@elizaos/plugin-sql
@elizaos/plugin-bootstrap      ← MESSAGE_RECEIVED, REPLY, providers
@elizaos/plugin-openai        ← or OpenRouter / DeepSeek via env
@elizaos/plugin-* domain      ← dflow, clawdbrowser, forge, …
```

Bootstrap is required so messages compose state, run actions, and evaluate.

## ActionResult contract (chaining)

Every domain action returns:

```ts
{
  success: boolean;
  text: string;
  userFacingText?: string;
  data: {
    actionName: "DFLOW_QUOTE", // REQUIRED for getPreviousResult
    ...payload
  };
  values?: Record<string, unknown>;
  turnComplete?: boolean;
  verifiedUserFacing?: boolean;
  error?: string | Error;
}
```

Runtime resolves prior steps via:

```ts
options.actionContext.getPreviousResult("DFLOW_QUOTE")
// matches result.data.actionName === "DFLOW_QUOTE"
```

Helpers live in:

- `plugins/plugin-dflow-trade/src/action-result.ts`
- `plugins/plugin-clawdbrowser/src/action-result.ts`

## Example plans

| User goal | ActionPlan |
| --- | --- |
| Trade readiness + quote + preview | `DFLOW_TRADE_STATUS` → `DFLOW_QUOTE` → `DFLOW_SWAP` |
| Tool discovery | `SEARCH_CLAWD_TOOLS` → `DESCRIBE_CLAWD_TOOL` |
| Dual-rail forge | `MINT_SOLANA_AGENT` → `REGISTER_ROBINHOOD_AGENT` |

## LLM keys

| Env | Role |
| --- | --- |
| `DEEPSEEK_API_KEY` | DeepSeek models (OpenAI-compatible / local-inference) |
| `OPENAI_API_KEY` | OpenAI via `@elizaos/plugin-openai` |
| `OPENROUTER_API_KEY` | Multi-provider via `@elizaos/plugin-openrouter` |

Trading tools are provider-agnostic; only the model plugin changes.

## Character examples

`solizardCheshireCharacter.messageExamples` include multi-action turns so the planner learns to emit ordered `actions: ["A", "B"]` arrays.
