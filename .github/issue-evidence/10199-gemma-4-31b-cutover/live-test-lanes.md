# gemma-4-31b cutover — live test lanes (2026-07-01)

Mission D evidence: every lane run from `/home/shaw/eliza-wt-gemma4`
(branch `feat/cerebras-gemma-4-31b-cutover`, rebased on develop).
`CEREBRAS_API_KEY` redacted throughout as `$CEREBRAS_API_KEY`.

gemma-4-31b facts under test: Cerebras-hosted, 131k context, 40k max output
(paid tier), reasoning off by default, strict `json_schema` + tool calling.

## Lane 1 — core field-registry live smoke (packages/core)

```bash
ELIZA_RUN_LIVE_TESTS=1 CEREBRAS_API_KEY=$CEREBRAS_API_KEY \
  bunx vitest run --config packages/test/vitest/real.config.ts \
  packages/core/src/runtime/__tests__/field-registry-cerebras.live.test.ts \
  --testTimeout 180000
```

Note: `--root packages/core` cannot run this lane — the package-local
`packages/core/vitest.config.ts` excludes `**/*.live.test.*`. The repo's
live/real lane config is `packages/test/vitest/real.config.ts` (same config
`test:e2e:heavy` uses), which includes `**/*.live.test.ts`.

**Result: PASS — 2/2 tests, real live calls (verbose timings prove network round-trips)**

```
✓ ResponseHandlerFieldRegistry — live Cerebras smoke > composes a stable schema and round-trips through the default Cerebras model 758ms
✓ ResponseHandlerFieldRegistry — live Cerebras smoke > extracts an abort intent when the user retracts mid-task 300ms

 Test Files  1 passed (1)
      Tests  2 passed (2)
```

`DEFAULT_CEREBRAS_TEXT_MODEL = "gemma-4-31b"`
(packages/core/src/contracts/service-routing.ts) — this lane exercises the
composed response-handler schema against the real gemma-4-31b structured-output
endpoint and round-trips into a typed `ResponseHandlerResult`.

## Lane 2 — plugin-openai cerebras-config live test

```bash
CEREBRAS_API_KEY=$CEREBRAS_API_KEY \
  bunx vitest run __tests__/cerebras-config.live.test.ts \
  --root plugins/plugin-openai --config vitest.live.config.ts \
  --testTimeout 180000
```

(`vitest.live.config.ts` is the package's live config; its include is
`__tests__/**/*.live.test.ts`.)

**Result: PASS — 1/1 tests**

```
 Test Files  1 passed (1)
      Tests  1 passed (1)
   Duration  13.39s (tests 599ms)
```

## Lane 3 — spawn-subagent refusal suppression (gemma-4-31b added to matrix)

```bash
ELIZA_RUN_LIVE_TESTS=1 CEREBRAS_API_KEY=$CEREBRAS_API_KEY CEREBRAS_REFUSAL_TRIALS=8 \
  bunx vitest run __tests__/cerebras-spawn-subagent-refusal.live.test.ts \
  --root plugins/plugin-openai --config vitest.live.config.ts \
  --testTimeout 600000
```

Gate note: this test is `describe.skip` unless **both** `CEREBRAS_API_KEY`
and `ELIZA_RUN_LIVE_TESTS=1` are set (a first run without the flag reported
`6 skipped`). Model matrix in the file:
`["gemma-4-31b", "gpt-oss-120b", "zai-glm-4.7"]` — 8 trials × 3 models.

**Result: PASS — 3/3 live tests (adversarial trio correctly skipped: gated behind `CEREBRAS_ADVERSARIAL=1`), 0 refusal leaks on all models including gemma-4-31b**

```
=== gemma-4-31b (8 trials) ===
  HTTP / parse failures:                          0 (0.0%)
  Wire replyText looked like a refusal:           0 (0.0%)
  Suppression fired (refusal -> plan.reply=""):   0 (0.0%)
  Picked spawn-related candidateAction:           8 (100.0%)
  Routed to non-simple planning context:          8 (100.0%)
  LEAKED refusal into plan.reply (bug):           0 (0.0%)
Sample wire refusal: (none observed)
Sample leaked refusal: (none — fix is holding)

✓ gemma-4-31b: planning-path replies never leak refusal text after parsing 2814ms
✓ gpt-oss-120b: planning-path replies never leak refusal text after parsing 2833ms   (same 0-leak table)
✓ zai-glm-4.7: planning-path replies never leak refusal text after parsing 10101ms   (same 0-leak table)

 Test Files  1 passed (1)
      Tests  3 passed | 3 skipped (6)
   Duration  30.84s
```

gpt-oss-120b and zai-glm-4.7 posted identical all-zero refusal/leak tables
(8/8 spawn-related candidateAction, 8/8 non-simple planning context each).
Notably gemma-4-31b is ~3.6× faster than zai-glm-4.7 on the same 8-trial loop.

