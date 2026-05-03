# Anthropic extended thinking (per cloud agent + env defaults)

**Extended thinking** (Anthropic “chain-of-thought” style reasoning) is configured per **cloud agent** (a row in `user_characters`) with optional **deploy** defaults and caps. It is **not** controlled from raw API request bodies.

## Per-agent setting (`user_characters.settings`)

| Key | Type | Meaning |
|-----|------|---------|
| `anthropicThinkingBudgetTokens` | Integer ≥ 0 | Token budget for thinking when the model is Anthropic. **`0`** turns thinking **off** for that agent even if env default is set. **Omitted** or invalid → fall back to env (see below). |

**Why JSON on the character:** The agent’s owner configures inference policy in one place (dashboard / API that updates the character). No redeploy is required to change thinking for a specific public agent.

**Why not a request parameter:** Callers of MCP/A2A/chat could not be trusted to raise thinking budgets and spend more tokens; the stored character record is the source of truth.

Exported constant: `ANTHROPIC_THINKING_BUDGET_CHARACTER_SETTINGS_KEY` in `packages/lib/providers/anthropic-thinking.ts` (value: `anthropicThinkingBudgetTokens`).

## Environment variables

| Variable | Role |
|----------|------|
| `ANTHROPIC_COT_BUDGET` | **Default** budget when the character **does not** set `anthropicThinkingBudgetTokens` (or it is invalid). Unset / empty / `0` → no budget from env (thinking stays off unless the character sets a positive integer). |
| `ANTHROPIC_COT_BUDGET_MAX` | Optional **ceiling** for any effective budget (character value **or** env default): `effective = min(requested, max)`. Unset / empty / `0` → no cap. |

**Why a default env:** Operators can turn on a baseline for routes that have **no** character context (e.g. generic `/api/v1/chat`) while agents with explicit settings override or disable locally.

**Why a max env:** Caps worst-case token use if a character sets a very large `anthropicThinkingBudgetTokens`.

## Where per-agent budget is applied

Today, **`parseThinkingBudgetFromCharacterSettings`** is wired into:

- `POST /api/agents/{id}/mcp` (tool `chat`)
- `POST /api/agents/{id}/a2a` (method `chat`)

Other routes keep **env-only** behavior (no `character.settings` on the request path):

- `POST /api/v1/chat` — uses `mergeAnthropicCotProviderOptions` with env defaults only (`ANTHROPIC_COT_BUDGET` / `ANTHROPIC_COT_BUDGET_MAX`). No character context is available on this route.
- `POST /api/v1/chat/completions` — uses `mergeAnthropicCotProviderOptions` with env defaults only (implementation: `app/api/v1/chat/completions/route.ts`). No character context is available on this route.

## Merge helpers (`mergeProviderOptions`, …)

Routes may already set `gateway` or `google` under `providerOptions`. Helpers **deep-merge** known top-level keys so adding `anthropic.thinking` does not drop sibling options.

## `cloud-provider-options.ts`

`CloudMergedProviderOptions` matches AI SDK `Record<string, JSONObject>` so merged objects stay type-safe without `any`.

## How to set `anthropicThinkingBudgetTokens`

Update the character’s `settings` JSON (`user_characters.settings` in PostgreSQL)—via your **character edit API**, **dashboard** (when exposed), or a one-off SQL/admin tool. The value must be a **finite number**; non-numbers are ignored and env default applies.

**Why there is no query/body parameter on MCP/A2A:** Consumers are often third-party tools; letting them pass a thinking budget would let anyone raise token spend against the billed org. The **character record** is authenticated-owner data.

## Operator checklist

1. Set **`ANTHROPIC_COT_BUDGET_MAX`** in production if you want a hard ceiling on thinking tokens.
2. Optionally set **`ANTHROPIC_COT_BUDGET`** as a default for routes **without** a resolved character (e.g. `/api/v1/chat`).
3. Document for creators: add `anthropicThinkingBudgetTokens` under **Settings** when you ship UI, or point them at this doc for API-managed characters.

## Related code

- `packages/lib/providers/anthropic-thinking.ts` — resolution, merges, character parser
- `packages/lib/config/env-validator.ts` — validates env keys when set
- `packages/tests/unit/anthropic-thinking.test.ts` — unit tests
