---
title: "Bug Report API"
sidebarTitle: "Bug Report"
description: "REST API endpoints for submitting bug reports from the desktop and web clients."
---

The bug report API accepts structured bug reports from the Eliza UI's Help menu and routes them into the project's issue tracker. Submissions are rate-limited per source IP to prevent abuse.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET    | `/api/bug-report/info`  | Returns environment metadata + rate-limit state used to prefill the form. |
| POST   | `/api/bug-report`       | Submits a bug report. Rate-limited: 5 submissions per 10 minute window per IP. |

---

## GET `/api/bug-report/info`

Returns metadata the client can use to prefill the bug report form (node version, app version, release channel) and the current rate-limit window.

## POST `/api/bug-report`

Submits a bug report with the following body shape:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `description` | string | yes | What went wrong. |
| `stepsToReproduce` | string | yes | How to trigger the issue. |
| `expectedBehavior` | string | no | What the user expected to happen. |
| `actualBehavior` | string | no | What actually happened. |
| `environment` | string | no | OS / runtime info. |
| `nodeVersion` | string | no | Node version reported by the client. |
| `modelProvider` | string | no | Which provider was in use (OpenAI, Anthropic, local, …). |
| `logs` | string | no | Recent log tail. |
| `category` | `"general"` \| `"startup-failure"` | no | Triage hint. |
| `appVersion` | string | no | App version string. |
| `releaseChannel` | string | no | `stable` / `beta` / `nightly`. |
| `startup` | object | no | Startup-failure context (reason, fail-fast diagnostics). |

### Rate limiting

Bug reports are rate-limited to **5 submissions per 10 minute window** per source IP. When the limit is hit, the endpoint returns 429.

### Triggered by

The Eliza UI shows a `Report a bug` entry in the Help menu in the header. The startup-failure UI also opens this form pre-filled with a `startup-failure` category and crash context.
