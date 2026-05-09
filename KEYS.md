# Test Credentials Manifest

Canonical inventory of API keys and credentials referenced by `*.test.ts`,
`*.test.tsx`, `*.live.e2e.test.ts`, `*.real.test.ts`, and `*.real.e2e.test.ts`
files under `packages/`, `plugins/`, and `cloud/`.

Default LLM for all non-provider-specific tests: Cerebras `gpt-oss-120b` via
`CEREBRAS_API_KEY` (auto-mapped to `OPENAI_API_KEY` + `OPENAI_BASE_URL` by the
test harness).

Legend:
- "In .env.test.example?" — listed as a template var in `.env.test.example`.
- "In CI?" — referenced as `secrets.X` in `.github/workflows/*.yml` (any file).
  Some keys are wired up only with the `ELIZA_E2E_` prefix in CI; those are
  noted in the Purpose column and counted as ✅ since CI does provision them
  under that name.

## LLM providers

| Key | Used by (plugin/package) | Test files | In .env.test.example? | In CI? | Purpose |
|---|---|---|---|---|---|
| `ANTHROPIC_API_KEY` | plugin-anthropic, plugin-agent-orchestrator, plugin-computeruse, plugin-form, plugin-wallet, agent (media), app-core (live-agent), cloud (providers fallback) | plugins/plugin-computeruse/test/computeruse.real.e2e.test.ts, packages/agent/src/providers/media-provider.real.test.ts, packages/app-core/test/live-agent/plugin-lifecycle.live.e2e.test.ts +4 more | ✅ | ✅ (also `ELIZA_E2E_ANTHROPIC_API_KEY`) | Anthropic provider e2e |
| `ANTHROPIC_OAUTH_TOKEN` | plugin-anthropic | plugins/plugin-anthropic/__tests__/credential-store.test.ts | ❌ | ❌ | Anthropic OAuth credential store e2e |
| `CEREBRAS_API_KEY` | core (trajectory recorder) — universal default LLM | packages/core/src/runtime/__tests__/trajectory-recorder.test.ts | ✅ | ❌ | Default LLM for entire test suite (Cerebras `gpt-oss-120b`) |
| `CLAUDE_CODE_OAUTH_TOKEN` | plugin-agent-orchestrator, plugin-anthropic | plugins/plugin-agent-orchestrator/src/__tests__/task-agent-live.e2e.test.ts, plugins/plugin-anthropic/__tests__/credential-store.test.ts | ❌ | ❌ | Claude Code subscription token for spawned coding sub-agents |
| `ELEVENLABS_API_KEY` | app-core (qa checklist real e2e) | packages/app-core/test/app/qa-checklist.real.e2e.test.ts | ✅ | ❌ | Voice/TTS e2e |
| `GEMINI_API_KEY` | app-core (live-agent), cloud (runtime factory) | cloud/packages/tests/runtime/integration/runtime-factory/config-change-race.test.ts, cloud/packages/tests/runtime/integration/runtime-factory/oauth-cache-invalidation.test.ts, packages/app-core/test/live-agent/plugin-lifecycle.live.e2e.test.ts | ❌ | ❌ | Google Gemini provider e2e (alias used by some tests instead of `GOOGLE_GENERATIVE_AI_API_KEY`) |
| `GOOGLE_API_KEY` | app-core (live-agent), cloud (runtime factory) | cloud/packages/tests/runtime/integration/runtime-factory/config-change-race.test.ts, cloud/packages/tests/runtime/integration/runtime-factory/oauth-cache-invalidation.test.ts, packages/app-core/test/live-agent/plugin-lifecycle.live.e2e.test.ts | ❌ | ✅ | Google AI Studio key |
| `GOOGLE_GENERATIVE_AI_API_KEY` | plugin-google-genai, app-core (live-agent), cloud (runtime factory) | cloud/packages/tests/runtime/integration/runtime-factory/config-change-race.test.ts, cloud/packages/tests/runtime/integration/runtime-factory/oauth-cache-invalidation.test.ts, packages/app-core/test/live-agent/plugin-lifecycle.live.e2e.test.ts +1 more | ✅ | ✅ (also `ELIZA_E2E_GOOGLE_GENERATIVE_AI_API_KEY`) | Gemini provider e2e |
| `GROQ_API_KEY` | plugin-groq, app-core (live-agent), cloud (providers fallback) | cloud/packages/tests/unit/providers-fallback.test.ts, packages/app-core/test/live-agent/plugin-lifecycle.live.e2e.test.ts | ✅ | ✅ (also `ELIZA_E2E_GROQ_API_KEY`) | Groq provider e2e |
| `OPENAI_API_KEY` | plugin-openai, plugin-vision, plugin-form, plugin-wallet, plugin-agent-orchestrator, agent (provider switch / credentials / media), app-core (live-agent), cloud (providers fallback) | plugins/plugin-vision/test/vision-cross-platform.e2e.test.ts, plugins/plugin-vision/test/vision.real.e2e.test.ts, packages/app-core/test/live-agent/plugin-lifecycle.live.e2e.test.ts +8 more | ✅ | ✅ (also `ELIZA_E2E_OPENAI_API_KEY`) | OpenAI provider e2e (also auto-populated from `CEREBRAS_API_KEY` by the test harness) |
| `OPENROUTER_API_KEY` | plugin-openrouter, app-core (live-agent), cloud (providers fallback, model catalog) | cloud/packages/tests/integration/model-catalog-live-server.live.e2e.test.ts, cloud/packages/tests/unit/providers-fallback.test.ts, packages/app-core/test/live-agent/plugin-lifecycle.live.e2e.test.ts +1 more | ✅ | ✅ (also `ELIZA_E2E_OPENROUTER_API_KEY`) | OpenRouter provider e2e |

