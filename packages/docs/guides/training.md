---
title: "Training & Fine-Tuning"
sidebarTitle: "Training & Fine-Tuning"
description: "Trajectory collection, dataset curation, fine-tuning workflows, and Ollama model import for agent self-improvement."
---

Eliza captures all LLM interactions as trajectories, which can be curated into training datasets and used to fine-tune local models. The training pipeline supports dataset building, training job management, model import to Ollama, and model activation.

## Table of Contents

1. [Trajectory Collection](#trajectory-collection)
2. [Trajectory Viewer](#trajectory-viewer)
3. [Training Datasets](#training-datasets)
4. [Fine-Tuning Workflow](#fine-tuning-workflow)
5. [Dashboard Integration](#dashboard-integration)
6. [API Endpoints](#api-endpoints)

---

<Info>
**API port note:** In development mode (`bun run dev`), the API runs on port **31337**. In production mode (`eliza start`), the API runs on port **2138**. Curl examples below use `localhost:2138` (production). Adjust the port for dev mode.
</Info>

<Info>
**Environment controls:** Set `ELIZA_DISABLE_TRAJECTORY_LOGGING=1` or `NODE_ENV=test` to disable trajectory persistence. Auto-training thresholds (default: 100 trajectories, 12h cooldown) can be configured via `/api/training/auto/config` or Settings → Auto-Training.
</Info>

## Trajectory Collection

Every LLM call made by the agent is automatically logged as part of a trajectory. The trajectory logger service (`trajectories`) records:

### Trajectory Record

Each trajectory captures a complete agent interaction session:

```typescript
interface TrajectoryListItem {
  id: string;
  agentId: string;
  source: string;          // "chat", "autonomy", "telegram", "discord", "api"
  status: TrajectoryStatus; // "active", "completed", "error", "timeout"
  startTime: number;
  endTime: number | null;
  durationMs: number | null;
  llmCallCount: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  createdAt: string;
}
```

### LLM Call Records

Individual LLM calls within a trajectory include:

- Model name
- System prompt and user prompt
- Response text
- Temperature and max tokens
- Purpose and action type
- Latency in milliseconds
- Prompt and completion token counts

### Provider Access Records

Provider accesses (memory lookups, knowledge base queries, etc.) are also tracked:

- Provider name and ID
- Purpose description
- Data payload and query parameters
- Timestamp

### Logging Control

Trajectory logging can be toggled at runtime:

- `GET /api/trajectories/config` -- check if logging is enabled
- `PUT /api/trajectories/config` with `{ "enabled": true/false }` -- enable or disable

---

## Trajectory Viewer

The trajectory viewer provides filtering, search, export, and deletion capabilities.

### Listing and Filtering

Trajectories can be filtered by:

| Filter | Description |
|--------|-------------|
| `source` | Origin platform (chat, autonomy, telegram, discord, api) |
| `status` | active, completed, error, timeout |
| `startDate` / `endDate` | Time range |
| `search` | Full-text search |
| `scenarioId` | Evaluation scenario |
| `batchId` | Evaluation batch |
| `isTrainingData` | Filter to training-flagged trajectories |

Pagination is supported via `limit` (max 500, default 50) and `offset` parameters.

### Trajectory Detail

Viewing a single trajectory returns the full record with all LLM calls and provider accesses, organized by step. Each step may contain multiple LLM calls and provider accesses with their timestamps.

### Export Formats

Trajectories can be exported in multiple formats:

| Format | Description |
|--------|-------------|
| `json` | Full trajectory data as JSON |
| `csv` | Tabular format for spreadsheet analysis |
| `art` | Agent Replay Transcript format |
| `zip` | ZIP archive containing multiple trajectory files |

Export options include filtering by trajectory IDs, date range, scenario/batch IDs, and whether to include full prompts.

### Statistics

`GET /api/trajectories/stats` returns aggregate statistics about all recorded trajectories.

### Deletion

Trajectories can be deleted selectively by ID array or in bulk (`all: true`).

---

## Training Datasets

Training datasets are curated collections of trajectories prepared for fine-tuning.

### Building a Dataset

The `POST /api/training/datasets/build` endpoint creates a dataset from collected trajectories:

```json
{
  "limit": 1000,
  "minLlmCallsPerTrajectory": 2
}
```

- `limit` -- maximum number of trajectories to include
- `minLlmCallsPerTrajectory` -- filter out trajectories with too few LLM interactions

### Listing Datasets

`GET /api/training/datasets` returns all previously built datasets.

---

## Native Prompt Optimization (Default Backend)

The default training backend is `native`, which runs prompt optimization techniques locally against collected trajectory data. Unlike fine-tuning (which modifies model weights), native optimization produces optimized prompt artifacts that improve the agent's behavior without requiring a new model.

### How It Works

The native backend dispatches per-task JSONL datasets through one of three optimizers:

| Optimizer | Description |
|-----------|-------------|
| `instruction-search` | Searches for improved system instructions using trajectory examples |
| `prompt-evolution` | Evolutionary prompt optimization (GEPA-style) |
| `bootstrap-fewshot` | Selects high-quality few-shot examples from trajectories |

Optimized prompts are written to `~/.eliza/optimized-prompts/<task>/`. The `OptimizedPromptService` automatically loads these artifacts at boot, so improvements take effect on restart without manual configuration.

### Auto-Training

Eliza can trigger native optimization automatically when enough trajectory data accumulates:

- **Default threshold:** 100 trajectories per task
- **Cooldown:** 12 hours between auto-training runs
- **Configuration:** Adjust via `POST /api/training/auto/config` or Settings > Auto-Training in the dashboard

Auto-training runs the native backend by default. It only fires when the trajectory count exceeds the threshold and no recent artifact exists for that task.

To disable auto-training at startup, set `ELIZA_DISABLE_AUTO_BOOTSTRAP=1`.

### Running Native Optimization Manually

```bash
bun run train -- --backend native --optimizer instruction-search \
  --dataset <path> --task <task>
```

### Privacy Filter

All training pipelines (both auto-training and on-demand) run a mandatory privacy filter (`privacy-filter.ts`) before writing JSONL datasets. This strips personally identifiable information from trajectory data before it is used for optimization.

---

## Fine-Tuning Workflow (Model Weight Training)

### Starting a Training Job

The `POST /api/training/jobs` endpoint launches a fine-tuning job:

```json
{
  "datasetId": "dataset-abc123",
  "maxTrajectories": 500,
  "backend": "mlx",
  "model": "eliza-1-2b",
  "iterations": 100,
  "batchSize": 4,
  "learningRate": 0.0001
}
```

| Parameter | Description |
|-----------|-------------|
| `datasetId` | ID of a previously built dataset |
| `maxTrajectories` | Cap on trajectories to use |
| `backend` | Training backend: `native` (default — MIPRO/GEPA prompt optimization), `mlx` (Apple Silicon), `cuda` (NVIDIA GPU), or `cpu` |
| `model` | Base model to fine-tune |
| `iterations` | Number of training iterations |
| `batchSize` | Training batch size |
| `learningRate` | Learning rate |

### Job Lifecycle

Training jobs emit stream events as they progress:

| Event Kind | Description |
|------------|-------------|
| `job_started` | Training job has begun |
| `job_progress` | Progress update with completion percentage |
| `job_log` | Training log output |
| `job_completed` | Training finished successfully |
| `job_failed` | Training encountered an error |
| `job_cancelled` | Training was cancelled by user |
| `dataset_built` | A new dataset was created |
| `model_activated` | A model was activated for agent use |
| `model_imported` | A model was imported to Ollama |

### Cancelling a Job

`POST /api/training/jobs/:id/cancel` cancels a running training job.

### Importing to Ollama

After training completes, the resulting model can be imported to Ollama for local inference:

`POST /api/training/models/:id/import-ollama`

```json
{
  "modelName": "my-fine-tuned-model",
  "baseModel": "eliza-1-2b",
  "ollamaUrl": "http://localhost:11434"
}
```

The `ollamaUrl` must target a loopback host (localhost, 127.0.0.1, or ::1) for security.

### Activating a Model

`POST /api/training/models/:id/activate` switches the agent to use a fine-tuned model:

```json
{
  "providerModel": "ollama/my-fine-tuned-model"
}
```

### Benchmarking

`POST /api/training/models/:id/benchmark` runs evaluation benchmarks against a trained model.

---

## Dashboard Integration

The Eliza dashboard provides two dedicated tabs for training:

### Fine-Tuning Tab (`FineTuningView`)

The Fine-Tuning view provides a complete UI for:

- Viewing training status and available trajectories
- Building datasets with configurable parameters
- Starting training jobs with backend/model selection
- Monitoring job progress in real-time via SSE stream events
- Importing completed models to Ollama
- Activating models for agent use

### Trajectories Tab (`TrajectoriesView`)

The Trajectories view displays:

- All captured LLM interactions with token counts and latency
- Status indicators (active, completed, error) with color coding
- Source badges (chat, autonomy, telegram, discord, api) with distinct colors
- Filtering by status and source
- Full-text search across trajectories
- Pagination (50 per page)
- Export to JSON/CSV/ZIP
- Bulk clearing of trajectory data

---

## Native Optimization (Default Backend)

The default training backend is `native`, which runs MIPRO / GEPA / bootstrap-fewshot optimization against collected trajectory data. Unlike the `mlx`/`cuda`/`cpu` backends that fine-tune model weights, native optimization produces optimized prompt artifacts stored under `~/.eliza/optimized-prompts/<task>/`. The `OptimizedPromptService` loads these automatically at boot.

### Auto-Training

When enough trajectories accumulate, the runtime can trigger native optimization automatically:

- **Threshold:** 100 trajectories per task (default)
- **Cooldown:** 12 hours between auto-training runs
- **Configuration:** `GET /api/training/auto/config` and `PUT /api/training/auto/config`, or Settings > Auto-Training in the dashboard
- **Disable at boot:** set `ELIZA_DISABLE_AUTO_BOOTSTRAP=1`

### Privacy Filter

All write paths that touch real user trajectories run through the privacy filter (`eliza/plugins/app-training/src/core/privacy-filter.ts`) before any JSONL is written. This applies to both the nightly export cron and on-demand training.

---

## API Endpoints

### Trajectory Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/trajectories` | List trajectories with filtering and pagination |
| `GET` | `/api/trajectories/:id` | Get full trajectory detail with LLM calls and provider accesses |
| `GET` | `/api/trajectories/stats` | Get aggregate trajectory statistics |
| `GET` | `/api/trajectories/config` | Check if trajectory logging is enabled |
| `PUT` | `/api/trajectories/config` | Enable or disable trajectory logging |
| `POST` | `/api/trajectories/export` | Export trajectories (json, csv, art, or zip) |
| `DELETE` | `/api/trajectories` | Delete trajectories by ID array or clear all |

### Training Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/training/status` | Get training service status |
| `GET` | `/api/training/trajectories` | List trajectories via training service (with limit/offset) |
| `GET` | `/api/training/trajectories/:id` | Get trajectory detail via training service |
| `GET` | `/api/training/datasets` | List all training datasets |
| `POST` | `/api/training/datasets/build` | Build a new dataset from trajectories |
| `GET` | `/api/training/jobs` | List all training jobs |
| `POST` | `/api/training/jobs` | Start a new training job |
| `GET` | `/api/training/jobs/:id` | Get training job details |
| `POST` | `/api/training/jobs/:id/cancel` | Cancel a running training job |
| `GET` | `/api/training/models` | List all trained models |
| `POST` | `/api/training/models/:id/import-ollama` | Import model to Ollama |
| `POST` | `/api/training/models/:id/activate` | Activate model for agent use |
| `POST` | `/api/training/models/:id/benchmark` | Run benchmarks against a model |

### Auto-Training

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/training/auto/config` | Get auto-training configuration |
| `PUT` | `/api/training/auto/config` | Update auto-training configuration |

---

## Native Optimization (Default Backend)

The default training backend is `native`. Native optimization uses techniques like MIPRO, GEPA, and bootstrap-fewshot to optimize prompts directly from trajectory data without fine-tuning a model. Outputs land as prompt artifacts under `~/.eliza/optimized-prompts/<task>/`. The `OptimizedPromptService` auto-loads those artifacts at boot.

To use native optimization:

```bash
curl -X POST http://localhost:31337/api/training/jobs \
  -H "Authorization: Bearer your-token" \
  -H "Content-Type: application/json" \
  -d '{
    "datasetId": "dataset-abc123",
    "backend": "native"
  }'
```

### Auto-Training Thresholds

Auto-training triggers automatically when trajectory counters exceed configured thresholds. The defaults are:

- **Threshold**: 100 trajectories accumulated per task
- **Cooldown**: 12 hours between auto-training runs

Configure these via the Settings dashboard (Auto-Training section) or the API:

```bash
curl -X PUT http://localhost:31337/api/training/auto/config \
  -H "Authorization: Bearer your-token" \
  -H "Content-Type: application/json" \
  -d '{
    "threshold": 100,
    "cooldownHours": 12
  }'
```

The auto-bootstrap runs at runtime boot when trajectory counters exceed the threshold and no artifact exists for the task. Disable it by setting `ELIZA_DISABLE_AUTO_BOOTSTRAP=1`.

### Privacy Filter

A privacy filter (`eliza/plugins/app-training/src/core/privacy-filter.ts`) is mandatory on every write path that touches real user trajectories. Both the nightly export cron and the on-demand training orchestrator run it before any JSONL is written, ensuring that sensitive user data is stripped from training datasets.

---

## End-to-End Tutorial

Walk through the complete training workflow using curl commands.

### Step 1: Check Training Status

```bash
curl http://localhost:31337/api/training/status \
  -H "Authorization: Bearer your-token"
```

Response:
```json
{
  "runtimeAvailable": true,
  "trajectoryCount": 150,
  "jobCount": 0
}
```

### Step 2: Browse Collected Trajectories

Trajectories are automatically collected as your agent processes messages. Each trajectory records LLM calls, provider accesses, and token usage.

```bash
curl "http://localhost:31337/api/training/trajectories?limit=10&offset=0" \
  -H "Authorization: Bearer your-token"
```

### Step 3: Build a Training Dataset

Filter trajectories into a dataset suitable for fine-tuning:

```bash
curl -X POST http://localhost:31337/api/training/datasets/build \
  -H "Authorization: Bearer your-token" \
  -H "Content-Type: application/json" \
  -d '{
    "limit": 500,
    "minLlmCallsPerTrajectory": 2
  }'
```

Response:
```json
{
  "dataset": {
    "id": "dataset-abc123",
    "trajectoryCount": 342,
    "createdAt": "2026-02-19T10:00:00.000Z"
  }
}
```

### Step 4: Start a Training Job

```bash
curl -X POST http://localhost:31337/api/training/jobs \
  -H "Authorization: Bearer your-token" \
  -H "Content-Type: application/json" \
  -d '{
    "datasetId": "dataset-abc123",
    "backend": "mlx",
    "model": "eliza-1-2b",
    "iterations": 100,
    "batchSize": 4,
    "learningRate": 0.0001
  }'
```

Supported backends: `native` (default, prompt optimization), `mlx` (Apple Silicon fine-tuning), `cuda` (NVIDIA GPU fine-tuning), `cpu` (CPU fine-tuning).

### Step 5: Monitor Progress

```bash
curl http://localhost:31337/api/training/jobs/job-xyz789 \
  -H "Authorization: Bearer your-token"
```

Job statuses: `pending` -> `running` -> `completed` (or `failed` / `cancelled`).

### Step 6: Import to Ollama

After training completes, import the fine-tuned model into Ollama for local inference:

```bash
curl -X POST http://localhost:31337/api/training/models/model-abc123/import-ollama \
  -H "Authorization: Bearer your-token" \
  -H "Content-Type: application/json" \
  -d '{
    "modelName": "my-fine-tuned-agent",
    "baseModel": "eliza-1-2b",
    "ollamaUrl": "http://localhost:11434"
  }'
```

The `ollamaUrl` must point to a local Ollama server (localhost, 127.0.0.1, or ::1 only).

### Step 7: Activate the Model

Switch your agent to use the fine-tuned model:

```bash
curl -X POST http://localhost:31337/api/training/models/model-abc123/activate \
  -H "Authorization: Bearer your-token" \
  -H "Content-Type: application/json" \
  -d '{"providerModel": "ollama/my-fine-tuned-agent"}'
```

This updates the agent's model configuration to use your fine-tuned model for inference.
