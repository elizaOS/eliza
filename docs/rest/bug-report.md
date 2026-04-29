---
title: Bug Report API
sidebarTitle: Bug Report
description: REST API endpoints for submitting bug reports from the dashboard.
---

## Get Environment Info

```
GET /api/bug-report/info
```

Returns the server's Node.js version, OS platform, and active submission mode, used by the frontend to pre-fill environment fields and decide whether reports go to a remote intake, GitHub, or the fallback URL.

**Response:**
```json
{
  "nodeVersion": "v20.11.0",
  "platform": "linux",
  "submissionMode": "remote"
}
```

## Submit Bug Report

```
POST /api/bug-report
```

Submits a bug report.

Submission priority:
1. If `MILADY_BUG_REPORT_API_URL` is set, forwards the report there as structured JSON.
2. Else if `GITHUB_TOKEN` is set, creates a GitHub issue on the project repository with labels `bug`, `triage`, `user-reported`.
3. Else returns a pre-filled GitHub issue URL as a fallback.

Rate-limited to **5 submissions per IP per 10-minute window**.

**Request body:**

| Field | Type | Required | Max Length |
|-------|------|----------|-----------|
| `description` | string | yes | 80 chars (used as issue title) |
| `stepsToReproduce` | string | yes | — |
| `expectedBehavior` | string | no | — |
| `actualBehavior` | string | no | — |
| `environment` | string | no | 200 chars |
| `nodeVersion` | string | no | 200 chars |
| `modelProvider` | string | no | 200 chars |
| `logs` | string | no | 50,000 chars |
| `category` | `"general"` or `"startup-failure"` | no | - |
| `appVersion` | string | no | 200 chars |
| `releaseChannel` | string | no | 200 chars |
| `startup` | object | no | structured startup diagnostics |

Logs and startup diagnostics are HTML-stripped and basic secret-like tokens are redacted before forwarding.

**Remote intake body example**
```json
{
  "source": "milady-desktop",
  "submittedAt": "2026-03-26T23:30:00.000Z",
  "category": "startup-failure",
  "description": "Milady startup failed: Backend Unreachable",
  "stepsToReproduce": "1. Launch Milady\n2. Wait for startup to complete\n3. Observe the startup failure screen",
  "environment": "Windows",
  "nodeVersion": "v22.14.0",
  "logs": "reason=backend-unreachable\nphase=starting-backend\nstatus=404",
  "startup": {
    "reason": "backend-unreachable",
    "phase": "starting-backend",
    "message": "Backend unavailable",
    "detail": "GET /api/status returned 404",
    "status": 404,
    "path": "/api/status"
  }
}
```

**Remote intake response example**
```json
{
  "accepted": true,
  "id": "rpt_123",
  "url": "https://cloud.example/reports/rpt_123"
}
```

**Response — with GitHub token:**
```json
{ "url": "https://github.com/milady-ai/milady/issues/42" }
```

**Response — with remote intake:**
```json
{ "accepted": true, "id": "rpt_123", "destination": "remote" }
```

**Response — without GitHub token:**
```json
{ "fallback": "https://github.com/milady-ai/milady/issues/new?template=bug_report.yml" }
```

**Errors:** `400` missing required fields; `429` rate limit exceeded; `502` GitHub API error.

## Environment Variables

- `MILADY_BUG_REPORT_API_URL`
  Preferred structured report intake endpoint. Intended for services like Eliza Cloud.
- `MILADY_BUG_REPORT_API_TOKEN`
  Optional bearer token sent to the remote intake endpoint.
- `ELIZA_CLOUD_BUG_REPORT_URL`
  Alias for `MILADY_BUG_REPORT_API_URL`
- `ELIZA_CLOUD_BUG_REPORT_TOKEN`
  Alias for `MILADY_BUG_REPORT_API_TOKEN`