## Eliza Cloud / agent platform

| Key | Used by (plugin/package) | Test files | In .env.test.example? | In CI? | Purpose |
|---|---|---|---|---|---|
| `ELIZAOS_CLOUD_API_KEY` | cloud (sdk), app-core (cloud-login persist), plugin-app-lifeops (approval queue) | cloud/packages/sdk/src/live.e2e.test.ts, packages/app-core/test/live-agent/cloud-login-persist.real.e2e.test.ts, plugins/app-lifeops/test/approval-queue.integration.test.ts +2 more | ❌ | ✅ (also `ELIZA_E2E_ELIZACLOUD_API_KEY` / `ELIZACLOUD_API_KEY`) | Eliza Cloud managed API key |
| `ELIZA_API_TOKEN` | agent (auth-routes), app-core (auth-bootstrap, auth-session, auth-pairing, api-auth-live, automations-compat, memory-relationships, qa-checklist), plugin-app-lifeops (remote signals) | packages/agent/src/api/auth-routes.test.ts, packages/app-core/src/api/auth-bootstrap-routes.real.test.ts, packages/app-core/src/api/auth-pairing-compat-routes.test.ts +6 more | ❌ | ❌ | Local agent API server auth token (per-test seeded) |
| `ELIZA_CLOUD_API_KEY` | cloud (sdk live e2e) | cloud/packages/sdk/src/live.e2e.test.ts | ❌ | ❌ | Cloud SDK direct API key |
| `ELIZA_CLOUD_PAIR_TOKEN` | cloud (sdk live e2e) | cloud/packages/sdk/src/live.e2e.test.ts | ❌ | ❌ | Cloud pairing token for desktop pairing flow |
| `ELIZA_CLOUD_SESSION_TOKEN` | cloud (sdk live e2e) | cloud/packages/sdk/src/live.e2e.test.ts | ❌ | ❌ | Cloud session token (browser-issued) |
| `ELIZA_LIFEOPS_REMOTE_E2E_TOKEN` | plugin-app-lifeops | plugins/app-lifeops/test/lifeops-activity-signals.remote.live.e2e.test.ts | ❌ | ❌ | Lifeops remote signal e2e bearer |
| `ELIZA_SERVICE_JWT_SECRET` | cloud (waifu bridge) | cloud/packages/tests/unit/waifu-bridge.test.ts | ❌ | ❌ | Internal service JWT signing secret |
| `ELIZA_WALLET_EXPORT_TOKEN` | app-core (api-auth-live), plugin-app-steward | packages/app-core/test/live-agent/api-auth-live.e2e.test.ts, plugins/app-steward/test/wallet-live.e2e.test.ts | ❌ | ❌ | Wallet export bearer for e2e |
| `GATEWAY_INTERNAL_SECRET` | cloud (gateway-webhook) | cloud/services/gateway-webhook/__tests__/internal-auth.test.ts | ❌ | ❌ | Internal gateway webhook auth |
| `INTERNAL_API_KEY` | plugin-computeruse | plugins/plugin-computeruse/src/__tests__/terminal.real.test.ts | ❌ | ❌ | Internal API key (computeruse terminal) |
| `INTERNAL_SECRET` | cloud (api group-a, group-h) | cloud/apps/api/test/e2e/group-a-auth.test.ts, cloud/apps/api/test/e2e/group-h-misc.test.ts | ❌ | ❌ | Cloud internal route shared secret |
| `SECRETS_MASTER_KEY` | cloud (discord-connections, telegram-automation) | cloud/packages/tests/integration/discord-connections.test.ts, cloud/packages/tests/integration/telegram-automation.test.ts | ❌ | ❌ | Cloud secrets vault master key |
| `STEWARD_TENANT_API_KEY` | cloud (steward-tenant) | cloud/packages/tests/unit/steward-tenant-config.test.ts | ❌ | ❌ | Steward tenant API key |
| `TEST_API_KEY` | cloud (api group A–J e2e, integration suites) | cloud/apps/api/test/e2e/agent-token-flow.test.ts, cloud/apps/api/test/e2e/group-a-auth.test.ts, cloud/apps/api/test/e2e/group-b-account-billing.test.ts +10 more | ❌ | ❌ | Cloud auth-gated e2e API key (tests skip when missing) |
| `WAIFU_SERVICE_KEY` | cloud (service-key-auth) | cloud/packages/tests/unit/service-key-auth.test.ts | ❌ | ❌ | Waifu service auth key |

