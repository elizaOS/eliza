---
title: "API de diagnostics"
sidebarTitle: "Diagnostics"
description: "Points de terminaison de l'API REST pour la récupération des journaux, les événements de l'agent, le journal d'audit de sécurité et le statut de l'extension navigateur."
---

L'API de diagnostics donne accès aux journaux du runtime, au flux d'événements de l'agent, au journal d'audit de sécurité et au statut du relais de l'extension navigateur. Le point de terminaison d'audit de sécurité prend en charge les requêtes ponctuelles et le streaming SSE pour la surveillance en temps réel.

<div id="endpoints">

## Points de terminaison

</div>

<div id="get-apilogs">

### GET /api/logs

</div>

Obtenir les entrées de journal mises en mémoire tampon avec filtrage optionnel. Renvoie jusqu'aux 200 dernières entrées correspondant aux filtres.

**Paramètres de requête**

| Paramètre | Type | Requis | Description |
|-----------|------|--------|-------------|
| `source` | string | Non | Filtrer par source du journal (par ex., `"eliza-api"`, `"runtime"`) |
| `level` | string | Non | Filtrer par niveau de journal (par ex., `"info"`, `"warn"`, `"error"`, `"debug"`) |
| `tag` | string | Non | Filtrer par étiquette |
| `since` | number | Non | Horodatage en millisecondes Unix — ne renvoie que les entrées à partir de ce moment |

**Réponse**

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

Obtenir les événements de l'agent mis en mémoire tampon (événements de la boucle d'autonomie et heartbeats). Utilisez `after` pour ne recevoir que les nouveaux événements depuis un ID d'événement connu pour un sondage efficace.

**Paramètres de requête**

| Paramètre | Type | Requis | Description |
|-----------|------|--------|-------------|
| `after` | string | Non | ID d'événement — ne renvoie que les événements après cet ID (pagination basée sur curseur) |
| `limit` | integer | Non | Nombre maximum d'événements à renvoyer (min : 1, max : 1000, défaut : 200) |
| `runId` | string | Non | Filtrer les événements par ID d'exécution d'autonomie |
| `fromSeq` | integer | Non | Filtrer les événements avec un numéro de séquence égal ou supérieur à cette valeur (min : 0). Renvoie 400 si non numérique. |

**Réponse**

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

Interroger le journal d'audit de sécurité. Prend en charge le filtrage par type d'événement et sévérité. Définissez `stream=1` ou incluez `Accept: text/event-stream` pour recevoir les événements via Server-Sent Events.

**Paramètres de requête**

| Paramètre | Type | Requis | Description |
|-----------|------|--------|-------------|
| `type` | string | Non | Filtrer par type d'événement d'audit. Valeurs valides : `sandbox_mode_transition`, `secret_token_replacement_outbound`, `secret_sanitization_inbound`, `privileged_capability_invocation`, `policy_decision`, `signing_request_submitted`, `signing_request_rejected`, `signing_request_approved`, `plugin_fallback_attempt`, `security_kill_switch`, `sandbox_lifecycle`, `fetch_proxy_error`. Renvoie 400 si invalide. |
| `severity` | string | Non | Filtrer par sévérité : `"info"`, `"warn"`, `"error"`, `"critical"`. Renvoie 400 si invalide. |
| `since` | string | Non | Horodatage en millisecondes Unix ou chaîne ISO 8601 — ne renvoie que les entrées après ce moment |
| `limit` | integer | Non | Nombre maximum d'entrées (min : 1, max : 1000, défaut : 200) |
| `stream` | string | Non | Définissez `"1"`, `"true"`, `"yes"` ou `"on"` pour activer le streaming SSE. Alternativement, définissez l'en-tête `Accept: text/event-stream`. |

**Réponse (requête ponctuelle)**

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

**Réponse (flux SSE)**

Le premier événement SSE est un `snapshot` avec les entrées existantes. Les événements suivants sont des événements `entry` pour les nouvelles entrées du journal d'audit en temps réel.

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

Vérifier le statut du relais de l'extension navigateur et le chemin de l'extension. Utilisé pour déterminer si l'extension navigateur Eliza est connectée et chargeable.

**Réponse**

```json
{
  "relayReachable": true,
  "relayPort": 18792,
  "extensionPath": "/path/to/chrome-extension"
}
```

| Champ | Type | Description |
|-------|------|-------------|
| `relayReachable` | boolean | Si le serveur relais de l'extension est accessible sur `relayPort` |
| `relayPort` | integer | Port sur lequel le relais est attendu (défaut : 18792) |
| `extensionPath` | string \| null | Chemin du système de fichiers vers l'extension Chrome intégrée, ou `null` si introuvable |
