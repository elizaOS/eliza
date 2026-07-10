# @elizaos/plugin-github

GitHub integration for elizaOS agents. Enables agents to manage pull requests, issues, and notifications using the GitHub REST API via Octokit.

## What it does

- **List pull requests** — open/closed/all for a specific repo or across accessible repos, with optional author filter.
- **Review pull requests** — submit approve, request-changes, or comment reviews (requires confirmation).
- **Issue management** — create, assign, close, reopen, comment on, or label issues (all write ops require confirmation).
- **Notification triage** — fetch unread GitHub notifications and return them ranked by priority score (reason, subject type, repo freshness). Read-only, no confirmation needed.
- **PAT management** — REST endpoints for storing/removing a GitHub Personal Access Token from local disk (`<state-dir>/credentials/github.json`).

## Enabling the plugin

Add `"@elizaos/plugin-github"` to the agent's `plugins` array in its character file or runtime configuration. The plugin is opt-in.

## Required configuration

At least one GitHub token must be configured. The plugin supports two roles:

- **`user`** — acts on behalf of the human (used for reviews and notifications by default).
- **`agent`** — acts on behalf of the Eliza agent (used for issue and PR ops by default).

### Multi-account (recommended)

Set `GITHUB_ACCOUNTS` to a JSON array:

```json
[
  { "accountId": "user", "role": "user", "token": "ghp_..." },
  { "accountId": "agent", "role": "agent", "token": "ghp_..." }
]
```

### Legacy single-account

| Env var | Role |
|---|---|
| `GITHUB_USER_PAT` | user |
| `GITHUB_AGENT_PAT` | agent |

### OAuth (optional)

To enable OAuth-app flows through the connector account manager, also set:

- `GITHUB_OAUTH_CLIENT_ID`
- `GITHUB_OAUTH_CLIENT_SECRET`
- `GITHUB_OAUTH_REDIRECT_URI`

## Actions

The plugin exposes one umbrella action `GITHUB` that dispatches to sub-operations via an `action` parameter:

| `action` value | What it does |
|---|---|
| `pr_list` | List pull requests |
| `pr_review` | Submit a PR review (requires `review_action`: approve / request-changes / comment) |
| `issue_create` | Create a new issue (`title` required) |
| `issue_assign` | Assign users to an issue |
| `issue_close` | Close an issue |
| `issue_reopen` | Reopen a closed issue |
| `issue_comment` | Add a comment to an issue |
| `issue_label` | Apply labels to an issue |
| `notification_triage` | Fetch and rank unread notifications |

All write operations require confirmation before they execute.

## HTTP routes

The plugin registers five routes on the agent's server for credential
management — they power the guided GitHub connection card in Settings →
Coding Agents (PAT paste or OAuth device sign-in):

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/github/token` | Returns connection status incl. `deviceFlowAvailable` (token never exposed) |
| `POST` | `/api/github/token` | Save a PAT (validated against GitHub `/user` before save; applied to the live runtime's per-agent settings) |
| `DELETE` | `/api/github/token` | Remove the saved PAT (disk + live runtime) |
| `POST` | `/api/github/device/start` | Start a GitHub OAuth device sign-in (needs `GITHUB_OAUTH_CLIENT_ID`); the device code never leaves the server |
| `POST` | `/api/github/device/poll` | Poll a pending sign-in: `pending` / `denied` / `expired`, or validate + save the granted token |

## Development

```bash
bun run --cwd plugins/plugin-github build
bun run --cwd plugins/plugin-github test
bun run --cwd plugins/plugin-github typecheck
```

See [CLAUDE.md](CLAUDE.md) for agent-facing layout and extension guide.
