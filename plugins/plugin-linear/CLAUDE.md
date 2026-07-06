# @elizaos/plugin-linear

Linear issue-tracking integration for elizaOS. Adds issue/comment/project/team CRUD, activity tracking, and a `linear_issues` search category to any Eliza agent that has a Linear API key configured.

## Purpose / role

This plugin connects an Eliza agent to Linear via the `@linear/sdk` client. It registers a single composite `LINEAR` action (routing to 11 sub-operations via regex + explicit op dispatch), four context providers, and the `LinearService` singleton. It is opt-in — add the package and set `LINEAR_API_KEY`; the plugin validates the key at startup and refuses to enable the action if no account is configured.

## Plugin surface

### Action

| Name | Description |
|------|-------------|
| `LINEAR` | Single router action. Dispatches to one of 11 sub-ops (see below) based on the `action` parameter or regex-matched message text. Similes include all permutations like `CREATE_LINEAR_ISSUE`, `SEARCH_LINEAR_ISSUES`, etc. |

Sub-operations routed by `LINEAR`:

| Op | Effect |
|----|--------|
| `create_issue` | Create a new issue in a team |
| `get_issue` | Fetch issue details by identifier (e.g. `ENG-123`) |
| `update_issue` | Update title, description, priority, assignee, labels, state, estimate, or due date |
| `delete_issue` | Archive an issue (Linear uses archive, not hard delete) |
| `search_issues` | Filter issues by query, state, assignee, label, project, team, priority |
| `create_comment` | Add a comment body to an issue |
| `update_comment` | Update a comment's body by comment ID |
| `delete_comment` | Delete a comment by ID |
| `list_comments` | List comments on an issue |
| `get_activity` | Return the in-memory activity log (last 1000 ops, configurable limit) |
| `clear_activity` | Wipe the activity log, optionally scoped to an account |

### Providers

| Name | Context gate | Cache | Description |
|------|-------------|-------|-------------|
| `LINEAR_ISSUES` | `automation`, `connectors` | `turn` | Up to 10 recent issues with state + assignee |
| `LINEAR_TEAMS` | `automation`, `connectors` | `agent` | Up to 20 teams with key, name, description |
| `LINEAR_PROJECTS` | `automation`, `connectors` | `agent` | Up to 10 active (`started`/`planned`) projects |
| `LINEAR_ACTIVITY` | `automation`, `connectors` | `turn` | Last 10 activity log entries |

All four require `minRole: ADMIN`.

### Service

| Name | `serviceType` | Description |
|------|--------------|-------------|
| `LinearService` | `"linear"` | Wraps `@linear/sdk` `LinearClient`; manages multi-account map; exposes typed methods for all CRUD ops; maintains an in-memory activity log (capped at 1000 entries). |

### Search category

`linear_issues` — registered via `registerLinearSearchCategory` on init. Supports filters: `query`, `state`, `assignee`, `label`, `project`, `team`, `priority`, `limit`, `accountId`.

### Connector account provider

`createLinearConnectorAccountProvider` registers this plugin with the core `ConnectorAccountManager`, enabling OAuth and API-key account lifecycle (list, create, patch, delete, startOAuth, completeOAuth).

## Layout

```
src/
  index.ts                     Plugin entry — exports linearPlugin, LinearService, accounts utilities
  accounts.ts                  readLinearAccounts(), resolveLinearDefaultAccount(), hasLinearAccountConfig()
  connector-account-provider.ts  ConnectorAccountProvider implementation (OAuth flow + account CRUD)
  search-category.ts           registerLinearSearchCategory() + LINEAR_ISSUES_SEARCH_CATEGORY definition
  prompts.ts                   LLM prompt templates used by action handlers
  types/
    index.ts                   LinearIssueInput, LinearCommentInput, LinearSearchFilters, error classes
  services/
    linear.ts                  LinearService — main SDK wrapper, multi-account client map, activity log
  providers/
    issues.ts                  LINEAR_ISSUES provider
    teams.ts                   LINEAR_TEAMS provider
    projects.ts                LINEAR_PROJECTS provider
    activity.ts                LINEAR_ACTIVITY provider
  actions/
    linear.ts                  linearAction router — ROUTES table, selectRoute(), dispatch logic
    createIssue.ts             create_issue sub-action handler
    getIssue.ts                get_issue sub-action handler
    updateIssue.ts             update_issue sub-action handler (handleUpdateIssue)
    deleteIssue.ts             delete_issue sub-action handler
    searchIssues.ts            search_issues sub-action handler
    createComment.ts           create_comment sub-action handler
    updateComment.ts           update_comment sub-action handler (handleUpdateComment)
    deleteComment.ts           delete_comment sub-action handler
    listComments.ts            list_comments sub-action handler
    getActivity.ts             get_activity sub-action handler
    clearActivity.ts           clear_activity sub-action handler
    account-options.ts         linearAccountIdParameter — shared action parameter definition
    routers.ts                 Routing helpers
    parseLinearPrompt.ts       LLM-assisted prompt parsing for complex inputs
    validate-linear-intent.ts  Intent validation utilities
    index.ts                   Re-exports
```

