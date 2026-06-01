# @elizaos/plugin-github

GitHub integration for Eliza agents: pull request listing and review, issue lifecycle management, and notification triage via the GitHub REST API.

## Purpose / role

Adds GitHub capabilities to any Eliza agent. The plugin is opt-in — add `"@elizaos/plugin-github"` to the agent's plugin list. It registers a `GitHubService` (Octokit REST client pool), three exposed action handlers promoted under one umbrella `GITHUB` action, three API routes for PAT management, and a search category for PR lookup.

## Plugin surface

### Actions (registered via `promoteSubactionsToActions(githubAction)`)

The umbrella action `GITHUB` dispatches to three sub-actions based on the `action` parameter:

| Action name | Constant | Sub-actions / ops | Default identity | Confirmation |
|---|---|---|---|---|
| `GITHUB` | umbrella | routes to all ops below | per op | per op |
| `GITHUB_ISSUE` | `GitHubActions.GITHUB_ISSUE_OP` | `create`, `assign`, `close`, `reopen`, `comment`, `label` | `agent` | required (`requireConfirmation`) |
| `GITHUB_PR` | `GitHubActions.GITHUB_PR_OP` | `list`, `review` | `agent` (list) / `user` (review) | required for `review` |
| `GITHUB_NOTIFICATION_TRIAGE` | `GitHubActions.GITHUB_NOTIFICATION_TRIAGE` | reads + scores unread notifications | `user` | none (read-only) |

All actions gate on `contextGate: { anyOf: ["code", "tasks", "connectors", "automation"] }` and `roleGate: { minRole: "USER" }`.

### Services

| Service class | `serviceType` | Purpose |
|---|---|---|
| `GitHubService` | `"github"` | Octokit client pool — resolves clients by role (`user`/`agent`) or explicit `accountId` |

### Routes

Registered at plugin init on the agent's HTTP server:

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/github/token` | Returns `{ connected, username?, scopes?, savedAt? }` — token never returned |
| `POST` | `/api/github/token` | Body `{ token }`. Validates against GitHub `/user`, persists to `<state-dir>/credentials/github.json` |
| `DELETE` | `/api/github/token` | Clears saved credential |

### Search category

`github_pull_requests` — registered at init via `registerGitHubSearchCategory`. Filters: `query`, `repo`, `state`, `author`, `as`, `accountId`, `limit`. Contexts: `code`, `automation`.

### Connector account provider

Registers with `ConnectorAccountManager` at init to expose GitHub accounts (PAT and OAuth) through the generic connector CRUD + OAuth flow surfaces. OAuth requires `GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET`, `GITHUB_OAUTH_REDIRECT_URI`.

## Layout

```
src/
  index.ts                     Plugin export, route wiring, plugin object
  types.ts                     GitHubIdentity, GitHubOctokitClient, GitHubActions, result types
  accounts.ts                  Account config reading (env + character settings + connector store)
  action-helpers.ts            Shared: service lookup, client resolution, param helpers
  rate-limit.ts                Rate-limit detection and formatting
  github-credentials.ts        Local PAT store: load/save/clear at <state-dir>/credentials/github.json
  search-category.ts           github_pull_requests search category registration
  connector-account-provider.ts  ConnectorAccountManager bridge (PAT + OAuth flows)
  connector-credential-refs.ts   Credential ref persistence helpers
  actions/
    github.ts                  GITHUB umbrella action — dispatches by action= param
    issue-op.ts                GITHUB_ISSUE action (create/assign/close/reopen/comment/label)
    pr-op.ts                   GITHUB_PR action (list/review)
    notification-triage.ts     GITHUB_NOTIFICATION_TRIAGE action + scoreNotification export
  services/
    github-service.ts          GitHubService — Octokit client pool, account resolution
  routes/
    github-routes.ts           Pure handleGitHubRoutes dispatcher for PAT CRUD endpoints