## Messaging connectors

| Key | Used by (plugin/package) | Test files | In .env.test.example? | In CI? | Purpose |
|---|---|---|---|---|---|
| `BLUESKY_HANDLE` | examples/bluesky | packages/examples/bluesky/__tests__/integration.test.ts | ❌ | ❌ | Bluesky handle for connector e2e |
| `BLUESKY_PASSWORD` | examples/bluesky | packages/examples/bluesky/__tests__/integration.test.ts | ✅ | ❌ | Bluesky app password |
| `ELIZA_APP_WHATSAPP_APP_SECRET` | cloud (whatsapp-webhook e2e) | cloud/packages/tests/integration/whatsapp-webhook-e2e.test.ts | ❌ | ❌ | WhatsApp webhook signing secret |
| `ELIZA_APP_WHATSAPP_VERIFY_TOKEN` | cloud (whatsapp-webhook e2e) | cloud/packages/tests/integration/whatsapp-webhook-e2e.test.ts | ❌ | ❌ | WhatsApp verify token |
| `ELIZA_WHATSAPP_ACCESS_TOKEN` | plugin-app-lifeops | plugins/app-lifeops/src/lifeops/service-mixin-runtime-delegation.test.ts | ❌ | ✅ (as `ELIZA_E2E_WHATSAPP_ACCESS_TOKEN`) | WhatsApp Cloud access token |
| `FARCASTER_FID` | app-core (farcaster connector live) | packages/app-core/test/live-agent/farcaster-connector.live.e2e.test.ts | ❌ | ❌ | Farcaster ID |
| `FARCASTER_NEYNAR_API_KEY` | app-core (farcaster connector live) | packages/app-core/test/live-agent/farcaster-connector.live.e2e.test.ts | ✅ | ❌ | Neynar API key |
| `FARCASTER_SIGNER_UUID` | app-core (farcaster connector live) | packages/app-core/test/live-agent/farcaster-connector.live.e2e.test.ts | ❌ | ❌ | Farcaster signer UUID |
| `FEISHU_APP_ID` | app-core (feishu connector live) | packages/app-core/test/live-agent/feishu-connector.live.e2e.test.ts | ❌ | ❌ | Feishu app ID |
| `FEISHU_APP_SECRET` | app-core (feishu connector live) | packages/app-core/test/live-agent/feishu-connector.live.e2e.test.ts | ❌ | ❌ | Feishu app secret |
| `FEISHU_TEST_CHAT_ID` | app-core (feishu connector live) | packages/app-core/test/live-agent/feishu-connector.live.e2e.test.ts | ❌ | ❌ | Feishu test chat ID |
| `MATRIX_ACCESS_TOKEN` | app-core (matrix connector live) | packages/app-core/test/live-agent/matrix-connector.live.e2e.test.ts | ❌ | ❌ | Matrix access token |
| `NOSTR_PRIVATE_KEY` | app-core (nostr connector live) | packages/app-core/test/live-agent/nostr-connector.live.e2e.test.ts | ❌ | ❌ | Nostr private key (nsec) |
| `TELEGRAM_BOT_TOKEN` | app-core (telegram connector live) | packages/app-core/test/live-agent/telegram-connector.live.e2e.test.ts | ✅ | ✅ (also `ELIZA_E2E_TELEGRAM_BOT_TOKEN`) | Telegram bot token |
| `TELEGRAM_TEST_CHAT_ID` | app-core (telegram connector live) | packages/app-core/test/live-agent/telegram-connector.live.e2e.test.ts | ✅ | ✅ (as `ELIZA_E2E_TELEGRAM_CHAT_ID`) | Telegram test chat ID |
| `TWITTER_ACCESS_TOKEN` | plugin-x | plugins/plugin-x/src/__tests__/e2e/twitter-integration.test.ts | ❌ | ✅ (as `X_ACCESS_TOKEN`) | X/Twitter user access token |
| `TWITTER_ACCESS_TOKEN_SECRET` | plugin-x | plugins/plugin-x/src/__tests__/e2e/twitter-integration.test.ts | ❌ | ✅ (as `X_ACCESS_SECRET`) | X/Twitter access token secret |
| `TWITTER_API_KEY` | plugin-x, cloud (oauth provider-registry) | cloud/packages/tests/unit/oauth/provider-registry.test.ts, plugins/plugin-x/src/__tests__/e2e/twitter-integration.test.ts | ❌ | ✅ (as `X_API_KEY`) | X/Twitter consumer key |
| `TWITTER_API_SECRET_KEY` | plugin-x, cloud (oauth provider-registry) | cloud/packages/tests/unit/oauth/provider-registry.test.ts, plugins/plugin-x/src/__tests__/e2e/twitter-integration.test.ts | ❌ | ✅ (as `X_API_SECRET`) | X/Twitter consumer secret |
| `TWITTER_CLIENT_ID` | cloud (oauth provider-registry, twitter-oauth2-client) | cloud/packages/tests/unit/oauth/provider-registry.test.ts, cloud/packages/tests/unit/twitter-oauth2-client.test.ts | ❌ | ✅ (as `ELIZA_E2E_TWITTER_CLIENT_ID`) | X/Twitter OAuth2 client ID |
| `TWITTER_CLIENT_SECRET` | cloud (twitter-oauth2-client) | cloud/packages/tests/unit/twitter-oauth2-client.test.ts | ❌ | ✅ (as `ELIZA_E2E_TWITTER_CLIENT_SECRET`) | X/Twitter OAuth2 client secret |
| `WHATSAPP_ACCESS_TOKEN` | app-core (live-agent plugin lifecycle) | packages/app-core/test/live-agent/plugin-lifecycle.live.e2e.test.ts | ❌ | ✅ (as `ELIZA_E2E_WHATSAPP_ACCESS_TOKEN`) | WhatsApp access token |
| `WHATSAPP_PHONE_NUMBER_ID` | app-core (live-agent plugin lifecycle) | packages/app-core/test/live-agent/plugin-lifecycle.live.e2e.test.ts | ✅ | ✅ (as `WHATSAPP_PHONE_ID` / `ELIZA_E2E_WHATSAPP_PHONE_NUMBER_ID`) | WhatsApp phone number ID |

