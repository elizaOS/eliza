# @elizaos/plugin-training

Fine-tuning, trajectory management, and prompt-optimization infrastructure for Eliza agents.

## Purpose / role

Adds data collection, trajectory export, prompt optimization, GPU training orchestration, benchmark evaluation, and a fine-tuning dashboard to an Eliza agent. Loaded as a plugin via `trainingPlugin` (exported from `src/setup-routes.ts`). The runtime hook entry-point is `registerTrainingRuntimeHooks` (`src/register-runtime.ts`), which registers `OptimizedPromptService`, nightly cron jobs, and the `TrainingTriggerService`. There is no automatic enable — the host runtime must call `registerTrainingRuntimeHooks` and register the plugin's routes.

## Plugin surface

### Routes (all registered with `rawPath: true`)

| Group | Paths |
|---|---|
| Training | `GET /api/training/status`, `GET|POST /api/training/auto/config`, `GET /api/training/auto/status`, `POST /api/training/auto/trigger`, `GET /api/training/auto/runs[/:runId]`, `GET /api/training/trajectories[/:id]`, `POST /api/training/trajectories/export`, `POST /api/training/trajectories/publish`, `GET /api/training/datasets`, `POST /api/training/datasets/build`, `GET /api/training/backends`, `GET|POST /api/training/jobs`, `GET /api/training/jobs/:jobId`, `POST /api/training/jobs/:jobId/cancel`, `GET /api/training/models`, `POST /api/training/models/:modelId/import-ollama`, `POST /api/training/models/:modelId/activate`, `POST /api/training/models/:modelId/benchmark`, `GET /api/training/blueprints`, `GET /api/training/context-catalog`, `GET /api/training/context-audit`, `POST /api/training/generate-dataset`, `POST /api/training/generate-roleplay`, `POST /api/training/roleplay/execute` |
| Vast.ai | `GET|POST /api/training/vast/jobs`, `GET /api/training/vast/jobs/:id`, `POST /api/training/vast/jobs/:id/cancel`, `POST /api/training/vast/jobs/:id/eval`, `GET /api/training/vast/jobs/:id/logs`, `GET /api/training/vast/jobs/:id/budget`, `GET /api/training/vast/models`, `GET /api/training/vast/models/:short_name/checkpoints`, `GET|POST /api/training/vast/inference/endpoints`, `DELETE /api/training/vast/inference/endpoints/:id`, `GET /api/training/vast/inference/stats` |
| Trajectories | `GET|DELETE /api/trajectories`, `GET|PUT /api/trajectories/config`, `POST /api/trajectories/export`, `GET /api/trajectories/stats`, `GET /api/trajectories/:id` |
| Experience | See `EXPERIENCE_ROUTE_PATHS` in `src/routes/experience-routes.ts` |

### Views (registered on `trainingPlugin`)

- `training` — Fine-tuning dashboard (`FineTuningView`). `developerOnly: true`.
- `training` (xr) — Same view in XR surface.
- `training/tui` — Terminal variant (`FineTuningTuiView`).

### Services

- `TrainingTriggerService` (`TRAINING_TRIGGER_SERVICE = "training_trigger_service"`) — counts completed trajectories per task, fires prompt optimization when the threshold is reached.
- `TrainingService` — public training API; reads trajectories from the runtime, builds privacy-filtered export bundles.
- `VastTrainingService` — Vast.ai GPU job orchestration (spawn `train_vast.sh`, `eval_checkpoint.py`).

### Cron jobs (registered by `registerTrainingRuntimeHooks`)

- Trajectory export cron — nightly, bucketizes trajectories into per-task JSONL under `<state>/training/datasets/<YYYY-MM-DD>/`, then optionally uploads to HuggingFace.
- Skill scoring cron — nightly, scores active skills against recent trajectories and updates `SKILL.md` frontmatter.

### Optimizers (`src/optimizers/`, `src/dspy/`)

| Name | File |
|---|---|
| `instruction-search` | `src/optimizers/instruction-search.ts` |
| `prompt-evolution` | `src/optimizers/prompt-evolution.ts` |
| `gepa` | `src/optimizers/gepa.ts` |
| `bootstrap-fewshot` | `src/optimizers/bootstrap-fewshot.ts` |
| `dspy-bootstrap-fewshot` | `src/dspy/optimizers/dspy-bootstrap-fewshot.ts` |
| `dspy-copro` | `src/dspy/optimizers/dspy-copro.ts` |
| `dspy-mipro` | `src/dspy/optimizers/dspy-mipro.ts` |

All optimizers consume `eliza_native_v1` JSONL rows and write artifacts to `<stateDir>/optimized-prompts/` via `OptimizedPromptService`.

## Layout

