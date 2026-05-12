# Why the optimized prompt made Anthropic worse

## Setup

- **Baseline** (`packages/core/src/prompts/planner.ts`): 1,520 chars, imperative voice ("task: Plan next native tool calls"), no role-play, no hardcoded action list, encourages a "smallest grounded queue" of tool calls.
- **First optimized artifact** (instruction-search via Cerebras gpt-oss-120b on a 16-row dataset): 1,517 chars, opens with "You are the LifeOps action planner. Your job is to read the user's message, determine the single most appropriate action…", hardcoded 20-action allowlist, "single best fit" rule, "still output the action with an empty `args` object".
- **Measured delta** with that optimized prompt confirmed-loaded at runtime: Anthropic Haiku 4.5 dropped from 10.5% → 5.3% on the `direct` self-care variant.

## Side-by-side diff

| Aspect | Baseline | Bad optimized |
| --- | --- | --- |
| Opening | `task: Plan next native tool calls.` | `You are the LifeOps action planner. Your job is to…` |
| Action surface | uses runtime-injected `tools` list, never enumerates names | hardcoded 20-action literal allowlist |
| Plurality | "smallest grounded queue" — multi-tool allowed | "Never output multiple actions; select the single best fit" |
| Missing args | "never use empty strings, placeholders, or invented values for required tool arguments; gather missing content with another grounded tool or choose no tool" | "If required arguments for the chosen action are missing, still output the action with an empty `args` object; the downstream system will handle prompting for missing data" |
| Visual style | flat dash list | markdown headers + fenced code blocks + numbered rules |

The bad version is **anti-correct on three of those rows**.

## Five concrete failure modes

### 1. Role-play priming flips Anthropic into chat mode

`"You are the LifeOps action planner. Your job is to…"` is a textbook role-play opener. Anthropic Haiku/Opus is RLHF-trained heavily for assistant-chat behaviour: that opener primes the model toward conversational, cautious, clarification-seeking output — exactly the `REPLY-with-questions` pattern we observed. The baseline uses `task:` which directly invokes task-completion mode. Cerebras gpt-oss-120b is less reactive to this framing because reasoning models trained on instruction-tuned corpora weigh imperative phrasing differently — so the optimizer's variant looked equivalent on Cerebras and bombed on Anthropic.

### 2. Hardcoded action list teaches the model to pick from a stale set

The runtime exposes a **tiered, per-turn subset** of actions (tier-A ≈ 3, tier-B ≈ 16, omitted ≈ N). The optimizer enumerated all 20 names in the prompt body. When Anthropic sees `LIFE, CALENDAR, REPLY, MESSAGE, BOOK_TRAVEL, …, FIRST_RUN, …` in the system prompt and ALSO sees a smaller list in the runtime-injected tool catalog, it gets two contradictory signals:

- "you may use any of these 20"
- "the runtime exposed only these 3"

Anthropic resolves this by either (a) picking a name from the prompt allowlist that isn't actually exposed (which the runtime rejects, recorder marks `actual=null`), or (b) defaulting to `FIRST_RUN.path=customize` — the most innocuous prompt-listed action. Both are wrong vs `expected=LIFE`.

### 3. "Empty args is fine" sabotages action handlers

Lifeops action handlers (e.g. `LIFE.create`) validate `args.title`, `args.kind`, `args.subaction` etc. and reject calls when required fields are missing. The optimized prompt told the planner to output `{"name":"LIFE","args":{}}` and let the downstream "handle prompting" — but the runtime treats missing args as a planner failure, marking `tool.success=false`, which the recorder logs as `actual=null`. The baseline correctly says "gather missing content with another grounded tool".

### 4. Single-action restriction kills chained planning

A real habit-creation often needs `LIFE.create` (define the habit) plus a follow-up `SCHEDULE.cron` or `CALENDAR.block`. The baseline's "smallest grounded queue" allows the planner to emit both. The optimized prompt's "Never output multiple actions; select the single best fit" caps it at one. For prompts that need two-step planning, the agent now picks one and returns control prematurely.

### 5. Verbose layout dilutes attention

