# @elizaos/plugin-linear

A comprehensive Linear integration plugin for ElizaOS, available in **TypeScript**, **Python**, and **Rust**.

## Overview

This plugin enables AI agents to interact with Linear's issue tracking and project management system through natural language. All three language implementations provide complete feature parity.

## Languages

| Language   | Package                     | Directory                      |
| ---------- | --------------------------- | ------------------------------ |
| TypeScript | `@elizaos/plugin-linear-ts` | [`typescript/`](./typescript/) |
| Python     | `elizaos-plugin-linear`     | [`python/`](./python/)         |
| Rust       | `elizaos-plugin-linear`     | [`rust/`](./rust/)             |

## Features

### 📋 Issue Management

- **Create Issues**: Create new issues with title, description, priority, assignees, and labels
- **Get Issue Details**: Retrieve comprehensive information about specific issues
- **Update Issues**: Modify existing issues with new information
- **Delete Issues**: Archive issues (move to archived state)
- **Search Issues**: Find issues using various filters and search criteria
- **Add Comments**: Comment on existing issues

### 👥 Team & User Management

- **List Teams**: View all teams in your Linear workspace
- **Get Team Details**: Retrieve specific team information

### 📊 Project Management

- **List Projects**: View all projects, optionally filtered by team
- **Get Project Details**: Retrieve specific project information

### 📈 Activity Tracking

- **Activity Log**: Track all Linear operations performed by the agent
- **Clear Activity**: Reset the activity log

## Configuration

All implementations require the same environment variables:

```env
# Required
LINEAR_API_KEY=your_linear_api_key

# Optional
LINEAR_WORKSPACE_ID=your_workspace_id
LINEAR_DEFAULT_TEAM_KEY=ENG
```

## Actions

All languages implement these actions with full parity:

| Action                  | Description                       |
| ----------------------- | --------------------------------- |
| `CREATE_LINEAR_ISSUE`   | Create a new issue                |
| `GET_LINEAR_ISSUE`      | Get issue details by ID or search |
| `UPDATE_LINEAR_ISSUE`   | Update an existing issue          |
| `DELETE_LINEAR_ISSUE`   | Archive an issue                  |
| `SEARCH_LINEAR_ISSUES`  | Search for issues with filters    |
| `CREATE_LINEAR_COMMENT` | Add a comment to an issue         |
| `LIST_LINEAR_TEAMS`     | List all teams                    |
| `LIST_LINEAR_PROJECTS`  | List all projects                 |
| `GET_LINEAR_ACTIVITY`   | View activity log                 |
| `CLEAR_LINEAR_ACTIVITY` | Clear activity log                |

## Providers

All languages implement these providers:

| Provider          | Description                   |
| ----------------- | ----------------------------- |
| `LINEAR_ISSUES`   | Context about recent issues   |
| `LINEAR_TEAMS`    | Context about teams           |
| `LINEAR_PROJECTS` | Context about active projects |
| `LINEAR_ACTIVITY` | Context about recent activity |

## Usage Examples

### Natural Language Queries

```
"Create a new issue: Fix login button not working on mobile devices"
"Show me issue ENG-123"
"What's the status of the payment bug?"
"Update issue COM2-7 priority to high"
"Show me all high priority bugs assigned to John"
"Comment on ENG-123: This has been fixed in the latest release"
"Show me all teams"
"List projects for the engineering team"
```

## Installation

### TypeScript

```bash
npm install @elizaos/plugin-linear-ts
# or
bun add @elizaos/plugin-linear-ts
```

```typescript
import { linearPlugin } from "@elizaos/plugin-linear-ts";
agent.registerPlugin(linearPlugin);
```

### Python

```bash
pip install elizaos-plugin-linear
```

```python
from elizaos_plugin_linear import linear_plugin
agent.register_plugin(linear_plugin)
```

### Rust

```toml
[dependencies]
elizaos-plugin-linear = "1.0"
```

```rust
use elizaos_plugin_linear::{LinearService, LinearConfig};

let service = LinearService::start(config).await?;
```

## Development

Each language has its own development workflow:

### TypeScript

```bash
cd typescript
npm install
npm run build
npm test
```

### Python

```bash
cd python
pip install -e ".[dev]"
pytest
```

### Rust

```bash
cd rust
cargo build
cargo test
```

## Priority Levels

Linear uses numeric priority levels:

- 0: No priority
- 1: Urgent
- 2: High
- 3: Normal (default)
- 4: Low

## Error Handling

All implementations provide custom error types:

- `LinearAPIError` / `LinearError::Api`: General API errors
- `LinearAuthenticationError` / `LinearError::Authentication`: Authentication failures
- `LinearRateLimitError` / `LinearError::RateLimit`: Rate limit exceeded

## License

MIT

## Contributing

Contributions are welcome! Please ensure changes maintain feature parity across all three language implementations.

## Support

For issues and feature requests, please create an issue on the [GitHub repository](https://github.com/elizaos/eliza).
