# Launch Readiness 02: Coding Subscriptions

## Second-Pass Status (2026-05-05)

- Superseded: account-pool strategy now flows into direct env and runtime shim selection paths.
- Still open: coding-agent preflight still needs broader provider coverage, inline subscription probe failures still map too broadly to `rate-limited`, and `resolveProviderCredentialMulti()` does not pass selection config.
- Launch gate: keep `packages/app-core/src/services/__tests__/account-pool.test.ts` in the focused launch suite and add row-aggregation/health-mapping tests before treating this area as complete.

## Current state

- Multi-account credential storage exists for subscription providers including `anthropic-subscription`, `openai-codex`, `gemini-cli`, `zai-coding`, `kimi-coding`, and `deepseek-coding`, plus direct API account providers including `zai-api`. Credentials are stored per provider/account under `~/.eliza/auth/{providerId}/{accountId}.json`, with legacy single-account migration.
- The account pool implements `priority`, `round-robin`, `least-used`, and `quota-aware` selection, plus health filtering, cooldown re-entry, and session affinity.
- Settings UI can add, test, refresh, delete, reprioritize, and choose a strategy for accounts. The strategy is persisted in config and displayed by `/api/accounts`.
- Runtime integration is only partial. AccountPool callers for Claude, Codex, and direct API credentials generally call `pool.select()` without passing the configured strategy or service-route account allowlist. In practice, runtime selection defaults to priority except when accounts are disabled, excluded, or unhealthy.
- Claude subscription support is intentionally code-agent only in the core startup path. Anthropic subscription tokens are not applied to `ANTHROPIC_API_KEY`; Claude Code child processes get `CLAUDE_CODE_OAUTH_TOKEN`/`ANTHROPIC_AUTH_TOKEN` only when spawning the `claude` CLI.
- Codex subscription accounts are not applied to `OPENAI_API_KEY`. The selected Codex account comes from the subscription selector shim when installed, and the shim can read persisted provider selection config.
- Z.AI direct API support exists in account-provider types, account routes, credential resolution, local provider enable-state, and runtime `getSetting()`. z.ai Coding Plan support is separate under `zai-coding`; coding-plan credentials are not copied into `ZAI_API_KEY` or `Z_AI_API_KEY`.
- Eliza Cloud and local fallback paths exist. Cloud-managed onboarding builds cloud service routing and clears subscription-provider config; `ELIZA_LOCAL_LLAMA=1` is documented in code as additive, so remote providers remain loadable unless explicit local-only mode applies.

## Evidence reviewed with file refs