```
src/
  index.ts                      Re-exports everything
  setup-routes.ts               trainingPlugin definition (routes + views)
  register-runtime.ts           registerTrainingRuntimeHooks — call at agent boot
  cli/
    train.ts                    CLI entry: `bun run train`
  core/
    training-config.ts          TrainingConfig, loadTrainingConfig, saveTrainingConfig
    training-orchestrator.ts    triggerTraining, listRuns, loadRun, recordRun
    training-collection-runner.ts  Full collection pipeline (HF ingest + feeds + scenarios + benchmarks)
    trajectory-export-bundle.ts Privacy-filtered export bundle builder
    trajectory-export-cron.ts   Nightly export cron registration
    trajectory-hf-upload.ts     HuggingFace JSONL uploader (shells out to hf CLI)
    trajectory-task-datasets.ts Per-task JSONL export (eliza_native_v1 format)
    trajectory-consumer.ts      Trajectory consumption utilities
    privacy-filter.ts           Anonymizer + PII/credential/geo stripping
    skill-scoring-cron.ts       Nightly skill eval cron
    dataset-generator.ts        Dataset generation utilities
    scenario-runner.ts          Scenario execution harness
    scenario-blueprints.ts      Scenario blueprint definitions
    action-benchmark-runner.ts  Eliza-1 action benchmark runner
    eliza1-benchmark-recipe.ts  Tier/variant definitions for Eliza-1 benchmarks
    eliza1-bundle-stager.ts     Bundle staging for Eliza-1 benchmarks
    benchmark-matrix-artifact.ts  Benchmark matrix artifact builder
    benchmark-vs-cerebras-runner.ts  Cerebras comparison benchmark runner
    cerebras-eval-model.ts      Cerebras eval model adapter
    eval-comparison-artifact.ts Eval comparison artifact builder
    artifact-store.ts           Artifact persistence store
    cli.ts                      Data collection CLI (run-collection, list-collections)
    context-catalog.ts          Context catalog builder
    context-audit.ts            Context audit
    context-types.ts            Shared context type definitions
    replay-validator.ts         Skill scoring against trajectory replays
    feed-generation-runner.ts   Feed generation pipeline runner
    huggingface-dataset-ingest.ts  HuggingFace dataset ingestion
    test-trajectory-collector.ts   Test trajectory collection
    roleplay-executor.ts        Roleplay execution harness
    roleplay-trajectories.ts    Roleplay trajectory utilities
    prompt-compare.ts           Prompt comparison utilities
    promotion-gate.ts           Promotion gating logic
    promotion-persist.ts        Promotion persistence
    training-analysis-index.ts  Training analysis index
    training-readiness-report.ts  Training readiness reporting
    ensure-cron-job.ts          Cron job registration helper
    track-c-queue-task.ts       Track-C queue task management
    wait-for-service.ts         Service readiness wait utility
    workspace-runtime.ts        Workspace runtime utilities
  backends/
    native.ts                   Native in-process optimizer backend
  optimizers/
    instruction-search.ts       Instruction-search optimizer
    prompt-evolution.ts         Prompt-evolution (genetic) optimizer
    gepa.ts                     GEPA (Pareto+feedback) optimizer
    bootstrap-fewshot.ts        Bootstrap few-shot optimizer
    scoring.ts                  createPromptScorer, scorePlannerAction
    types.ts                    OptimizerName, OptimizerResult, etc.
  dspy/
    optimizers/                 DSPy-native variants (bootstrap, COPRO, MIPRO)
    signature.ts                Signature DSL
    predict.ts                  Predict module
    lm-adapter.ts               Runtime → DSPy LM adapter
  routes/
    training-routes.ts          /api/training/* handlers
    training-vast-routes.ts     /api/training/vast/* handlers
    trajectory-routes.ts        /api/trajectories/* handlers
    experience-routes.ts        Experience service routes
  services/
    training-service.ts         TrainingService class
    training-service-like.ts    TrainingService interface/base
    training-trigger.ts         TrainingTriggerService + bootstrapOptimizationFromAccumulatedTrajectories
    training-vast-service.ts    VastTrainingService
    training-service-registry.ts  getActiveTrainingService / setActiveTrainingService
    training-backend-check.ts   detectAvailableBackends
    vast-job-store.ts           VastJobStore (JSONL job state)
    vast-inference-stats.ts     Inference stats parsing
    vast-subprocess.ts          runCapture / runDetachedToLog
  ui/
    FineTuningView.tsx          Dashboard React component
    fine-tuning-panels.tsx      Panel sub-components
```

## Commands

Scripts are defined in `package.json`; run them from the repo root with `bun run --cwd`:

