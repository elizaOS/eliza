---
title: "Training API"
sidebarTitle: "Training"
description: "REST API endpoints for fine-tuning the agent's model using trajectory data."
---

The training API enables fine-tuning workflows: browse collected trajectories, build datasets, launch training jobs, and manage fine-tuned models. The training service must be available and the agent runtime initialized for most operations.

## Endpoints

### GET /api/training/status

Get the training service status.

**Response**

```json
{
  "runningJobs": 0,
  "queuedJobs": 0,
  "completedJobs": 0,
  "failedJobs": 0,
  "modelCount": 0,
  "datasetCount": 0,
  "runtimeAvailable": true
}
```

---

### GET /api/training/trajectories

List trajectories available for training with pagination.

**Query Parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `limit` | integer | No | Number of results to return (default: 100) |
| `offset` | integer | No | Number of results to skip (default: 0) |

**Response**

```json
{
  "available": true,
  "total": 142,
  "trajectories": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "source": "chat",
      "status": "completed",
      "llmCallCount": 5,
      "startTime": 1718000000000,
      "endTime": 1718000010000
    }
  ]
}
```

---

### GET /api/training/trajectories/:id

Get detailed trajectory data for a specific trajectory, including LLM calls and provider accesses.

**Path Parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | Yes | Trajectory ID |

**Response**

```json
{
  "trajectory": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "llmCalls": [],
    "providerAccesses": []
  }
}
```

---

### GET /api/training/datasets

List all built training datasets.

**Response**

```json
{
  "datasets": [
    {
      "id": "dataset-2024-06-10",
      "createdAt": 1718000000000,
      "trajectoryCount": 50,
      "exampleCount": 250
    }
  ]
}
```

---

### POST /api/training/datasets/build

Build a new training dataset from available trajectories.

**Request**

```json
{
  "limit": 100,
  "minLlmCallsPerTrajectory": 2
}
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `limit` | integer | No | Maximum number of trajectories to include |
| `minLlmCallsPerTrajectory` | integer | No | Minimum LLM calls a trajectory must have to be included |

**Response (201 Created)**

```json
{
  "dataset": {
    "id": "dataset-2024-06-10",
    "createdAt": 1718000000000,
    "trajectoryCount": 87,
    "exampleCount": 435
  }
}
```

---

### GET /api/training/jobs

List all training jobs.

**Response**

```json
{
  "jobs": [
    {
      "id": "job-001",
      "status": "completed",
      "datasetId": "dataset-2024-06-10",
      "backend": "mlx",
      "model": "eliza-1-2b",
      "createdAt": 1718000000000,
      "completedAt": 1718003600000
    }
  ]
}
```

---

### POST /api/training/jobs

Start a new training job.

**Request**

```json
{
  "datasetId": "dataset-2024-06-10",
  "backend": "mlx",
  "model": "eliza-1-2b",
  "iterations": 100,
  "batchSize": 4,
  "learningRate": 1e-5
}
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `datasetId` | string | No | Dataset ID to train on (uses latest if omitted) |
| `maxTrajectories` | integer | No | Cap on trajectories to use |
| `backend` | string | No | Training backend: `"native"` (default, prompt optimization via MIPRO/GEPA), `"mlx"`, `"cuda"`, or `"cpu"` |
| `model` | string | No | Base model to fine-tune |
| `iterations` | integer | No | Number of training iterations |
| `batchSize` | integer | No | Batch size |
| `learningRate` | float | No | Learning rate |

**Response (201 Created)**

```json
{
  "job": {
    "id": "job-002",
    "status": "running",
    "datasetId": "dataset-2024-06-10",
    "backend": "mlx",
    "createdAt": 1718005000000
  }
}
```

---

### GET /api/training/jobs/:id

Get the status of a specific training job.

**Path Parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | Yes | Training job ID |

**Response**

```json
{
  "job": {
    "id": "job-002",
    "status": "running",
    "progress": 0.45,
    "currentIteration": 45,
    "totalIterations": 100,
    "loss": 0.234
  }
}
```

---

### POST /api/training/jobs/:id/cancel

Cancel a running training job.

**Path Parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | Yes | Training job ID |

**Response**

```json
{
  "job": {
    "id": "job-002",
    "status": "cancelled"
  }
}
```

---

### GET /api/training/models

List all fine-tuned models.

**Response**

```json
{
  "models": [
    {
      "id": "model-001",
      "jobId": "job-001",
      "name": "eliza-1-2b-v1",
      "createdAt": 1718003600000,
      "active": false
    }
  ]
}
```

---

### POST /api/training/models/:id/import-ollama

Import a fine-tuned model into Ollama for local inference.

**Path Parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | Yes | Model ID |

**Request**

```json
{
  "modelName": "eliza-v1",
  "baseModel": "eliza-1-2b",
  "ollamaUrl": "http://localhost:11434"
}
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `modelName` | string | No | Name to register in Ollama |
| `baseModel` | string | No | Base model identifier in Ollama |
| `ollamaUrl` | string | No | Ollama URL — must be a loopback host (localhost, 127.0.0.1, or ::1) |

**Response**

```json
{
  "model": {
    "id": "model-001",
    "ollamaName": "eliza-v1",
    "importedAt": 1718005000000
  }
}
```

---

### POST /api/training/models/:id/activate

Activate a fine-tuned model so the agent uses it for inference.

**Path Parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | Yes | Model ID |

**Request**

```json
{
  "providerModel": "eliza-v1"
}
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `providerModel` | string | No | Provider-specific model identifier (e.g., Ollama model name) |

**Response**

```json
{
  "ok": true,
  "activeModel": "eliza-v1"
}
```

---

### POST /api/training/models/:id/benchmark

Run a benchmark against a fine-tuned model to evaluate performance.

**Path Parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | Yes | Model ID |

**Response**

```json
{
  "modelId": "model-001",
  "scores": {
    "coherence": 0.87,
    "consistency": 0.91,
    "helpfulness": 0.84
  },
  "completedAt": 1718006000000
}
```

---

### GET /api/training/auto/config

Get the auto-training configuration (thresholds, cooldown).

**Response**

```json
{
  "threshold": 100,
  "cooldownHours": 12,
  "enabled": true
}
```

---

### PUT /api/training/auto/config

Update the auto-training configuration.

**Request**

```json
{
  "threshold": 200,
  "cooldownHours": 24
}
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `threshold` | integer | No | Number of trajectories per task before auto-training triggers |
| `cooldownHours` | number | No | Minimum hours between auto-training runs |
| `enabled` | boolean | No | Enable or disable auto-training |

**Response**

```json
{
  "ok": true,
  "config": {
    "threshold": 200,
    "cooldownHours": 24,
    "enabled": true
  }
}
```

---

## Common Error Codes

| Status | Code | Description |
|--------|------|-------------|
| 400 | `INVALID_REQUEST` | Request body is malformed or missing required fields |
| 401 | `UNAUTHORIZED` | Missing or invalid authentication token |
| 404 | `NOT_FOUND` | Requested resource does not exist |
| 500 | `TRAINING_FAILED` | Training job failed to start or complete |
| 503 | `SERVICE_UNAVAILABLE` | Training service is not available |
| 500 | `INTERNAL_ERROR` | Unexpected server error |