## Productivity / SaaS / OAuth

| Key | Used by (plugin/package) | Test files | In .env.test.example? | In CI? | Purpose |
|---|---|---|---|---|---|
| `CLOUDFLARE_API_TOKEN` | cloud (cloudflare-registrar-stub) | cloud/packages/tests/unit/domains/cloudflare-registrar-stub.test.ts | ❌ | ✅ | Cloudflare registrar stub |
| `CRON_SECRET` | cloud (cron-auth, model-catalog) | cloud/packages/tests/integration/cron-auth.test.ts, cloud/packages/tests/integration/model-catalog-live-server.live.e2e.test.ts, cloud/packages/tests/unit/cron-auth.test.ts | ❌ | ❌ | Cron endpoint shared secret |
| `DUFFEL_API_KEY` | plugin-app-lifeops (book-travel) | plugins/app-lifeops/test/book-travel.approval.integration.test.ts, plugins/app-lifeops/test/travel-duffel.integration.test.ts | ❌ | ❌ | Duffel travel booking API |
| `ELIZA_GOOGLE_OAUTH_DESKTOP_CLIENT_ID` | plugin-app-lifeops | plugins/app-lifeops/test/assistant-user-journeys.live.e2e.test.ts, plugins/app-lifeops/test/assistant-user-journeys.morning-brief.e2e.test.ts, plugins/app-lifeops/test/lifeops-calendar-chat.real.test.ts +1 more | ❌ | ❌ | Desktop Google OAuth client ID |
| `GOOGLE_CLIENT_ID` | cloud (oauth-api, oauth provider-registry) | cloud/packages/tests/integration/oauth-api.test.ts, cloud/packages/tests/unit/oauth/provider-registry.test.ts | ❌ | ✅ (as `GOOGLE_OAUTH_CLIENT_ID`) | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | cloud (oauth provider-registry) | cloud/packages/tests/unit/oauth/provider-registry.test.ts | ❌ | ✅ (as `GOOGLE_OAUTH_CLIENT_SECRET`) | Google OAuth client secret |
| `GOOGLE_OAUTH_TEST_TOKEN` | plugin-app-lifeops (google-drive integration) | plugins/app-lifeops/test/google-drive.integration.test.ts | ❌ | ❌ | Pre-issued Google OAuth bearer for tests |
| `HCLOUD_TOKEN` | cloud (agent-hot-pool-cron) | cloud/packages/tests/unit/agent-hot-pool-cron.test.ts | ❌ | ❌ | Hetzner Cloud API token |
| `HETZNER_CLOUD_API_KEY` | cloud (agent-hot-pool-cron) | cloud/packages/tests/unit/agent-hot-pool-cron.test.ts | ❌ | ❌ | Hetzner Cloud API key (alias) |
| `HETZNER_CLOUD_TOKEN` | cloud (agent-hot-pool-cron) | cloud/packages/tests/unit/agent-hot-pool-cron.test.ts | ❌ | ❌ | Hetzner Cloud token (alias) |
| `KV_REST_API_TOKEN` | cloud (cache-adapters, redis-queue, model-catalog live) | cloud/packages/tests/integration/model-catalog-live-server.live.e2e.test.ts, cloud/packages/tests/unit/cache-adapters.test.ts, cloud/packages/tests/unit/redis-queue.test.ts | ❌ | ❌ | Vercel KV / Upstash REST token |
| `PLAYWRIGHT_TEST_AUTH_SECRET` | cloud (playwright-test-session) | cloud/packages/tests/unit/playwright-test-session.test.ts | ❌ | ❌ | Playwright test session signing secret |
| `UPSTASH_REDIS_REST_TOKEN` | cloud (cache-adapters, redis-queue) | cloud/packages/tests/unit/cache-adapters.test.ts, cloud/packages/tests/unit/redis-queue.test.ts | ❌ | ❌ | Upstash Redis REST token |