## Commands

```bash
bun run --cwd plugins/plugin-linear build        # Bun.build bundle + tsc .d.ts → dist/
bun run --cwd plugins/plugin-linear dev          # bun --hot build.ts (rebuild on change)
bun run --cwd plugins/plugin-linear test         # vitest run
bun run --cwd plugins/plugin-linear test:watch   # vitest watch
bun run --cwd plugins/plugin-linear typecheck    # tsgo --noEmit
bun run --cwd plugins/plugin-linear lint         # biome check --write --unsafe
bun run --cwd plugins/plugin-linear format       # biome format --write
bun run --cwd plugins/plugin-linear clean        # rm dist .turbo artifacts
```

## Config / env vars

| Variable | Required | Description |
|----------|----------|-------------|
| `LINEAR_API_KEY` | **Yes** | Personal or workspace API key from linear.app/settings/api |
| `LINEAR_WORKSPACE_ID` | No | Workspace ID; used as the default workspace context |
| `LINEAR_DEFAULT_TEAM_KEY` | No | Team key (e.g. `ENG`) — default team for issue creation when not specified |
| `LINEAR_ACCOUNT_ID` | No | Override the account ID for the single-API-key account (default: `"default"`) |
| `LINEAR_DEFAULT_ACCOUNT_ID` | No | Alias for `LINEAR_ACCOUNT_ID` |
| `LINEAR_ACCOUNTS` | No | JSON array/object of multi-account configs — each entry accepts `apiKey`, `accountId`, `workspaceId`, `defaultTeamKey`, `label` |
| `LINEAR_OAUTH_CLIENT_ID` | OAuth only | Linear OAuth app client ID |
| `LINEAR_OAUTH_CLIENT_SECRET` | OAuth only | Linear OAuth app client secret |
| `LINEAR_OAUTH_REDIRECT_URI` | OAuth only | OAuth redirect URI registered with Linear |

Multi-account config via `LINEAR_ACCOUNTS` accepts either a JSON array or object keyed by account ID. Within each record the plugin also reads nested `credentials`, `metadata`, and `settings` sub-objects for `apiKey` / `workspaceId` / `defaultTeamKey`.

Character-file override: `character.settings.linear.accounts` (array or object) is read before env vars.

## How to extend

### Add a new sub-operation

1. Create `src/actions/<opName>.ts` exporting an `Action` or a `LinearHandlerFn`.
2. Add the op string to the `LinearOp` union and `ALL_OPS` array in `src/actions/linear.ts`.
3. Add a `LinearRoute` entry to `ROUTES` with `op`, a `match` regex, and either `action` or `run`.
4. Import and wire the handler in the ROUTES table.
5. Expose the new simile strings in `linearAction.similes` if needed.

### Add a new provider

1. Create `src/providers/<name>.ts` exporting a `Provider` object with `name`, `get`, `contexts`, `contextGate`.
2. Import and add it to the `providers` array in `src/index.ts`.

### Add a new service method

1. Add the method to `LinearService` in `src/services/linear.ts`.
2. Call `this.logActivity(...)` at the end so the activity log stays consistent.
3. If a new input type is needed, add it to `src/types/index.ts`.

## Conventions / gotchas

