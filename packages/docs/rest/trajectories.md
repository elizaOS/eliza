---
title: "Trajectories API"
sidebarTitle: "Trajectories"
description: "REST API endpoints for browsing, exporting, and managing agent trajectory logs — the detailed records of the agent's reasoning and LLM calls."
---

Trajectories are structured records of the agent's autonomous activity: each trajectory captures LLM calls, provider accesses, token usage, and timing for one agent reasoning session. They form the raw data for fine-tuning and performance analysis.

Trajectory data is provided by the native `trajectories` service. The agent must be running with trajectories enabled for these endpoints to function.

## Endpoints

### GET /api/trajectories

List and search trajectories with filters and pagination.

**Query Parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `limit` | integer | No | Results per page (min: 1, max: 500, default: 50) |
| `offset` | integer | No | Results to skip (default: 0) |
| `source` | string | No | Filter by source (e.g., `"chat"`, `"autonomy"`) |
| `status` | string | No | Filter by status: `"active"`, `"completed"`, `"error"`, or `"timeout"` |
| `startDate` | string | No | ISO 8601 start date filter |
| `endDate` | string | No | ISO 8601 end date filter |
| `search` | string | No | Text search across trajectory data |
| `scenarioId` | string | No | Filter by scenario ID |
| `batchId` | string | No | Filter by batch ID |
| `isTrainingData` | boolean | No | Filter to training-flagged trajectories only |

**Response**

```json
{
  "trajectories": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "agentId": "agent-uuid",
      "roomId": null,
      "entityId": null,
      "conversationId": null,
      "source": "autonomy",
      "status": "completed",
      "startTime": 1718000000000,
      "endTime": 1718000010000,
      "durationMs": 10000,
      "llmCallCount": 3,
      "providerAccessCount": 2,
      "totalPromptTokens": 1200,
      "totalCompletionTokens": 340,
      "metadata": {},
      "createdAt": "2024-06-10T12:00:00.000Z",
      "updatedAt": "2024-06-10T12:00:10.000Z"
    }
  ],
  "total": 142,
  "offset": 0,
  "limit": 50
}
```

---

### GET /api/trajectories/stats

Get aggregate trajectory statistics.

**Response**

```json
{
  "totalTrajectories": 142,
  "totalLlmCalls": 891,
  "totalProviderAccesses": 320,
  "totalPromptTokens": 450000,
  "totalCompletionTokens": 128000,
  "averageDurationMs": 8500,
  "bySource": {
    "chat": 98,
    "autonomy": 44
  },
  "byModel": {
    "claude-opus-4-7": 500,
    "claude-sonnet-4-5": 391
  }
}
```

---

### GET /api/trajectories/:id

Get full trajectory details including all LLM calls and provider accesses.

**Path Parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | Yes | Trajectory ID |

**Response**

```json
{
  "trajectory": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "agentId": "agent-uuid",
    "source": "autonomy",
    "status": "completed",
    "startTime": 1718000000000,
    "endTime": 1718000010000,
    "durationMs": 10000,
    "llmCallCount": 3,
    "providerAccessCount": 2,
    "totalPromptTokens": 1200,
    "totalCompletionTokens": 340,
    "metadata": {}
  },
  "llmCalls": [
    {
      "id": "call-001",
      "trajectoryId": "550e8400-e29b-41d4-a716-446655440000",
      "stepId": "step-0",
      "model": "claude-opus-4-7",
      "systemPrompt": "You are Eliza...",
      "userPrompt": "What should I post today?",
      "response": "Here are some ideas...",
      "temperature": 0.7,
      "maxTokens": 1024,
      "purpose": "action_selection",
      "actionType": "autonomy",
      "latencyMs": 1200,
      "promptTokens": 800,
      "completionTokens": 340,
      "timestamp": 1718000001000,
      "createdAt": "2024-06-10T12:00:01.000Z"
    }
  ],
  "providerAccesses": [
    {
      "id": "access-001",
      "trajectoryId": "550e8400-e29b-41d4-a716-446655440000",
      "stepId": "step-0",
      "providerName": "twitter",
      "purpose": "context_retrieval",
      "data": {},
      "timestamp": 1718000000500,
      "createdAt": "2024-06-10T12:00:00.500Z"
    }
  ]
}
```

---

### GET /api/trajectories/config

Get trajectory logging configuration.

**Response**

```json
{
  "enabled": true
}
```

---

### PUT /api/trajectories/config

Enable or disable trajectory logging.

**Request**

```json
{
  "enabled": false
}
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `enabled` | boolean | Yes | `true` to enable trajectory logging, `false` to disable |

**Response**

```json
{
  "enabled": false
}
```

---

### POST /api/trajectories/export

Export trajectories in various formats. Returns a file download.

**Request**

```json
{
  "format": "json",
  "includePrompts": true,
  "trajectoryIds": ["550e8400-e29b-41d4-a716-446655440000"],
  "startDate": "2024-06-01",
  "endDate": "2024-06-30"
}
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `format` | string | Yes | Export format: `"json"`, `"csv"`, `"art"`, or `"zip"` |
| `includePrompts` | boolean | No | Whether to include full prompt/response text (default: `false`) |
| `trajectoryIds` | string[] | No | Specific trajectory IDs to export. Exports all if omitted |
| `startDate` | string | No | ISO 8601 start date filter |
| `endDate` | string | No | ISO 8601 end date filter |
| `scenarioId` | string | No | Filter by scenario ID |
| `batchId` | string | No | Filter by batch ID |

**Response**

File download with appropriate `Content-Type` and `Content-Disposition` headers:

| Format | Content-Type |
|--------|-------------|
| `json` | `application/json` |
| `csv` | `text/csv` |
| `art` | `application/octet-stream` |
| `zip` | `application/zip` |

---

### DELETE /api/trajectories

Delete trajectories by ID or delete all trajectories.

**Request (delete specific)**

```json
{
  "trajectoryIds": ["550e8400-e29b-41d4-a716-446655440000"]
}
```

**Request (delete all)**

```json
{
  "all": true
}
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `trajectoryIds` | string[] | No | List of trajectory IDs to delete |
| `all` | boolean | No | Set to `true` to delete all trajectories |

**Response**

```json
{
  "deleted": 5
}
```
