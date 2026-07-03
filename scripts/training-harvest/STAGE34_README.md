# Stage 3 (GEPA sweep) + Stage 4 (extract & push) — driver reference

Two drivers that consume the gpt-5.5 harvest tree
(`.github/issue-evidence/gpt55-training-pipeline/harvest/{scenario,benchmark}/`)
built by `harvest-runner.mjs` / `bench-e2e-harvest-runner.mjs`.

- **Stage 3** turns the harvest's *real agent failures* into GEPA-optimized
  prompts, re-runs the failing scenarios to confirm the flip, and feeds the
  now-passing trajectories back into the harvest.
- **Stage 4** collects every *passing* trajectory (originals + Stage-3 flips),
  converts them to `eliza_native_v1` training JSONL, splits train/val/test, and
  (guarded) pushes an additive subdir to HuggingFace.

Neither driver commits, and neither echoes any secret (HF token, Cerebras key,
codex tokens). They only write under the evidence tree.

---

## Stage 3 — `stage3-gepa-sweep.mjs`

### What it does

1. **Select GEPA-optimizable failures** from `report.json` (authoritative — never
   stderr). Each failed scenario is classified:
   - `CONNECTOR_CRED` — env-gated (missing connector / credential / mock; or a
     `connector.*` / `*.certify` scenario id). **Excluded** — can't train/GEPA a
     missing-credential failure.
   - `ACTION_SELECTION` — wrong action / wrong action args
     (`no selected action in […]`, `expectedActions`, `selectedActionArguments`,
     `expected N call(s) to X`). GEPA-optimizable.
   - `JUDGE_BELOW` — response judge score under threshold (`responseJudge`,
     `score X < Y`). GEPA-optimizable.
   - `OUTPUT_FORMAT` — `responseIncludes/Excludes`, structured-argument mismatch.
     GEPA-optimizable.
   - `OTHER` — real failure, no clean task mapping — not GEPA-targeted here.
2. **Group by GEPA task.** Each failing scenario's own `native.jsonl` rows carry a
   stamped `metadata.task_type`; the failure is bucketed into the GEPA `--task`
   it implicates (ACTION_SELECTION → `action_planner`; else the dominant mapped
   task present — `should_respond`, a LifeOps task, etc.). `evaluation` rows are
   evaluator calls, not a GEPA prompt task — dropped from grouping.
