# gemma-4-31b cutover — live test lanes, verification re-run (2026-07-01 ~23:00 local)

Independent re-run of every Mission-D lane from `/home/shaw/eliza-wt-gemma4`
(branch `feat/cerebras-gemma-4-31b-cutover`). The first-run evidence in
`live-test-lanes.md` (commit `f4d0d72281`) is left untouched; this file proves
the lanes are **reproducibly green**, not a one-off. `CEREBRAS_API_KEY`
redacted throughout as `$CEREBRAS_API_KEY`.

Result summary: **5/5 lanes PASS again, results byte-for-byte consistent with
the first run** (same pass counts, same 0-leak refusal tables, same
interrupt-bench final score 97.07 and identical score distribution).

## Lane 1 — core field-registry live smoke

```bash
ELIZA_RUN_LIVE_TESTS=1 CEREBRAS_API_KEY=$CEREBRAS_API_KEY \
  bunx vitest run --config packages/test/vitest/real.config.ts \
  packages/core/src/runtime/__tests__/field-registry-cerebras.live.test.ts \
  --testTimeout 180000
```

Config note (re-verified this run): `--root packages/core` cannot run this
lane — `packages/core/vitest.config.ts:44` excludes `**/*.live.test.*`; the
repo live lane config is `packages/test/vitest/real.config.ts`, which includes
`*.live.test.ts` files.

**PASS — 2/2**

```
 Test Files  1 passed (1)
      Tests  2 passed (2)
   Duration  1.32s (tests 799ms)
```

## Lane 2 — plugin-openai cerebras-config live test

```bash
CEREBRAS_API_KEY=$CEREBRAS_API_KEY bunx vitest run \
  __tests__/cerebras-config.live.test.ts --root plugins/plugin-openai \
  --config vitest.live.config.ts --testTimeout 180000
```

**PASS — 1/1**

```
 Test Files  1 passed (1)
      Tests  1 passed (1)
   Duration  8.11s (tests 618ms)
```

## Lane 3 — spawn-subagent refusal suppression (8 trials × 3 models)

```bash
ELIZA_RUN_LIVE_TESTS=1 CEREBRAS_API_KEY=$CEREBRAS_API_KEY \
  CEREBRAS_REFUSAL_TRIALS=8 bunx vitest run \
  __tests__/cerebras-spawn-subagent-refusal.live.test.ts \
  --root plugins/plugin-openai --config vitest.live.config.ts \
  --testTimeout 600000
```

Run twice this session (both green): 19.66s and 22.03s wall. Verbatim
gemma-4-31b table from the captured verbose log:

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
```

**PASS — 3 passed | 3 skipped (6)** — the skipped trio is the adversarial set
gated behind `CEREBRAS_ADVERSARIAL=1`, by design. gpt-oss-120b and
zai-glm-4.7 posted the same all-zero leak tables.

## Lane 4 — plugin-elizacloud unit lane (no API)

```bash
bunx vitest run __tests__/unit/text-cerebras-response-format.test.ts \
  --root plugins/plugin-elizacloud
```

**PASS — 10/10**

```
 Test Files  1 passed (1)
      Tests  10 passed (10)
   Duration  7.43s
```

## Lane 5a — interrupt-bench cerebras smoke

```bash
cd packages/benchmarks/interrupt-bench && \
  CEREBRAS_API_KEY=$CEREBRAS_API_KEY bun run scripts/cerebras-smoke.ts
```

Default model re-confirmed: `DEFAULT_MODEL = "gemma-4-31b"`
(`src/llm-cerebras.ts:16`); no `--model` flag passed.

**PASS — latency 438ms**, strict-json_schema Stage-1 payload parsed cleanly
(`shouldRespond: "RESPOND"`, `intents: ["send_email"]`, a well-formed
`threadOps` create op, facts + relationships populated).

## Lane 5b — interrupt-bench full live bench

```bash
cd packages/benchmarks/interrupt-bench && \
  CEREBRAS_API_KEY=$CEREBRAS_API_KEY bun run bench -- --mode=cerebras \
  --out=/tmp/claude-1000/interrupt-gemma4-rerun
```

**PASS — FINAL SCORE 97.07 (aggregate 97.07 + judge 0.00), pass tier 95,
110 scenarios, model gemma-4-31b.** Whole run took 37.6s wall
(started 06:02:51Z, finished 06:03:29Z), per-call latencies ~300–500ms.

```
FINAL SCORE: 97.07 (aggregate=97.07 + judge=0.00)
PASS TIER: 95
```

Score distribution (identical to first run):

| score | scenarios |
|---|---|
| 100.0 | 86 |
| 95.0 | 9 |
| 85.0 | 3 |
| 80.0 | 11 |
| 50.0 | 1 |

Same weak spots as run 1 (all scorer/model-behavior deltas, no harness
failures): `C1-mid-task-steering` family intent axis (11×80),
`K1-recipe-assembly--edge-ack` missing dm-alice reply (1×50),
`A4-stream-with-retraction` retracted-detail state (85s), `B1` trace axis
(`abortFired=false` where `ack-and-stop` expected, 95s).

Full rerun report copied beside this file:
`interrupt-bench-cerebras-rerun-2026-07-01T23.md`.

## Blockers

None. No lane failed for a real reason; no 429s were even observed this run.
