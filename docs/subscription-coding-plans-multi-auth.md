# Subscription Coding Plans Multi-Auth Plan

Date: 2026-05-10

## Scope

This feature is only for subscription coding plans. It is not an API-key
resale layer, not a quota-bypass proxy, and not a way to run one vendor's
subscription through another vendor's model surface.

Allowed surfaces:

- Claude subscription: Claude Code only.
- ChatGPT/Codex subscription: Codex CLI or a Codex-backed client only.
- Gemini subscription: Gemini CLI only.
- z.ai Coding Plan: z.ai coding endpoint only.
- Kimi Code: Kimi coding endpoint only.
- DeepSeek: unavailable until there is a first-party coding subscription
  surface that can be integrated without substituting general API billing.

Direct API keys remain supported by the existing provider settings, but they
are separate from subscription coding plans.

Official pages checked on 2026-05-10:

- OpenAI Codex with ChatGPT plans:
  https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan/
- Claude Code plans and rate limits:
  https://support.anthropic.com/en/articles/11145838-using-claude-code-with-your-pro-or-max-plan
- Gemini CLI authentication and quotas:
  https://ai.google.dev/gemini-api/docs/gemini-cli
- DeepSeek API pricing:
  https://api-docs.deepseek.com/quick_start/pricing
- z.ai billing and API docs:
  https://docs.z.ai/guides/pricing
- Kimi/Moonshot API docs:
  https://platform.moonshot.ai/docs

## Reference Repos Reviewed

TypeScript-heavy references:

- `ndycode/codex-multi-auth`: OpenAI Codex multi-account OAuth, local bridge,
  runtime rotation proxy, request failure policy, project-scoped storage.
- `andyvandaric/opencode-ag-auth`: opencode plugin for Google Antigravity /
  Gemini CLI OAuth, quota probing, model/request transforms, proxy support,
  account manager, verification handling.
- `NoeFabris/opencode-antigravity-auth`: same plugin contract family as
  `opencode-ag-auth`; useful for cross-checking the opencode plugin API.
- `Lampese/codex-switcher`: Tauri + React account cards, add/import OAuth UI,
  usage refresh, subscription expiry display.
- `Yajush-afk/linux-codexbar`: React/Tauri tray model with provider snapshots
  for Codex, Claude, and OpenCode usage windows.

JavaScript / other useful references:

- `rchaz/claude-nonstop`: Claude Code profile directories, usage scoring,
  rate-limit detection, session migration, keychain/secret-service reads.
- `KarpelesLab/teamclaude`: Anthropic proxy account manager, OAuth import,
  refresh coalescing, rate-limit header accounting, no-account 429 handling.
- `qqliaoxin/openclaw-auth-ui`: web UI that shells out to first-party auth
  commands, captures authorization URLs, restarts the coding gateway, exposes
  provider and status endpoints.
- `Loongphy/codex-auth`: broader Codex account registry and auto-switcher in
  Zig; useful for daemon/CLI workflow shape but not a TypeScript source.
- CodexBar desktop/tray variants (`steipete`, `babakarto`, `nek0der`,
  `rursache`, `mryll`) mainly inform cross-platform packaging, status cards,
  WSL/KDE/tray caveats, and setup detection.

## API And Setup Examples

### OpenAI Codex Subscription

Reference implementation: `ndycode/codex-multi-auth`, `Lampese/codex-switcher`,
`Yajush-afk/linux-codexbar`, `qqliaoxin/openclaw-auth-ui`.

Setup examples:

```sh
npm i -g @openai/codex
codex login

# Reference manager workflow
npm i -g codex-multi-auth
codex-multi-auth login
codex-multi-auth status
codex-multi-auth list
codex-multi-auth switch 2
codex-multi-auth forecast --live
```

OAuth details from the TypeScript reference:

```ts
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const REDIRECT_URI = "http://localhost:1455/auth/callback";
const SCOPE = "openid profile email offline_access";
```