## Web3 / wallets

| Key | Used by (plugin/package) | Test files | In .env.test.example? | In CI? | Purpose |
|---|---|---|---|---|---|
| `BIRDEYE_API_KEY` | plugin-wallet (solana birdeye) | plugins/plugin-wallet/src/chains/solana/__tests__/integration/birdeye-direct.live.test.ts | ❌ | ✅ | Birdeye Solana market data |
| `EVM_PRIVATE_KEY` | app-core (api-auth-live, automations-compat) | packages/app-core/test/live-agent/api-auth-live.e2e.test.ts, packages/app-core/test/live-agent/automations-compat-routes.test.ts | ❌ | ❌ | EVM wallet private key for live e2e |
| `HELIUS_API_KEY` | plugin-wallet (solana birdeye) | plugins/plugin-wallet/src/chains/solana/__tests__/integration/birdeye-direct.live.test.ts | ❌ | ❌ | Helius Solana RPC API key |
| `LENS_API_KEY` | app-core (lens connector live) | packages/app-core/test/live-agent/lens-connector.live.e2e.test.ts | ❌ | ❌ | Lens Protocol API key |
| `LENS_PRIVATE_KEY` | app-core (lens connector live) | packages/app-core/test/live-agent/lens-connector.live.e2e.test.ts | ❌ | ❌ | Lens Protocol signing key |
| `POLYMARKET_PRIVATE_KEY` | app-core (automations-compat) | packages/app-core/test/live-agent/automations-compat-routes.test.ts | ❌ | ❌ | Polymarket private key |
| `SOLANA_API_KEY` | app-core (api-auth-live) | packages/app-core/test/live-agent/api-auth-live.e2e.test.ts | ❌ | ❌ | Solana RPC API key |
| `SOLANA_PRIVATE_KEY` | app-core (api-auth-live, automations-compat) | packages/app-core/test/live-agent/api-auth-live.e2e.test.ts, packages/app-core/test/live-agent/automations-compat-routes.test.ts | ❌ | ❌ | Solana wallet private key for live e2e |
| `TEST_PRIVATE_KEY` | plugin-wallet (evm transfer live) | plugins/plugin-wallet/src/chains/evm/__tests__/integration/transfer.live.test.ts | ❌ | ❌ | Test EVM private key |

