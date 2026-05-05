---
title: "GitHub Plugin"
sidebarTitle: "GitHub"
description: "GitHub connector for Eliza — interact with repositories, issues, and pull requests."
---

The GitHub plugin connects Eliza agents to GitHub, enabling interactions with repositories, issues, pull requests, and other GitHub resources.

**Package:** `@elizaos/plugin-github`

> **Note:** GitHub is categorized as a **feature** plugin in the registry, not a connector. It provides repository management, issue tracking, and PR workflows.

## Installation

```bash
eliza plugins install @elizaos/plugin-github
```

## Setup

### 1. Create a GitHub Personal Access Token

1. Go to [github.com/settings/tokens](https://github.com/settings/tokens)
2. Click **Generate new token** (classic) or **Fine-grained token**
3. Select the scopes needed for your use case (e.g., `repo`, `issues`, `pull_requests`)
4. Copy the generated token

### 2. Configure Eliza

```json
{
  "connectors": {
    "github": {
      "apiToken": "YOUR_API_TOKEN",
      "owner": "YOUR_GITHUB_OWNER",
      "repo": "YOUR_GITHUB_REPO"
    }
  }
}
```

Or via environment variables:

```bash
export GITHUB_API_TOKEN=YOUR_API_TOKEN
export GITHUB_OWNER=YOUR_GITHUB_OWNER
export GITHUB_REPO=YOUR_GITHUB_REPO
```

## Configuration

| Field | Required | Description |
|-------|----------|-------------|
| `apiToken` | Yes | GitHub personal access token |
| `owner` | No | Default GitHub repository owner (username or organization) |
| `repo` | No | Default GitHub repository name |
| `branch` | No | Default branch name (defaults to `main`) |
| `appId` | No | GitHub App ID for app-based authentication |
| `appPrivateKey` | No | GitHub App private key for app-based authentication |
| `installationId` | No | GitHub App installation ID |
| `webhookSecret` | No | Secret for validating GitHub webhook payloads |
| `enabled` | No | Set `false` to disable (default: `true`) |

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `GITHUB_API_TOKEN` | Yes | GitHub personal access token (primary auto-enable trigger) |
| `GITHUB_OWNER` | No | Default repository owner (username or organization) |
| `GITHUB_REPO` | No | Default repository name |
| `GITHUB_BRANCH` | No | Default branch name |
| `GITHUB_APP_ID` | No | GitHub App ID (for GitHub App authentication) |
| `GITHUB_APP_PRIVATE_KEY` | No | GitHub App private key |
| `GITHUB_INSTALLATION_ID` | No | GitHub App installation ID |
| `GITHUB_WEBHOOK_SECRET` | No | Secret for webhook signature verification |

## Related

- [Connectors Guide](/guides/connectors) — General connector documentation
