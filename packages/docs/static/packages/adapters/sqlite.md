# SQLite Adapter

## Purpose

A SQLite database adapter for ElizaOS that provides persistent storage capabilities with vector similarity search support.

## Key Features

- Full SQLite database implementation of ElizaOS database interface
- Vector similarity search via sqlite-vec extension
- JSON validation and foreign key constraints
- Built-in caching system
- Comprehensive transaction support with circuit breaker pattern
- Support for storing and retrieving various data types including memories, accounts, goals, and knowledge base

## Installation

```bash
bun install @elizaos-plugins/adapter-sqlite
```

## Configuration

- `SQLITE_FILE`: Path to the SQLite database file (default: `./data/db.sqlite`)
- Default database location is in a `data` directory in project root

## Integration

Implements the `IDatabaseAdapter` interface and extends the `DatabaseAdapter` base class to provide a lightweight, file-based storage solution for ElizaOS.

## Example Usage

```typescript
import sqlitePlugin from '@elizaos-plugins/adapter-sqlite';
import { IAgentRuntime } from '@elizaos/core';

// Initialize with ElizaOS runtime
function initializeAgent(runtime: IAgentRuntime) {
  runtime.use(sqlitePlugin);
}
```
