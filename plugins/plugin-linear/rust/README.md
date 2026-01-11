# elizaos-plugin-linear

Rust implementation of the Linear integration plugin for ElizaOS.

## Features

- **Issue Management**: Create, read, update, delete, and search issues
- **Comment Management**: Add comments to issues
- **Team Operations**: List and filter teams
- **Project Management**: List and filter projects
- **Activity Tracking**: Track and view Linear operations
- **Async/Await**: Full async support with Tokio
- **Type Safety**: Strong typing with serde for serialization

## Installation

Add to your `Cargo.toml`:

```toml
[dependencies]
elizaos-plugin-linear = "1.0"
```

## Configuration

Set these environment variables:

```bash
export LINEAR_API_KEY=your_api_key          # Required
export LINEAR_WORKSPACE_ID=your_workspace   # Optional
export LINEAR_DEFAULT_TEAM_KEY=ENG          # Optional
```

## Usage

```rust
use elizaos_plugin_linear::{LinearService, LinearConfig, IssueInput};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let config = LinearConfig {
        api_key: std::env::var("LINEAR_API_KEY")?,
        workspace_id: std::env::var("LINEAR_WORKSPACE_ID").ok(),
        default_team_key: std::env::var("LINEAR_DEFAULT_TEAM_KEY").ok(),
    };

    let service = LinearService::start(config).await?;

    // Create an issue
    let issue = service.create_issue(IssueInput {
        title: "Fix login button".to_string(),
        team_id: "team-123".to_string(),
        description: Some("The login button is not responsive".to_string()),
        priority: Some(2),
        ..Default::default()
    }).await?;

    println!("Created issue: {} ({})", issue.title, issue.identifier);

    // Search issues
    let issues = service.search_issues(SearchFilters {
        query: Some("bug".to_string()),
        limit: Some(10),
        ..Default::default()
    }).await?;

    for issue in issues {
        println!("- {}: {}", issue.identifier, issue.title);
    }

    Ok(())
}
```

## Actions

| Action                  | Description               |
| ----------------------- | ------------------------- |
| `CREATE_LINEAR_ISSUE`   | Create a new issue        |
| `GET_LINEAR_ISSUE`      | Get issue details         |
| `UPDATE_LINEAR_ISSUE`   | Update an existing issue  |
| `DELETE_LINEAR_ISSUE`   | Archive an issue          |
| `SEARCH_LINEAR_ISSUES`  | Search for issues         |
| `CREATE_LINEAR_COMMENT` | Add a comment to an issue |
| `LIST_LINEAR_TEAMS`     | List teams                |
| `LIST_LINEAR_PROJECTS`  | List projects             |
| `GET_LINEAR_ACTIVITY`   | View activity log         |
| `CLEAR_LINEAR_ACTIVITY` | Clear activity log        |

## Providers

| Provider          | Description                   |
| ----------------- | ----------------------------- |
| `LINEAR_ISSUES`   | Context about recent issues   |
| `LINEAR_TEAMS`    | Context about teams           |
| `LINEAR_PROJECTS` | Context about projects        |
| `LINEAR_ACTIVITY` | Context about recent activity |

## Development

```bash
# Build
cargo build

# Test
cargo test

# Run with optimizations
cargo build --release

# Check formatting
cargo fmt --check

# Run clippy
cargo clippy
```

## Error Handling

The library provides typed errors:

```rust
use elizaos_plugin_linear::LinearError;

match service.get_issue("ENG-123").await {
    Ok(issue) => println!("Found: {}", issue.title),
    Err(LinearError::NotFound(msg)) => println!("Not found: {}", msg),
    Err(LinearError::Authentication(msg)) => println!("Auth error: {}", msg),
    Err(LinearError::RateLimit { reset_time }) => {
        println!("Rate limited, retry after {} seconds", reset_time);
    }
    Err(e) => println!("Error: {}", e),
}
```

## License

MIT