## Missing on CI (action required)

The following keys are referenced by at least one test file but are **not**
listed in any `.github/workflows/*.yml` (no `secrets.X` reference, including
`ELIZA_E2E_*` aliases). Live/integration tests that rely on them will be
silently skipped in CI:

- `ANTHROPIC_OAUTH_TOKEN` (plugin-anthropic credential-store e2e)
- `CEREBRAS_API_KEY` — universal default LLM, the entire Cerebras-backed test
  suite has no provisioned key in CI
- `CLAUDE_CODE_OAUTH_TOKEN` (plugin-agent-orchestrator task-agent live e2e,
  plugin-anthropic credential store)
- `CRON_SECRET` (cloud cron-auth + model-catalog live e2e)
- `DUFFEL_API_KEY` (plugin-app-lifeops travel)
- `ELEVENLABS_API_KEY` (app-core qa checklist real e2e)
- `ELIZA_API_TOKEN` (agent + app-core auth route tests, 9 files)
- `ELIZA_CLOUD_API_KEY` / `ELIZA_CLOUD_PAIR_TOKEN` / `ELIZA_CLOUD_SESSION_TOKEN`
  (cloud sdk live e2e)
- `ELIZA_LIFEOPS_REMOTE_E2E_TOKEN` (plugin-app-lifeops remote signals)
- `ELIZA_SERVICE_JWT_SECRET` (cloud waifu-bridge)
- `ELIZA_WALLET_EXPORT_TOKEN` (app-core api-auth-live, plugin-app-steward
  wallet)
- `ELIZA_APP_WHATSAPP_APP_SECRET` / `ELIZA_APP_WHATSAPP_VERIFY_TOKEN`
  (cloud whatsapp-webhook e2e)
- `EVM_PRIVATE_KEY` (app-core api-auth-live + automations-compat)
- `FARCASTER_FID` / `FARCASTER_NEYNAR_API_KEY` / `FARCASTER_SIGNER_UUID`
  (app-core farcaster connector live)
- `FEISHU_APP_ID` / `FEISHU_APP_SECRET` / `FEISHU_TEST_CHAT_ID`
  (app-core feishu connector live)
