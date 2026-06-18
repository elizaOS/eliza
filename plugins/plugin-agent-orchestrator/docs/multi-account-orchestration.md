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
- [x] Per-participant interruption decider: a running sub-agent keeps working; a new room message is classified (deliver / queue / interrupt / ignore) before it is injected. The "busy" check covers `tool_running` (the dominant mid-turn state), not just `busy`; queued messages flush when the session returns to `ready`. An Eliza participant's `shouldRespond` verdict threads through unchanged when a caller supplies it; coding sub-agents use the structural decider. `multiParty` (more than one live sub-agent in the room) is computed in the forward handler so ambient-chatter suppression is live.
- [x] Task-room participant **view**: the "Coding accounts" sidebar widget shows the live sub-agent → account assignment map + per-account usage (the flat global map). The dedicated per-room participant roster (orchestrator + owning user + each sub-agent grouped by room, with `activeAgentCount` / `multiParty`) now ships as `GET /api/orchestrator/rooms` (`OrchestratorTaskService.getRoomRoster`), the room-scoped counterpart to `/accounts`. Rooms with no sub-agent sessions are omitted.

### P3 — Tests + mocks + live E2E
- [x] Mock account fixtures (multi-account, multi-provider) + an in-memory pool for unit tests.
- [x] Unit tests: selection strategy, per-agent env injection + API-key drop (Claude & Codex), intra-provider retry, usage attribution, interruption decider, route registration.
- [x] Live E2E (gated `ORCHESTRATOR_LIVE_MULTI_ACCOUNT=1`): validates the selector bridge + usage probe against ≥2 **real** linked accounts (distinct-account rotation via the exclude set; live session/weekly usage).
- [x] **Composed offline E2E** (`bun run --cwd plugins/plugin-agent-orchestrator test:e2e:multi-account`): real app-core `AccountPool` (real-format mock accounts in a temp state dir) → installed selector bridge → orchestrator `AcpService.spawnSession` → a REAL spawned subprocess (a fake "acpx" standing in for the subscription CLI). Asserts 10/10: two Claude spawns pick **distinct** accounts (least-used round-robin), each subprocess receives its account's `CLAUDE_CODE_OAUTH_TOKEN`, the parent `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` are dropped, Codex gets a per-account `CODEX_HOME/auth.json` with the right token+account_id. Point `ELIZA_ACP_CLI` at the real binary + connect real accounts for true live-key validation. (This harness caught a real cli-transport bug: `runAcpx` rebuilt the env without `agentType`, re-adding the parent keys — now fixed.)

### P4 — Connect-accounts window
- [x] The connect-accounts window (Settings → Accounts: `AddAccountDialog` OAuth / API-key / coding-plan-key flows, `AccountList`, `RotationStrategyPicker`) pre-exists and is the surface for linking multiple accounts of each type.

## Known constraints / follow-ups
- **OpenCode pool-rotates across Cerebras accounts only.** OpenCode resolves a pooled key for exactly one backend — Cerebras (`CEREBRAS_API_KEY`, see `buildOpencodeSpawnConfig`) — so `opencode` is a multi-account selector type mapped to `cerebras-api`: it least-used-rotates across linked Cerebras accounts (the bridge injects the selected `CEREBRAS_API_KEY`, which OpenCode's config reads) and no-ops when none are linked (Eliza Cloud / single-key setups are unchanged). OpenCode's other backends (Eliza Cloud, local, user-configured opencode.json) are not pooled. Precedence: a `CEREBRAS_API_KEY` runtime **setting** still wins over a pooled injection — pooling is authoritative only when no single key is configured.
- **z.ai / Kimi / GLM have no first-party coding CLI.** Their linked accounts serve the main runtime's API-key routing (`resolveProviderCredentialMulti` for `zai-api` / `moonshot-api`) and OpenCode's provider config — there is no `zai`/`kimi`/`glm` spawnable agent type, so they are not advertised as coding-agent selector candidates.

## Quality bar
- No regression when zero accounts are linked (bridge returns null → today's behavior).
- Selected account is **observable** (session metadata + structured log + dashboard), never assumed.
- Subscription tokens only ever flow to the first-party coding subprocess (TOS), never into runtime `process.env`.
- Per-agent credential precedence is enforced: a selected Claude subscription drops `ANTHROPIC_API_KEY`; a selected Codex subscription (per-account `CODEX_HOME`) drops a forwarded `OPENAI_API_KEY` — so the chosen account always authenticates.
