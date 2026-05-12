---
title: "Diagnostics API"
sidebarTitle: "Diagnostics"
description: "REST API endpoints for log retrieval, agent events, security audit log, and browser extension status."
---

The diagnostics API provides access to runtime logs, the agent event stream, the security audit log, and browser extension relay status. The security audit endpoint supports both one-shot queries and SSE streaming for real-time monitoring.

## Endpoints

### GET /api/logs

Get buffered log entries with optional filtering. Returns up to the last 200 entries matching the filters.

**Query Parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `source` | string | No | Filter by log source (e.g., `"eliza-api"`, `"runtime"`) |
| `level` | string | No | Filter by log level (e.g., `"info"`, `"warn"`, `"error"`, `"debug"`) |
| `tag` | string | No | Filter by tag |
| `since` | number | No | Unix ms timestamp — only return entries at or after this time |

**Response**

```json
{
  "entries": [
    {
      "timestamp": 1718000000000,
      "level": "info",
      "source": "eliza-api",
      "tags": ["startup"],
      "message": "API server started on port 2138"
    }
  ],
  "sources": ["eliza-api", "runtime", "plugin-anthropic"],
  "tags": ["startup", "auth", "knowledge"]
}
```

---

### GET /api/agent/events

Get buffered agent events (autonomy loop events and heartbeats). Use `after` to receive only new events since a known event ID for efficient polling.

**Query Parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `after` | string | No | Event ID — returns only events after this ID (cursor-based pagination) |
| `limit` | integer | No | Maximum events to return (min: 1, max: 1000, default: 200) |
| `runId` | string | No | Filter events by autonomy run ID |
| `fromSeq` | integer | No | Filter events with sequence number at or above this value (min: 0). Returns 400 if non-numeric. |

**Response**

```json
{
  "events": [
    {
      "type": "agent_event",
      "version": 1,
      "eventId": "evt-001",
      "ts": 1718000000000,
      "runId": "run-abc",
      "seq": 12,
      "payload": { "action": "thinking_started" }
    }
  ],
  "latestEventId": "evt-001",
  "totalBuffered": 47,
  "replayed": true
}
```

---

### GET /api/security/audit

Query the security audit log. Supports filtering by event type and severity. Set `stream=1` or include `Accept: text/event-stream` to receive events via Server-Sent Events.

**Query Parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `type` | string | No | Filter by audit event type. Valid values: `sandbox_mode_transition`, `secret_token_replacement_outbound`, `secret_sanitization_inbound`, `privileged_capability_invocation`, `policy_decision`, `signing_request_submitted`, `signing_request_rejected`, `signing_request_approved`, `plugin_fallback_attempt`, `security_kill_switch`, `sandbox_lifecycle`, `fetch_proxy_error`. Returns 400 if invalid. |
| `severity` | string | No | Filter by severity: `"info"`, `"warn"`, `"error"`, `"critical"`. Returns 400 if invalid. |
| `since` | string | No | Unix ms timestamp or ISO 8601 string — only return entries after this time |
| `limit` | integer | No | Maximum entries (min: 1, max: 1000, default: 200) |
| `stream` | string | No | Set to `"1"`, `"true"`, `"yes"`, or `"on"` to enable SSE streaming. Alternatively, set the `Accept: text/event-stream` header. |

**Response (one-shot)**

```json
{
  "entries": [
    {
      "timestamp": "2024-06-10T12:00:00.000Z",
      "type": "policy_decision",
      "summary": "Shell command blocked by policy",
      "metadata": { "command": "rm -rf /" },
      "severity": "warn",
      "traceId": "trace-abc-123"
    }
  ],
  "totalBuffered": 152,
  "replayed": true
}
```

**Response (SSE stream)**

The first SSE event is a `snapshot` with existing entries. Subsequent events are `entry` events for new audit log entries in real time.

```
event: snapshot
data: {"type":"snapshot","entries":[...],"totalBuffered":152}

event: entry
data: {"type":"entry","entry":{"type":"policy_decision","severity":"warn",...}}
```

---

### GET /api/extension/status

Check browser extension relay status and extension path. Used to determine whether the Eliza browser extension is connected and loadable.

**Response**

```json
{
  "relayReachable": true,
  "relayPort": 18792,
  "extensionPath": "/path/to/chrome-extension"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `relayReachable` | boolean | Whether the extension relay server is reachable at `relayPort` |
| `relayPort` | integer | Port the relay is expected on (default: 18792) |
| `extensionPath` | string \| null | Filesystem path to the bundled Chrome extension, or `null` if not found |