| | chars | tokens (approx) |
| --- | ---: | ---: |
| baseline | 1,520 | 350 |
| bad optimized | 1,517 | 340 |
| but the bad optimized "instructions" portion (after split on `context_object:`) | 1,517 | 340 |
| baseline "instructions" portion | ~570 | 130 |

So the **instruction portion** is ~3× longer in the bad optimized than in the baseline (570 → 1,517). More tokens of instruction = less attention budget for the runtime-injected context, action catalog, and conversation. With Anthropic Haiku at the smaller model size, this matters.

## Why the optimizer's *score* was good but the *behaviour* was bad

The score was `scorePlannerAction(actual, expected)` on Cerebras-generated outputs against the recorded toolCalls. That metric:

- Extracted the first uppercase token (regex fallback) when JSON parsing didn't find a top-level `action` field — meaning `{toolCalls:[{name:LIFE}]}` was matching via the regex that hits `LIFE` anywhere in the string.
- Measured one model's match against another's recorded output, not the agent under test's match against expectations.

Both effects rewarded the "wrong" winning prompt. **Fix landed:** `extractPlannerAction` now parses `toolCalls[0].name` directly, so the regex fallback is genuinely a fallback. Run the optimizer with this fix and the prompt that wins should be one that maximises *exact tool-name match*, not text-similarity.

## What would actually move Anthropic accuracy

1. **Evaluate the optimizer with Anthropic.** The optimizer chose a prompt that makes Cerebras output the recorded outputs; that prompt's performance on Anthropic is uncorrelated. Setting `TRAIN_MODEL_PROVIDER=anthropic` for the optimizer's evaluator changes which prompt wins.

2. **Curate a dataset where every row's `response.text` is the *correct* expected output**, not the agent's recorded wrong output. Already shipped via `scripts/lifeops-build-corrected-training-set.mjs`.

3. **Use few-shot demonstrations**, not natural-language rules. DSPy/ax pattern: pick top-K examples by similarity to current input, inline them under a `Demonstrations:` block, let the model imitate. Already shipped in `optimizers/bootstrap-fewshot.ts` — but not yet wired into the production prompt assembly.

4. **Add anti-meme rejection in the variant generator.** Rejected variants are skipped before scoring. Already shipped in `optimizers/instruction-search.ts` after this analysis.

5. **Length cap on variants.** Optimizer can no longer expand the prompt unboundedly. Already shipped (1.3× baseline cap).

6. **Don't enumerate action names in the prompt body.** Already enforced via the rewriter constraint and the rejection regex.

## What ax/DSPy do that we should adopt next

- **Per-example failure tracking.** DSPy's MIPRO v2 records WHICH cases each variant fails on, then prefers variants that fix specific failure clusters. Our optimizer only sees aggregate score.
- **Bootstrap-via-trace.** DSPy runs the agent on training data and pulls the *successful* trajectories as demonstration candidates. We have the corrected dataset — wire it into bootstrap-fewshot as the seed pool.
- **Validation loops.** When the planner output doesn't parse as a valid JSON tool call, DSPy retries with a "your previous output was malformed; here is the parser error: …" prompt. We have retries (planner-loop's `MAX_RETRIES`) but no error-context feedback.
- **Signature-typed I/O.** DSPy declares `system: ContextObject -> ToolCallList`. The framework auto-derives the prompt from the signature. We have the JSON schema in `plannerSchema` but don't render it into the prompt at variant-time.

## Next-step recommendation

The runtime is currently using the baseline `plannerTemplate` (the bad artifact was deleted). That gives the agent the best floor we have. The path forward to actually move Anthropic accuracy:

1. Run the **fixed** optimizer (anti-meme + length cap + corrected scorer) with `TRAIN_MODEL_PROVIDER=anthropic` over the corrected dataset.
2. Wire the resulting artifact through the runtime via `OptimizedPromptService` (already done).
3. Re-bench Anthropic on `direct` and confirm a measurable lift over 10.5%.

The cost gap: scoring with Anthropic instead of Cerebras is ~5× per round but the artefact actually transfers.