```bash
bun run --cwd plugins/plugin-training clean                  # remove build output
bun run --cwd plugins/plugin-training build                  # build package artifacts
bun run --cwd plugins/plugin-training build:js               # js build lane
bun run --cwd plugins/plugin-training build:views            # views build lane
bun run --cwd plugins/plugin-training build:types            # types build lane
bun run --cwd plugins/plugin-training typecheck              # TypeScript typecheck
bun run --cwd plugins/plugin-training lint                   # mutating Biome check
bun run --cwd plugins/plugin-training lint:check             # read-only Biome check
bun run --cwd plugins/plugin-training format                 # write formatting
bun run --cwd plugins/plugin-training format:check           # read-only formatting check
bun run --cwd plugins/plugin-training test                   # run package tests
bun run --cwd plugins/plugin-training test:watch             # watch test lane
bun run --cwd plugins/plugin-training train                  # optimizer CLI
bun run --cwd plugins/plugin-training collect                # data collection CLI
bun run --cwd plugins/plugin-training trajectories:review    # bun --conditions=eliza-source scripts/trajectory-quality-review.ts
bun run --cwd plugins/plugin-training verify:view-switching  # bun run scripts/verify-view-switching.ts
bun run --cwd plugins/plugin-training gepa:view-context      # bun run scripts/gepa-view-context.ts
bun run --cwd plugins/plugin-training lifeops:gepa           # bun run scripts/lifeops-gepa-loop.ts
bun run --cwd plugins/plugin-training lifeops:gepa-seed      # bun --conditions=eliza-source scripts/lifeops-gepa-seed.ts
```

## Config / env vars

| Var | Required | Purpose |
|---|---|---|
| `ELIZA_STATE_DIR` | no | State root override (default `~/.eliza`) |
| `TRAINING_STATE_DIR` | no | Override for training-specific state dir |
| `ELIZA_DISABLE_TRAINING_CRONS` | no | Set to `1`/`true`/`yes` to skip cron registration |
| `ELIZA_DISABLE_AUTO_BOOTSTRAP` | no | Disable auto-bootstrap of prompt optimization on start |
| `TRAIN_MODEL` | no | Model id for native optimizer (overrides runtime default) |
| `TRAIN_MODEL_PROVIDER` | no | Provider for `TRAIN_MODEL` |
| `TRAIN_OPTIMIZER` | no | Default optimizer name |
| `TRAINING_PROVIDER` | no | Provider used during training runs |
| `ELIZA_TRAJECTORY_HF_REPO` | no | `org/dataset` — enables HuggingFace JSONL upload after nightly export |
| `HF_TOKEN` | no | HuggingFace token (canonical). Fallbacks: `HUGGINGFACE_HUB_TOKEN`, `HUGGING_FACE_HUB_TOKEN` |
| `ELIZA_TRAJECTORY_DIR` | no | Override trajectory storage dir |
| `ELIZA_TEST_TRAJECTORY_DIR` | no | Override dir for test trajectory collection |
| `ELIZA_ACTION_BENCHMARK_TRAJECTORY_DIR` | no | Override dir for action benchmark trajectories |
| `ELIZA_ACTION_BENCHMARK_REPORT_PATH` | no | Override path for action benchmark text report |
| `ELIZA_ACTION_BENCHMARK_REPORT_JSON_PATH` | no | Override path for action benchmark JSON report |
| `ELIZA_INFERENCE_STATS_PATH` | no | Override inference stats JSONL path |
| `ELIZA_VAST_MAX_USD` | no | Budget cap for Vast.ai GPU jobs |
| `ANTHROPIC_API_KEY` | no | Required for Anthropic-backed optimizer runs |
| `OPENAI_API_KEY` | no | Required for OpenAI-backed optimizer runs |
| `CEREBRAS_API_KEY` | no | Required for Cerebras benchmark comparisons |
| `CEREBRAS_MODEL` | no | Model id for Cerebras benchmark |
| `LOCAL_LLAMA_CPP_API_KEY` | no | API key for local llama.cpp endpoint |
| `OLLAMA_URL` | no | URL for local Ollama inference endpoint |
| `DATABASE_URL` | no | Database connection URL (used by workspace runtime) |
| `ELIZA_LIVE_TEST_LARGE_MODEL` | no | Model id override for live large-model tests |
| `REAL_LLM_MODEL` | no | Model id override for real-LLM integration tests |

Training config is persisted at `<stateDir>/training/config.json`. Key fields: `autoTrain` (bool, default true), `triggerThreshold` (int, default 100 trajectories per task), `triggerCooldownHours` (default 12), `backends` (default `["native"]`), `perTaskOverrides`.

## How to extend

**Add a new optimizer:**
1. Create `src/optimizers/<name>.ts` implementing the optimizer function.
2. Export it from `src/optimizers/index.ts`.
3. Add the name to `OptimizerName` union in `src/optimizers/types.ts`.
4. Wire it in `src/backends/native.ts` where `NATIVE_OPTIMIZERS` and the dispatch switch live.
5. Add it to the `--optimizer` help text in `src/cli/train.ts`.

