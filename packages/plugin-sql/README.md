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

The adapter supports two approaches to managing database schema:

### 1. Initial Setup

Migrations are automatically run during initialization if:

- Database tables don't exist
- Vector extension is not found

This is handled internally by:

```typescript
await runMigrations(pgPool);
```

### 2. Schema Updates

To update the schema:

1. Install drizzle-kit (if not already installed):

```bash
bun add -D drizzle-kit
```

2. Create or update your schema files (e.g., `schema/account.ts`):

```typescript
import { pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const accountTable = pgTable('accounts', {
  id: uuid('id').primaryKey().notNull(),
  name: text('name'),
  email: text('email').notNull(),
  // Add new fields here
  newField: text('newField'),
});
```

3. Generate migrations:

```bash
npx drizzle-kit generate:pg
```

This will create SQL migration files in your migrations directory.

4. Apply migrations using one of these methods:

a. Using drizzle-kit:

```bash
npx drizzle-kit push:pg
```

b. Through your application code:

```typescript
import { migrate } from 'drizzle-orm/node-postgres/migrator';

await migrate(db, { migrationsFolder: './drizzle' });
```

c. Using the provided migration script:

```bash
npm run migrate
# or
bun migrate
```

d. Using drizzle-kit migrate command:

```bash
npx drizzle-kit migrate
```

This command will read the configuration from `drizzle.config.ts` and pull the PostgreSQL URI from the `.env` file. Make sure your `.env` file contains the `POSTGRES_URL` variable with the correct connection string.

### Migration Configuration

The plugin uses a `drizzle.config.ts` file to configure migrations:

```typescript
import { config } from 'dotenv';
import { defineConfig } from 'drizzle-kit';

config({ path: '../../.env' });

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/index.ts',
  out: './drizzle/migrations',
  dbCredentials: {
    url: process.env.POSTGRES_URL || 'file:../../.elizadb',
  },
  breakpoints: true,
});
```

### Database Support

The plugin supports two database backends:

1. **PostgreSQL**: Used when `POSTGRES_URL` environment variable is provided
2. **PGlite**: Used as a fallback when no PostgreSQL URL is provided

Both backends use the same migration files, ensuring consistent schema across environments.

### Note on Vector Support

Make sure the PostgreSQL vector extension is installed before running migrations. The adapter will validate vector setup during initialization.

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
