# S3 — GEPA optimization loop (RUNNABLE-AS-IS, smoked live)

Stage 3 of the gpt-5.5 → eliza-1 training pipeline: take scenarios that **FAIL**
when run through gpt-5.5, GEPA-optimize the task's system prompt until they
**PASS**, then let the now-passing trajectories feed the Stage-4 harvest.

## Verdict: RUNNABLE AS-IS. GEPA exists as real, tested TypeScript — not just an issue.

The optimizer is not a stub and not Python-only. It is a formal GEPA
implementation (Goyal et al. 2024 — reflective evolution + Pareto frontier)
wired end-to-end into a native backend, a CLI, a promotion gate, and the
runtime pickup service. I **smoked it live** below: a genuinely-failing
`view_context` case went **0.000 → 1.000** on a live Cerebras `gemma-4-31b`,
the artifact persisted through the real `OptimizedPromptService`, and a fresh
service instance loaded it back — the exact mechanism that flips a re-run to
passing at agent boot.

> One real gap (not a blocker for the mechanism): the `train` CLI hard-locks its
> eval adapter to Cerebras. To score GEPA on the pipeline's *exact* model
> (gpt-5.5-via-Codex) rather than a fast proxy, a codex `LlmAdapter` must be
> dropped into the same swappable seam. See **Blockers** below.

---

## 1. The located entrypoint (file:line)