How it works:

- Generate PKCE and `state`.
- Start a loopback listener on `127.0.0.1:1455` for `/auth/callback`.
- Open the authorization URL with `codex_cli_simplified_flow=true`.
- Exchange `code + code_verifier` at `/oauth/token`.
- Store `access_token`, `refresh_token`, `id_token`, expiry, and account id
  under the app's account store, while preserving the official Codex auth
  shape for Codex-only execution.
- Refresh with `grant_type=refresh_token` against the same token endpoint.

Useful first-party Codex subscription APIs observed in the examples:

```http
GET https://chatgpt.com/backend-api/wham/usage
GET https://chatgpt.com/backend-api/accounts/check/v4-2023-04-27
POST https://chatgpt.com/backend-api/codex/responses
Authorization: Bearer <codex-oauth-access-token>
chatgpt-account-id: <account-id-if-present>
User-Agent: codex-cli/1.0.0
```

Local bridge shape from `codex-multi-auth`:

```http
GET  http://127.0.0.1:<port>/health
GET  http://127.0.0.1:<port>/v1/models
POST http://127.0.0.1:<port>/v1/responses
Authorization: Bearer <local-client-token>
```

Required handlers:

- Callback port in use: return a manual paste flow, do not lose PKCE state.
- Invalid OAuth state: reject the login.
- Token refresh failure: mark only that account unhealthy.
- 401: one forced refresh, then require re-login.
- 429 / quota: respect `Retry-After` and account reset metadata.
- All accounts unavailable: return an explicit unavailable/rate-limit status
  with next retry time; do not fall back to `OPENAI_API_KEY`.

Current repo status:

- Provider id `openai-codex` exists.
- OAuth/account CRUD guards exist.
- Credential resolver refuses Codex subscription as a direct API key.
- Codex usage probing and pool metadata are wired.
- Full local bridge/runtime proxy is still Wave 1C work.

### Claude Code Subscription

Reference implementation: `rchaz/claude-nonstop`, `KarpelesLab/teamclaude`,
`Yajush-afk/linux-codexbar`.

Setup examples:

```sh
claude auth login

# Per-account profile layout from claude-nonstop
CLAUDE_CONFIG_DIR=~/.claude-nonstop/profiles/work claude auth login
CLAUDE_CONFIG_DIR=~/.claude-nonstop/profiles/personal claude auth login
```

Credential locations:

- macOS keychain service `Claude Code-credentials`.
- Custom profile keychain service `Claude Code-credentials-<sha256_8(path)>`.
- Linux file fallback `<CLAUDE_CONFIG_DIR>/.credentials.json`.
- Default file fallback `~/.claude/.credentials.json`.

Credential shape:

```json
{
  "claudeAiOauth": {
    "accessToken": "<access-token>",
    "refreshToken": "<refresh-token>",
    "expiresAt": 1778416602000,
    "scopes": ["user:profile"],
    "rateLimitTier": "max"
  }
}
```

Usage and profile APIs observed in the examples:

```http
GET https://api.anthropic.com/api/oauth/usage
GET https://api.anthropic.com/api/oauth/profile
Authorization: Bearer <claude-code-oauth-access-token>
anthropic-beta: oauth-2025-04-20
anthropic-version: 2023-06-01
```

Refresh API variants seen in references:

```http
POST https://platform.claude.com/v1/oauth/token
Content-Type: application/json or application/x-www-form-urlencoded

grant_type=refresh_token
refresh_token=<refresh-token>
client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e
```

Runtime behavior examples:

- Spawn Claude Code with `CLAUDE_CONFIG_DIR=<profile-dir>`.
- Detect rate limits using the Claude Code terminal output pattern for
  "limit reached" with a reset time.
- Migrate the active session file before resuming with another profile.
- Score accounts by effective utilization: max of session and weekly usage.
- If every account is near exhaustion, sleep until the earliest reset instead
  of cycling accounts.

Required handlers:

- Missing CLI: show "run claude auth login" / install hint.
- Missing credentials: provider configured false.
- Missing `user:profile` scope: require re-login.
- Expired access token with refresh token: refresh once under a mutex.
- Expired token without refresh token: require re-login.
- 401: force refresh, then mark account auth-failed.
- 429 or account near quota: switch only to another Claude Code account, or
  wait until reset.
- Unsupported OS credential store: fall back to file path and show warning.

Current repo status:

- Provider id `anthropic-subscription` exists.
- Claude Code credential import from file/keychain exists.
- Refresh, invalid-grant caching, and status rows exist.
- Credential resolver refuses Claude subscription as `ANTHROPIC_API_KEY`.
- Full session migration is not implemented; task-agent framework switching is
  handled at the orchestrator level.

### Gemini CLI Subscription

Reference implementation: `andyvandaric/opencode-ag-auth`,
`NoeFabris/opencode-antigravity-auth`, `Yajush-afk/linux-codexbar`.

Setup example:

```sh
npm i -g @google/gemini-cli
gemini auth login
```

The opencode references support Google Antigravity and Gemini CLI OAuth. For
this repo's policy, Gemini subscription support must stay external CLI-only
unless we add a dedicated Gemini CLI runner. Do not import Google tokens into
generic `GEMINI_API_KEY`.

Antigravity/Gemini reference details:

```ts
const ANTIGRAVITY_REDIRECT_URI = "http://localhost:51121/oauth-callback";
const ANTIGRAVITY_ENDPOINT_DAILY =
  "https://daily-cloudcode-pa.sandbox.googleapis.com";
const ANTIGRAVITY_ENDPOINT_AUTOPUSH =
  "https://autopush-cloudcode-pa.sandbox.googleapis.com";
const ANTIGRAVITY_ENDPOINT_PROD = "https://cloudcode-pa.googleapis.com";
const GEMINI_CLI_ENDPOINT = ANTIGRAVITY_ENDPOINT_PROD;
```

Quota APIs observed:

```http
POST https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels
POST https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota
Authorization: Bearer <google-oauth-access-token>
Content-Type: application/json
User-Agent: GeminiCLI/1.0.0/gemini-2.5-pro (<platform>; <arch>)
```

Request transformer shape in the TypeScript plugin:

```ts
// Input headed for Generative Language API:
// /models/<model>:generateContent or :streamGenerateContent

const transformedUrl =
  `${baseEndpoint}/v1internal:${rawAction}${streaming ? "?alt=sse" : ""}`;

headers.set("Authorization", `Bearer ${accessToken}`);
headers.delete("x-api-key");
```

Required handlers:

- `gemini` binary missing: configured false with install/login hint.
- CLI logged out: configured true may still fail preflight; show re-login hint.
- OAuth callback in WSL/SSH/remote: bind `0.0.0.0` only when required;
  default to loopback.
- Proxy env vars: honor `HTTPS_PROXY` / `HTTP_PROXY` when making provider
  calls.
- Quota API missing/empty: show "quota unavailable" without failing the entire
  provider.
- 429 / model capacity / 503 / 529: back off with jitter, never cross to a
  direct API key.

Current repo status:

- Provider id `gemini-cli` exists.
- UI shows external CLI-only setup copy.
- Status detection checks whether `gemini` is on `PATH`.
- Task-agent orchestration can prefer Gemini CLI when selected.
- We still need a dedicated Gemini CLI preflight and a first-party CLI runner
  adapter before claiming full Gemini subscription execution.

### z.ai Coding Plan

Reference implementation: `qqliaoxin/openclaw-auth-ui` shows z.ai as a
separate provider in the coding auth UI; official z.ai docs provide billing/API
surface. The OpenClaw UI's API-key tab writes `ZAI_API_KEY` for direct API use,
but this feature uses `zai-coding` to keep coding-plan credentials separate
from generic `zai-api`.

Setup example:

