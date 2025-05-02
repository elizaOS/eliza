# ElizaOS MySQL Database Adapter

A MySQL database adapter built with Drizzle ORM for the ElizaOS ecosystem, using the `mysql2` driver.

## Installation

```bash
# Using bun
bun add @elizaos/plugin-mysql
```

## Vector Dimensions

The adapter supports the following vector dimensions defined in the MySQL schema using the `vector(N)` type:

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

**Important Note**: Once an agent is initialized with a specific embedding dimension, it cannot be changed. Attempting to change the dimension will result in an error: "Cannot change embedding dimension for agent"

## Features

- **MySQL Integration**: Uses the `mysql2` driver for connecting to MySQL databases.
- **Connection Pooling**: Managed by `MySql2ConnectionManager`.
- **Robust Operations**: Implements automatic retries with exponential backoff for database operations.
- **Vector Search**: Supports vector similarity search capabilities if your MySQL instance/version supports the `vector` type (e.g., MySQL HeatWave, or MySQL 8+ with vector plugins).
- **ElizaOS Core Integration**: Provides implementations for memory management, caching, room/participant management, entity/relationship tracking, and task management within the ElizaOS framework.

## Database Schema

The plugin uses a structured schema defined with Drizzle ORM for MySQL. The main tables include:

### Core Tables

- **`agents`**: Stores agent information and configurations.
- **`rooms`**: Manages conversation rooms and their settings.
- **`participants`**: Tracks participants in rooms.
- **`memories`**: Stores agent memories with vector embeddings for semantic search.
- **`embeddings`**: Manages vector embeddings (using `vector(N)` type) for memories.
- **`entities`**: Represents entities that agents can interact with.
- **`relationships`**: Tracks relationships between entities.
- **`components`**: Stores agent components and their configurations.
- **`tasks`**: Manages tasks and goals for agents.
- **`logs`**: Stores system logs related to entities and rooms.
- **`cache`**: Provides a caching mechanism for frequently accessed data.
- **`worlds`**: Manages world settings and configurations.

Each table is defined using Drizzle ORM schema definitions in the `src/schema` directory and reflected in the SQL migration files under `drizzle/migrations`. Key MySQL data types used include `varchar(36)` for UUIDs, `timestamp`, `json`, `boolean`, and `vector(N)`.

## Usage

The adapter is registered within the ElizaOS runtime via the plugin system. The runtime loads the `mysqlPlugin` which initializes the `MySql2DatabaseAdapter`.

```typescript
// Example of how the plugin might be registered and used internally by ElizaOS
import type { IAgentRuntime } from '@elizaos/core';
import mysqlPlugin from '@elizaos/plugin-mysql'; // Assuming this is the entry point

async function setupDatabase(runtime: IAgentRuntime) {
  // The runtime would call the plugin's init function
  await mysqlPlugin.init(null, runtime);

  // The runtime now has the database adapter registered
  // runtime.database // -> Instance of MySql2DatabaseAdapter
}
```

The core interaction happens through the `IAgentRuntime` interface, which delegates database operations to the registered adapter (`MySql2DatabaseAdapter` in this case).

## Error Handling Configuration

The adapter inherits retry logic from `BaseDrizzleAdapter` with these default settings:

```typescript
{
    maxRetries: 3,
    baseDelay: 1000,  // 1 second
    maxDelay: 10000,  // 10 seconds
    jitterMax: 1000,  // 1 second
}
```

The `MySql2ConnectionManager` also uses a default connection timeout:

```typescript
{
  connectionTimeout: 5000; // 5 seconds (for mysql2 pool)
}
```

## Requirements

- MySQL Server (Version supporting `vector` types is required for vector search, e.g., MySQL 8+ with appropriate setup or MySQL HeatWave).
- Node.js or Bun (Check `package.json` for specific version requirements).

## Development Setup (Using Docker)

This package includes a `docker-compose.yml` file to easily spin up a compatible MySQL container for local development.

1.  **Ensure Docker and Docker Compose are installed.**
2.  **Start the container:** From the `packages/plugin-mysql` directory, run:

    ```bash
    docker compose up -d
    ```

    This will start a MySQL 9.1.0 container named `mysql-vector` in the background.

3.  **Container Details:**

    - **Image**: `mysql:9.1.0`
    - **Port**: Exposes MySQL on the default port `3306`.
    - **Database**: Creates a database named `mydb`.
    - **User**: Creates a user `myuser` with password `mysecret`.
    - **Root Password**: `rootsecret`.
    - **Volume**: Persists data in a Docker volume named `mysql_vector_data`.

4.  **Configure Environment:** Set your `MYSQL_URL` environment variable in your `.env` file to connect to this container:

    ```dotenv
    MYSQL_URL="mysql://myuser:mysecret@localhost:3306/mydb"
    ```

