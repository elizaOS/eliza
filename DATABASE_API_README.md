# elizaOS Database API

## Overview

...

### 2. CRUD Naming Convention

| Prefix | Operation | Returns |
|--------|-----------|---------|
| `create*` | INSERT | `UUID[]` (created IDs) |
| `get*` / `search*` | SELECT | Entity arrays or `null` |
| `update*` | UPDATE | `void` |
| `delete*` | DELETE | `void` |
| `upsert*` | INSERT ... ON CONFLICT UPDATE | `void` |

...

## Method Reference

...

### Agent CRUD

| Method | Returns | Description |
|--------|---------|-------------|
| `getAgents()` | `Agent[]` | All agents |
| `getAgentsByIds(ids)` | `Agent[]` | By ID list |
| `createAgents(agents)` | `UUID[]` | Insert agents |
| `updateAgents(updates)` | `void` | Modify agents |
| `deleteAgents(ids)` | `void` | Remove agents |
| `upsertAgents(agents)` | `void` | Insert or update |
| `countAgents()` | `number` | Total count |
| `cleanupAgents()` | `void` | Remove stale agents |

...
