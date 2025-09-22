# DrizzleDatabaseAdapter

A PostgreSQL database adapter built with Drizzle ORM for the ElizaOS ecosystem.

## Installation

```bash
# Using bun
bun add @elizaos/plugin-sql
```

## Vector Dimensions

The adapter supports the following vector dimensions:

```typescript
VECTOR_DIMS = {
  SMALL: 384,
  MEDIUM: 512,
  LARGE: 768,
  XL: 1024,
  XXL: 1536,
  XXXL: 3072,
};
```

Important Note: Once an agent is initialized with a specific embedding dimension, it cannot be changed. Attempting to change the dimension will result in an error: "Cannot change embedding dimension for agent"

## Features

- Circuit breaker pattern for database failures
- Automatic retries with exponential backoff
- Connection pooling
- Vector search capabilities
- Memory management
- Caching system
- Room and participant management
- Goal tracking system

## Database Schema

The plugin uses a structured schema with the following main tables:

### Core Tables

- **Agent**: Stores agent information and configurations
- **Room**: Manages conversation rooms and their settings
- **Participant**: Tracks participants in rooms
- **Memory**: Stores agent memories with vector embeddings for semantic search
- **Embedding**: Manages vector embeddings for various entities
- **Entity**: Represents entities that agents can interact with
- **Relationship**: Tracks relationships between entities
- **Component**: Stores agent components and their configurations
- **Tasks**: Manages tasks and goals for agents
- **Log**: Stores system logs
- **Cache**: Provides a caching mechanism for frequently accessed data
- **World**: Manages world settings and configurations

Each table is defined using Drizzle ORM schema definitions in the `src/schema` directory. The schema is designed to support the ElizaOS ecosystem's requirements for agent-based systems.

## Usage

The adapter is typically used as part of the ElizaOS runtime:

```typescript
async function findDatabaseAdapter(runtime: IAgentRuntime) {
  let adapter = runtime;

  if (!adapter) {
    const drizzleAdapterPlugin = await import('@elizaos/plugin-sql');
    const drizzleAdapterPluginDefault = drizzleAdapterPlugin.default;
    adapter = drizzleAdapterPluginDefault.adapter;
    if (!adapter) {
      throw new Error('Internal error: No database adapter found for default plugin-sql');
    }
  } else if (!adapter) {
    throw new Error(
      'Multiple database adapters found. You must have no more than one. Adjust your plugins configuration.'
    );
  }

  const adapterInterface = await adapter?.init(runtime);
  return adapterInterface;
}
```

## Error Handling Configuration

The adapter implements the following error handling configurations:

```typescript
{
    failureThreshold: 5,
    resetTimeout: 60000,
    halfOpenMaxAttempts: 3,
    maxRetries: 3,
    baseDelay: 1000,  // 1 second
    maxDelay: 10000,  // 10 seconds
    jitterMax: 1000,  // 1 second
    connectionTimeout: 5000  // 5 seconds
}
```

## Requirements

- PostgreSQL with vector extension installed
- Node.js or Bun (≥1.2.2)

## Environment Variables

The plugin uses the following environment variables:

- `POSTGRES_URL`: Connection string for PostgreSQL database (e.g., `postgresql://user:password@localhost:5432/dbname`)
  - If not provided, the plugin will use PGlite as a fallback
- `PGLITE_DATA_DIR`: (Optional) Directory for PGlite data storage (default: `./pglite`)

These variables should be defined in a `.env` file at the root of your project.

## Database Pool Configuration

Default pool configuration:

```typescript
{
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000
}
```

## Migration Support

ElizaOS v1.0.0 introduces **dynamic runtime migrations** - automatic schema management that runs at startup without manual intervention. Plugins can define their schemas and the system handles all migrations automatically.

### TLDR: What Changed?

**Before (v0.x):** Manual migrations with `drizzle-kit generate` → `drizzle-kit push` → restart  
**Now (v1.0.0):** Define schema in plugin → Start agent → Migrations run automatically ✨

### Key Features

- **Zero-Config Migrations**: No more manual migration commands
- **Plugin Isolation**: Each plugin gets its own schema namespace
- **Safety First**: Destructive changes blocked by default in production
- **Concurrent Safety**: Built-in locks prevent race conditions
- **Rollback Protection**: All migrations run in transactions

### How It Works

1. **Plugin defines schema** using Drizzle ORM:

```typescript
// In your plugin's schema.ts
import { pgTable, text, uuid } from 'drizzle-orm/pg-core';

export const myTable = pgTable('my_table', {
  id: uuid('id').primaryKey(),
  name: text('name').notNull(),
});

// Export schema in your plugin
export const plugin = {
  name: '@your-org/plugin-name',
  schema: schema, // Your Drizzle schema object
  // ... rest of plugin
};
```

2. **Runtime detects changes** at startup:

```bash
[RuntimeMigrator] Starting migration for plugin: @your-org/plugin-name
[RuntimeMigrator] Executing 2 SQL statements...
[RuntimeMigrator] Migration completed successfully
```

