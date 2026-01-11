# elizaOS GitHub Plugin - Rust

Rust implementation of the GitHub plugin for elizaOS agents.

## Features

- **Repository Operations**: Get repository info, list contents
- **Issue Management**: Create, list, get, update issues
- **Pull Request Management**: Create, list, merge PRs
- **Branch Operations**: Create and delete branches
- **Code Review**: Create reviews and comments
- **Type Safety**: Strongly typed with no `unknown` or `any`

## Installation

Add to your `Cargo.toml`:

```toml
[dependencies]
elizaos-plugin-github = "1.0.0"
```

## Quick Start

```rust
use elizaos_plugin_github::{GitHubConfig, GitHubService};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Load config from environment
    let config = GitHubConfig::from_env()?;

    // Create and start service
    let mut service = GitHubService::new(config);
    service.start().await?;

    // Create an issue
    use elizaos_plugin_github::CreateIssueParams;

    let issue = service.create_issue(CreateIssueParams {
        owner: "my-org".to_string(),
        repo: "my-repo".to_string(),
        title: "Bug: Something is broken".to_string(),
        body: Some("Description of the bug".to_string()),
        assignees: vec!["developer".to_string()],
        labels: vec!["bug".to_string()],
        milestone: None,
    }).await?;

    println!("Created issue #{}: {}", issue.number, issue.html_url);

    Ok(())
}
```

## Environment Variables

| Variable                | Required | Description                    |
| ----------------------- | -------- | ------------------------------ |
| `GITHUB_API_TOKEN`      | Yes      | GitHub personal access token   |
| `GITHUB_OWNER`          | No       | Default repository owner       |
| `GITHUB_REPO`           | No       | Default repository name        |
| `GITHUB_BRANCH`         | No       | Default branch (default: main) |
| `GITHUB_WEBHOOK_SECRET` | No       | Webhook verification secret    |

## Actions

| Action                    | Description                |
| ------------------------- | -------------------------- |
| `CreateIssueAction`       | Create new issues          |
| `CreatePullRequestAction` | Create pull requests       |
| `CreateCommentAction`     | Add comments to issues/PRs |
| `CreateBranchAction`      | Create branches            |
| `MergePullRequestAction`  | Merge pull requests        |

## Providers

| Provider                  | Description                    |
| ------------------------- | ------------------------------ |
| `RepositoryStateProvider` | Current repository information |
| `IssueContextProvider`    | Recent issues context          |

## Building

```bash
# Development build
cargo build

# Release build
cargo build --release

# Run tests
cargo test
```

## WASM Support

The crate supports WebAssembly via the `wasm` feature:

```toml
[dependencies]
elizaos-plugin-github = { version = "1.0.0", default-features = false, features = ["wasm"] }
```

## License

MIT



