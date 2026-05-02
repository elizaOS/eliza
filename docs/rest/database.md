---
title: "Database API"
sidebarTitle: "Database"
description: "REST API endpoints for inspecting database status, schema, and running read-only queries."
---

The Database API provides endpoints for inspecting the agent's database connection, listing tables, and running read-only queries. These endpoints power the Database Explorer in the Advanced section of the dashboard.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/database/status` | Database connection status |
| GET | `/api/database/config` | Database configuration |
| GET | `/api/database/tables` | List all tables |
| POST | `/api/database/query` | Run a read-only SQL query |

---

### GET /api/database/status

Returns the current database connection status.

**Response**

```json
{
  "provider": "pglite",
  "connected": true,
  "serverVersion": "16.0",
  "tableCount": 42,
  "pgliteDataDir": "~/.eliza/workspace/.eliza/.elizadb",
  "postgresHost": null
}
```

| Field | Type | Description |
|-------|------|-------------|
| `provider` | string | `"pglite"` or `"postgres"` |
| `connected` | boolean | Whether the database is reachable |
| `serverVersion` | string | PostgreSQL version |
| `tableCount` | number | Total number of tables |
| `pgliteDataDir` | string \| null | Data directory for PGLite (null for Postgres) |
| `postgresHost` | string \| null | Hostname for Postgres (null for PGLite) |

---

### GET /api/database/config

Returns the current database configuration and whether a restart is needed to apply changes.

**Response**

```json
{
  "config": {},
  "activeProvider": "pglite",
  "needsRestart": false
}
```

| Field | Type | Description |
|-------|------|-------------|
| `config` | object | Current database configuration |
| `activeProvider` | string | The active provider (`"pglite"` or `"postgres"`) |
| `needsRestart` | boolean | Whether config changes require a restart |

---

### GET /api/database/tables

List all tables in the database.

**Response**

```json
{
  "tables": [
    "accounts",
    "memories",
    "goals",
    "participants",
    "rooms"
  ]
}
```

---

### POST /api/database/query

Run a read-only SQL query against the database.

<Warning>
This endpoint is restricted to SELECT queries. Mutation queries (INSERT, UPDATE, DELETE, DROP, etc.) are rejected.
</Warning>

**Request body**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `query` | string | Yes | SQL SELECT query |

**Response**

```json
{
  "columns": ["id", "name"],
  "rows": [["uuid-1", "Agent 1"]],
  "rowCount": 1,
  "durationMs": 3
}
```

| Field | Type | Description |
|-------|------|-------------|
| `columns` | string[] | Column names |
| `rows` | array[] | Row data as arrays of values |
| `rowCount` | number | Number of rows returned |
| `durationMs` | number | Query execution time in milliseconds |
