---
title: "诊断 API"
sidebarTitle: "诊断"
description: "用于日志检索、代理事件、安全审计日志和浏览器扩展状态的 REST API 端点。"
---

诊断 API 提供对运行时日志、代理事件流、安全审计日志和浏览器扩展中继状态的访问。安全审计端点同时支持一次性查询和 SSE 流式传输，用于实时监控。

<div id="endpoints">

## 端点

</div>

<div id="get-apilogs">

### GET /api/logs

</div>

获取缓冲的日志条目，支持可选过滤。返回匹配过滤器的最近 200 条条目。

**查询参数**

| 参数 | 类型 | 必填 | 描述 |
|------|------|------|------|
| `source` | string | 否 | 按日志来源过滤（如 `"eliza-api"`、`"runtime"`） |
| `level` | string | 否 | 按日志级别过滤（如 `"info"`、`"warn"`、`"error"`、`"debug"`） |
| `tag` | string | 否 | 按标签过滤 |
| `since` | number | 否 | Unix 毫秒时间戳 — 仅返回此时间及之后的条目 |

**响应**

```json
{
  "entries": [
    {
      "timestamp": 1718000000000,
      "level": "info",
      "source": "eliza-api",
      "tags": ["startup"],
      "message": "API server started on port 31337"
    }
  ],
  "sources": ["eliza-api", "runtime", "plugin-anthropic"],
  "tags": ["startup", "auth", "knowledge"]
}
```

---

<div id="get-apiagentevents">

### GET /api/agent/events

</div>

获取缓冲的代理事件（自主循环事件和心跳）。使用 `after` 仅接收自已知事件 ID 之后的新事件，以实现高效轮询。

**查询参数**

| 参数 | 类型 | 必填 | 描述 |
|------|------|------|------|
| `after` | string | 否 | 事件 ID — 仅返回此 ID 之后的事件（基于游标的分页） |
| `limit` | integer | 否 | 返回的最大事件数（最小：1，最大：1000，默认：200） |
| `runId` | string | 否 | 按自主运行 ID 过滤事件 |
| `fromSeq` | integer | 否 | 过滤序列号等于或大于此值的事件（最小：0）。非数字时返回 400。 |

**响应**

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

<div id="get-apisecurityaudit">

### GET /api/security/audit

</div>

查询安全审计日志。支持按事件类型和严重性过滤。设置 `stream=1` 或包含 `Accept: text/event-stream` 以通过 Server-Sent Events 接收事件。

**查询参数**

| 参数 | 类型 | 必填 | 描述 |
|------|------|------|------|
| `type` | string | 否 | 按审计事件类型过滤。有效值：`sandbox_mode_transition`、`secret_token_replacement_outbound`、`secret_sanitization_inbound`、`privileged_capability_invocation`、`policy_decision`、`signing_request_submitted`、`signing_request_rejected`、`signing_request_approved`、`plugin_fallback_attempt`、`security_kill_switch`、`sandbox_lifecycle`、`fetch_proxy_error`。无效时返回 400。 |
| `severity` | string | 否 | 按严重性过滤：`"info"`、`"warn"`、`"error"`、`"critical"`。无效时返回 400。 |
| `since` | string | 否 | Unix 毫秒时间戳或 ISO 8601 字符串 — 仅返回此时间之后的条目 |
| `limit` | integer | 否 | 最大条目数（最小：1，最大：1000，默认：200） |
| `stream` | string | 否 | 设置为 `"1"`、`"true"`、`"yes"` 或 `"on"` 以启用 SSE 流式传输。也可设置 `Accept: text/event-stream` 头。 |

**响应（一次性查询）**

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

**响应（SSE 流）**

第一个 SSE 事件是包含现有条目的 `snapshot`。后续事件为实时新审计日志条目的 `entry` 事件。

```
event: snapshot
data: {"type":"snapshot","entries":[...],"totalBuffered":152}

event: entry
data: {"type":"entry","entry":{"type":"policy_decision","severity":"warn",...}}
```

---

<div id="get-apiextensionstatus">

### GET /api/extension/status

</div>

检查浏览器扩展中继状态和扩展路径。用于确定 Eliza 浏览器扩展是否已连接且可加载。

**响应**

```json
{
  "relayReachable": true,
  "relayPort": 18792,
  "extensionPath": "/path/to/chrome-extension"
}
```

| 字段 | 类型 | 描述 |
|------|------|------|
| `relayReachable` | boolean | 扩展中继服务器是否可在 `relayPort` 上访问 |
| `relayPort` | integer | 中继预期使用的端口（默认：18792） |
| `extensionPath` | string \| null | 捆绑的 Chrome 扩展在文件系统中的路径，未找到时为 `null` |
