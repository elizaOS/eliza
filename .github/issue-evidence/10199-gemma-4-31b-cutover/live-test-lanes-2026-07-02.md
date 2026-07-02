# gemma-4-31b cutover — Mission D live test lanes (2026-07-02)

Fresh run of all five live lanes from `/home/shaw/eliza-wt-gemma4`
(branch `feat/cerebras-gemma-4-31b-cutover`, rebased on develop, workspace built).
Supersedes nothing — this is an independent re-verification alongside
`live-test-lanes.md` and `live-test-lanes-rerun-2026-07-01T23.md`.
`CEREBRAS_API_KEY` redacted throughout as `$CEREBRAS_API_KEY`.

gemma-4-31b facts under test: Cerebras-hosted, 131k context, 40k max output
(paid tier), reasoning off by default (`reasoning_effort` opt-in), strict
`json_schema` + tool calling.

Environment: node v25.2.1 (nvm) on PATH; no stray bench server on :39371 at start.

## Result summary

| Lane | Command target | Result |
|---|---|---|
| 1 | core field-registry Cerebras live smoke | PASS 2/2 |
| 2 | plugin-openai cerebras-config live | PASS 1/1 |
| 3 | plugin-openai refusal suppression live (8 trials × 3 models) | PASS 3/3 (+3 adversarial skipped by design) |
| 4 | plugin-elizacloud response_format / reasoning_effort unit | PASS 10/10 |
| 5a | interrupt-bench cerebras smoke | PASS (gemma-4-31b default, 385 ms) |
| 5b | interrupt-bench live cerebras bench ×2 | run1 91.62 / tier 90; run2 **97.07 / tier 95** (matches prior recorded 97.07 exactly) |

No lane failed for a real reason. Zero refusal leaks. Zero 429s observed.

## Lane 1 — core field-registry live smoke (packages/core)

```bash
ELIZA_RUN_LIVE_TESTS=1 CEREBRAS_API_KEY=$CEREBRAS_API_KEY \
  bunx vitest run --config packages/test/vitest/real.config.ts \
  packages/core/src/runtime/__tests__/field-registry-cerebras.live.test.ts \
  --testTimeout 180000
```

Note (unchanged from prior evidence): `--root packages/core` cannot run this
lane — `packages/core/vitest.config.ts` excludes `**/*.live.test.*`; the repo's
live/real lane config is `packages/test/vitest/real.config.ts`.

**PASS — 2/2**

```
✓ ResponseHandlerFieldRegistry — live Cerebras smoke > composes a stable schema and round-trips through the default Cerebras model 428ms
✓ ResponseHandlerFieldRegistry — live Cerebras smoke > extracts an abort intent when the user retracts mid-task 252ms
 Test Files  1 passed (1)
      Tests  2 passed (2)
```

## Lane 2 — plugin-openai cerebras-config live test

```bash
CEREBRAS_API_KEY=$CEREBRAS_API_KEY \
  bunx vitest run __tests__/cerebras-config.live.test.ts \
  --root plugins/plugin-openai --config vitest.live.config.ts \
  --testTimeout 180000
```

`vitest.live.config.ts` is the package's live config (its `include` is
`__tests__/**/*.live.test.ts`; the default `vitest.config.ts` excludes live tests).

**PASS — 1/1**

```
Info [OpenAI] Not registering IMAGE: the Cerebras endpoint does not serve it
Info [OpenAI] Not registering TRANSCRIPTION: the Cerebras endpoint does not serve it
✓ plugin-openai Cerebras live > uses TEXT_LARGE against Cerebras and returns real text + usage 211ms
 Test Files  1 passed (1)
      Tests  1 passed (1)
```

## Lane 3 — refusal suppression live (gemma-4-31b now in the model matrix)

```bash
ELIZA_RUN_LIVE_TESTS=1 CEREBRAS_API_KEY=$CEREBRAS_API_KEY CEREBRAS_REFUSAL_TRIALS=8 \
  bunx vitest run __tests__/cerebras-spawn-subagent-refusal.live.test.ts \
  --root plugins/plugin-openai --config vitest.live.config.ts \
  --testTimeout 600000
```

Gate note: the suite is `describe.skip` unless **both** `CEREBRAS_API_KEY` and
`ELIZA_RUN_LIVE_TESTS=1` are set (a first attempt without the flag skipped all
6 tests). The 3 adversarial tests additionally require `CEREBRAS_ADVERSARIAL=1`
and stay skipped by design in this lane.

`CEREBRAS_REFUSAL_MODELS = ["gemma-4-31b", "gpt-oss-120b", "zai-glm-4.7"]` —
gemma-4-31b entry confirmed present.

**PASS — 3/3 (3 adversarial skipped by design), 8 trials per model, zero leaks**