- Multi-account storage and migration: `packages/agent/src/auth/account-storage.ts:183-247`, `packages/agent/src/auth/account-storage.ts:288-325`.
- Provider/account type support: `packages/agent/src/auth/types.ts:11-18`, `packages/agent/src/auth/types.ts:56-65`, `packages/shared/src/contracts/service-routing.ts:379-390`.
- AccountPool strategies and selection: `packages/app-core/src/services/account-pool.ts:60-89`, `packages/app-core/src/services/account-pool.ts:129-158`, `packages/app-core/src/services/account-pool.ts:160-217`.
- Runtime shims/selectors: `packages/app-core/src/services/account-pool.ts:626-870`.
- Direct account env application, including Z.AI alias write: `packages/app-core/src/services/account-pool.ts:640-700`.
- Keep-alive usage/health refresh: `packages/app-core/src/services/account-pool.ts:708-755`.
- Accounts API strategy persistence and listing: `packages/agent/src/api/accounts-routes.ts:174-219`, `packages/agent/src/api/accounts-routes.ts:568-655`.
- Account test/usage probes: `packages/agent/src/api/accounts-routes.ts:320-365`, `packages/agent/src/api/accounts-routes.ts:899-1023`.
- OAuth account save and Codex account-id extraction: `packages/agent/src/auth/oauth-flow.ts:100-136`, `packages/agent/src/auth/oauth-flow.ts:183-213`, `packages/agent/src/auth/oauth-flow.ts:289-314`, `packages/agent/src/auth/oauth-flow.ts:452-470`.
- Claude code-agent-only runtime policy: `packages/agent/src/auth/credentials.ts:520-652`, `packages/shared/src/contracts/onboarding.ts:223-253`, `packages/shared/src/contracts/onboarding.ts:611-629`, `packages/agent/src/api/provider-switch-config.ts:849-893`.
- Claude Code spawn env and health feedback: `plugins/plugin-agent-orchestrator/src/actions/spawn-agent.ts:475-607`, `plugins/plugin-agent-orchestrator/src/services/pty-spawn.ts:78-115`, `plugins/plugin-agent-orchestrator/src/services/pty-spawn.ts:507-518`.
- Task-agent readiness/scoring: `plugins/plugin-agent-orchestrator/src/services/task-agent-frameworks.ts:682-720`, `plugins/plugin-agent-orchestrator/src/services/task-agent-frameworks.ts:999-1046`.
- Coding-agent preflight subscription checks: `plugins/app-task-coordinator/src/evals/coordinator-preflight.ts:358-459`.
- UI account management and strategy picker: `packages/app-core/src/components/accounts/AccountList.tsx:96-155`, `packages/app-core/src/components/accounts/RotationStrategyPicker.tsx:33-62`, `packages/app-core/src/components/settings/ProviderSwitcher.tsx:1219-1303`.
- Legacy subscription panel behavior: `packages/app-core/src/components/settings/SubscriptionStatus.tsx:278-320`, `packages/app-core/src/components/settings/SubscriptionStatus.tsx:572-690`.
- Subscription status/delete routes and stale REST docs: `packages/agent/src/api/subscription-routes.ts:54-90`, `packages/agent/src/api/subscription-routes.ts:270-338`, `docs/rest/subscriptions.md:17-30`, `docs/rest/subscriptions.md:166-175`.
- Plugin loading, cloud/local fallback, and Z.AI plugin map: `packages/agent/src/runtime/plugin-collector.ts:108-128`, `packages/agent/src/runtime/plugin-collector.ts:240-450`, `packages/agent/src/runtime/plugin-collector.optional-bundled.test.ts:183-214`.
- Runtime bootstrap and env allowlist: `packages/agent/src/runtime/eliza.ts:2255-2305`, `packages/agent/src/runtime/eliza.ts:2926-2988`.
- Credential resolver Z.AI alias and multi-account default-priority resolution: `packages/app-core/src/api/credential-resolver.ts:176-182`, `packages/app-core/src/api/credential-resolver.ts:247-320`.
- Local provider enable-state: `packages/app-core/src/services/local-inference/providers.ts:315-330`, `packages/app-core/src/services/local-inference/providers.ts:380-397`.
- Native desktop credential scan and auth masking: `packages/app-core/platforms/electrobun/src/native/credentials.ts:113-155`, `packages/app-core/platforms/electrobun/src/native/credentials.ts:507-612`, `packages/app-core/platforms/electrobun/src/native/agent.ts:389-405`.
- Anthropic plugin OAuth pool path requiring guard review: `plugins/plugin-anthropic/utils/credential-store.ts:1-12`, `plugins/plugin-anthropic/utils/credential-store.ts:111-178`.

## What I could validate

- AccountPool itself supports multiple accounts, independent provider pools, priority, round-robin, least-used, quota-aware, explicit `accountIds`, exclusions, session affinity, health skipping, cooldown re-entry, and usage refresh logic.
- `/api/accounts` supports multi-account CRUD, provider strategy persistence, direct API-key providers, OAuth status streaming, health state surfaced from the pool, and independent Anthropic/Codex pools.
- Core startup installs account-pool shims before subscription credentials are applied.
- Claude subscription is not applied to runtime env by `applySubscriptionCredentials`; Codex subscription is not applied to `OPENAI_API_KEY`.
- Codex, z.ai Coding Plan, Kimi Code, and Gemini CLI subscription credentials are not applied to general API environment variables. They are restricted to their first-party coding client or dedicated coding endpoint.
- Claude Code spawns can receive the selected account token in child env, and subprocess auth failures can mark that account rate-limited, invalid, or needing reauth.
- Settings UI exposes the multi-account list and strategy controls for both subscription and direct API providers.
- Auth sanitization exists for native startup diagnostics and native credential scan masks returned API keys.
- Eliza Cloud and local fallback logic is present in code and covered partially by plugin-collector tests.

## What I could not validate

