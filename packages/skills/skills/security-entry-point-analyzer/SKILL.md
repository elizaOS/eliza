---
name: security-entry-point-analyzer
description: "Map and analyze application entry points for security assessment. Use when identifying attack surface, cataloging API endpoints, finding exposed interfaces, tracing input handling from entry to processing, or prioritizing areas for security testing."
allowed-tools:
  - Bash
  - Read
  - Write
  - Glob
  - Grep
---

# Entry Point Analysis

## When to Use

- Mapping an application's attack surface before security testing
- Cataloging all API endpoints, routes, and exposed interfaces
- Identifying which entry points handle untrusted input
- Prioritizing code paths for deeper security review
- Understanding data flow from external input to internal processing

## When NOT to Use

- Deep vulnerability analysis of specific code paths (use static analysis)
- Network-level attack surface mapping (use nmap/network tools)
- Binary reverse engineering entry points (use DWARF/disassembly tools)

## Entry Point Categories

| Category | Examples | Priority |
|----------|----------|----------|
| HTTP routes/endpoints | REST APIs, GraphQL, webhooks | High |
| WebSocket handlers | Real-time messaging, streaming | High |
| File upload handlers | Document upload, image processing | Critical |
| Authentication endpoints | Login, OAuth callbacks, token refresh | Critical |
| Deserialization points | JSON/XML/protobuf parsing from external | High |
| CLI argument parsing | User-supplied flags and arguments | Medium |
| IPC/RPC interfaces | gRPC, message queues, Unix sockets | Medium |
| Cron/scheduled tasks | Jobs triggered by external data | Low-Medium |
| Environment variables | Config that influences behavior | Low |

## Discovery Techniques

### Route Discovery
```bash
# Express.js / Node
grep -rn "app\.\(get\|post\|put\|delete\|patch\|all\|use\)(" --include="*.ts" --include="*.js" .

# Flask / Python
grep -rn "@app\.route\|@blueprint\.route\|@api\.route" --include="*.py" .

# Spring / Java
grep -rn "@\(Get\|Post\|Put\|Delete\|Patch\|Request\)Mapping" --include="*.java" .

# GraphQL resolvers
grep -rn "Mutation\|Query\|Subscription" --include="*.ts" --include="*.graphql" .
```

### Input Handling
```bash
# Request body/query/param access
grep -rn "req\.body\|req\.query\|req\.params\|request\.json\|request\.form" .

# File upload handling
grep -rn "multer\|upload\|multipart\|formidable\|busboy" .

# Header access
grep -rn "req\.headers\|request\.headers\|getHeader" .
```

## Analysis Workflow

1. **Enumerate** all entry points (routes, handlers, listeners)
2. **Classify** by input type and trust level
3. **Trace** input flow from entry to first processing step
4. **Identify** authentication/authorization requirements per endpoint
5. **Document** attack surface map with risk ratings
6. **Prioritize** unauthenticated endpoints handling complex input
