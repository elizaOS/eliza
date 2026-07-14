# @elizaos/plugin-github

GitHub integration for Eliza agents: pull request listing and review, issue lifecycle management, and notification triage via the GitHub REST API.

## Purpose / role

Adds GitHub capabilities to any Eliza agent. The plugin is opt-in — add `"@elizaos/plugin-github"` to the agent's plugin list. It registers a `GitHubService` (Octokit REST client pool), three exposed action handlers promoted under one umbrella `GITHUB` action, seven API routes for agent-scoped credential management (PAT paste + the full OAuth device lifecycle), and a search category for PR lookup.

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
| `GET` | `/api/github/token` | Returns `{ connected, deviceFlowAvailable, username?, scopes?, savedAt? }` — token never returned |
| `POST` | `/api/github/token` | Body `{ token }`. Validates against GitHub `/user`, commits to the shared encrypted vault under this agent's collision-free key, then refreshes the runtime's GitHub clients |
| `DELETE` | `/api/github/token` | Clears only this agent's vault credential and live runtime clients |
| `POST` | `/api/github/device/start` | Starts a GitHub OAuth device flow (needs the `GITHUB_OAUTH_CLIENT_ID` setting; 409 with an owner-setup message otherwise). Returns `{ flowId, userCode, verificationUri, intervalSeconds, expiresInSeconds }` — the GitHub `device_code` never leaves the server |
| `POST` | `/api/github/device/poll` | Body `{ flowId }`. One poll: 200 `{ status: "pending" \| "denied" \| "expired" }` or, on grant, validates + persists like the PAT route and returns `{ status: "complete", …connected status }`. Flows are scoped to the agent that started them |
| `POST` | `/api/github/device/cancel` | Body `{ flowId }`. Cancels an agent-owned flow server-side so later polls cannot revive it |
| `POST` | `/api/github/device/reconnect` | Starts an atomic replacement flow for a connected agent; denial, expiry, or cancellation preserves the current credential |

### Search category

`github_pull_requests` — registered at init via `registerGitHubSearchCategory`. Filters: `query`, `repo`, `state`, `author`, `as`, `accountId`, `limit`. Contexts: `code`, `automation`.

### Connector account provider

Registers with `ConnectorAccountManager` at init to expose GitHub accounts (PAT and OAuth) through the generic connector CRUD + OAuth flow surfaces. OAuth requires `GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET`, `GITHUB_OAUTH_REDIRECT_URI`.

## Layout

```
src/
  index.ts                     Plugin composition root and exports
  register-routes.ts           App-route plugin loader — registers githubPlugin via registerAppRoutePluginLoader
  types.ts                     GitHubIdentity, GitHubOctokitClient, GitHubActions, result types
  accounts.ts                  Account config reading (env + character settings + connector store)
  action-helpers.ts            Shared: service lookup, client resolution, param helpers
  rate-limit.ts                Rate-limit detection and formatting
  github-credentials.ts        Encrypted-vault store with agent-bound credential envelopes
  github-route-adapter.ts      Shared-vault/runtime adapter and seven production routes
  device-flow.ts               Agent-owned OAuth state machine (start/poll/cancel; newest flow wins)
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
    github-routes.ts           Typed PAT + device-flow HTTP boundary
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
| `GITHUB_TOKEN` | No | Agent runtime bootstrap token and the live setting populated from that agent's encrypted guided credential. Guided auth never writes `process.env` |
| `GITHUB_USER_PAT` | No (legacy) | PAT for the `user` role (acting on behalf of the human) |
| `GITHUB_AGENT_PAT` | No (legacy) | PAT for the `agent` role (acting on behalf of the agent) |
| `GITHUB_USER_ACCOUNT_ID` | No | Override account ID for the legacy `user` slot (default: `"user"`) |
| `GITHUB_AGENT_ACCOUNT_ID` | No | Override account ID for the legacy `agent` slot (default: `"agent"`) |
| `ELIZA_E2E_GITHUB_USER_PAT` | No | E2E fallback for `GITHUB_USER_PAT` |
| `ELIZA_E2E_GITHUB_AGENT_PAT` | No | E2E fallback for `GITHUB_AGENT_PAT` |
| `GITHUB_OAUTH_CLIENT_ID` | Device flow or connector OAuth | Public GitHub OAuth app client ID. Device flow must be enabled on the app; the guided device routes require no client secret |
| `GITHUB_OAUTH_CLIENT_SECRET` | Connector callback OAuth only | GitHub OAuth app client secret; not read or sent by the guided device flow |
| `GITHUB_OAUTH_REDIRECT_URI` | Connector callback OAuth only | OAuth redirect URI registered on the GitHub app; not used by device flow |

At least one account source — explicit account records, a role-specific PAT, connector OAuth, or the guided `GITHUB_TOKEN` runtime setting — must exist for actions to resolve a client. The guided credential supplies the default `agent` account only when no explicit agent account is configured; it does not impersonate the `user` role. A missing role is rejected at runtime (logged as `[GitHubService] no GitHub <role> account configured`).

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
- **Route authentication stays at the host boundary.** `handleGitHubRoutes` is exercised through the real runtime plugin dispatcher, whose central gate authenticates before calling the pure route boundary.
- **Rate limits surface cleanly.** `inspectRateLimit` in `rate-limit.ts` detects GitHub rate-limit responses (HTTP 403 with `x-ratelimit-remaining: 0`); `formatRateLimitMessage` renders a human-readable message with the reset time from `x-ratelimit-reset`.
- **Guided credentials are agent-bound and encrypted.** The shared vault key includes a collision-free encoding of `runtime.agentId`, the encrypted envelope repeats that binding, and the token is never returned to the browser. Missing is disconnected; corrupt/unavailable storage is an error.
- **Git subprocesses receive scoped credentials only.** The orchestrator strips ambient `GITHUB_TOKEN`, `GH_TOKEN`, and `CR_PAT`; a selected runtime token travels via GitHub's per-command HTTP extra header rather than process-global mutation.
- **`GitHubOctokitClient` is a structural interface**, not the full Octokit class — tests can inject a mock without depending on the real Octokit.
- **`tsup` builds two entry points:** `src/index.ts` and `src/register-routes.ts`. `register-routes.ts` is an app-route plugin loader that calls `registerAppRoutePluginLoader("@elizaos/plugin-github", ...)` — it registers the full `githubPlugin`, it is not a route-only subset.

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
