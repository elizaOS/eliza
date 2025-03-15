# ElizaOS Supabase Adapter

This adapter enables ElizaOS to integrate with Supabase for data persistence and real-time capabilities.

## Prerequisites

- Supabase account and project
- ElizaOS installation
- Node.js and npm/yarn/pnpm

## Installation

```bash
npm install github:elizaos-plugins/adapter-supabase
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

## Required Environment Variables

The adapter requires the following environment variables:

- `SUPABASE_URL`: Your Supabase project URL
- `SUPABASE_ANON_KEY`: Your Supabase project's anonymous key

You can find these values in your Supabase project dashboard under Project Settings > API.

## Database Setup

Before using the adapter, ensure you've run both migration files:
- `schema.sql`: Sets up the required database tables and relationships
- `seed.sql`: Populates initial data (if any)

These migrations must be executed before starting the adapter to ensure proper functionality.

## Usage

Once configured, the adapter will automatically handle:
- Data persistence for character states and interactions
- Real-time updates for multi-user environments
- State synchronization across different instances
- Secure data storage and retrieval