```

## Commands

```bash
bun run --cwd plugins/plugin-github build       # tsup ESM build + .d.ts
bun run --cwd plugins/plugin-github test        # vitest run
bun run --cwd plugins/plugin-github typecheck   # tsgo --noEmit
bun run --cwd plugins/plugin-github clean       # rm dist .turbo
```

## Config / env vars

| Env var | Required | Purpose |
|---|---|---|
| `GITHUB_ACCOUNTS` | No (preferred) | JSON array/object of `{ accountId, role, token }` records — supports multiple accounts |
| `GITHUB_USER_PAT` | No (legacy) | PAT for the `user` role (acting on behalf of the human) |
| `GITHUB_AGENT_PAT` | No (legacy) | PAT for the `agent` role (acting on behalf of the agent) |
| `GITHUB_USER_ACCOUNT_ID` | No | Override account ID for the legacy `user` slot (default: `"user"`) |
| `GITHUB_AGENT_ACCOUNT_ID` | No | Override account ID for the legacy `agent` slot (default: `"agent"`) |
| `ELIZA_E2E_GITHUB_USER_PAT` | No | E2E fallback for `GITHUB_USER_PAT` |
| `ELIZA_E2E_GITHUB_AGENT_PAT` | No | E2E fallback for `GITHUB_AGENT_PAT` |
| `GITHUB_OAUTH_CLIENT_ID` | OAuth only | GitHub OAuth app client ID |
| `GITHUB_OAUTH_CLIENT_SECRET` | OAuth only | GitHub OAuth app client secret |
| `GITHUB_OAUTH_REDIRECT_URI` | OAuth only | OAuth redirect URI registered on the GitHub app |

At least one of `GITHUB_ACCOUNTS`, `GITHUB_USER_PAT`, or `GITHUB_AGENT_PAT` must be set for the plugin to function. A missing `user` or `agent` account causes that role's operations to be rejected at runtime (logged as `[GitHubService] no GitHub <role> account configured`).

Character-level config is also supported under `character.settings.github.accounts` (array or object keyed by account ID).

## How to extend

**Add a new action:**
1. Create `src/actions/my-op.ts` exporting a typed `Action` with `name`, `contexts`, `contextGate`, `roleGate`, `validate`, and `handler`.
2. Use `buildResolvedClient(runtime, selection)` from `action-helpers.ts` to get an authenticated Octokit client.
3. Call `requireConfirmation` from `@elizaos/core` for any write op.
4. Register the new action in `src/actions/github.ts` by extending `GITHUB_ACTIONS` and adding a dispatch branch in the umbrella handler, OR add it directly to the `actions` array in `src/index.ts`.

**Add a new provider/evaluator:**
Export from `src/index.ts` and add to the `githubPlugin` object's `providers` or `evaluators` arrays.

**Add a new route:**
Add an entry to `githubRoutes` in `src/index.ts` and a handler in `src/routes/github-routes.ts`. Routes use raw `http.IncomingMessage` / `http.ServerResponse` — no Express.

## Conventions / gotchas

- **Confirmation is not optional for write ops.** All write actions use `requireConfirmation` from `@elizaos/core`. The `confirmed: true` parameter in the action schema is vestigial — the runtime confirmation gate is authoritative. `isConfirmed` in `action-helpers.ts` always returns `false` and is deprecated.
- **Two identity roles, two PATs.** `user` = human acting; `agent` = the Eliza agent acting. Operations that affect the repo on behalf of the agent use `agent`; operations that respond as the user (reviews, notifications) default to `user`.
- **Account precedence:** `GITHUB_ACCOUNTS` JSON > `GITHUB_USER_PAT`/`GITHUB_AGENT_PAT` legacy env vars. Character settings are layered in before env vars. ConnectorAccountManager credentials (OAuth) overlay everything by `accountId`.
- **No test harness for route auth.** `handleGitHubRoutes` is a pure dispatcher with no auth. The agent's server layer is expected to authenticate before calling the route handler.
- **Rate limits surface cleanly.** `inspectRateLimit` in `rate-limit.ts` detects GitHub 429/403 rate-limit responses and formats a human-readable message with reset time.
- **PAT storage is local-first.** `<state-dir>/credentials/github.json` (mode 0600). Written atomically via a tmp-rename. The token is never returned to the browser via the GET route.
- **`GitHubOctokitClient` is a structural interface**, not the full Octokit class — tests can inject a mock without depending on the real Octokit.
- **`tsup` builds two entry points:** `src/index.ts` and `src/register-routes.ts` (for route-only consumers that don't want the full plugin).