```sh
# In Eliza settings, add an account under z.ai Coding Plan.
# Do not store it as ZAI_API_KEY unless the user selected direct API billing.
```

Coding endpoint default in this repo:

```ts
const ZAI_CODING_BASE_URL = "https://api.z.ai/api/coding/paas/v4";
```

Probe shape:

```http
GET https://api.z.ai/api/coding/paas/v4/models
Authorization: Bearer <zai-coding-plan-token>
```

Required handlers:

- Endpoint unavailable: mark health degraded with retry time.
- Token rejected: mark account auth-failed and require replacement.
- `/models` absent or non-OpenAI-compatible: surface unsupported endpoint,
  do not rewrite to direct `https://api.z.ai/api/paas/v4`.
- Explicit user-selected direct API key stays under `zai-api`, not
  `zai-coding`.

Current repo status:

- Provider id `zai-coding` exists.
- Account add UI uses coding-plan wording.
- Backend stores token under `zai-coding`.
- Credential resolver refuses it as `ZAI_API_KEY`.
- Runtime coding adapter is Wave 1D work.

### Kimi Code

Reference implementation: no provided repo has a mature Kimi coding-plan
runtime; `qqliaoxin/openclaw-auth-ui` is the closest multi-provider auth UI
shape. Kimi/Moonshot generic API remains separate as `moonshot-api`.

Setup example:

```sh
# In Eliza settings, add an account under Kimi Code.
# Do not store it as MOONSHOT_API_KEY unless the user selected direct API billing.
```

Coding endpoint default in this repo:

```ts
const KIMI_CODING_BASE_URL = "https://api.kimi.com/coding/v1";
```

Probe shape:

```http
GET https://api.kimi.com/coding/v1/models
Authorization: Bearer <kimi-code-token>
```

Required handlers:

- Endpoint unavailable or not documented for the user's plan: show unavailable.
- Token rejected: mark account auth-failed and require replacement.
- If only Moonshot direct API billing is available, require the user to select
  `moonshot-api`; do not silently remap.

Current repo status:

- Provider id `kimi-coding` exists.
- Account add UI uses Kimi Code wording.
- Backend stores token under `kimi-coding`.
- Credential resolver refuses it as `MOONSHOT_API_KEY`.
- Runtime coding adapter is Wave 1D work.

### DeepSeek Coding Subscription

No first-party coding subscription surface was found in the official DeepSeek
docs checked on 2026-05-10. The official surface is direct API billing.

Required behavior:

- Show DeepSeek Coding Plan as unavailable.
- Do not accept a "DeepSeek coding subscription" credential.
- Direct API users can still configure `deepseek-api`.

Current repo status:

- Provider id `deepseek-coding` exists.
- Status API emits an unavailable row with a reason.
- Account add routes reject credentials for this provider.

## Implementation Already In This Branch

Provider ids now distinguish subscription coding plans from direct API keys:

- `anthropic-subscription`
- `openai-codex`
- `gemini-cli`
- `zai-coding`
- `kimi-coding`
- `deepseek-coding`

Selection ids expose those in onboarding/settings:

- `anthropic-subscription`
- `openai-subscription`
- `gemini-subscription`
- `zai-coding-subscription`
- `kimi-coding-subscription`
- `deepseek-coding-subscription`

Guardrails implemented:

- Subscription credentials are not exported as direct API env vars.
- A shared `SUBSCRIPTION_PROVIDER_METADATA` table now records provider ids,
  selection ids, auth mode, billing mode, allowed client, setup hint,
  dedicated coding endpoint, probe path, and unavailable reason.
- The credential resolver refuses subscription ids as direct API credentials.
- Account routes reject API-key add for OAuth-only, external-CLI, and
  unavailable subscription providers.
- Account routes reject OAuth start for non-OAuth providers.
- Gemini is external CLI auth only.
- z.ai/Kimi coding-plan keys are stored under coding-plan ids and probed only
  against dedicated coding endpoints.