- The plugin name in `package.json` is `@elizaos/plugin-linear` but the exported `Plugin.name` is `"@elizaos/plugin-linear-ts"`. Keep both as-is — they serve different registry purposes.
- `deleteIssue` calls `client.archiveIssue` — Linear does not support true hard-deletes on issues via the public API.
- Activity log is in-memory and resets on service stop. Max 1000 entries (oldest evicted).
- Multi-account lookups fall through: explicit `accountId` → `defaultAccountId` setting → first registered account.
- Providers are gated to `minRole: ADMIN` and `contexts: ["automation", "connectors"]`. They will not appear in general conversation context.
- The `LINEAR` action uses `promoteSubactionsToActions` so sub-action names are also available as top-level action names in the agent runtime.
- OAuth flow requires `LINEAR_OAUTH_CLIENT_ID`, `LINEAR_OAUTH_CLIENT_SECRET`, and `LINEAR_OAUTH_REDIRECT_URI`. API-key flow does not need any of these.
- See the root `AGENTS.md` for repo-wide conventions (logger-only, ESM, naming, architecture rules).

<!-- BEGIN: evidence-and-e2e-mandate (managed; canonical standard = repo-root AGENTS.md) -->
## ⛔ NON-NEGOTIABLE — evidence, trajectories & real end-to-end tests

> The binding, repo-wide standard is **[AGENTS.md](../../AGENTS.md)**. Read it.
> Nothing in this package is *done* until it is *proven* done — a reviewer must confirm it
> works **without reading the code**, from the artifacts you attach. This applies to **every**
> feature, fix, refactor, and chore here. "Tests pass" is not proof; "CI is green" is not proof.

- **Record AND read model trajectories.** Capture the *actual* inputs and outputs of the model
  from a **live** LLM — not the deterministic proxy, not a mock: the prompt, the
  providers/context, the raw model output, every tool/action call, and the result. Then **open
  the trajectory and review it by hand.** A captured-but-unread trajectory is not evidence
  (`packages/scenario-runner/bin/eliza-scenarios run <scenario> --report <out>`).
- **Real, full-featured E2E — no larp.** Every feature ships detailed end-to-end tests that
  drive the *real* path end to end. Not the happy "front door" only: cover error paths,
  edge/empty/invalid input, concurrency, roles/permissions, and adversarial input. A test that
  asserts against a mock/stub/fixture standing in for the thing under test **does not count**.
  If the real model/device/chain/connector/account is hard to reach, **make it reachable — that
  is the work**, not an excuse to mock. If the existing tests here are shallow or mocked, fixing
  them is part of your change.
- **Screenshots + logs at every phase**, plus a **complete walkthrough video/run-through** of
  the entire feature or view, start to finish (`bun run test:e2e:record`).
- **Manually review every artifact the change touches** — never just the green check: client
  logs (console + network), server logs (`[ClassName] …`), the model trajectories in and out,
  before/after full-page screenshots, **and the domain artifacts listed below for this package.**
- **No residuals. No shortcuts.** The goal is not "done" — it is *everything* done. Clear every
  blocker by the **hard path**: build the real architecture, stand up the real
  model/device/service, actually test it. Never leave a TODO, a stub, a stepping-stone, or a
  "follow-up." When unsure, research thoroughly, weigh the options, and ship the best,
  highest-effort, production-ready version. Keep going until every possibility is exhausted.

Artifacts → attached inline in the PR (MP4 video, JPG screenshots, logs in `<details>`); attach each evidence type **or**
explicitly mark it N/A with a reason — never leave it blank. If `develop` moved and changed
behavior, **re-capture** evidence; stale proof is worse than none.

**Capture & manually review for this package — platform connector:**
- A real (or sandbox-account) round-trip on the platform: inbound message → agent → outbound reply, captured as logs **and** a screenshot/recording of the actual conversation.
- The raw inbound event/webhook payload and the outbound API request/response, with IDs mapped correctly (`stringToUuid` / `createUniqueUuid`).
- Attachments, threads/replies, edits, multi-account, and rate-limit/error paths — not just a single text ping.
- The agent trajectory for the turn the connector drove.
<!-- END: evidence-and-e2e-mandate -->
