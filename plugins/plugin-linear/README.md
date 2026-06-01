# @elizaos/plugin-linear

Linear issue-tracking integration for [elizaOS](https://github.com/elizaos/eliza). Gives Eliza agents full CRUD control over Linear issues, comments, teams, and projects through natural-language commands.

## What it does

- Create, read, update, archive, and search Linear issues
- Add, update, delete, and list comments on issues
- Browse teams and active projects as agent context
- Track an in-memory activity log of all Linear operations the agent performs
- Register as a named search category (`linear_issues`) for structured issue queries
- Support both API-key and OAuth workspace authentication
- Multi-account configuration — manage multiple Linear workspaces from one agent

## Requirements

- Node.js runtime (ESM)
- A Linear API key from [linear.app/settings/api](https://linear.app/settings/api)

## Installation

```bash
bun add @elizaos/plugin-linear
```

## Configuration

### Minimal (single workspace, API key)

```env
LINEAR_API_KEY=lin_api_xxxxxxxxxxxxxxxxxxxxx
```

### Full options

```env
# Required
LINEAR_API_KEY=lin_api_xxxxxxxxxxxxxxxxxxxxx

# Optional
LINEAR_WORKSPACE_ID=your_workspace_id
LINEAR_DEFAULT_TEAM_KEY=ENG          # default team key for new issues
LINEAR_ACCOUNT_ID=default            # label for this account in multi-account setups

# Multi-account (JSON array or object keyed by account ID)
LINEAR_ACCOUNTS=[{"accountId":"work","apiKey":"lin_api_...","defaultTeamKey":"ENG"},{"accountId":"oss","apiKey":"lin_api_..."}]

# OAuth (only needed if using OAuth flow instead of API keys)
LINEAR_OAUTH_CLIENT_ID=your_client_id
LINEAR_OAUTH_CLIENT_SECRET=your_client_secret
LINEAR_OAUTH_REDIRECT_URI=https://your-app/oauth/linear/callback
```

Character-file alternative — set `character.settings.linear.accounts` to an array or object of account configs with the same fields.

## Enabling the plugin

Add it to your agent's plugin list:

```typescript
import { linearPlugin } from "@elizaos/plugin-linear";

const agent = new AgentRuntime({
  plugins: [linearPlugin],
  // ...
});
```

The plugin validates the Linear API key on startup and will throw `LinearAuthenticationError` if none is found or the key is invalid.

## Capabilities

### Actions

The plugin exposes a single `LINEAR` action that routes to 11 operations. The agent infers the operation from context, or you can pass `action` explicitly.

| Operation | What it does |
|-----------|-------------|
| `create_issue` | Create a new issue in a team |
| `get_issue` | Fetch issue details by identifier (e.g. `ENG-123`) |
| `update_issue` | Change title, description, priority, assignee, labels, state, estimate, or due date |
| `delete_issue` | Archive an issue |
| `search_issues` | Filter issues by query, state, assignee, label, project, team, or priority |
| `create_comment` | Add a comment to an issue |
| `update_comment` | Edit a comment |
| `delete_comment` | Remove a comment |
| `list_comments` | List comments on an issue |
| `get_activity` | View the agent's operation history log |
| `clear_activity` | Clear the activity log |

Example triggers:

- "Create a Linear issue for the login bug in team ENG"
- "What's the status of ENG-456?"
- "Comment on ENG-123 that QA can retest"
- "Search open high-priority bugs assigned to alice"
- "Update ENG-789 priority to urgent"

### Context providers

These inject Linear data into the agent's context window automatically when relevant. All require `ADMIN` role.

| Provider | Data injected |
|----------|--------------|
| `LINEAR_ISSUES` | Up to 10 recent issues with state and assignee |
| `LINEAR_TEAMS` | Up to 20 teams with key, name, description |
| `LINEAR_PROJECTS` | Up to 10 active projects with state and dates |
| `LINEAR_ACTIVITY` | Last 10 Linear operations the agent performed |

### Search category

The plugin registers a `linear_issues` search category that accepts structured filters: `query`, `state`, `assignee`, `label`, `project`, `team`, `priority`, `limit`, `accountId`.

## Priority values

Linear uses numeric priorities: `1` = Urgent, `2` = High, `3` = Normal, `4` = Low, `0` = No priority.

## Notes

- "Delete issue" calls Linear's archive endpoint — Linear does not expose hard-delete via the public API.
- The activity log is in-memory and resets when the agent stops. Maximum 1000 entries.
- All four providers are gated to the `automation` and `connectors` contexts, so they appear only when those contexts are active.

## License

MIT