## Lane 4 — plugin-elizacloud unit lane (no API)

```bash
bunx vitest run __tests__/unit/text-cerebras-response-format.test.ts \
  --root plugins/plugin-elizacloud
```

**Result: PASS — 10/10 tests**

```
 Test Files  1 passed (1)
      Tests  10 passed (10)
   Duration  7.70s
```

## Lane 5a — interrupt-bench cerebras smoke

```bash
cd packages/benchmarks/interrupt-bench && \
  CEREBRAS_API_KEY=$CEREBRAS_API_KEY bun run scripts/cerebras-smoke.ts
```

Default model confirmed in source: `DEFAULT_MODEL = "gemma-4-31b"`
(`src/llm-cerebras.ts:16`); the smoke passes no `--model` flag so it hits
gemma-4-31b.

**Result: PASS — strict-json_schema Stage-1 payload parsed cleanly**

```
Schema fields: shouldRespond, contexts, intents, threadOps, candidateActionNames, replyText, facts, relationships, addressedTo
Calling Cerebras...

Latency: 467ms
Parsed:
{
  "shouldRespond": "RESPOND",
  "intents": ["send_email"],
  "threadOps": [{ "type": "create", "workThreadId": "thread_email_bob_lunch", ... }],
  "candidateActionNames": ["send_email", "draft_email"],
  "replyText": "I can help you send that email to Bob about lunch tomorrow. ...",
  "facts": ["User wants to send an email", "Recipient is Bob", "Topic is lunch tomorrow"],
  "relationships": [{ "subject": "alice", "predicate": "wants_to_email", "object": "bob" }],
  "addressedTo": ["alice"]
}
```

## Lane 5b — interrupt-bench live bench (`--mode=cerebras`)

```bash
cd packages/benchmarks/interrupt-bench && \
  CEREBRAS_API_KEY=$CEREBRAS_API_KEY bun run bench -- --mode=cerebras \
  --out=/tmp/claude-1000/interrupt-gemma4
```

**Result: PASS — FINAL SCORE 97.07 (pass tier 95), 110 scenarios, model gemma-4-31b**

Report header (`/tmp/claude-1000/interrupt-gemma4/report.md`, copied to
`interrupt-bench-cerebras-report-2026-07-01.{md,json}` beside this file):

```
- Mode: cerebras
- Model: gemma-4-31b
- Aggregate: **97.07**
- Judge bonus: 0.00
- Final score: **97.07**
- Pass tier: **95**
```

Base-scenario score table:

| ID | Category | Weight | Score | Boundary | State | Intent | Routing | Trace |
|---|---|---|---|---|---|---|---|---|
| A1-fragmented-email-draft | A | 2 | 100.0 | ok | 100 | 100 | 100 | 100 |
| A4-stream-with-retraction | A | 3 | 85.0 | ok | 50 | 100 | 100 | 100 |
| B1-pure-cancellation | B | 3 | 95.0 | ok | 100 | 100 | 100 | 50 |
| B2-destructive-cancellation | B | 4 | 100.0 | ok | 100 | 100 | 100 | 100 |
| C1-mid-task-steering | C | 3 | 80.0 | ok | 100 | 0 | 100 | 100 |
| D1-cross-channel-leak | D | 5 | 100.0 | ok | 100 | 100 | 100 | 100 |
| F1-pivot-within-thread | F | 3 | 100.0 | ok | 100 | 100 | 100 | 100 |
| G1-cross-channel-prompt-resolution | G | 3 | 100.0 | ok | 100 | 100 | 100 | 100 |
| H1-concurrent-merge | H | 4 | 100.0 | ok | 100 | 100 | 100 | 100 |
| K1-recipe-assembly | K | 2 | 100.0 | ok | 100 | 100 | 100 | 100 |

(Latency axis is skipped by design in cerebras mode; full 110-row table in the
copied report.)

Score distribution across all 110 scenarios:

| score | scenarios |
|---|---|
| 100.0 | 86 |
| 95.0 | 9 |
| 85.0 | 3 |
| 80.0 | 11 |
| 50.0 | 1 |

Weak spots (all model-behavior scoring deltas, not harness failures):
- `C1-mid-task-steering` family (11 × 80.0) — intent axis 0: steering intent
  not emitted the way the scorer expects.
- `K1-recipe-assembly--edge-ack` (1 × 50.0) — no reply produced in `dm-alice`
  (`reply count: got 0, expected 1-1`).
- `A4-stream-with-retraction` (+2 edges, 85.0) — scheduledTask state kept a
  retracted "tomorrow/3pm" detail.
- `B1-pure-cancellation` family (95.0) — trace axis 50: `abortFired=false`,
  `preemptMode=(none)` where `ack-and-stop` expected.

Per-scenario Cerebras call latencies during the run were ~255–500ms.
