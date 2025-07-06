# ElizaOS PostgreSQL Adapter

## Purpose

A database adapter plugin for ElizaOS that provides PostgreSQL connectivity with vector embedding support for semantic search capabilities.

## Key Features

- Seamless integration with ElizaOS memory and knowledge storage systems
- Vector embedding storage and retrieval with pgvector extension
- Support for multiple embedding models and dimensions
- Robust connection management with automatic retries and circuit breaking
- Full transaction support for safe database operations
- Comprehensive memory, relationship, and knowledge management
- Built-in caching system

## Installation

Install the adapter via npm:

```bash
bun install @elizaos-plugins/adapter-postgres
```

Or using bun:

```bash
bun add @elizaos-plugins/adapter-postgres
```

## Configuration

Add to ElizaOS configuration:

```javascript
// agent.config.js
export default {
  adapters: ['postgres'],
  settings: {
    POSTGRES_URL: 'postgresql://username:password@localhost:5432/elizaos',
  },
};
```

## Prerequisites

- PostgreSQL 15+ with pgvector extension installed
- Connection permissions to create tables and extensions

## Integration

The adapter automatically initializes the required database schema when first connecting, providing methods for memory management, knowledge management, and vector search using pgvector for semantic capabilities.
