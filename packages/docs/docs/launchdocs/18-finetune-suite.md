# Launch Readiness 18: Fine-Tune Suite

## Second-Pass Status (2026-05-05)

- Current: the public training API is still partly backed by in-memory stubs, and the native path is prompt optimization rather than model-weight fine-tuning.
- Still open: no verified pipeline exists from trajectory dataset to trained model artifact to registry publication, runtime activation, benchmark gate, and rollback; privacy filtering is too narrow for launch claims.
- Launch gate: `bun run --cwd plugins/app-training test` is useful package coverage, but live/cloud trainers and model publication remain unvalidated.

Worker: 18  
Date: 2026-05-04  
Scope reviewed: fine-tuning harness, trajectory collection, training/eval scripts, dataset flow, model publishing assumptions, launch-readiness.

## Current state

The repo has a real `@elizaos/app-training` package with three distinct surfaces:

1. A route/UI service layer that exposes `/api/training/*` endpoints but is mostly in-memory/stubbed for datasets, jobs, and models.
2. A newer auto-training orchestration path that can read completed trajectories, privacy-filter them, export per-task JSONL datasets, and dispatch to a backend.
3. Backend adapter for `native` prompt optimization (locally executable, prompt-only — not model weight fine-tuning).

Launch-readiness assessment: this is not launch-ready as a fine-tuned model suite. It is launchable only as an experimental data export and prompt-optimization harness. The repository does not currently demonstrate end-to-end fine-tuning, evaluation against held-out trajectories, model publishing, Ollama import, activation, rollback, or production-safe default behavior for tuned model use.

## Evidence

### Training service/API layer is a stub

- `plugins/app-training/src/services/training-service.ts:34` defines `TrainingService`, but it stores datasets/jobs/models only in process memory.
- `plugins/app-training/src/services/training-service.ts:65` returns an empty trajectory list unconditionally.
- `plugins/app-training/src/services/training-service.ts:77` returns `null` for every trajectory id.
- `plugins/app-training/src/services/training-service.ts:85` creates only a metadata-only `DatasetRecord`; it does not read trajectories or write dataset files.
- `plugins/app-training/src/services/training-service.ts:104` creates a queued job record only; there is no trainer invocation or job state progression.
- `plugins/app-training/src/services/training-service.ts:141`, `:150`, and `:159` have placeholder import/activate/benchmark methods that only operate on the empty in-memory `models` array.
- `plugins/app-training/src/routes/training-routes.ts:316` wires `/api/training/trajectories` through this service, so that route cannot currently return real trajectories.
- `plugins/app-training/src/routes/training-routes.ts:347` and `:373` expose dataset/job creation on top of the stub service.

### Real trajectory-backed path exists, but separately

- `plugins/app-training/src/core/training-orchestrator.ts:425` is the real orchestration entry point.
- It requires a runtime `trajectories` service at `plugins/app-training/src/core/training-orchestrator.ts:438`.
- It pulls up to 500 recent trajectories at `plugins/app-training/src/core/training-orchestrator.ts:470`.
- It applies `applyPrivacyFilter` before writing JSONL at `plugins/app-training/src/core/training-orchestrator.ts:478`.
- It exports datasets with `exportTrajectoryTaskDatasets` at `plugins/app-training/src/core/training-orchestrator.ts:488`.
- It selects a task based on threshold policy at `plugins/app-training/src/core/training-orchestrator.ts:495`.
- It records run JSON under `<state>/training/runs` at `plugins/app-training/src/core/training-orchestrator.ts:383`.
- `plugins/app-training/src/services/training-trigger.ts:338` increments per-task counters when a trajectory completes, and `:401` fires the orchestrator when thresholds/cooldowns allow it.
- Runtime registration exists in `plugins/app-training/src/register-runtime.ts:10`; it registers trajectory export cron, skill scoring cron, and the training trigger service.
- Trajectory storage attempts to notify the trigger service on completion in `packages/agent/src/runtime/trajectory-storage.ts:240`.

### Dataset export is implemented

- `plugins/app-training/src/core/trajectory-task-datasets.ts:15` defines five task buckets: `should_respond`, `context_routing`, `action_planner`, `response`, `media_description`.
- Task inference is heuristic, based on call purpose/tags/model/metadata and response shape at `plugins/app-training/src/core/trajectory-task-datasets.ts:209`.
- Examples are emitted as Gemini-style `{ messages: [...] }` rows at `plugins/app-training/src/core/trajectory-task-datasets.ts:266`.
- JSONL files and a summary are written at `plugins/app-training/src/core/trajectory-task-datasets.ts:355`.
- `/api/training/trajectories/export` can split by task using this exporter at `plugins/app-training/src/routes/training-routes.ts:790`, but that endpoint depends on the stub `TrainingService` trajectory methods and therefore exports zero real examples through the `/api/training/*` route today.

