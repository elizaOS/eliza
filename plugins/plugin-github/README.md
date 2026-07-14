# @elizaos/plugin-github

GitHub integration for elizaOS agents. Enables agents to manage pull requests, issues, and notifications using the GitHub REST API via Octokit.

## What it does

- **List pull requests** — open/closed/all for a specific repo or across accessible repos, with optional author filter.
- **Review pull requests** — submit approve, request-changes, or comment reviews (requires confirmation).
- **Issue management** — create, assign, close, reopen, comment on, or label issues (all write ops require confirmation).
- **Notification triage** — fetch unread GitHub notifications and return them ranked by priority score (reason, subject type, repo freshness). Read-only, no confirmation needed.
- **Guided authentication** — PAT and OAuth device sign-in, stored per agent in the shared encrypted vault and applied without a restart.

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

The settings card's device flow needs a GitHub OAuth App client ID with
**Enable Device Flow** checked:

- `GITHUB_OAUTH_CLIENT_ID`

Device flow is a public-client protocol: it does not use a client secret or
callback. The separate connector callback-OAuth surface also requires:

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

The plugin registers seven routes on the agent's server for credential
management — they power the guided GitHub connection card in Settings →
Coding Agents (PAT paste or OAuth device sign-in):

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/github/token` | Returns connection status incl. `deviceFlowAvailable` (token never exposed) |
| `POST` | `/api/github/token` | Validate a PAT against GitHub `/user`, save it in this agent's encrypted vault record, and refresh live clients |
| `DELETE` | `/api/github/token` | Remove only this agent's vault credential and refresh live clients |
| `POST` | `/api/github/device/start` | Start a GitHub OAuth device sign-in (needs `GITHUB_OAUTH_CLIENT_ID`); the device code never leaves the server |
| `POST` | `/api/github/device/poll` | Poll a pending sign-in: `pending` / `denied` / `expired`, or validate + save the granted token |
| `POST` | `/api/github/device/cancel` | Cancel an agent-owned pending flow server-side |
| `POST` | `/api/github/device/reconnect` | Atomically replace a connected credential; unsuccessful flows preserve the old one |

Every device flow and vault record is bound to `runtime.agentId`. The plugin
never writes an agent token into `process.env`, and the orchestrator strips
ambient GitHub token variables from child processes before supplying a selected
runtime credential through a command-scoped Git HTTP header.

## Development

```bash
bun run --cwd plugins/plugin-github build
bun run --cwd plugins/plugin-github test
bun run --cwd plugins/plugin-github typecheck
```

See [CLAUDE.md](CLAUDE.md) for agent-facing layout and extension guide.
