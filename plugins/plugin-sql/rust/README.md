# elizaOS Plugin SQL - Rust Implementation

This is the Rust implementation of the elizaOS SQL database plugin. It provides PostgreSQL and PGLite adapters that are fully compatible with the TypeScript implementation.

## Features

- **PostgreSQL Adapter**: Full PostgreSQL support using sqlx
- **PGLite Adapter**: In-browser PostgreSQL via @electric-sql/pglite (WASM)
- **Schema Compatibility**: Database schema matches TypeScript Drizzle ORM
- **Vector Search**: pgvector support for embedding similarity search
- **Full CRUD**: Complete memory, agent, entity, and world management

## Building

### Prerequisites

- Rust 1.70 or later
- wasm-pack (for WASM builds)
- PostgreSQL (for native builds with postgres feature)

### Native Build

```bash
cargo build --release
```

### WASM Build

```bash
# For web browsers
wasm-pack build --target web --out-dir pkg/web --features wasm

# For Node.js
wasm-pack build --target nodejs --out-dir pkg/node --features wasm
```

### Build Script

```bash
./build.sh
```

## Testing

```bash
cargo test
```

## Usage

### Rust (Native with PostgreSQL)

```rust
use elizaos_plugin_sql::{PostgresAdapter, DatabaseAdapter};
use elizaos::UUID;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let agent_id = UUID::new_v4();
    let adapter = PostgresAdapter::new(
        "postgres://localhost/eliza",
        &agent_id
    ).await?;

    adapter.init().await?;

    // Create a memory
    let memory = Memory::message(
        UUID::new_v4(),
        UUID::new_v4(),
        "Hello, world!"
    );

    let memory_id = adapter.create_memory(&memory, "messages", true).await?;

    Ok(())
}
```

### JavaScript (WASM with PGLite)

```javascript
import init, { WasmPgLiteAdapter } from "@elizaos/plugin-sql/rust";
import { PGlite } from "@electric-sql/pglite";

// Initialize WASM module
await init();

// Create PGLite instance
const pglite = new PGlite();

// Create adapter
const adapter = await new WasmPgLiteAdapter("agent-id-uuid", null);
await adapter.init_with_pglite(pglite);
await adapter.init();

// Create a memory
const memoryId = await adapter.create_memory(
  JSON.stringify({
    entityId: "entity-id",
    roomId: "room-id",
    content: { text: "Hello, world!" },
  }),
  "messages",
);

console.log(`Created memory: ${memoryId}`);
```

## Architecture

```
src/
├── lib.rs           # Library entry point
├── base.rs          # DatabaseAdapter trait
├── schema/          # Database schema definitions
│   ├── mod.rs       # Schema module exports
│   ├── agent.rs     # Agents table
│   ├── memory.rs    # Memories table
│   ├── embedding.rs # Embeddings table
│   ├── entity.rs    # Entities table
│   ├── room.rs      # Rooms table
│   ├── world.rs     # Worlds table
│   └── ...
├── postgres/        # PostgreSQL adapter
│   ├── mod.rs
│   ├── adapter.rs
│   └── manager.rs
├── pglite/          # PGLite adapter (WASM)
│   ├── mod.rs
│   ├── adapter.rs
│   └── manager.rs
└── wasm.rs          # WASM bindings
```

## Database Schema

The schema is designed to be identical to the TypeScript Drizzle ORM schema:

| Table         | Description                           |
| ------------- | ------------------------------------- |
| agents        | Agent character configurations        |
| memories      | Agent memories and messages           |
| embeddings    | Vector embeddings for semantic search |
| entities      | User/entity accounts                  |
| rooms         | Channels and rooms                    |
| worlds        | Servers and worlds                    |
| components    | Entity components                     |
| participants  | Room participants                     |
| relationships | Entity relationships                  |
| tasks         | Scheduled tasks                       |
| logs          | Activity logs                         |
| cache         | Key-value cache                       |

## Migration System

The Rust implementation includes a migration system compatible with the TypeScript RuntimeMigrator:

```rust
use elizaos_plugin_sql::migration::{MigrationService, derive_schema_name};
use std::sync::Arc;

// Create migration service
let migration_service = MigrationService::new(pool.clone());
migration_service.initialize().await?;

// Get migration status
let status = migration_service.get_status("@your-org/plugin-name").await?;

// Derive schema name for plugin isolation
let schema_name = derive_schema_name("@your-org/plugin-name");
// Returns: "your_org_plugin_name"
```

Features:

- Migration tracking tables (`migrations._migrations`, `migrations._journal`, `migrations._snapshots`)
- Schema snapshot storage
- Plugin schema namespacing for isolation
- Transaction-safe migrations

### Future: drizzle-rs Integration

The [drizzle-rs fork](https://github.com/themixednuts/drizzle-rs) is vendored at `vendor/drizzle-rs` for future integration. When stable, it will provide:

- Schema definition using Rust macros
- Automatic SQL generation from schema diffs
- Type-safe database queries

## Compatibility

This implementation is designed to be 100% compatible with the TypeScript version:

- **Schema Matching**: Tables and columns match Drizzle ORM definitions
- **JSON Format**: All data uses camelCase to match TypeScript
- **UUID Format**: UUIDs are stored in lowercase format
- **Vector Search**: Uses pgvector with same similarity functions
- **Migration Tables**: Same migration tracking schema as TypeScript

## License

MIT
