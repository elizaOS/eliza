---
title: "API de diagnósticos"
sidebarTitle: "Diagnósticos"
description: "Endpoints de la API REST para la recuperación de registros, eventos del agente, registro de auditoría de seguridad y estado de la extensión del navegador."
---

La API de diagnósticos proporciona acceso a los registros del runtime, el flujo de eventos del agente, el registro de auditoría de seguridad y el estado del relay de la extensión del navegador. El endpoint de auditoría de seguridad soporta tanto consultas únicas como streaming SSE para monitoreo en tiempo real.

<div id="endpoints">

## Endpoints

</div>

<div id="get-apilogs">

### GET /api/logs

</div>

Obtener entradas de registro almacenadas en búfer con filtrado opcional. Devuelve hasta las últimas 200 entradas que coincidan con los filtros.

**Parámetros de consulta**

| Parámetro | Tipo | Requerido | Descripción |
|-----------|------|-----------|-------------|
| `source` | string | No | Filtrar por origen del registro (ej., `"eliza-api"`, `"runtime"`) |
| `level` | string | No | Filtrar por nivel de registro (ej., `"info"`, `"warn"`, `"error"`, `"debug"`) |
| `tag` | string | No | Filtrar por etiqueta |
| `since` | number | No | Marca de tiempo en milisegundos Unix — solo devuelve entradas en o después de este momento |

**Respuesta**

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

Obtener eventos del agente almacenados en búfer (eventos del bucle de autonomía y heartbeats). Use `after` para recibir solo eventos nuevos desde un ID de evento conocido para un sondeo eficiente.

**Parámetros de consulta**

| Parámetro | Tipo | Requerido | Descripción |
|-----------|------|-----------|-------------|
| `after` | string | No | ID de evento — devuelve solo eventos después de este ID (paginación basada en cursor) |
| `limit` | integer | No | Máximo de eventos a devolver (mín: 1, máx: 1000, por defecto: 200) |
| `runId` | string | No | Filtrar eventos por ID de ejecución de autonomía |
| `fromSeq` | integer | No | Filtrar eventos con número de secuencia igual o superior a este valor (mín: 0). Devuelve 400 si no es numérico. |

**Respuesta**

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

Consultar el registro de auditoría de seguridad. Soporta filtrado por tipo de evento y severidad. Establezca `stream=1` o incluya `Accept: text/event-stream` para recibir eventos mediante Server-Sent Events.

**Parámetros de consulta**

| Parámetro | Tipo | Requerido | Descripción |
|-----------|------|-----------|-------------|
| `type` | string | No | Filtrar por tipo de evento de auditoría. Valores válidos: `sandbox_mode_transition`, `secret_token_replacement_outbound`, `secret_sanitization_inbound`, `privileged_capability_invocation`, `policy_decision`, `signing_request_submitted`, `signing_request_rejected`, `signing_request_approved`, `plugin_fallback_attempt`, `security_kill_switch`, `sandbox_lifecycle`, `fetch_proxy_error`. Devuelve 400 si es inválido. |
| `severity` | string | No | Filtrar por severidad: `"info"`, `"warn"`, `"error"`, `"critical"`. Devuelve 400 si es inválido. |
| `since` | string | No | Marca de tiempo en milisegundos Unix o cadena ISO 8601 — solo devuelve entradas después de este momento |
| `limit` | integer | No | Máximo de entradas (mín: 1, máx: 1000, por defecto: 200) |
| `stream` | string | No | Establezca `"1"`, `"true"`, `"yes"` u `"on"` para habilitar streaming SSE. Alternativamente, establezca el encabezado `Accept: text/event-stream`. |

**Respuesta (consulta única)**

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

**Respuesta (flujo SSE)**

El primer evento SSE es un `snapshot` con las entradas existentes. Los eventos posteriores son eventos `entry` para nuevas entradas del registro de auditoría en tiempo real.

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

Verificar el estado del relay de la extensión del navegador y la ruta de la extensión. Se utiliza para determinar si la extensión del navegador Eliza está conectada y puede cargarse.

**Respuesta**

```json
{
  "relayReachable": true,
  "relayPort": 18792,
  "extensionPath": "/path/to/chrome-extension"
}
```

| Campo | Tipo | Descripción |
|-------|------|-------------|
| `relayReachable` | boolean | Si el servidor relay de la extensión es accesible en `relayPort` |
| `relayPort` | integer | Puerto en el que se espera el relay (por defecto: 18792) |
| `extensionPath` | string \| null | Ruta del sistema de archivos a la extensión de Chrome incluida, o `null` si no se encuentra |