- Live Claude Code OAuth, Codex OAuth, Codex account organization IDs, Z.AI API keys, or Eliza Cloud credentials. I did not use live credentials or network probes.
- Actual round-robin/balancing/fallback behavior in a spawned Claude/Codex session with multiple real accounts. Code review indicates configured strategy is not currently passed into runtime selection.
- Whether Codex's live API accepts the current `probeCodexUsage` model and ChatGPT subscription token shape.
- Native desktop credential discovery against real current Codex and Claude credential files/keychain entries.
- End-to-end UI behavior in a browser; this was a code/test review, not an interactive desktop QA pass.

## Bugs/risks P0-P3

### P0

- None found.

### P1

- Configured account balancing is not wired into runtime selection. The UI/API persist strategies (`accounts-routes.ts:202-219`, `AccountList.tsx:102-107`), and AccountPool honors a passed strategy (`account-pool.ts:147-217`), but the runtime shims/selectors call `pool.select()` without `strategy` or `accountIds`: Anthropic shim (`account-pool.ts:810-815`), orchestrator shim (`account-pool.ts:835-839`), subscription selector (`account-pool.ts:864-865`), multi-credential resolver (`credential-resolver.ts:267-301`), and direct env application (`account-pool.ts:653-657`). Expected round-robin/least-used/quota-aware behavior will not happen in real runtime paths unless a caller passes the strategy explicitly.
- Claude spawn fallback is health-marking, not immediate retry. `spawn-agent.ts:573-607` watches output and marks the selected account unhealthy, but the reviewed action does not respawn the failed task on a second account in the same attempt. The next spawn should avoid the marked account, but same-task fallback needs end-to-end verification or explicit retry logic.

### P2

- Coding-agent preflight collapses multiple account rows by provider ID. `/api/subscription/status` returns an array of per-account rows (`subscription-routes.ts:54-83`), but preflight builds a `Map` keyed only by `provider` (`coordinator-preflight.ts:430-459`). One invalid row can mask a valid account, or vice versa, depending on row order.
- Native desktop Codex credential scan needs end-to-end verification against current Codex CLI OAuth files. Runtime status now detects `.codex/auth.json` with `tokens.access_token` via the Codex CLI-backed provider path, but desktop onboarding/preflight should confirm it reports `openai-codex` without exposing or copying OAuth tokens into `OPENAI_API_KEY`.
- Z.AI alias support is inconsistent. Runtime settings and credential resolver accept both `ZAI_API_KEY` and `Z_AI_API_KEY` (`eliza.ts:2260-2272`, `credential-resolver.ts:176-182`), but plugin auto-loading only maps `ZAI_API_KEY` (`plugin-collector.ts:108-128`), and native env scanning only detects `ZAI_API_KEY` (`credentials.ts:507-548`). CLI startup normalizes the alias elsewhere, but non-CLI/native paths still need coverage.
- Claude subscription direct-runtime guard should be tested. Core startup avoids applying Anthropic subscription tokens to `ANTHROPIC_API_KEY` (`credentials.ts:520-582`) and provider-switch avoids using Anthropic subscription as `llmText` (`provider-switch-config.ts:881-892`). However, `plugin-anthropic` still contains an OAuth pool path that can fetch Anthropic subscription tokens when its shim is installed (`credential-store.ts:111-147`). That path may be unreachable in intended launch config, but it needs a guard test so Claude remains code-agent only.
- Subscription refresh fallback marks every inline subscription probe failure as `rate-limited` (`accounts-routes.ts:1005-1019`). 401/403/invalid credential failures should become `needs-reauth` or `invalid`, not rate-limited.
- Codex account test uses `model: "gpt-5-mini"` (`accounts-routes.ts:334-342`). I could not verify that this is a valid/current model for the target Codex subscription flow; if not, account testing will false-fail.

### P3

- Legacy subscription panel ignores multi-account detail. It uses `find()` for the first provider status row (`SubscriptionStatus.tsx:278-284`) and hard-disables disconnect for both panels (`SubscriptionStatus.tsx:572-690`). The newer `AccountList` mitigates this, but the legacy panel can confuse QA.
- REST docs for subscriptions are stale. The docs still show `providers` as an object and document legacy provider-level delete (`docs/rest/subscriptions.md:17-30`, `docs/rest/subscriptions.md:166-175`), while the route returns an array and multi-account delete lives under `/api/accounts`.
- AccountPool strategy unit tests do not prove the settings strategy reaches runtime shims. Existing tests validate the algorithm only when `strategy` is passed directly.

