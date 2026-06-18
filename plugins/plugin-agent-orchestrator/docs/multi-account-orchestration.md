# Multi-account coding-agent orchestration

Goal: an Eliza orchestrator agent that runs **multiple Claude Code, Codex (and
z.ai / OpenCode) subscriptions**, picks the **least-used** account for each new
sub-agent, tracks per-account **session + weekly usage**, manages those
sub-agents in a **shared task room**, and decides **when to interrupt** a
running sub-agent vs. let it keep working.

## What already existed (do not rebuild)

| Layer | Location | Status |
|---|---|---|
| Account contracts (`LinkedAccountConfig`, `LinkedAccountUsage`, 12 provider ids) | `packages/contracts/src/service-routing.ts` | ✅ |
| Credential storage (`<stateDir>/auth/{providerId}/{accountId}.json`) | `packages/agent/src/auth/account-storage.ts` | ✅ |
| OAuth flows (Anthropic + Codex) + coding-plan keys + API keys | `packages/agent/src/auth/oauth-flow.ts`, `credentials.ts` | ✅ |
| `AccountPool` — priority / round-robin / **least-used** / quota-aware, affinity, health | `packages/app-core/src/services/account-pool.ts` | ✅ |
| Usage probes (`pollAnthropicUsage`, `pollCodexUsage`) + JSONL day counters | `packages/app-core/src/services/account-usage.ts` | ✅ |
| Accounts REST API (`/api/accounts/*` incl. OAuth SSE) | `packages/agent/src/api/accounts-routes.ts` | ✅ |
| Settings UI (AccountList / AccountCard / AddAccountDialog / RotationStrategyPicker) + `useAccounts` | `packages/ui/src/components/accounts/*` | ✅ |
| Multi-account API-key routing for the *main agent* | `credential-resolver.ts` → `resolveProviderCredentialMulti` | ✅ |
| Orchestrator tasks, sessions, task-rooms, event bridge, usage rollup, REST + SSE | `plugins/plugin-agent-orchestrator/*` | ✅ |
| `shouldRespond` (RESPOND/IGNORE/STOP) + per-room `TurnControllerRegistry` abort | `packages/core/src/*` | ✅ |

## The keystone gap

The `AccountPool` was wired into **API-key model routing** but **not into the
coding-agent spawn path**. Coding agents authenticate by *subscription*, not API
key: `applySubscriptionCredentialsLocal` never injects Claude/Codex tokens into
`process.env`, and `AcpService.buildEnv` even *strips* an OAuth
`ANTHROPIC_API_KEY` so Claude Code falls back to the single machine login
(`~/.claude`). So every spawned sub-agent used one account, with no rotation and
no per-account attribution.

The orchestrator plugin depends only on `@elizaos/core`, so it cannot import the
pool. `account-pool.ts` already solves this with `globalThis`-symbol **bridges**
(Anthropic + subscription-selector). We add a third: a **coding-agent selector
bridge**.

## Hitlist

### P0 — Keystone: account selection on spawn (round-robin / least-used)
- [x] `coding-account-bridge.ts` (app-core): install `Symbol.for("eliza.account-pool.coding-agent.v1")` bridge — `select(agentType)`, `markRateLimited`, `markNeedsReauth`, `recordUsage`, `describe()`.
- [x] Per-agent credential injection: claude → `CLAUDE_CODE_OAUTH_TOKEN`; codex → per-account `CODEX_HOME/auth.json`; direct API providers → their env key; z.ai coding key.
- [x] Wire into `AcpService.spawnSession`: select before transport branch, merge `envPatch` into `customCredentials`, stamp `session.metadata.account*`, surface on `SpawnResult.metadata`.
- [x] `buildEnv`: when `CLAUDE_CODE_OAUTH_TOKEN` is injected for claude, drop `ANTHROPIC_API_KEY` so the selected subscription wins.
- [x] `OrchestratorTaskSession` carries `accountProviderId` / `accountId` / `accountLabel`; populate from `result.metadata`.
- [x] Exclude-on-failure retry: on auth/rate-limit error, mark account + re-select excluding it.

### P1 — Usage attribution + stats
- [x] `recordUsage` also calls the bridge → pool `recordCall` + `account-usage` JSONL keyed by the serving account.
- [x] `/api/orchestrator/accounts` route: connected accounts + live usage + which sub-agents are on which account.
- [x] Settings already shows per-account usage; orchestrator dashboard widget adds the accounts + usage summary.

### P2 — Room system + interruption decider
- [x] Per-participant interruption decider: a running sub-agent keeps working; a new user message in the task room is classified (interrupt / queue / ignore) before it is injected. Eliza participants use `shouldRespond`; coding sub-agents use a structural decider.
- [x] Task room view shows participants (orchestrator + user + each sub-agent + its account) and per-agent run state.

### P3 — Tests + mocks + live E2E
- [x] Mock account fixtures (multi-account, multi-provider) + an in-memory pool for unit tests.
- [x] Unit tests: selection strategy, env injection per agent type, exclude-on-failure, usage attribution, interruption decider.
- [x] Live E2E (gated `ORCHESTRATOR_LIVE_MULTI_ACCOUNT=1`): spawn against ≥2 real accounts, assert each used a distinct account + usage moved.

### P4 — Connect-accounts window
- [x] Verify the AddAccountDialog OAuth/API-key/coding-key flows; open the accounts surface for the operator to connect multiple of each type.

## Quality bar
- No regression when zero accounts are linked (bridge returns null → today's behavior).
- Selected account is **observable** (session metadata + structured log + dashboard), never assumed.
- Subscription tokens only ever flow to the first-party coding subprocess (TOS), never into runtime `process.env`.