- DeepSeek coding subscription is surfaced as unavailable with a reason.
- Non-Codex subscriptions do not set runtime `model.primary`.

## Gaps Found During The Second Review

These are not optional if the product promise is "multi-subscription coding
rotation"; they are the remaining implementation waves.

- Codex local bridge/runtime proxy: needed for `/v1/models` and `/v1/responses`
  routing with local bearer tokens, account selection, request ledger, and
  bounded failover.
- Codex account identity hydration: decode id token/account id/email and update
  account metadata after refresh.
- Provider request failure policy: centralize 401, 403, 429, 5xx, network
  timeout, context overflow, verification-required, and unavailable-client
  decisions.
- Proxy support: provider calls should honor `HTTPS_PROXY` / `HTTP_PROXY`.
- Gemini CLI preflight: distinguish missing binary, installed but logged out,
  quota unavailable, and quota exhausted.
- z.ai/Kimi runtime adapters: only for coding workflows, using their dedicated
  coding endpoints.
- UI/account status parity: expose last failure, reset time, allowed client,
  next retry, and unavailable reason in one shared provider metadata table.

## Sub-Agent Wave Plan

### Wave 0: Setup And Prep

Agent A: reference capture and contract table

- Own files: `packages/agent/src/auth/types.ts`,
  `packages/shared/src/contracts/onboarding.ts`,
  `packages/core/src/contracts/onboarding.ts`,
  `packages/shared/src/contracts/service-routing.ts`,
  `packages/core/src/contracts/service-routing.ts`.
- Create one exported subscription provider metadata table with:
  `providerId`, `selectionIds`, `allowedClient`, `billingMode`, `authMode`,
  `defaultBaseUrl`, `probePath`, `directProviderId`, `availability`.
- Move duplicated provider copy out of UI/backend switch statements where
  possible.
- Add tests proving selection ids and provider ids stay synchronized.

Agent B: policy and credential audit

- Own files: `packages/app-core/src/api/credential-resolver.ts`,
  `packages/agent/src/auth/credentials.ts`,
  `packages/agent/src/api/provider-switch-config.ts`.
