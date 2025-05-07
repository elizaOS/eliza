# Client-GitHub for Eliza Framework

## Purpose

A component of the Eliza framework designed to interact with GitHub repositories, providing functionalities to clone repositories, manage branches, create pull requests, and maintain file-based knowledge for Eliza agents.

## Key Features

- Repository Management: Clone, pull, and switch branches
- File Processing: Generate agent memories from repository files
- Pull Request Management: Create and manage pull requests programmatically
- Commit Operations: Stage, commit, and push files
- Knowledge Base Integration: Convert repository content into agent memories
- Branch Management: Flexible branch switching and creation

## Installation

```bash
bun add @elizaos/client-github
```

## Configuration

Environment variables required:
| Variable | Description | Required |
| ------------------ | ----------------------------------- | -------- |
| `GITHUB_OWNER` | Owner of the GitHub repository | Yes |
| `GITHUB_REPO` | Repository name | Yes |
| `GITHUB_BRANCH` | Target branch (default: `main`) | Yes |
| `GITHUB_PATH` | Path to focus on within the repo | Yes |
| `GITHUB_API_TOKEN` | GitHub API token for authentication | Yes |

## Integration

The client leverages GitHub's REST API via the `@octokit/rest` library and integrates with Eliza framework through the `@elizaos/core` dependency.

## Example Usage

```typescript
// Initialization
import { GitHubClientInterface } from '@elizaos/client-github';
const client = await GitHubClientInterface.start(runtime);

// Creating Memories
await client.createMemoriesFromFiles();

// Creating Pull Requests
await client.createPullRequest(
  'Feature: Add new functionality',
  'feature/new-feature',
  [
    {
      path: 'src/feature.ts',
      content: '// New feature implementation',
    },
  ],
  'Implements new functionality with tests'
);

// Direct Commits
await client.createCommit('Update configuration', [
  {
    path: 'config.json',
    content: JSON.stringify(config, null, 2),
  },
]);
```
