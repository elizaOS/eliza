# The Anthropic accuracy gap is a context-routing bug, not a prompt bug

## What we measured

| Run | Provider | Planner system prompt | Passed | Accuracy |
| --- | --- | --- | ---: | ---: |
| baseline (the original `plannerTemplate`) | Anthropic Haiku 4.5 | `task: Plan next native tool calls.` | 2/19 | 10.5% |
| v4 | Anthropic Haiku 4.5 | bullshit role-play (`You are the LifeOps action planner...`) | 1/19 | 5.3% |
| v5 | Anthropic Haiku 4.5 | clean optimized (`Use only the tools listed...`) — no role-play, no hardcoded action list, length cap enforced | 1/19 | 5.3% |
| v6 | Anthropic Haiku 4.5 | clean optimized + widened LIFE.contexts | — | (Anthropic credits exhausted; could not measure) |

So the prompt "improvement" (removing role-play, no hardcoded actions, anti-meme rejection in the optimizer's variant generator) **moved the needle by 0pp on Anthropic accuracy**. v5 = v4. Both around the baseline floor.

## Reading the trajectories

For each of the 19 self-care `direct` benchmark cases, the recorded trajectory shows:

```
scenario                                       tier_A_actions
workout-blocker-basic__direct                  (empty)
brush-teeth-spanish__direct                    RESOLVE_REQUEST
brush-teeth-night-owl__direct                  NONE,REPLY
shower-weekly-basic__direct                    REPLY,RESOLVE_REQUEST
goal-sleep-basic__direct                       RESOLVE_REQUEST
... 14 more, all the same shape ...
```

`LIFE` — the action the benchmark expects — **is never in tier-A** for any of the 19 cases. The action retrieval step has filtered it out before the planner ever sees a tool list. So the planner is choosing the best from `{REPLY, RESOLVE_REQUEST, NONE}` — none of which create a habit. Anthropic correctly chooses `REPLY` and politely asks the user for clarification.

The agent isn't failing the benchmark. The benchmark is being failed by retrieval upstream of the planner.

## Why retrieval excludes LIFE

Every recorded trajectory's planner system prompt header reads:

```
selected_contexts: general

contexts:
- general: Normal conversation and public agent behavior. Use when the reply needs general agent state but no tool work.
```

`general` is a chat-style context. The action retrieval filter respects each action's `contexts: [...]` allowlist. `LIFE`'s allowlist is `["tasks", "todos", "calendar", "health"]` — `"general"` is **not** in it. So when the messageHandler picks `general` for the user message, retrieval drops `LIFE` from the candidate pool and the planner can't choose it.

The same context-narrowing pattern affects most lifeops actions:

| Action | contexts |
| --- | --- |
| LIFE | `tasks, todos, calendar, health` |
| CALENDAR | `calendar, contacts, tasks, connectors, web` |
| BOOK_TRAVEL | `calendar, contacts, tasks, payments, finance, browser` |
| APP_BLOCK | `screen_time, automation, settings, tasks` |
| SCHEDULE | `calendar, tasks, health, screen_time` |
| HEALTH | `health, tasks, calendar` |
| FIRST_RUN | `tasks, automation` |
| PROFILE | `memory, contacts, tasks, settings, calendar` |

None include `general`. So when the messageHandler picks `general` (which it does for every habit-creation prompt in the benchmark), every primary action is filtered out, and the planner is stuck with terminal/passive actions.

## Why the messageHandler picks `general`

The messageHandler stage runs first on every turn and decides which contexts apply. For a prompt like *"Brush teeth from Spanish phrasing — Recordame que me cepille los dientes por la mañana y por la noche"*, the model evaluates against the available context labels:

- `general: Normal conversation and public agent behavior. Use when the reply needs general agent state but no tool work.`
- `tasks: Todos, reminders, goals, habits, routines, follow-ups, ...`
- `calendar: ...`
- `health: ...`

The model picks `general` because the request reads like conversation more than a tool-driven task to it. The `tasks` description is correct in principle — but the messageHandler isn't trained on the runtime's specific context taxonomy, so it defaults to `general`.

## Why this didn't show up on Cerebras

Cerebras gpt-oss-120b's messageHandler picks different contexts than Anthropic Haiku does for the same prompt. The Cerebras run had 89.5% accuracy on `direct` because its messageHandler picked `tasks` for these prompts (which exposes LIFE) more often than Anthropic's did. So the benchmark's accuracy gap between providers (89.5% vs 10.5%) is mostly a context-routing gap, not a planner-prompt gap.

## The fix that actually moves the metric

Two paths:

### Path A — widen the context allowlists (least invasive)

Add `"general"` to the `contexts` list for the high-frequency action surfaces: LIFE, CALENDAR, SCHEDULE, HEALTH. Already shipped for LIFE in this commit. Cost: those actions will appear in tool-search candidate pools for chat-shaped prompts, slightly more BM25 / RRF noise per turn — but they'll be available for the planner to pick.

### Path B — fix the messageHandler's context selection

Tighten the messageHandler's prompt so it routes any imperative-with-action-verb ("remind me to…", "create a habit…", "set up a routine…") to `tasks` rather than `general`. This is the cleaner architectural fix; it's a targeted prompt change in `core/src/services/message.ts:buildMessageHandlerSystemPrompt`. Higher-leverage, lower-risk; recommended.

### Path C — drop the context filter on tool retrieval

The current filter (action's `contexts` ∩ messageHandler's `selectedContexts`) is double-bookkeeping: the planner already sees the full action catalog and decides which to use. The context filter is meant to keep the catalog smaller for cost, but it's losing real candidates. Loosen the filter so any action whose simile/description matches the query keywords above a threshold is included regardless of context. Highest impact, requires a thoughtful retrieval-stage change.

## Recommendation

1. **Ship the LIFE context widening** (already done in this commit). Re-run the bench on Cerebras to confirm no regression there. Re-run on Anthropic when credits return.
2. **Fix the messageHandler** to route habit-creation prompts to `tasks` (path B). This is the high-leverage architectural fix; it benefits every action surface, not just LIFE.
3. **Optionally pursue path C** as a longer-term cleanup — the current `contexts` field on actions is an information-poor proxy for "which mental model should be active when the user asks this".

## What this means for the optimizer

The optimizer was given the wrong job. We were trying to tune the planner's prompt to recover accuracy that was lost upstream — at retrieval. No prompt change at the planner stage can fix a missing tool. That's why the accuracy was flat across baseline, role-play, and clean variants: Anthropic was always picking the best from the same wrong toolset.

This is the DSPy/ax lesson: optimization at the wrong stage of a multi-stage program produces noise. DSPy MIPRO v2 traces failure to the specific decision point — if it had been wired to score *which stage* failed, it would have flagged retrieval as the culprit instead of grinding away at the planner's wording.