### Privacy controls exist but are narrow

- `plugins/app-training/src/core/privacy-filter.ts:1` documents credential, handle, privacy-level, and geo redaction.
- `plugins/app-training/src/core/privacy-filter.ts:241` clones trajectories and transforms only `steps[*].llmCalls[*].systemPrompt/userPrompt/response`.
- The filter intentionally preserves metadata, as tested in `plugins/app-training/test/privacy-filter.test.ts:113`.
- This is good for filtering/sorting, but risk remains if secrets, PII, file contents, screenshots OCR, tool outputs, or user data are stored outside those three string fields.

### Backend adapters are mostly integration placeholders

- `plugins/app-training/src/backends/native.ts:1` describes native as prompt optimization, not model fine-tuning. It parses JSONL rows and runs prompt optimizers.
- `plugins/app-training/src/backends/native.ts:172` creates an adapter over `runtime.useModel`, scores variants, and returns optimized prompt artifacts.
- `plugins/app-training/src/core/training-orchestrator.ts:230` dispatches native and persists optimized prompt artifacts only if `optimized_prompt` service is available.
- `plugins/app-training/src/core/training-orchestrator.ts:217` explicitly refuses Vertex dispatch from threshold/cron paths because project/bucket config is not available there.
- `plugins/app-training/src/core/vertex-tuning.ts:280` can upload local JSONL to GCS and create a Vertex tuning job, but this was not validated live.
- `plugins/app-training/src/core/vertex-tuning.ts:470` returns a model preference patch/recommended id but does not itself publish, activate, benchmark, or rollback the tuned model.

### CLI exists but is not a production trainer

- `plugins/app-training/src/cli/train.ts:36` exposes `--backend native`.
- Vertex waits for job completion at `plugins/app-training/src/cli/train.ts:177`, so it is a long-running/live cloud command.
- Native CLI uses a deterministic stub adapter at `plugins/app-training/src/cli/train.ts:211`; it is explicitly described as a smoke test path, not production LLM optimization.

## What I could validate

Command:

```sh
bun run --cwd plugins/app-training test
```

Result:

```text
$ vitest run
RUN  v4.1.5 /Users/shawwalters/eliza-workspace/milady/eliza/plugins/app-training
Test Files  8 passed (8)
Tests  66 passed (66)
Duration  21.53s
```

This validates the bounded unit suite for:

- CLI argument parsing.
- Native backend JSONL parsing and optimizer dispatch against fake adapters.
- Training config normalization/persistence.
- Trigger/orchestrator behavior with fake trajectory services.
- Privacy filter redaction and metadata preservation.
- Nightly trajectory export privacy guard with fake trajectories.
- Cron registration tests.

I also validated by inspection that `plugins/app-training/package.json` has only `train`, `test`, and `test:watch`; there is no package-level typecheck script.

## What I could not validate

- No live Vertex tuning job was run; that would require GCP credentials, GCS bucket access, network calls, and long polling.
- No long-running training, weight export, model upload, model registry publishing, Ollama import, activation, or rollback was performed.
- The live e2e test in `plugins/app-training/test/training-api.live.e2e.test.ts` is gated on `ELIZA_LIVE_TEST=1`; I did not run it.
- I did not run repo-wide typecheck/build because this workspace is large and the task requested bounded validation only.
- I did not validate the UI behavior in `plugins/app-training/src/ui/FineTuningView.tsx` against a live runtime.

## Bugs and risks

### P0

- No launch-ready fine-tuned model suite exists. The only locally runnable path is native prompt optimization, not model fine-tuning. External fine-tuning paths are placeholders or live cloud integrations with no verified launch artifact flow.
- The public-looking `/api/training/datasets`, `/api/training/jobs`, `/api/training/models`, and `/api/training/trajectories` route surface is materially misleading because `TrainingService` is in-memory and returns no real trajectories, models, or completed jobs.
- Model publishing assumptions are not implemented. There is no verified pipeline from trajectory dataset to trained model artifact to registry publication to runtime model preference activation to benchmark gate to rollback.

### P1