5.  **Stop the container:**
    ```bash
    docker compose down
    ```

## Environment Variables

The plugin uses the following environment variable:

- `MYSQL_URL`: Connection string for the MySQL database (e.g., `mysql://user:password@localhost:3306/dbname`). This is **required**.

This variable should be defined in a `.env` file at the root of your project where the ElizaOS agent runtime is executed.

## Database Pool Configuration

The `MySql2ConnectionManager` uses `mysql2/promise.createPool`. Default settings used in the manager (can be overridden via connection string where applicable):

```typescript
{
    connectTimeout: 5000,
    waitForConnections: true,
    connectionLimit: 20,
    queueLimit: 0
}
```

## Migration Support

Database schema management is handled using Drizzle ORM and Drizzle Kit.

### 1. Initial Setup

Migrations are automatically run by `MySql2ConnectionManager.runMigrations()` during the plugin's initialization (`init` function). Drizzle ORM checks the database against the migration files in `drizzle/migrations` and applies any pending migrations.

### 2. Schema Updates

To update the database schema:

1.  **Install Drizzle Kit** (if not already installed):

    ```bash
    bun add -D drizzle-kit mysql2
    # or
    npm install -D drizzle-kit mysql2
    ```

    _(Note: `mysql2` might already be a dependency, but ensure `drizzle-kit` is present)._

2.  **Modify Schema**: Update the Drizzle schema definitions in `src/schema/*.ts`.

3.  **Generate Migrations**: Run the Drizzle Kit command to generate SQL migration files based on your schema changes.

    ```bash
    npx drizzle-kit generate
    ```

    _(Drizzle Kit should automatically detect the MySQL dialect from your `drizzle.config.ts`)_

    This will create new SQL migration file(s) in the `drizzle/migrations` directory.

4.  **Apply Migrations**: The new migrations will be applied automatically the next time the ElizaOS agent initializes this plugin. Alternatively, you can apply them manually using Drizzle Kit (ensure your `.env` file has `MYSQL_URL`):
    ```bash
    npx drizzle-kit migrate
    ```
    Or, if you prefer push (potentially destructive, use with caution):
    ```bash
    npx drizzle-kit push
    ```

### Migration Configuration

The plugin should include a `drizzle.config.ts` file configured for MySQL:

```typescript
import { config } from 'dotenv';
import { defineConfig } from 'drizzle-kit';

// Adjust the path to your .env file as needed
config({ path: '../../.env' });

export default defineConfig({
  dialect: 'mysql', // Specify MySQL dialect
  schema: './src/schema/index.ts',
  out: './drizzle/migrations',
  dbCredentials: {
    url: process.env.MYSQL_URL!, // Ensure MYSQL_URL is set in your .env
  },
  breakpoints: true,
});
```

_(Make sure this configuration file exists and is accurate)_

### Note on Vector Support

The schema uses `vector(N)` data types. Ensure your target MySQL database version and configuration support this type for vector operations to function correctly.

## Clean Shutdown

The `MySql2ConnectionManager` implements cleanup handlers for `SIGINT`, `SIGTERM`, and `beforeExit` to ensure proper closing of the MySQL connection pool when the application shuts down.

## Implementation Details

### Connection Management (`MySql2ConnectionManager`)

The plugin utilizes a global singleton pattern (`GLOBAL_SINGLETONS` symbol) within the `src/index.ts` file to manage the `MySql2ConnectionManager` instance. This ensures:

1.  **Single Connection Manager**: Only one `MySql2ConnectionManager` instance (and thus one connection pool) exists per Node.js process, regardless of how many times the plugin is initialized (e.g., by different agents in the same process).
2.  **Resource Efficiency**: Prevents creating multiple redundant connection pools to the same MySQL database.
3.  **Consistent State**: All adapters using this plugin within the same process share the same connection pool state.
4.  **Proper Cleanup**: Centralizes the cleanup logic for the connection pool during application shutdown.

```typescript
// Simplified view from src/index.ts
const GLOBAL_SINGLETONS = Symbol.for('@elizaos/plugin-mysql/global-singletons');
// ... setup global registry ...

function createDatabaseAdapter(config, agentId) {
  if (config.mysqlUrl) {
    // Reuse or create the singleton manager
    if (!globalSingletons.mysqlConnectionManager) {
      globalSingletons.mysqlConnectionManager = new MySql2ConnectionManager(config.mysqlUrl);
    }
  }
  // ... error handling ...
  return new MySql2DatabaseAdapter(agentId, globalSingletons.mysqlConnectionManager);
}
```

This pattern ensures efficient and safe management of MySQL connections within the ElizaOS environment.
