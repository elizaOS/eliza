# elizaos-plugin-github (Python)

Python implementation of the GitHub plugin for elizaOS.

## Installation

```bash
pip install elizaos-plugin-github
```

## Usage

```python
from elizaos_plugin_github import GitHubConfig, GitHubService

# Create configuration
config = GitHubConfig(
    api_token="ghp_your_token_here",
    owner="my-org",
    repo="my-repo",
)

# Create service
service = GitHubService(config)

# Start service
await service.start()

# Create an issue
from elizaos_plugin_github.types import CreateIssueParams

issue = await service.create_issue(
    CreateIssueParams(
        owner="my-org",
        repo="my-repo",
        title="Bug: Something is broken",
        body="Description of the bug...",
        labels=["bug"],
    )
)
print(f"Created issue #{issue.number}")

# Create a pull request
from elizaos_plugin_github.types import CreatePullRequestParams

pr = await service.create_pull_request(
    CreatePullRequestParams(
        owner="my-org",
        repo="my-repo",
        title="Fix the bug",
        head="fix/bug-123",
        base="main",
    )
)
print(f"Created PR #{pr.number}")

# Stop service
await service.stop()
```

## Configuration

The plugin can be configured via environment variables:

- `GITHUB_API_TOKEN` (required): GitHub personal access token
- `GITHUB_OWNER`: Default repository owner
- `GITHUB_REPO`: Default repository name
- `GITHUB_BRANCH`: Default branch (defaults to "main")
- `GITHUB_WEBHOOK_SECRET`: Secret for webhook verification
- `GITHUB_APP_ID`: GitHub App ID for app authentication
- `GITHUB_APP_PRIVATE_KEY`: GitHub App private key
- `GITHUB_INSTALLATION_ID`: GitHub App installation ID

## Features

### Repository Operations

- Get repository information
- List repositories

### Issue Operations

- Create issues
- Get issue details
- Update issues
- List issues
- Close/reopen issues

### Pull Request Operations

- Create pull requests
- Get PR details
- Update pull requests
- List pull requests
- Merge pull requests

### Review Operations

- Create reviews (approve, request changes, comment)
- List reviews

### Comment Operations

- Create comments on issues/PRs
- List comments

### Branch Operations

- Create branches
- Delete branches
- List branches

### File Operations

- Get file content
- List directory contents

### Commit Operations

- Create commits with file changes

## Development

```bash
# Install dev dependencies
pip install -e ".[dev]"

# Run tests
pytest

# Type checking
mypy elizaos_plugin_github

# Linting
ruff check .
ruff format .
```

## License

MIT