- `/api/training/trajectories/export` goes through `TrainingService.getTrajectoryById`, which currently always returns `null`; task split exports through this API will report no real examples unless a different service implementation is injected.
- Auto-training is enabled by default in config tests (`autoTrain: true`, `backends: ["native"]`). If runtime hooks are registered in production without operator intent, it may run LLM-driven prompt optimization from user trajectories. This is privacy/cost/product-risk sensitive even with filtering.
- Privacy filtering only transforms `systemPrompt`, `userPrompt`, and `response` strings. If trajectory records include raw tool inputs/outputs, observations, metadata, attachments, memory contents, screenshots, or file excerpts elsewhere, the export path can still write sensitive data.
- Dataset task classification is heuristic and can mis-bucket examples. For example, `runtime_use_model` and generic `action` hints can classify planner examples, while fallback response classification can absorb unknown call types.
- Native scoring uses LLM/prompt-output matching and fake adapters in tests; there is no held-out eval gate proving the optimized prompt improves real task behavior.
- Vertex model names map to preview ids in `vertex-tuning.ts`; these may be stale or unavailable and were not verified live.

### P2

- The route layer and orchestrator layer are not unified. Operators may use `/api/training/jobs` and think they launched training, while the real orchestration path is under `/api/training/auto/*` and trigger services.
- Native optimized prompts persist only if `optimized_prompt` service exists; otherwise a run can be marked succeeded/skipped with no usable artifact.
- `triggerTraining` pulls recent trajectories by count only; there is no split management, dedupe, holdout set, quality label, consent filter, or contamination guard.
- Run status treats `dispatchResult.invoked` as `succeeded`; it does not distinguish submitted, running, completed, failed, or evaluated for async backends.

### P3

- Dataset summaries include useful counts but no hashes, schema versions, consent profile, source time window, or model/backend config snapshot.
- CLI help and comments overstate "training" for native path; it should be labeled prompt optimization to avoid operator confusion.
- Tests cover faked happy paths more than realistic runtime/service wiring.
- No docs were found explaining operational prerequisites, expected costs, credential setup, or launch rollback procedure.

## Codex-fixable work

- Replace the stub `TrainingService` trajectory/dataset/job/model methods with adapters to the real trajectory service and orchestrator, or clearly hide/disable those routes until backed.
- Make `/api/training/trajectories/export` use the native trajectory service directly, like `/api/trajectories`, and apply the privacy filter before every disk write.
- Add schema/version/hash metadata to exported datasets and run records.
- Add unit tests for task inference edge cases, empty task buckets, duplicated LLM calls, malformed JSONL, and private/limited consent behavior.
- Add a strict dry-run endpoint that reports exact dataset counts, output paths, backend, and why training would or would not start.
- Rename native UI/CLI language from "fine-tune" to "prompt optimization" where appropriate.
- Add a package-level typecheck script or document the intended monorepo command for `app-training`.

## Human work needed

- Decide whether launch requires actual tuned model weights or whether prompt optimization is acceptable for v1.
- Select target base models per task and confirm provider support, cost, limits, data retention, and terms.
- Provision GCP/Vertex credentials and run a small supervised tuning job on a non-sensitive, approved dataset.
- Define dataset consent policy and retention rules for user trajectories, including whether metadata/tool observations may be exported.
- Define model registry/publishing target, naming/versioning, owner scope, rollback, and activation approval workflow.
- Approve quality gates: minimum held-out eval score, regression thresholds, safety/privacy checks, and manual review requirements.
- Decide default `autoTrain` behavior for launch; default-on is risky without explicit user/operator consent and clear spend controls.

## Recommended tests/evals

- Unit: task extraction classification for all five task buckets with realistic trajectory fixtures.
- Unit: privacy filter over full trajectory shape, including tool observations, metadata, attachments, memory snippets, and nested arbitrary strings.
- Integration: `/api/training/trajectories/export` with a real runtime `trajectories` service and at least one completed trajectory.
- Integration: `triggerTraining` with real `DatabaseTrajectoryLogger`, `OptimizedPromptService`, and native backend in dry-run and fake-adapter modes.
- Contract: Atropos CLI invocation arguments and result ingestion with a fake executable.
- Live gated: Vertex create/list/status/orchestrate against a tiny approved JSONL dataset.
- Eval: held-out trajectory replay using `plugins/app-training/src/core/replay-validator.ts`, comparing baseline vs optimized/tuned model.
- Eval: regression suite for `should_respond`, `action_planner`, `response`, `context_routing`, and `media_description`.
- Safety: privacy leak scan of every generated JSONL and run artifact before upload/publish.
- Operational: activation/rollback drill that applies a model preference patch, verifies runtime use, then reverts.

## Changed paths

- `launchdocs/18-finetune-suite.md`

No code files were modified.
