# ElizaOS Supabase Adapter

## Purpose

This adapter enables ElizaOS to integrate with Supabase for data persistence and real-time capabilities.

## Prerequisites

- Supabase account and project
- ElizaOS installation
- Node.js and npm/yarn/bun

## Installation

```bash
bun install github:elizaos-plugins/adapter-supabase
```

## Configuration

1. Add the adapter to your character configuration:

```json
{
  "plugins": ["@elizaos-plugins/adapter-supabase"],
  "settings": {
    "secrets": {
      "SUPABASE_URL": "your-supabase-project-url",
      "SUPABASE_ANON_KEY": "your-supabase-anon-key"
    }
  }
}
```

2. Set up the database schema by running the migrations:

```bash
# Run the schema migration
psql -f schema.sql

# Seed the initial data
psql -f seed.sql
```

## Integration

Once configured, the adapter will automatically handle:

- Data persistence for character states and interactions
- Real-time updates for multi-user environments
- State synchronization across different instances
- Secure data storage and retrieval