3. **Build the per-task GEPA dataset.** GEPA optimizes a task's **system prompt**
   against that task's **gold** `(input → expected)` rows. The native backend
   deliberately **excludes failed-scenario rows as gold** (`native.ts`
   `isFailedScenarioSignal`, #8795) — a wrong output must never be optimized
   *toward*. So the dataset for a task = the **passing** scenarios' `native.jsonl`
   rows for that `task_type`, deduped, written in the exact `eliza_native_v1`
   shape the native backend parses (`datasets/<task>.gepa.jsonl`). The failing
   scenarios supply only the *inputs* the optimized prompt must then get right;
   the confirmation is the re-run.
4. **Emit the exact `train` command per task**, then (with `--run`) execute it:
   GEPA → artifact at `<state-dir>/optimized-prompts/<task>/current` → re-run the
   failing scenarios with `ELIZA_STATE_DIR=<state-dir>` so the runtime substitutes
   the optimized prompt at boot → capture the flip. Every flip's now-passing
   trajectory is copied into `harvest/scenario/<family>/<item>__gepa/` (additive;
   never overwrites the original failing capture) so Stage 4 picks it up.

Scoring model is **Cerebras** (fast, sanctioned — `TRAIN_MODEL_PROVIDER=cerebras`,
default `gemma-4-31b`). The flip **validation** re-run is **gpt-5.5-via-Codex**
(the S1 provider env at `/tmp/s1-provider-full.json`).

Resumable: per-task dataset, per-task artifact, and per-scenario rerun verdict are
all on disk; re-invoking skips completed steps unless `--force`.

### Commands

```bash
# DRY RUN (default): classify + group + build datasets + PRINT the per-task commands.
node scripts/training-harvest/stage3-gepa-sweep.mjs --dry-run

# SMALL end-to-end proof: GEPA one task on its real harvested cases + 1 rerun.
CEREBRAS_API_KEY=<key> \
  node scripts/training-harvest/stage3-gepa-sweep.mjs --run --only action_planner --max-rerun 1

# FULL SWEEP (expensive — run after the full harvest completes):
CEREBRAS_API_KEY=<key> \
  node scripts/training-harvest/stage3-gepa-sweep.mjs --run

# Re-run failing scenarios against an already-produced artifact store (no GEPA):
node scripts/training-harvest/stage3-gepa-sweep.mjs --rerun-only --state-dir <dir>
```

Flags: `--only <task>`, `--max-rerun <n>` (cap reruns per task), `--state-dir <dir>`
(GEPA artifact store; default `s3-gepa/sweep/state`), `--force`, `--timeout-ms`.

Each task's raw `train` command (what `--run` executes):

```bash
TRAIN_MODEL_PROVIDER=cerebras CEREBRAS_API_KEY=<key> ELIZA_STATE_DIR=<state-dir> \
  bun run --cwd plugins/plugin-training train -- \
    --backend native --optimizer gepa --task <task> \
    --dataset .github/issue-evidence/gpt55-training-pipeline/s3-gepa/sweep/datasets/<task>.gepa.jsonl
```

(`--baseline` is inferred from the dataset's system message when omitted; for
tasks whose native rows carry no `request.system` — e.g. `view_context` — pass
`--baseline <prompt.txt>`.)

### Task-grouping map (native `task_type` → GEPA `--task`)

| native `task_type` | GEPA `--task`     | scorer                       |
|--------------------|-------------------|------------------------------|
| `should_respond`   | `should_respond`  | token-overlap (default)      |
| `context_routing`  | `context_routing` | token-overlap (default)      |
| `action_planner`   | `action_planner`  | `scorePlannerAction` (exact) |
| `response`         | `response`        | token-overlap (default)      |
| `media_description`| `media_description`| token-overlap (default)     |
| `view_context`     | `view_context`    | `scoreViewSelection` (exact) |
| `calendar_extract` … `screentime_recap` (8 LifeOps) | same id | `scoreLifeOpsTask` (exact) |
| `evaluation`       | *(dropped)*       | not a GEPA prompt task       |

Valid `--task` ids = `ALL_TRAJECTORY_TRAINING_TASKS`
(`plugins/plugin-training/src/core/trajectory-task-datasets.ts`). Scorers:
`plugins/plugin-training/src/optimizers/scoring.ts`.

### Known scorer nuance (documented, non-blocking)

`scorePlannerAction` → `extractPlannerAction` reads `record.name ?? action ??
actionName` first; the harvested AI-SDK toolCalls use `toolName`, so it falls
through to the `\b[A-Z][A-Z0-9_]{2,}\b` regex fallback. On the harvested
`action_planner` gold this resolves the correct action for **152/154** rows; 2
rows where an ALL-CAPS token precedes the toolName mis-extract. GEPA still runs
and scores over the whole set; the S3 smoke already proved the full 0→1 flip on
`view_context`. (A one-line fix — teach `extractPlannerAction` to read
`toolName` — would make it exact; out of scope for these drivers.)

---

## Stage 4 — `stage4-extract-and-push.mjs`

### What it does

1. **Collect all passing trajectories** — every harvest item with
   `verdict.status === "passed"`, across both families, **including Stage-3
   GEPA-flips** (`<item>__gepa/`).
2. **Extract** each item's `native.jsonl` through the proven Python extractor
   (`packages/training/scripts/extract_trajectory_to_native.py --require-pass`),
   which validates every row through `validate_native_record` and drops any
   failed/skipped-scenario row (belt-and-suspenders — passing items shouldn't
   have any).
3. **Dedup + clean.** Drop degenerate rows (no user turn OR no non-empty
   expected). Dedup on the training signal `(system, user, expected)`, not on
   ids/timestamps.
4. **Split** train/val/test with a deterministic `hash(seed + callId)` in
   `[0,1)` (mirrors `prepare_eliza1_trajectory_dataset.py` `stable_unit`; default
   val-ratio 0.05, test-ratio 0.05). Splits are disjoint by construction.
5. **Assemble** `assembled/{train,val,test}.jsonl` + `manifest.json`, and
   schema-self-check the sample row.
6. **Push (guarded, `--push` only)** to `elizaos/eliza-1-training-data` under a
   **new additive subdir** `converted/gpt55-scenarios/` via
   `hf upload … --repo-type dataset`. Default is local-assemble-only; the push
   never clobbers the existing `converted/{xlam,hermes,glaive,openclaw,merged}`
   sets.

### Commands

```bash
# STATS only (extract + classify, no writes):
node scripts/training-harvest/stage4-extract-and-push.mjs --stats

# LOCAL ASSEMBLE (default — writes assembled/{train,val,test}.jsonl + manifest):
node scripts/training-harvest/stage4-extract-and-push.mjs

# PUSH to HF (guarded — run after full harvest + Stage-3 flips are in):
HF_TOKEN=$(cat ~/.cache/huggingface/token) \
  node scripts/training-harvest/stage4-extract-and-push.mjs --push
```

Flags: `--out <dir>`, `--seed <s>`, `--val-ratio`, `--test-ratio`.

### Dataset schema (matches `elizaos/eliza-1-training-data` converted rows)

One row = one Vercel AI SDK `generateText` boundary — the `eliza_native_v1`
shape (`packages/training/scripts/lib/native_record.py`). The HF
`converted/merged/*.jsonl` records use the core projection
`{format, boundary, request:{messages,tools}, response:{text,toolCalls},
metadata, scenarioId, stepIndex}`; the assembled rows are a **strict superset**
of that (same core keys + richer per-boundary provenance:
`trajectoryId, callId, scenarioStatus, judgeScore, modelType, provider,
schemaVersion, …`). Because the push target is a new additive subdir, the
superset is preferred — no provenance is dropped and every training loader reads
the same core fields.

```json
{"format":"eliza_native_v1","schemaVersion":1,"boundary":"vercel_ai_sdk.generateText",
 "scenarioStatus":"passed",
 "request":{"messages":[{"role":"user","content":"…"}],"tools":[…]},
 "response":{"text":"…","toolCalls":[{"toolName":"CALENDAR","input":{…}}],"finishReason":"…"},
 "trajectoryId":"…","agentId":"…","callId":"…","scenarioId":"…",
 "metadata":{"task_type":"action_planner","scenario_status":"passed","judge_score":null,…}}
```

Acceptance gate (`validate_native_record`): `format == eliza_native_v1`,
`boundary ∈ {generateText, streamText}`, `request` has ≥1 user turn (messages)
OR a non-empty `prompt`, `response` has non-empty `text` OR non-empty
`toolCalls`.

### HF push target

- Repo: `elizaos/eliza-1-training-data` (dataset, public; token role = write).
- Path-in-repo: `converted/gpt55-scenarios/{train,val,test}.jsonl` (additive).
- Uploader: `hf upload <repo> <local> <path-in-repo> --repo-type dataset`
  (same mechanism as the runtime cron `trajectory-hf-upload.ts`).

---

## The full-run sequence (once the harvest completes)

```bash
# 1. Full GEPA sweep — optimize every runnable task, re-run failing scenarios,
#    capture flips back into harvest/scenario/<family>/<item>__gepa/.
CEREBRAS_API_KEY=<key> \
  node scripts/training-harvest/stage3-gepa-sweep.mjs --run

# 2. Extract every passing trajectory (originals + flips) → local splits.
node scripts/training-harvest/stage4-extract-and-push.mjs

# 3. Publish the additive subdir to HuggingFace.
HF_TOKEN=$(cat ~/.cache/huggingface/token) \
  node scripts/training-harvest/stage4-extract-and-push.mjs --push
```