- `GATEWAY_INTERNAL_SECRET` (cloud gateway-webhook internal-auth)
- `GEMINI_API_KEY` (alias used by app-core live-agent + cloud runtime-factory)
- `GOOGLE_OAUTH_TEST_TOKEN` (plugin-app-lifeops google-drive integration)
- `HCLOUD_TOKEN` / `HETZNER_CLOUD_API_KEY` / `HETZNER_CLOUD_TOKEN`
  (cloud agent-hot-pool-cron)
- `HELIUS_API_KEY` (plugin-wallet solana birdeye)
- `INTERNAL_API_KEY` (plugin-computeruse terminal)
- `INTERNAL_SECRET` (cloud api group-a / group-h e2e)
- `KV_REST_API_TOKEN` / `UPSTASH_REDIS_REST_TOKEN`
  (cloud cache-adapters + redis-queue + model-catalog live)
- `LENS_API_KEY` / `LENS_PRIVATE_KEY` (app-core lens connector live)
- `MATRIX_ACCESS_TOKEN` (app-core matrix connector live)
- `NOSTR_PRIVATE_KEY` (app-core nostr connector live)
- `PLAYWRIGHT_TEST_AUTH_SECRET` (cloud playwright-test-session)
- `POLYMARKET_PRIVATE_KEY` (app-core automations-compat)
- `SECRETS_MASTER_KEY` (cloud discord-connections + telegram-automation)
- `SOLANA_API_KEY` / `SOLANA_PRIVATE_KEY` / `TEST_PRIVATE_KEY`
  (wallet live e2e)
- `STEWARD_TENANT_API_KEY` (cloud steward-tenant-config)
- `TEST_API_KEY` (cloud api group A–J e2e, 13 files — auth-gated tests skip
  without it)
- `WAIFU_SERVICE_KEY` (cloud service-key-auth)
- `ELIZA_GOOGLE_OAUTH_DESKTOP_CLIENT_ID` (plugin-app-lifeops assistant +
  morning-brief + calendar-chat)
- `ELIZA_WHATSAPP_ACCESS_TOKEN` (plugin-app-lifeops service-mixin runtime
  delegation)

## Optional / local-only

These appear in `.env.test.example` and/or CI but are not directly referenced
by any in-scope test file (no `process.env.X` lookup in a `*.test.ts` /
`*.real.e2e.test.ts` / `*.live.e2e.test.ts`). They are configured for plugin
loading or tooling rather than test-time gates:

- `XAI_API_KEY` — plugin-xai loads from this; no test file reads it directly.
- `GITHUB_TOKEN` — used by CI workflows and runtime, not by any in-scope test.
- `LINEAR_API_KEY`, `CALENDLY_API_KEY` — plugin runtime config; no in-scope
  test reads them via `process.env`.
- `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` — plugin runtime config; no
  in-scope test reads them via `process.env`.
- `GOOGLE_OAUTH_REFRESH_TOKEN` — plugin runtime config.
- `SHOPIFY_API_KEY` — plugin runtime config.
- `HYPERLIQUID_PRIVATE_KEY`, `POLYMARKET_API_KEY` — plugin runtime config
  (note: `POLYMARKET_PRIVATE_KEY` IS used by tests, the `_API_KEY` variant is
  not).
- `SLACK_BOT_TOKEN`, `SLACK_TEST_CHANNEL_ID` — connector runtime config.
- `DISCORD_BOT_TOKEN`, `DISCORD_TEST_GUILD_ID` — connector runtime config (CI
  has them as `ELIZA_E2E_DISCORD_*`).
- `WHATSAPP_TOKEN` — connector runtime config (the test-relevant var is
  `WHATSAPP_ACCESS_TOKEN` / `ELIZA_WHATSAPP_ACCESS_TOKEN`).
- `X_BEARER_TOKEN` — connector runtime config (test files use the
  `TWITTER_*` quartet).
- `ELIZAOS_API_KEY` — surfaced via `runtime.getSetting("ELIZAOS_API_KEY")`
  in plugin code, not via `process.env` in test files.