The optimizer OptimizedPromptService points at
(`packages/core/src/services/optimized-prompt.ts:1` — "Native MIPRO/GEPA/…
optimizers under `plugins/plugin-training/src/optimizers/`") is real and here:

| Piece | File:line | What it is |
|---|---|---|
| **GEPA optimizer** | `plugins/plugin-training/src/optimizers/gepa.ts:94` — `runGepa()` | Reflective feedback + Pareto(score,tokens) + feedback/compress/crossover mutations. Returns `{optimizedPrompt, score, baseline, lineage}`. |
| **Metric / scorer** | `plugins/plugin-training/src/optimizers/scoring.ts:44` — `createPromptScorer()`; `:246` `scoreViewSelection`; `:226` `scorePlannerAction`; `:257` `scoreAgreement`; `:451` `scoreLifeOpsTask` | Runs the candidate prompt through the LLM per example, compares to the recorded expected output. Task-specific comparators. |
| **Native backend (production dispatch)** | `plugins/plugin-training/src/backends/native.ts:470` — `runNativeBackend()`; dispatch at `:305`, `case "gepa": return runGepa(input)` at `:321` | Parses `eliza_native_v1` JSONL → examples, picks the task scorer, deterministic train/holdout split, dispatches to the optimizer. |
| **CLI entrypoint** | `plugins/plugin-training/src/cli/train.ts:109` — `runTrainCli()` (npm `train`) | `--backend native --optimizer gepa --dataset <jsonl> --task <task>`. Persists the winner via `OptimizedPromptService.setPrompt`. |
| **Per-task script** | `plugins/plugin-training/scripts/gepa-view-context.ts` (npm `gepa:view-context`) | Canonical single-task GEPA run + promotion gate; my smoke mirrors this path. |
| **LifeOps trajectory loop** | `plugins/plugin-training/scripts/lifeops-gepa-loop.ts` (npm `lifeops:gepa`) → `triggerTraining` (`src/core/training-orchestrator.ts`) | File-backed loop: reads recorded trajectories → buckets per task → native GEPA → promotion gate → persist. |
| **Promotion gate (#8797)** | `plugins/plugin-training/src/core/promotion-gate.ts:124` — `evaluatePromotion()` | Variance-aware: promote only if candidate beats incumbent by `1.5×stddev`. |
| **Runtime pickup** | `packages/core/src/services/optimized-prompt.ts:450` — `OptimizedPromptService`; `setPrompt` `:551`, `getPrompt` `:505`, `refresh` `:698` | Writes `vN.json` + `current` symlink + HMAC `.mac`; the runtime substitutes the optimized prompt for the task at boot. |

Also present: DSPy-native optimizer family (`dspy-bootstrap-fewshot`,
`dspy-copro`, `dspy-mipro`) under `plugins/plugin-training/src/dspy/`, dispatched
through the same native backend (`native.ts:339` `runDspyOptimizer`). There is
**no** separate "DSPy-GEPA" — GEPA is the native TS implementation above; the
DSPy variants are bootstrap/COPRO/MIPRO.

Deterministic proof the code path executes here:
`bunx vitest run plugins/plugin-training/src/optimizers/__tests__/gepa.test.ts`
→ **5/5 pass**.

---

## 2. The failing-case → GEPA → re-run loop (exact commands)

**How a failure becomes an optimized prompt, and how a re-run passes:**

1. **Stage 2 harvest** writes, per scenario, `verdict.json {status, rows, judgeScore}`
   + `native.jsonl` (`eliza_native_v1` rows). `status:"failed"` items are the GEPA targets.
2. **Build the per-task dataset.** GEPA optimizes a *task's system prompt* against
   that task's **gold** `(input → expected)` rows. The native backend deliberately
   **excludes failed-scenario rows** as gold (`native.ts:229-235`
   `isFailedScenarioSignal`) — a failure's wrong output must never be optimized
   toward. Gold comes from passing/reference rows; the failing scenario supplies
   the *inputs* the optimized prompt must get right.
3. **Run GEPA** (writes `<stateDir>/optimized-prompts/<task>/current`):

   ```bash
   TRAIN_MODEL_PROVIDER=cerebras CEREBRAS_API_KEY=… \
   bun run --cwd plugins/plugin-training train -- \
     --backend native --optimizer gepa \
     --dataset <per-task eliza_native_v1.jsonl> \
     --task  <should_respond|action_planner|response|view_context|calendar_extract|…> \
     --baseline <baseline-prompt.txt>     # else inferred from the dataset's system msg
   ```

   The winner is written by `OptimizedPromptService.setPrompt` to
   `${ELIZA_STATE_DIR:-~/.eliza}/optimized-prompts/<task>/vN.json` with a
   `current` symlink and an HMAC `.mac` sidecar.
4. **Re-run the failing scenario** with the *same state dir*. At boot
   `OptimizedPromptService.refresh()` scans the store and `getPrompt(task)` returns
   the optimized prompt, which the runtime substitutes for that task's baseline.
   The scenario that failed on the baseline now passes — using the exact S1
   incantation:

   ```bash
   cd packages/scenario-runner
   env -i HOME="$HOME" PATH="$PATH" \
     ELIZA_STATE_DIR=<same stateDir as step 3> \
     ELIZA_CHAT_VIA_CLI=codex ELIZA_CLI_CODEX_MODEL=gpt-5.5 \
     ELIZA_PLANNER_NATIVE_TOOLS=0 ELIZA_SAVE_TRAJECTORIES=1 \
     ELIZA_CONFIG_PATH=/tmp/nonexistent-eliza-config.json \
     bun --env-file=<(:) --conditions eliza-source --tsconfig-override ../../tsconfig.json \
       src/cli.ts run <SCENARIO_DIR> --scenario <id> \
       --report-dir <out> --run-dir <out> --export-native <out/native.jsonl>
   ```

Per-task alternative for the LifeOps family (drives the whole loop through the
orchestrator + promotion gate from a trajectory directory):

```bash
TRAIN_MODEL_PROVIDER=cerebras CEREBRAS_API_KEY=… \
bun run --cwd plugins/plugin-training lifeops:gepa -- \
  --trajectories ../../reports/scenarios/run/trajectories --task calendar_extract
```

---

## 3. The live smoke (real, not fabricated)

Script: `smoke-gepa-live.ts` (in this dir). It drives the **real** `runGepa` +
**real** `createPromptScorer`/`scoreViewSelection` + **real** `evaluatePromotion`
+ **real** `OptimizedPromptService`, against a live Cerebras `gemma-4-31b` (the
model the sanctioned `TRAIN_MODEL_PROVIDER=cerebras` adapter defaults to,
`train.ts:169`).

Run:
```bash
CEREBRAS_API_KEY=… bun --conditions=eliza-source \
  .github/issue-evidence/gpt55-training-pipeline/s3-gepa/smoke-gepa-live.ts
```

**The genuinely-failing case:** `smoke-dataset-view_context.jsonl` (12 rows,
`eliza_native_v1`) where the correct view is obvious from the user text. The
baseline prompt lists the view vocabulary but gives **no output contract** and
invites a conversational reply — so the live model answers in prose, from which
`scoreViewSelection` extracts no `{viewId}` → **baseline scores 0.000 (all fail)**.

> Note: the plugin's own `__fixtures__/view-context.jsonl` is NOT a valid
> GEPA-alone smoke — its expected mapping is idiosyncratic (e.g. `"task-coordinator"`),
> which needs bootstrap-fewshot *demonstrations*, not instruction rewriting. GEPA
> on it correctly stays at 0 (that run is in git history of this dir). The curated
> dataset isolates the failure GEPA is actually built to fix: a missing output contract.

**Before / after (reproduced twice; `smoke-run.log`, `smoke-report.json`):**

| | score (12/12) | outcome |
|---|---|---|
| baseline prompt | **0.000** | FAIL — prose, no parseable `{viewId}` |
| GEPA-optimized prompt | **1.000** | PASS — exact `{viewId}` every row |

- **Promotion gate:** `PROMOTE (delta=1.0000 > margin 0.0000)`.
- **Runtime pickup:** `OK (optimizer=gepa, score=1.000)` — a fresh
  `OptimizedPromptService` loaded `current` and returned the optimized prompt.
- **Optimized prompt GEPA discovered** (`artifact-view_context.json`):
  > *"Select the most relevant view from: calendar, inbox, wallet, finances,
  > todos, goals, health, documents, relationships, focus, none. Return only a
  > JSON object with keys "viewId" and "reason". No conversational text or markdown."*
- **Lineage proves the algorithm ran**, not a lucky guess: reflection diagnosed
  the real failure ("providing descriptive, verbatim responses", "wrapping the
  JSON in Markdown"); feedback-mutations that added the JSON contract scored
  1.000; compress-mutations that dropped it scored 0.000 and were Pareto-dominated.
- **On-disk artifact store** (temp state dir, matches the runtime contract):
  `optimized-prompts/view_context/` = `v1.json` + `v1.json.mac` (HMAC-SHA256
  integrity, SOC2 CC6.8) + `current -> v1.json`.

### Files in this directory
| File | Role |
|---|---|
| `smoke-gepa-live.ts` | The live smoke driver (real optimizer + real service). |
| `smoke-dataset-view_context.jsonl` | Curated 12-row `eliza_native_v1` failing case. |
| `smoke-run.log` | Full captured stdout of the authoritative run. |
| `smoke-report.json` | Before/after scores, promotion decision, optimized prompt, full lineage. |
| `artifact-view_context.json` | The persisted `OptimizedPromptArtifact` (schema-valid, HMAC-verified on reload). |

---

## 4. How GEPA-flipped runs feed the Stage-4 harvest

The loop is self-reinforcing:

1. A scenario **fails** on the current prompt at gpt-5.5 → Stage-2 `verdict.json status:"failed"`.
2. GEPA optimizes that task's prompt → artifact at `optimized-prompts/<task>/current`.
3. The scenario is **re-run** with that state dir → `OptimizedPromptService` substitutes
   the optimized prompt → it now **passes**, emitting a fresh `native.jsonl`
   (`eliza_native_v1`) trajectory with `scenarioStatus: passed`.
4. The **Stage-4 harvest** (`scripts/training-harvest/`, and the pass-only extraction
   already proven in `../s4-data-nebius/proven-scenario-passonly.native.jsonl`) keeps
   only passing trajectories → those GEPA-flipped rows join the training corpus
   alongside the originally-passing ones.

So GEPA converts a *failed* scenario into *two* assets: a better production prompt
(loaded at boot) **and** a new passing trajectory for the eliza-1 training data.

---

## Blockers / gaps (honest)

1. **gpt-5.5 scoring adapter is not wired into the native backend.** `train.ts:128`
   hard-requires `TRAIN_MODEL_PROVIDER=cerebras` and loads the Cerebras eval adapter
   (`train.ts:147-167`). GEPA's `LlmAdapter` is a swappable seam (`optimizers/types.ts:63`),
   so scoring on the pipeline's exact model means dropping in a codex `LlmAdapter`
   that shells `codex exec -m gpt-5.5` (the S1 provider seam). Until then, either
   (a) use Cerebras `gemma-4-31b` as a fast scoring proxy and *validate* the flip by
   re-running the scenario on gpt-5.5-via-Codex (step 2.4), or (b) add the codex
   adapter branch to `train.ts` / `runNativeBackend`. This is a ~1-file addition,
   **not** a rewrite — the optimizer, gate, and persistence are all model-agnostic.
2. **Cost at gpt-5.5.** GEPA is hundreds of completions per task
   (population × generations × (score + reflect)); cold `codex exec` is ~20-40s/call,
   so scoring GEPA directly on gpt-5.5 is expensive. The Cerebras proxy (sub-second,
   sanctioned) is the practical scoring model; gpt-5.5 is the *validation* re-run.
3. **Cerebras shared-endpoint throttling** (HTTP 429 `queue_exceeded`) hits under
   load; the smoke adapter rides through it with exponential backoff. A production
   Stage-3 sweep should honor rate limits / retry, as the smoke does.

## The exact Stage-3 command (one line)

```bash
TRAIN_MODEL_PROVIDER=cerebras CEREBRAS_API_KEY=… \
bun run --cwd plugins/plugin-training train -- \
  --backend native --optimizer gepa \
  --dataset <per-task eliza_native_v1.jsonl> --task <task> --baseline <baseline.txt>
```
→ artifact at `${ELIZA_STATE_DIR:-~/.eliza}/optimized-prompts/<task>/current`;
re-run the failing scenario with that `ELIZA_STATE_DIR` to confirm the flip.
