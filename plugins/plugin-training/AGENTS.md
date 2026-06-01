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
    privacy-filter.ts           Anonymizer + PII/credential/geo stripping
    skill-scoring-cron.ts       Nightly skill eval cron
    dataset-generator.ts        Dataset generation utilities
    scenario-runner.ts          Scenario execution harness
    action-benchmark-runner.ts  Eliza-1 action benchmark runner
    eliza1-benchmark-recipe.ts  Tier/variant definitions for Eliza-1 benchmarks
    cli.ts                      Data collection CLI (run-collection, list-collections)
    context-catalog.ts          Context catalog builder
    context-audit.ts            Context audit
    replay-validator.ts         Skill scoring against trajectory replays
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
    training-trigger.ts         TrainingTriggerService + bootstrapOptimization
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

```bash
bun run --cwd plugins/plugin-training train             # Run native optimizer CLI
bun run --cwd plugins/plugin-training collect          # Run data collection (CLI)
bun run --cwd plugins/plugin-training test             # Run vitest suite
bun run --cwd plugins/plugin-training test:watch       # Vitest in watch mode
bun run --cwd plugins/plugin-training build            # Full build (JS + views + types)
bun run --cwd plugins/plugin-training build:js         # tsup JS bundle only
bun run --cwd plugins/plugin-training build:views      # Vite views bundle only
bun run --cwd plugins/plugin-training build:types      # TypeScript declarations
bun run --cwd plugins/plugin-training clean            # Remove dist/
```

## Config / env vars

| Var | Required | Purpose |
|---|---|---|
| `ELIZA_STATE_DIR` | no | State root override (default `~/.eliza`) |
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
| `ELIZA_INFERENCE_STATS_PATH` | no | Override inference stats JSONL path |
| `ELIZA_VAST_MAX_USD` | no | Budget cap for Vast.ai GPU jobs |
| `ANTHROPIC_API_KEY` | no | Required for Anthropic-backed optimizer runs |
| `OPENAI_API_KEY` | no | Required for OpenAI-backed optimizer runs |
| `CEREBRAS_API_KEY` | no | Required for Cerebras benchmark comparisons |
| `CEREBRAS_MODEL` | no | Model id for Cerebras benchmark |
| `LOCAL_LLAMA_CPP_API_KEY` | no | API key for local llama.cpp endpoint |

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