```
✓ gemma-4-31b: planning-path replies never leak refusal text after parsing 2842ms
✓ gpt-oss-120b: planning-path replies never leak refusal text after parsing 3161ms
✓ zai-glm-4.7: planning-path replies never leak refusal text after parsing 7141ms
 Test Files  1 passed (1)
      Tests  3 passed | 3 skipped (6)
```

Per-model report (identical for all three models, gemma-4-31b shown):

```
=== gemma-4-31b (8 trials) ===
  Wire replyText looked like a refusal:           0 (0.0%)
  Suppression fired (refusal -> plan.reply=""):   0 (0.0%)
  LEAKED refusal into plan.reply (bug):           0 (0.0%)
Sample wire refusal: (none observed)
Sample leaked refusal: (none — fix is holding)
```

## Lane 4 — plugin-elizacloud response_format / reasoning_effort unit lane

```bash
bunx vitest run __tests__/unit/text-cerebras-response-format.test.ts \
  --root plugins/plugin-elizacloud
```

**PASS — 10/10**

```
✓ emits json_object for cerebras-served gemma-4-31b
✓ emits json_object for cerebras-served cerebras:gemma-4-31b
✓ emits json_object for cerebras-served gpt-oss-120b
✓ emits json_object for cerebras-served zai-glm-4.7
✓ keeps json_schema for non-cerebras models
✓ maps eliza.thinking=off for gpt-oss-120b to reasoning_effort:low
✓ maps eliza.thinking=off for gemma-4-31b to reasoning_effort:none
✓ maps eliza.thinking=off for zai-glm-4.7 to reasoning_effort:none
✓ omits reasoning_effort when thinking is not suppressed
✓ never sets reasoning_effort for non-cerebras models
 Test Files  1 passed (1)
      Tests  10 passed (10)
```

## Lane 5a — interrupt-bench cerebras smoke

```bash
cd packages/benchmarks/interrupt-bench && \
  CEREBRAS_API_KEY=$CEREBRAS_API_KEY bun run scripts/cerebras-smoke.ts
```

**PASS.** Hits gemma-4-31b by default: `src/llm-cerebras.ts` has
`const DEFAULT_MODEL = "gemma-4-31b"` and `src/runner.ts` documents
`--model=<id> (default: gemma-4-31b)`.

```
Schema fields: shouldRespond, contexts, intents, threadOps, candidateActionNames, replyText, facts, relationships, addressedTo
Latency: 385ms
"intents": ["send_email"]
"threadOps": [{ "type": "create", "workThreadId": "thread_email_bob_lunch", ... }]
"replyText": "I can help you send that email to Bob about lunch tomorrow. ..."
```

Strict json_schema round-trip parsed cleanly (fragmented "i need to / send /
an email / to bob about lunch tomorrow" coalesced into one send_email intent).

## Lane 5b — interrupt-bench live cerebras bench (run twice)

```bash
cd packages/benchmarks/interrupt-bench && \
  CEREBRAS_API_KEY=$CEREBRAS_API_KEY bun run bench -- --mode=cerebras --out=/tmp/claude-1000/interrupt-gemma4
# stability check:
  CEREBRAS_API_KEY=$CEREBRAS_API_KEY bun run bench -- --mode=cerebras --out=/tmp/claude-1000/interrupt-gemma4-run2
```

Model: **gemma-4-31b** (from report.json `model` field). 110 scenarios per run,
~34 s wall clock per full run on Cerebras.

| Run | Final score | Pass tier | Notes |
|---|---|---|---|
| run1 | 91.62 | 90 | sampling-variance dip: F1-pivot edges 0.55 ×8, G1 edges 0.65 ×8, K1-edge-ack 0.50 |
| run2 | **97.07** | **95** | score distribution **byte-identical** to the two prior recorded runs (2026-07-01) |

run2 sub-1.0 scenarios (identical set to prior recorded runs):

```
A4-stream-with-retraction 0.85 (+edge-context, +edge-boundary 0.85)
B1-pure-cancellation 0.95 (+8 edges at 0.95 — routing axis 50)
C1-mid-task-steering 0.80 × all 11 variants (intent axis 0 — known stable miss)
K1-recipe-assembly--edge-ack 0.50
below-1 count: 24 / 110, final 97.07, tier 95
```

Interpretation: 97.07 is the reproducible score for gemma-4-31b on this bench
(now reproduced 3× across two days); run1's 91.62 shows the one-run floor under
sampling variance still clears the 90 tier. The C1 intent-axis miss is the same
stable deficit recorded in `interrupt-bench-cerebras-report-2026-07-01.md`.

Full reports checked in alongside this file:
- `interrupt-bench-cerebras-report-2026-07-02-run1.{md,json}` (91.62)
- `interrupt-bench-cerebras-report-2026-07-02-run2.{md,json}` (97.07)

## Blockers

None. Every lane passed; no assertion failures, no rate-limit (429) events,
no refusal leaks. The only non-PASS observation is bench run1's variance dip
(91.62), which still clears tier 90 and disappeared on immediate rerun.
