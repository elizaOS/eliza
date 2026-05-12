# Current Memory Sharing Architecture

**Document Version:** 1.3  
**Last Updated:** 2024-09-15  
**Author:** Platform Engineering Team  
**Status:** Under Review — Known Issues Documented

---

## Overview

The multi-agent memory sharing system enables five AI agents to collaborate by sharing knowledge, state, and configuration data through a centralized storage layer. Each agent maintains a private memory store optimized for its workload, and all agents have access to a shared PostgreSQL database for cross-agent communication.

## Architecture Components

### Private Storage (Per Agent)

Each agent maintains its own private memory store:

| Agent | Storage Backend | Purpose |
|-------|----------------|---------|
| research_agent | ChromaDB | Vector embeddings for research documents and knowledge retrieval |
| coding_agent | SQLite | Local code snippets, AST representations, and review history |
| customer_agent | Redis | Session state, conversation history, and customer context (includes PII) |
| analytics_agent | Pinecone | High-dimensional analytics embeddings and report vectors |
| ops_agent | Filesystem | Deployment manifests, credentials, and infrastructure configs |

### Shared Storage

All agents connect to a shared PostgreSQL 15.4 instance:

- **Host:** `pgcluster.internal:5432`
- **Database:** `shared_memory`
- **Schema:** `shared`
- **Tables:**
  - `shared.knowledge_base` — General knowledge entities and facts
  - `shared.entity_store` — Named entities, relationships, and metadata
  - `shared.workflow_state` — Cross-agent workflow coordination state
  - `shared.config_cache` — Shared configuration parameters

### Synchronization

The sync mechanism is **pull-based with polling**:

1. Each agent polls the shared PostgreSQL instance at a fixed interval
2. Default sync frequency: **every 5 minutes (300 seconds)** for all agents
3. Agents pull any rows updated since their last sync timestamp
4. Writes go directly to the shared tables — no write buffer or queue
5. No push notifications or event-driven sync

## Data Flow

```
┌──────────────┐     Direct SQL     ┌─────────────────────┐
│ research_agent│────────────────────│                     │
│  (ChromaDB)  │                    │                     │
├──────────────┤     Direct SQL     │   Shared PostgreSQL │
│ coding_agent │────────────────────│                     │
│  (SQLite)    │                    │   shared.knowledge  │
├──────────────┤     Direct SQL     │   shared.entity     │
│customer_agent│────────────────────│   shared.workflow   │
│  (Redis)     │                    │   shared.config     │
├──────────────┤     Direct SQL     │                     │
│analytics_agt │────────────────────│                     │
│  (Pinecone)  │                    │                     │
├──────────────┤     Direct SQL     │                     │
│  ops_agent   │────────────────────│                     │
│  (filesystem)│                    │                     │
└──────────────┘                    └─────────────────────┘
```

## Authentication

- Each agent authenticates to the shared database using a service account
- Agent-level authentication only — no row-level or column-level access control
- All agents use the same schema and have full read/write access to all shared tables
- No role-based access control (RBAC) is implemented

## Known Issues

### 1. Race Conditions
Multiple agents can write to the same row simultaneously. There is no row-level locking, optimistic concurrency control, or conflict detection. The last write simply overwrites previous data.

### 2. No Data Classification Enforcement
The shared database has no mechanism to enforce data classification policies. Any agent can write any category of data (including confidential or restricted) to shared tables, and any agent can read it.

### 3. No PII Masking
Customer PII that enters the shared namespace is stored in plaintext. There is no automatic masking, tokenization, or encryption at the field level. If the customer_agent writes customer data to a shared table, all other agents can read the raw PII.

### 4. No Versioning
Shared records have no version numbers or change history. When an agent overwrites a record, the previous value is lost. There is no audit trail of changes within the database itself (audit logging is handled externally).

### 5. No Namespace Separation
All agents write to the same tables with no logical separation. There are no per-agent namespaces, prefixes, or partitions. This makes it impossible to enforce per-agent access policies at the database level.

### 6. Sync Conflicts
Because sync is pull-based with no conflict detection, two agents can modify the same record between sync cycles. The result depends on which agent's write reaches the database last. Approximately 8 conflict incidents have been recorded in the past 30 days.

### 7. No Schema Validation
Agents can write arbitrary JSON to shared tables. There is no schema validation, which has led to schema drift issues where different agents expect different field structures for the same record type.

## Metrics

- Average sync latency: ~150ms per pull cycle
- Conflict rate: ~3-4 incidents per week
- Data loss incidents (last 60 days): 4 confirmed cases
- Uptime: 99.2% (shared PostgreSQL)

## Planned Improvements

The platform engineering team has identified the need for a comprehensive redesign addressing:
- Proper access control and namespace separation
- Conflict resolution beyond "last write wins"
- PII masking and data classification enforcement
- Event-driven sync to replace polling
- Versioning and change tracking

This document serves as the baseline for the redesign effort.
