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
    XXXL: 3072
}
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
            throw new Error("Internal error: No database adapter found for default plugin-sql");
        }
    } else if (!adapter) {
        throw new Error("Multiple database adapters found. You must have no more than one. Adjust your plugins configuration.");
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
pnpm add -D drizzle-kit
```

2. Create or update your schema files (e.g., `schema/account.ts`):
```typescript
import { pgTable, text, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const accountTable = pgTable("accounts", {
    id: uuid("id").primaryKey().notNull(),
    name: text("name"),
    email: text("email").notNull(),
    // Add new fields here
    newField: text("newField"),
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
import { migrate } from "drizzle-orm/node-postgres/migrator";

await migrate(db, { migrationsFolder: "./drizzle" });
```

### Note on Vector Support
Make sure the PostgreSQL vector extension is installed before running migrations. The adapter will validate vector setup during initialization.

## Clean Shutdown

The adapter implements cleanup handlers for:
- SIGINT
- SIGTERM
- beforeExit

These ensure proper closing of database connections when the application shuts down.