**Add a new API route group:**
1. Create `src/routes/<group>-routes.ts` with a handler function.
2. Export the handler and path list from `src/routes/index.ts`.
3. Register paths and handler in `src/setup-routes.ts` following the existing `TRAINING_ROUTES` / `VAST_ROUTES` pattern.

**Add a new service:**
1. Create `src/services/<name>.ts`.
2. Export from `src/services/index.ts`.
3. Register via `runtime.registerService(...)` in `registerTrainingRuntimeHooks` if it must be available at runtime.

## Conventions / gotchas

- **No actions or providers.** This plugin registers only routes, views, and services. There are no `actions`, `providers`, or `evaluators` fields on `trainingPlugin`.
- **Privacy filter is mandatory** before any disk write or upload. Always run `applyPrivacyFilter` / `buildTrajectoryExportBundle` — never write raw trajectories.
- **Native backend is in-process.** It calls `runtime.useModel(ModelType.TEXT_LARGE, ...)` directly. No HTTP server subprocess.
- **Vast.ai backend shells out** to Python/bash scripts under `eliza/packages/training/scripts/`. That directory must exist at runtime for Vast routes to work.
- **`ELIZA_DISABLE_TRAINING_CRONS=1`** must be set manually in tests to avoid cron registration side-effects; it is not set automatically by the framework.
- **`trainingPlugin.name` is `@elizaos/plugin-training-routes`** (not `@elizaos/plugin-training`) — this is the name the route registry sees.
- **Views are `developerOnly: true`.** They do not appear in production without an explicit developer-mode flag.
- The build has two distinct bundles: JS (tsup) and views (Vite, `vite.config.views.ts`). Run `build:js` and `build:views` separately when iterating.

<!-- BEGIN: evidence-and-e2e-mandate (managed; canonical standard = repo-root PR_EVIDENCE.md) -->
## ⛔ NON-NEGOTIABLE — evidence, trajectories & real end-to-end tests

> The binding, repo-wide standard is **[PR_EVIDENCE.md](../../PR_EVIDENCE.md)**. Read it.
> Nothing in this package is *done* until it is *proven* done — a reviewer must confirm it
> works **without reading the code**, from the artifacts you attach. This applies to **every**
> feature, fix, refactor, and chore here. "Tests pass" is not proof; "CI is green" is not proof.

- **Record AND read model trajectories.** Capture the *actual* inputs and outputs of the model
  from a **live** LLM — not the deterministic proxy, not a mock: the prompt, the
  providers/context, the raw model output, every tool/action call, and the result. Then **open
  the trajectory and review it by hand.** A captured-but-unread trajectory is not evidence
  (`packages/scenario-runner/bin/eliza-scenarios run <scenario> --report <out>`).
- **Real, full-featured E2E — no larp.** Every feature ships detailed end-to-end tests that
  drive the *real* path end to end. Not the happy "front door" only: cover error paths,
  edge/empty/invalid input, concurrency, roles/permissions, and adversarial input. A test that
  asserts against a mock/stub/fixture standing in for the thing under test **does not count**.
  If the real model/device/chain/connector/account is hard to reach, **make it reachable — that
  is the work**, not an excuse to mock. If the existing tests here are shallow or mocked, fixing
  them is part of your change.
- **Screenshots + logs at every phase**, plus a **complete walkthrough video/run-through** of
  the entire feature or view, start to finish (`bun run test:e2e:record`).
- **Manually review every artifact the change touches** — never just the green check: client
  logs (console + network), server logs (`[ClassName] …`), the model trajectories in and out,
  before/after full-page screenshots, **and the domain artifacts listed below for this package.**
- **No residuals. No shortcuts.** The goal is not "done" — it is *everything* done. Clear every
  blocker by the **hard path**: build the real architecture, stand up the real
  model/device/service, actually test it. Never leave a TODO, a stub, a stepping-stone, or a
  "follow-up." When unsure, research thoroughly, weigh the options, and ship the best,
  highest-effort, production-ready version. Keep going until every possibility is exhausted.

Artifacts → attached inline in the PR (MP4 video, JPG screenshots, logs in `<details>`); attach each evidence type **or**
explicitly mark it N/A with a reason — never leave it blank. If `develop` moved and changed
behavior, **re-capture** evidence; stale proof is worse than none.

**Capture & manually review for this package — agent behavior / app plugin:**
- A **live-LLM** scenario trajectory showing the behavior end to end and asserting the **outcome**, not just that routing/an action was selected (see #9970).
- The artifacts the behavior creates — memories, knowledge, scheduled-task rows, relationships, documents, outputs — inspected after the run.
- Backend `[ClassName]` logs of the action/service/runner firing, plus error/edge/permission paths.
- The empty-state and adversarial-input behavior, not just one happy scenario.
<!-- END: evidence-and-e2e-mandate -->
