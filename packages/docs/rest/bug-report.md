---
title: "Bug Report API"
sidebarTitle: "Bug Reports"
description: "REST API endpoints for bug report metadata and submission."
---

The bug report API powers the in-app report flow. It returns local diagnostic metadata, accepts sanitized report payloads, and submits them through the configured intake path.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/bug-report/info` | Get local bug report metadata and submission mode |
| POST | `/api/bug-report` | Submit a bug report |

---

### GET /api/bug-report/info

Returns metadata used to prefill the bug report form.

**Response**

```json
{
  "nodeVersion": "v24.15.0",
  "platform": "darwin",
  "submissionMode": "remote"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `nodeVersion` | string | Node.js version running the API server |
| `platform` | string | Operating system platform from `os.platform()` |
| `submissionMode` | string | `remote`, `github`, or `fallback` |

---

### POST /api/bug-report

Submits a bug report. Reports are rate-limited per remote address. `description` and `stepsToReproduce` are required.

**Request Body**

```json
{
  "description": "Chat fails after switching providers",
  "stepsToReproduce": "1. Open Settings\n2. Switch provider\n3. Send a chat message",
  "expectedBehavior": "The chat response should complete",
  "actualBehavior": "The request fails",
  "environment": "desktop",
  "nodeVersion": "v24.15.0",
  "modelProvider": "Eliza Cloud",
  "logs": "Relevant redacted logs",
  "category": "general"
}
```

**Response**

When remote intake is configured:

```json
{
  "accepted": true,
  "id": "bug_123",
  "url": "https://example.com/bugs/bug_123",
  "destination": "remote"
}
```

When GitHub issue creation is configured:

```json
{
  "url": "https://github.com/elizaos/eliza/issues/123"
}
```

When no submit backend is configured:

```json
{
  "fallback": "https://github.com/elizaos/eliza/issues/new?template=bug_report.yml"
}
```

**Errors**

| Status | Description |
|--------|-------------|
| 400 | Missing `description` or `stepsToReproduce` |
| 429 | Too many bug report submissions from the same remote address |
| 502 | Remote intake or GitHub API submission failed |
