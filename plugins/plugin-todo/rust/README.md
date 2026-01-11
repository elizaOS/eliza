# elizaos-plugin-todo - Rust

The Rust implementation of the elizaOS Todo plugin.

## Installation

Add to your `Cargo.toml`:

```toml
[dependencies]
elizaos-plugin-todo = "1.0"
```

## Features

- `native` (default): Full async support with tokio and PostgreSQL via sqlx
- `wasm`: WebAssembly support for browser environments

## Usage

```rust
use elizaos_plugin_todo::{TodoClient, TodoConfig, types::{TodoType, TodoPriority}};
use uuid::Uuid;
use chrono::Utc;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    dotenvy::dotenv().ok();
    let config = TodoConfig::from_env()?;
    let client = TodoClient::new(config).await?;

    // Create a todo
    let todo_id = client.create_todo(
        Uuid::new_v4(), // agent_id
        Uuid::new_v4(), // world_id
        Uuid::new_v4(), // room_id
        Uuid::new_v4(), // entity_id
        "Buy groceries".to_string(),
        Some("Milk, eggs, bread".to_string()),
        TodoType::OneOff,
        Some(2), // priority
        true,    // is_urgent
        Some(Utc::now() + chrono::Duration::days(1)),
        None,    // completed_at
        None,    // metadata
        Some(vec!["shopping".to_string()]),
    ).await?;

    // Get todos
    let todos = client.get_todos(None, None, None, None, None, None, None, Some(10)).await?;

    // Complete a todo
    client.update_todo(
        todo_id,
        None, None, None, None,
        Some(true),  // is_completed
        None,
        Some(Utc::now()),  // completed_at
        None, None,
    ).await?;

    Ok(())
}
```

## Structure

```
rust/
├── Cargo.toml           # Package manifest
├── src/
│   ├── lib.rs           # Library entry point
│   ├── client.rs        # Todo client
│   ├── config.rs        # Configuration
│   ├── types.rs         # Type definitions
│   ├── error.rs         # Error types
│   ├── data_service.rs  # Database operations
│   ├── cache_manager.rs # Caching
│   ├── notification_manager.rs # Notifications
│   ├── reminder_service.rs # Reminder logic
│   └── wasm.rs          # WASM bindings
├── tests/               # Integration tests
└── README.md
```

## Building

### Native

```bash
cargo build --release
```

### WebAssembly

```bash
# For web
wasm-pack build --target web --out-dir pkg/web

# For Node.js
wasm-pack build --target nodejs --out-dir pkg/node
```

## Testing

```bash
cargo test
```

With coverage:

```bash
cargo tarpaulin
```

## API

### TodoClient

```rust
impl TodoClient {
    pub async fn new(config: TodoConfig) -> Result<Self>;

    pub async fn create_todo(
        &self,
        agent_id: Uuid,
        world_id: Uuid,
        room_id: Uuid,
        entity_id: Uuid,
        name: String,
        description: Option<String>,
        todo_type: TodoType,
        priority: Option<i32>,
        is_urgent: bool,
        due_date: Option<DateTime<Utc>>,
        completed_at: Option<DateTime<Utc>>,
        metadata: Option<Value>,
        tags: Option<Vec<String>>,
    ) -> Result<Uuid>;

    pub async fn get_todo(&self, todo_id: Uuid) -> Result<Option<TodoData>>;

    pub async fn get_todos(
        &self,
        agent_id: Option<Uuid>,
        world_id: Option<Uuid>,
        room_id: Option<Uuid>,
        entity_id: Option<Uuid>,
        todo_type: Option<TodoType>,
        is_completed: Option<bool>,
        tags: Option<Vec<String>>,
        limit: Option<i64>,
    ) -> Result<Vec<TodoData>>;

    pub async fn update_todo(
        &self,
        todo_id: Uuid,
        name: Option<String>,
        description: Option<String>,
        priority: Option<i32>,
        is_urgent: Option<bool>,
        is_completed: Option<bool>,
        due_date: Option<DateTime<Utc>>,
        completed_at: Option<DateTime<Utc>>,
        metadata: Option<Value>,
        tags: Option<Vec<String>>,
    ) -> Result<bool>;

    pub async fn delete_todo(&self, todo_id: Uuid) -> Result<bool>;

    pub async fn get_overdue_todos(/* ... */) -> Result<Vec<TodoData>>;

    pub async fn reset_daily_todos(/* ... */) -> Result<i64>;
}
```

### Types

```rust
pub enum TodoType {
    Daily,
    OneOff,
    Aspirational,
}

pub enum TodoPriority {
    Highest = 1,
    High = 2,
    Medium = 3,
    Low = 4,
}

pub struct TodoData {
    pub id: Uuid,
    pub agent_id: Uuid,
    pub world_id: Uuid,
    pub room_id: Uuid,
    pub entity_id: Uuid,
    pub name: String,
    pub description: Option<String>,
    pub todo_type: TodoType,
    pub priority: Option<TodoPriority>,
    pub is_urgent: bool,
    pub is_completed: bool,
    pub due_date: Option<DateTime<Utc>>,
    pub completed_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub metadata: Value,
    pub tags: Vec<String>,
}
```

### Error Handling

```rust
pub enum TodoError {
    Config(String),
    Database(String),
    NotFound(String),
    InvalidInput(String),
    Other(String),
}

pub type Result<T> = std::result::Result<T, TodoError>;
```

## Configuration

```rust
use elizaos_plugin_todo::TodoConfig;

// From environment
let config = TodoConfig::from_env()?;

// Manual
let config = TodoConfig {
    database_url: "postgresql://user:pass@localhost/db".to_string(),
};
```

Environment variables:

- `DATABASE_URL` - PostgreSQL connection string

## License

MIT
