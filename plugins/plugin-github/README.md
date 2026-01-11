# @elizaos/plugin-github

Multi-language GitHub plugin for elizaOS agents with full feature parity across TypeScript, Python, and Rust implementations.

## Overview

This plugin provides comprehensive GitHub integration for elizaOS agents, enabling them to:

- Create and manage issues
- Create, review, and merge pull requests
- Create branches and push code changes
- Comment on issues and PRs
- Clone and interact with repositories locally

## Installation

### TypeScript/JavaScript

```bash
npm install @elizaos/plugin-github
# or
bun add @elizaos/plugin-github
```

### Python

```bash
pip install elizaos-plugin-github
# or
poetry add elizaos-plugin-github
```

### Rust

```toml
[dependencies]
elizaos-plugin-github = "1.0.0"
```

## Configuration

Set the following environment variables:

| Variable           | Required | Description                    |
| ------------------ | -------- | ------------------------------ |
| `GITHUB_API_TOKEN` | Yes      | GitHub personal access token   |
| `GITHUB_OWNER`     | No       | Default repository owner       |
| `GITHUB_REPO`      | No       | Default repository name        |
| `GITHUB_BRANCH`    | No       | Default branch (default: main) |
| `GITHUB_PATH`      | No       | Local path for cloning repos   |

### Token Permissions

Your GitHub token should have the following scopes:

- `repo` - Full control of private repositories
- `workflow` - Update GitHub Actions workflows (optional)
- `write:packages` - Upload packages (optional)

## Usage

### TypeScript

```typescript
import { githubPlugin } from "@elizaos/plugin-github";

// Register with your agent
const agent = new AgentRuntime({
  plugins: [githubPlugin],
  // ... other config
});
```

### Python

```python
from elizaos_plugin_github import GitHubService, GitHubConfig

config = GitHubConfig.from_env()
service = GitHubService(config)
await service.start()

# Create an issue
issue = await service.create_issue(
    owner="my-org",
    repo="my-repo",
    title="Bug: Something is broken",
    body="Description of the issue",
    labels=["bug"]
)
```

### Rust

```rust
use elizaos_plugin_github::{GitHubConfig, GitHubService, CreateIssueParams};

let config = GitHubConfig::from_env()?;
let mut service = GitHubService::new(config);
service.start().await?;

let issue = service.create_issue(CreateIssueParams {
    owner: "my-org".to_string(),
    repo: "my-repo".to_string(),
    title: "Bug: Something is broken".to_string(),
    body: Some("Description".to_string()),
    assignees: vec![],
    labels: vec!["bug".to_string()],
    milestone: None,
}).await?;
```

## Actions

All implementations provide these actions:

| Action                       | Description                   |
| ---------------------------- | ----------------------------- |
| `CREATE_GITHUB_ISSUE`        | Create a new issue            |
| `CREATE_GITHUB_PULL_REQUEST` | Create a new pull request     |
| `CREATE_GITHUB_COMMENT`      | Comment on an issue or PR     |
| `CREATE_GITHUB_BRANCH`       | Create a new branch           |
| `PUSH_CODE`                  | Push code changes to a branch |
| `MERGE_GITHUB_PULL_REQUEST`  | Merge a pull request          |
| `REVIEW_GITHUB_PULL_REQUEST` | Review a pull request         |

## Providers

| Provider          | Description                               |
| ----------------- | ----------------------------------------- |
| `repositoryState` | Current repository information and status |
| `issueContext`    | Context about recent issues               |

## Project Structure

```
plugin-github/
├── package.json           # Root package with build scripts
├── README.md              # This file
├── typescript/            # TypeScript implementation
│   ├── src/
│   │   ├── actions/       # GitHub actions
│   │   ├── providers/     # Context providers
│   │   ├── config.ts      # Configuration
│   │   ├── error.ts       # Error types
│   │   ├── service.ts     # Main service
│   │   ├── types.ts       # Type definitions
│   │   └── index.ts       # Entry point
│   └── __tests__/         # Tests
├── python/                # Python implementation
│   ├── elizaos_plugin_github/
│   │   ├── actions/       # GitHub actions
│   │   ├── providers/     # Context providers
│   │   ├── config.py      # Configuration
│   │   ├── error.py       # Error types
│   │   ├── service.py     # Main service
│   │   ├── types.py       # Type definitions
│   │   └── __init__.py    # Entry point
│   └── tests/             # Tests
└── rust/                  # Rust implementation
    ├── src/
    │   ├── actions/       # GitHub actions
    │   ├── providers/     # Context providers
    │   ├── config.rs      # Configuration
    │   ├── error.rs       # Error types
    │   ├── service.rs     # Main service
    │   ├── types.rs       # Type definitions
    │   └── lib.rs         # Entry point
    └── tests/             # Tests
```

## Building

```bash
# Build all implementations
bun run build

# Build individually
bun run build:ts      # TypeScript
bun run build:python  # Python
bun run build:rust    # Rust
```

## Testing

```bash
# Run all tests
npx vitest

# Run individually
bun run test:ts      # TypeScript
bun run test:python  # Python
bun run test:rust    # Rust
```

## Feature Parity

All three implementations maintain feature parity:

| Feature           | TypeScript | Python | Rust |
| ----------------- | ---------- | ------ | ---- |
| Issue CRUD        | ✅         | ✅     | ✅   |
| PR Management     | ✅         | ✅     | ✅   |
| Branch Operations | ✅         | ✅     | ✅   |
| Code Push         | ✅         | ✅     | ✅   |
| Reviews           | ✅         | ✅     | ✅   |
| Comments          | ✅         | ✅     | ✅   |
| Webhooks          | ✅         | ✅     | 🔄   |
| Local Git         | ✅         | ✅     | 🔄   |

✅ = Implemented | 🔄 = Planned

## Error Handling

All implementations use strongly-typed errors with no `unknown` or `any` types:

```typescript
// TypeScript
import { GitHubError, RepositoryNotFoundError } from "@elizaos/plugin-github";

try {
  await service.getRepository("owner", "repo");
} catch (error) {
  if (error instanceof RepositoryNotFoundError) {
    console.log(`Repository not found: ${error.owner}/${error.repo}`);
  }
}
```

## License

MIT