## Low-risk fixes Codex can do

- Thread persisted provider strategy and optional service-route `accountIds` into every runtime selector: Anthropic shim, orchestrator shim, subscription selector, direct API credential application, and `resolveProviderCredentialMulti`.
- Add an integrated selection test that saves `accountStrategies.openai-codex = "round-robin"` or `"least-used"`, installs the default pool, then calls the same selector used by runtime and asserts the selected account changes as expected.
- Update coding-agent preflight to aggregate per-account subscription rows: pass if any enabled/configured account is valid, warn if some are invalid, and include account labels/IDs in details.
- Verify native credential scan reports Codex CLI OAuth as `openai-codex` through the Codex CLI-backed provider path; add `Z_AI_API_KEY` to native env scanning.
- Add `Z_AI_API_KEY` to plugin auto-detection or centralize alias normalization before plugin collection in all launch paths.
- Make subscription inline fallback use `healthForProbeStatus()` or equivalent status mapping instead of blanket `rate-limited`.
- Replace or verify the Codex probe model, and make the probe model configurable/testable.
- Update REST docs and legacy subscription panel copy so users know multi-account management is in `AccountList`.

## Human QA needed

- Add two Claude subscription accounts, set round-robin, spawn several Claude Code tasks, and confirm real account alternation in logs or account `lastUsedAt`.
- Force one Claude account to fail auth/rate limit, confirm the account is marked unhealthy in settings and the next task selects a different account.
- Add two Codex accounts, set round-robin/quota-aware, confirm `OPENAI_API_KEY`/Codex requests use the expected account and usage refresh works with real `ChatGPT-Account-Id`.
- Verify Claude subscription alone does not power the main agent; main agent should require Eliza Cloud or an Anthropic API key.
- Verify Eliza Cloud selected as runtime provider still lets coding agents route through cloud where intended, and local fallback remains available when cloud is disabled.
- Verify a real `ZAI_API_KEY` and a real `Z_AI_API_KEY` work in CLI and desktop/native launch paths.
- Verify desktop onboarding detects current Codex CLI OAuth and Claude Code keychain/file credentials without exposing raw secrets in UI/logs.

## Suggested automated tests

- Runtime strategy propagation: configure two accounts and `accountStrategies[provider] = "round-robin"`; assert the runtime selector/shim alternates accounts.
- Orchestrator same-task fallback: simulate Claude subprocess auth failure and assert account health changes; if same-task retry is desired, assert a second account is used before the task fails.
- Preflight multi-account aggregation: mock `/api/subscription/status` with mixed valid/invalid rows and assert provider readiness reports correctly.
- Native credential discovery: fixtures for Codex `tokens.access_token`, Codex legacy `OPENAI_API_KEY`, Claude credentials file, Claude keychain JSON, `ZAI_API_KEY`, and `Z_AI_API_KEY`.
- Claude code-agent-only guard: with only `anthropic-subscription`, assert startup does not set `ANTHROPIC_API_KEY`, does not set `llmText` to Anthropic subscription, and only Claude Code spawn env receives the token.
- Z.AI plugin collection: with only `Z_AI_API_KEY`, assert plugin-zai loads in every launch path that bypasses CLI normalization.
- Subscription refresh health mapping: mock 401/403/429/500 for inline probes and assert health becomes `needs-reauth`/`invalid`/`rate-limited` as appropriate.
- Subscription UI multi-row rendering: multiple app accounts plus CLI-detected row should not hide valid app-owned status or deletion affordances.

## Targeted tests run

- `bun test packages/app-core/platforms/electrobun/src/native/agent.test.ts` - pass, 1 test / 6 assertions.
- `bun test packages/agent/src/runtime/plugin-collector.optional-bundled.test.ts` - pass, 13 tests / 38 assertions.
- `bun test packages/app-core/src/services/__tests__/account-pool.test.ts` - all 25 listed tests passed, then Bun exited 1 with `error: An internal error occurred (WriteFailed)` while printing the very large coverage table from repo `bunfig.toml`.
- `bun test packages/agent/src/api/accounts-routes.test.ts` - all 16 listed tests passed, then Bun exited 1 with the same Bun `WriteFailed` during coverage table output.

## Changed paths

- `launchdocs/02-coding-subscriptions.md`