- Search every path that maps account credentials to env vars.
- Prove subscription ids never become `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
  `GEMINI_API_KEY`, `ZAI_API_KEY`, `MOONSHOT_API_KEY`, or `DEEPSEEK_API_KEY`.
- Add regression tests for each refusal path.

### Wave 1: Full Build

Agent A: account storage and identity

- Own files: `packages/agent/src/auth/account-storage.ts`,
  `packages/agent/src/auth/credentials.ts`,
  `packages/agent/src/api/accounts-routes.ts`.
- Add account identity hydration for Codex and Claude:
  id token decode, account id, email, organization/user id, expiry.
- Add availability fields:
  `allowedClient`, `billingMode`, `availabilityReason`, `lastFailure`,
  `nextRetryAt`.
- Keep file storage fallback; prepare keychain/vault adapter behind the same
  API.

Agent B: runtime account selection and failure policy

- Own files: `packages/app-core/src/services/account-pool.ts`,
  `packages/app-core/src/services/account-usage.ts`.
- Add a failure-policy module based on the TypeScript references:
  retry same account, fail over to another same-provider account, mark auth
  failed, mark quota limited, mark provider unavailable.
- Add health score and backoff with jitter.
- Preserve session affinity and cap attempts.
- When all accounts are limited, return earliest reset instead of cycling.

Agent C: Codex bridge and Codex subscription execution

- Own new files under `packages/app-core/src/services/codex-subscription/`.
- Implement local loopback bridge:
  `/health`, `/v1/models`, `/v1/responses`.
- Require local bearer tokens unless explicitly disabled in tests.
- Select only `openai-codex` accounts.
- Forward only Codex-compatible requests to the Codex-backed endpoint.
- Record usage/failure ledger entries.
- Do not fall back to `OPENAI_API_KEY`.

Agent D: Gemini CLI adapter

- Own files: `plugins/plugin-agent-orchestrator/src/services/task-agent-frameworks.ts`
  plus a new Gemini CLI preflight module.
- Add preflight states:
  missing binary, not logged in, quota unavailable, quota exhausted, ready.
- Execute Gemini work through the CLI only.
- Do not persist Google OAuth tokens as API credentials.
- Include WSL/SSH callback guidance in setup UI.

Agent E: z.ai and Kimi coding adapters

- Own new files under `packages/app-core/src/services/coding-plan-adapters/`
  and tests.
- Implement `/models` probe and request adapter for coding workflows only.
- Use `zai-coding` and `kimi-coding` credentials, never direct API provider
  credentials.
- Support configurable base URLs, but default to the dedicated coding endpoints.
- Return explicit unavailable/unsupported when the endpoint contract differs.

Agent F: UI parity

- Own files:
  `packages/ui/src/components/accounts/AddAccountDialog.tsx`,
  `packages/ui/src/components/accounts/AccountCard.tsx`,
  `packages/ui/src/components/settings/ProviderSwitcher.tsx`,
  `packages/ui/src/components/settings/SubscriptionStatus.tsx`.
- Replace copy switches with shared metadata where feasible.
- Show allowed client, setup command, availability reason, last failure,
  next retry, and reset time.
- Add external CLI and unavailable states for every non-importable provider.

### Wave 2: Testing, Validation, Verification

Agent A: unit coverage

- Account routes: add/update/delete, OAuth start/submit/cancel, unavailable
  provider rejection, CLI-only rejection, coding endpoint probes.
- Credential resolver: every subscription provider refusal path.
- Provider switch config: onboarding ids, runtime persistence, model primary
  clearing.

Agent B: integration coverage

- Mock Codex bridge `/v1/models` and `/v1/responses`.
- Mock Claude usage/profile responses including 401, 429, expired token,
  missing scope, and reset windows.
- Mock Gemini CLI preflight for missing binary and logged-out states.
- Mock z.ai/Kimi `/models` success and unavailable responses.

Agent C: UI verification

- Use browser tests/screenshots for:
  add account per provider, unavailable DeepSeek, external Gemini CLI,
  z.ai/Kimi coding-plan key entry, account card health/usage states.
- Validate no text overlap on narrow desktop and mobile widths.

### Wave 3: Optimization And Consolidation

- Collapse shared/core duplicate contract definitions if a generator exists.
- Move provider copy/icons/availability into one table.
- Add provider probe caching with short TTLs.
- Add structured diagnostics export for account health and routing decisions.
- Remove dead paths that still assume a single subscription account.

### Wave 4: Cleanup, Develop Push, Workflows

- Rebase on latest `develop`.
- Run targeted tests first, then package typechecks, then repo-wide workflows.
- Resolve unrelated pre-existing typecheck failures separately or isolate them.
- Stage only subscription coding-plan changes.
- Push to `develop` only after the dirty worktree is clean/isolated and all
  required workflows pass.

## Verification Already Run

- `bunx biome check` on touched files.
- `packages/shared`: `bun run typecheck`.
- `packages/core`: `bun run typecheck`.
- `plugins/plugin-agent-orchestrator`: `bun run typecheck`.
- Targeted `packages/agent` tests:
  `bun run test -- test/api/accounts-routes.test.ts src/auth/credentials.test.ts src/api/provider-switch-config.test.ts`.
- Targeted `packages/app-core` tests:
  `bun run test -- src/services/account-pool.test.ts`.

Known unrelated blockers before repo-wide workflow push:

- `packages/ui/src/state/useCloudState.ts`: existing toast severity mismatch.
- `packages/ui/src/components/shell/onboarding-theme.ts`: missing
  `OnboardingThemeConfig` export.
- `packages/app-core/src/api/sensitive-request-routes.ts` and
  `sensitive-request-store.ts`: existing `SensitiveRequestAuditEvent` / `audit`
  type mismatch.
