---
title: Memory & Context API
sidebarTitle: Memory
description: REST API endpoints for storing, searching, and retrieving agent memory and context.
---

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/memory/remember` | Save a free-text note into persistent memory |
| GET | `/api/memory/search` | Full-text keyword search over memory notes |
| GET | `/api/context/quick` | Search memory + knowledge and synthesize a concise answer |

---

## Remember

```
POST /api/memory/remember
```

Saves a free-text note into the agent's persistent hash-memory room.

**Request body:**
```json
{ "text": "The user prefers dark mode themes." }
```

| Field | Type | Required |
|-------|------|----------|
| `text` | string | yes |

**Response:**
```json
{
  "ok": true,
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "text": "The user prefers dark mode themes.",
  "createdAt": 1700000000000
}
```

**Errors:** `400` if `text` is missing or empty; `503` if agent runtime is unavailable.

## Search Memory

```
GET /api/memory/search
```

Full-text keyword search over saved memory notes. Scans up to 500 most recent entries and returns top matches by term-overlap score.

**Query params:**

| Param | Type | Required | Default | Max |
|-------|------|----------|---------|-----|
| `q` | string | yes | — | — |
| `limit` | integer | no | `10` | `50` |

**Response:**
```json
{
  "query": "dark mode",
  "results": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "text": "The user prefers dark mode themes.",
      "createdAt": 1700000000000,
      "score": 1.5
    }
  ],
  "count": 1,
  "limit": 10
}
```

**Errors:** `400` if `q` is absent.

## Quick Context

```
GET /api/context/quick
```

Searches both memory notes and the knowledge base simultaneously, then synthesizes a concise answer (max 120 words) via the agent's text model.

**Query params:**

| Param | Type | Required | Default | Max |
|-------|------|----------|---------|-----|
| `q` | string | yes | — | — |
| `limit` | integer | no | `8` | `20` |

**Response:**
```json
{
  "query": "What theme does the user prefer?",
  "answer": "The user prefers dark mode themes.",
  "memories": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "text": "The user prefers dark mode themes.",
      "createdAt": 1700000000000,
      "score": 1.5
    }
  ],
  "knowledge": [
    {
      "id": "uuid",
      "text": "Theme configuration documentation...",
      "similarity": 0.87,
      "documentId": "uuid",
      "documentTitle": "themes.pdf",
      "position": 3
    }
  ]
}
```

Knowledge results are filtered to `similarity >= 0.2`. The `documentId`, `documentTitle`, and `position` fields are present only when available in the fragment metadata.

## Memory Viewer

### Browse Memories

```
GET /api/memories/browse
```

Paginated browse of all agent memories across memory tables (messages, memories, facts, documents), sorted newest first.

**Query params:**

| Param | Type | Required | Default | Max |
|-------|------|----------|---------|-----|
| `limit` | integer | no | `50` | `200` |
| `offset` | integer | no | `0` | — |
| `type` | string | no | all tables | Filter to a single memory table: `messages`, `memories`, `facts`, or `documents` |
| `entityId` | string | no | — | Filter by a single entity ID |
| `entityIds` | string | no | — | Comma-separated list of entity IDs to filter by |
| `roomId` | string | no | — | Filter by room ID |
| `q` | string | no | — | Text search query — filters results by keyword overlap |

**Response:**
```json
{
  "memories": [
    {
      "id": "uuid",
      "type": "messages",
      "text": "The user prefers dark mode.",
      "entityId": "uuid",
      "roomId": "uuid",
      "agentId": "uuid",
      "createdAt": 1700000000000,
      "metadata": null,
      "source": "hash_memory"
    }
  ],
  "total": 142,
  "limit": 50,
  "offset": 0
}
```

---

### Memory Feed

```
GET /api/memories/feed
```

Time-ordered feed of recent memories (newest first), with cursor-based pagination. Designed for infinite-scroll UIs.

**Query params:**

| Param | Type | Required | Default | Max |
|-------|------|----------|---------|-----|
| `limit` | integer | no | `50` | `100` |
| `before` | number | no | — | Unix ms timestamp — only return entries created before this time |
| `type` | string | no | all tables | Filter to a single memory table |

**Response:**
```json
{
  "memories": [ ... ],
  "count": 50,
  "limit": 50,
  "hasMore": true
}
```

| Field | Type | Description |
|-------|------|-------------|
| `hasMore` | boolean | `true` if more memories exist beyond the returned page |

---

### Memories by Entity

```
GET /api/memories/by-entity/:entityId
```

Browse memories associated with a specific entity (person). Supports multi-identity lookups via the `entityIds` query parameter.

**Path params:**

| Param | Type | Description |
|-------|------|-------------|
| `entityId` | string | Primary entity identifier |

**Query params:**

| Param | Type | Required | Default | Max |
|-------|------|----------|---------|-----|
| `entityIds` | string | no | — | Comma-separated list of entity IDs for multi-identity people |
| `limit` | integer | no | `50` | `200` |
| `offset` | integer | no | `0` | — |
| `type` | string | no | all tables | Filter to a single memory table |

**Response:**
```json
{
  "entityId": "uuid",
  "memories": [ ... ],
  "total": 28,
  "limit": 50,
  "offset": 0
}
```

---

### Memory Stats

```
GET /api/memories/stats
```

Returns aggregate memory counts broken down by memory table.

**Response:**
```json
{
  "total": 523,
  "byType": {
    "messages": 412,
    "memories": 67,
    "facts": 31,
    "documents": 13
  }
}