3. **Automatic safety checks**:

```bash
# Destructive changes are blocked
[RuntimeMigrator] Destructive migration blocked
[RuntimeMigrator] Destructive operations detected:
[RuntimeMigrator]   - Column "email" will be dropped from table "users"
[RuntimeMigrator] To proceed:
[RuntimeMigrator]   1. Set ELIZA_ALLOW_DESTRUCTIVE_MIGRATIONS=true
[RuntimeMigrator]   2. Or use { force: true } option
```

### Migration Controls

Control migration behavior via environment variables:

```bash
# Allow destructive migrations (drops, type changes)
ELIZA_ALLOW_DESTRUCTIVE_MIGRATIONS=true

# Development vs Production
NODE_ENV=production  # Stricter checks, verbose off by default
NODE_ENV=development  # More permissive, verbose on
```

Or programmatically:

```typescript
await databaseAdapter.runPluginMigrations(plugins, {
  verbose: true, // Show SQL statements
  force: true, // Allow destructive changes
  dryRun: true, // Preview without applying
});
```

### Transitioning from Manual Migrations

If you have existing manual Drizzle migrations:

1. **Keep existing migrations** - They remain compatible
2. **Add schema to plugin** - Export your Drizzle schema
3. **First run** - Runtime migrator detects current state
4. **Future changes** - Just update schema and restart

Example transition:

```typescript
// Before: Manual migrations
// 1. Edit schema
// 2. Run: bunx drizzle-kit generate
// 3. Run: bunx drizzle-kit push
// 4. Restart agent

// After: Runtime migrations
// 1. Edit schema in plugin
// 2. Restart agent (migrations run automatically)
```

### Schema Namespacing

Plugins automatically get namespaced schemas for isolation:

- `@elizaos/plugin-sql` → Uses `public` schema (core tables)
- `@your-org/plugin-name` → Uses `your_org_plugin_name` schema
- Prevents table name conflicts between plugins
- Clean separation of concerns

To use a custom schema:

```typescript
import { pgSchema } from 'drizzle-orm/pg-core';

const mySchema = pgSchema('my_custom_schema');
export const myTable = mySchema.table('my_table', {
  // ... columns
});
```

### Debugging Migrations

Check migration status:

```typescript
const migrator = migrationService.getMigrator();
const status = await migrator.getStatus('@your-org/plugin-name');
console.log(status);
// {
//   hasRun: true,
//   lastMigration: { hash: "...", timestamp: ... },
//   journal: [...],
//   snapshots: 3
// }
```

Preview changes without applying:

```typescript
const check = await migrator.checkMigration('@your-org/plugin-name', schema);
if (check?.hasDataLoss) {
  console.log('Warning: Destructive changes:', check.warnings);
}
```

### Database Support

The plugin supports two database backends with automatic migration support:

1. **PostgreSQL**: Production-ready with full feature support
2. **PGlite**: Embedded database for development/testing

Both use identical migration systems - develop locally with PGlite, deploy to PostgreSQL.

### Troubleshooting

**"Destructive migration blocked"**

- Set `ELIZA_ALLOW_DESTRUCTIVE_MIGRATIONS=true` for development
- For production, review changes carefully before enabling

**"Migration already in progress"**

- Another instance is running migrations
- System will wait for lock automatically

**"No changes detected"**

- Schema matches database state
- No migration needed

**Manual migration needed?**

- Use standard Drizzle Kit for complex scenarios:
  ```bash
  bunx drizzle-kit generate
  bunx drizzle-kit migrate
  ```

## Clean Shutdown

The adapter implements cleanup handlers for:

- SIGINT
- SIGTERM
- beforeExit

These ensure proper closing of database connections when the application shuts down.

## Implementation Details

### Connection Management

The plugin uses a global singleton pattern to manage database connections. This approach ensures that:

1. **Single Connection Per Process**: Only one connection manager instance exists per Node.js process, regardless of how many times the package is imported or initialized.

2. **Resource Efficiency**: Prevents multiple connection pools to the same database, which could lead to resource exhaustion.

3. **Consistent State**: Ensures all parts of the application share the same database connection state.

4. **Proper Cleanup**: Facilitates proper cleanup of database connections during application shutdown, preventing connection leaks.

This pattern is particularly important in monorepo setups or when the package is used by multiple modules within the same process. The implementation uses JavaScript Symbols to create a global registry that persists across module boundaries.

```typescript
// Example of the singleton pattern implementation
const GLOBAL_SINGLETONS = Symbol.for('@elizaos/plugin-sql/global-singletons');

// Store managers in a global symbol registry
if (!globalSymbols[GLOBAL_SINGLETONS]) {
  globalSymbols[GLOBAL_SINGLETONS] = {};
}

// Reuse existing managers or create new ones when needed
if (!globalSingletons.postgresConnectionManager) {
  globalSingletons.postgresConnectionManager = new PostgresConnectionManager(config.postgresUrl);
}
```

This approach is especially critical for PGlite connections, which require careful management to ensure proper shutdown and prevent resource leaks.
