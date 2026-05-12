# Full Real E2E Environment Key Inventory

Last audited: 2026-05-10

This document lists the environment keys needed to run real end-to-end testing for
Eliza Cloud, local agents, sensitive secret requests, payment links, OAuth account
connections, private DM delivery, tunnels, callbacks, and security validation.

No secret values are recorded here. The local availability notes only say whether a
non-placeholder value was found in ignored local env files or generated dev vars.

## Status Legend

- `configured`: a non-placeholder value exists in one of the audited ignored env files.
- `generated`: local E2E setup generates or injects the value.
- `example only`: the key appears in a template only and needs a real value.
- `placeholder`: the key exists locally but is empty or a placeholder.
- `missing`: no local value or template value was found in the audited files.
- `request field`: the value is supplied per API request, not as process env.

Audited local files: `.env`, `.env.test`, `cloud/.env`, `cloud/.env.local`,
`cloud/.env.vercel.preview.local`, `cloud/.env.vercel.production.local`, and
`cloud/apps/api/.dev.vars`.

Audited templates: `.env.example`, `.env.test.example`, `cloud/.env.example`,
`cloud/apps/api/.dev.vars.example`, `cloud/packages/infra/local/.env.*.example`,
and `cloud/services/gateway-discord/terraform/tfvars/secrets.tfvars.example`.

## Cleaned Missing External Configuration

These are the remaining real external credentials or account-specific targets
after removing local/generated shared secrets, optional one-off harness values,
and duplicated backend choices.

| Key or group | Status | Blocks |
| --- | --- | --- |
| `ELIZAOS_CLOUD_API_KEY` or `ELIZA_CLOUD_API_KEY` | configured locally via SIWE | Cloud SDK live checks, cloud-backed tunnel plugin, authenticated cloud tool tests. The wallet private key was not stored or handed to workers. |
| Discord runtime test targets | configured locally | Runtime plugin DM, slash-command, and public-context verification tests. Test channel defaults to `DISCORD_CHANNEL_ID`; guild ID was inferred from Discord's channel API. |
| Telegram runtime target: `TELEGRAM_TEST_CHAT_ID` | missing | Real Telegram private-chat fallback tests. `TELEGRAM_BOT_TOKEN`, bot ID, and username are inferred locally from Eliza App Telegram config. |
| Optional post-merge social targets: `SLACK_BOT_TOKEN`, `SLACK_TEST_CHANNEL_ID` | example only | Slack connector coverage outside the core secret/payment flow. `X_BEARER_TOKEN` is mirrored from the configured Twitter bearer token. |
| Organization-level Twilio: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER` | missing / example only | Org-level SMS/voice live tests. WhatsApp and Blooio generic names are now mirrored locally from Eliza App provider config. |
| Tunnel backend, choose one: headscale/proxy credentials, local Tailscale login or `TAILSCALE_AUTH_KEY`, or `NGROK_AUTH_TOKEN` | missing | Real local exposure and callback E2E. Cloud Tailscale auth can now use the configured `ELIZAOS_CLOUD_API_KEY`, but this machine does not currently have the `tailscale` CLI available. |
| Cloud customer tunnel proxy: `HEADSCALE_PUBLIC_URL`, `HEADSCALE_INTERNAL_TOKEN`, `TUNNEL_PROXY_HOST`, `TUNNEL_TAILNET_DOMAIN`, `TUNNEL_PROXY_TS_AUTHKEY` | missing | Managed customer tunnel issuance, reverse lookup, and public proxy routing. |
| Google Drive test extra: `GOOGLE_OAUTH_TEST_TOKEN` | missing | Real Google Drive API coverage. `GOOGLE_REDIRECT_URI` is generated locally from `NEXT_PUBLIC_API_URL`. |
| Vendor OAuth clients: Shopify, Calendly, LinkedIn | missing | Vendor OAuth/account-linking live tests. Linear OAuth names are mirrored from the configured Linear client. |
| Optional LLM providers: `OPENROUTER_API_KEY`, `GROQ_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`, `XAI_API_KEY` | placeholder / example only | Provider-specific live coverage. OpenAI, Anthropic, Cerebras, and AI Gateway are configured. |
| Object storage backend, choose one: `R2_ACCOUNT_ID`/`R2_ACCESS_KEY_ID`/`R2_SECRET_ACCESS_KEY` plus buckets, or generic `STORAGE_PROVIDER`/`STORAGE_ENDPOINT`/`STORAGE_ACCESS_KEY_ID`/`STORAGE_SECRET_ACCESS_KEY` plus buckets | missing | Node-side object storage tests outside Worker local R2 bindings and Docker local file storage. |
| `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN` | example only | Real domain registrar/DNS purchase/update tests. |
| `HCLOUD_TOKEN` | example only | Real Hetzner autoscale node provisioning. |

Removed from the missing API-key list:

- `INTERNAL_SECRET`, `GATEWAY_INTERNAL_SECRET`, `AGENT_SERVER_SHARED_SECRET`,
  and `PLAYWRIGHT_TEST_AUTH_SECRET` are local/deployment shared secrets, not
  provider API keys. Local Cloud API dev-var sync now preserves or generates
  them.
- `ELIZAOS_CLOUD_API_KEY` has been minted through SIWE and synchronized into
  local Cloud API dev vars as both `ELIZAOS_CLOUD_API_KEY` and
  `ELIZA_CLOUD_API_KEY`.
- `ELIZA_API_TOKEN` is generated locally as a shared secret for protected local
  agent/API tests. An external protected remote target can still require its own
  target-specific token.
- `ELIZA_LIFEOPS_REMOTE_E2E_TOKEN` is a confusing harness alias. Prefer
  `ELIZA_API_TOKEN` for protected agent calls.
- `STEWARD_API_URL`, `STEWARD_SESSION_SECRET`, tenant IDs, and
  `STEWARD_TENANT_API_KEY` are already configured locally. Only Steward platform
  administration/vault paths still need platform/master credentials.
- `DISCORD_API_TOKEN` and `DISCORD_APPLICATION_ID` are mirrored in local dev vars
  from `DISCORD_BOT_TOKEN` and `DISCORD_CLIENT_ID`.
- `DISCORD_TEST_CHANNEL_ID` is mirrored from `DISCORD_CHANNEL_ID`; 
  `DISCORD_TEST_GUILD_ID` was inferred via the Discord channel API.
- Generic Telegram, WhatsApp, and Blooio env names are mirrored from existing
  Eliza App provider config; Telegram bot ID/username were inferred via
  Telegram `getMe`.
- `GOOGLE_REDIRECT_URI` is generated from `NEXT_PUBLIC_API_URL`.
- `FAL_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`/`GOOGLE_API_KEY`, and
  `UPSTASH_REDIS_REST_URL`/`UPSTASH_REDIS_REST_TOKEN` have local alias mirroring
  where a source alias is present.
- Payment core keys for Stripe, OxaPay, x402, payout wallets, and Alchemy are
  already configured; remaining payment work is callback reachability and test
  target setup.

## Test Harness And Gates

| Key | Status | Required for |
| --- | --- | --- |
| `ELIZA_LIVE_TEST=1` | configured | Enables live app-core, plugin, and LifeOps suites. |
| `TEST_LANE=post-merge` | configured as `pr` locally | Allows real E2E tests in root `run-all-tests`. |
| `ELIZA_REAL_APIS=1` | example only | Post-merge tests that must hit real APIs instead of fakes. |
| `CLOUD_FULL_SUITE=1` | missing | Forces cloud smoke failures instead of skipping. |
| `ELIZA_CLOUD_SDK_LIVE=1` | missing | Enables cloud SDK live E2E. |
| `TEST_BASE_URL`, `TEST_API_BASE_URL`, `TEST_SERVER_PORT` | generated / optional | Local cloud API or Worker target selection. |
| `TEST_API_KEY`, `TEST_SESSION_TOKEN`, `TEST_SESSION_COOKIE_NAME` | generated | Authenticated cloud E2E requests. |
| `TEST_DATABASE_URL`, `DATABASE_URL` | generated / configured | DB-backed cloud E2E. |
| `CRON_SECRET` | configured | Cron route auth and queue processing tests. |
| `INTERNAL_SECRET` | generated in preload/dev vars | Internal route auth in local and deployed tests. |
| `PLAYWRIGHT_TEST_AUTH`, `PLAYWRIGHT_TEST_AUTH_SECRET` | generated when enabled | Cloud Playwright session bootstrap. |

## Cloud Runtime Core

| Key | Status | Required for |
| --- | --- | --- |
| `DATABASE_URL` | configured | Cloud API DB, OAuth persistence, payments, sensitive requests. |
| `NEXT_PUBLIC_APP_URL` | configured | OAuth redirects, payment return URLs, public sensitive request links. |
| `NEXT_PUBLIC_API_URL` | configured | API base URL, x402 public payment resource fallback. |
| `ELIZA_API_URL` | missing | HTTPS webhook URL override for local ngrok/tunnel webhook testing. |
| `ELIZA_CLOUD_URL` | configured in generated dev vars | Gateway/cloud SDK base URL. |
| `CACHE_BACKEND` | configured | Local Wadis/Redis selection. |
| `REDIS_URL` | configured | Agent server and gateway coordination. |
| `KV_REST_API_URL`, `KV_REST_API_TOKEN` | configured | Upstash REST cache/events/gateway failover. |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | mirrored locally from `KV_REST_API_*` | Alternate Upstash naming used by some deployments. |
| `BLOB_READ_WRITE_TOKEN` | configured | Gateway voice blob handling where used. |

## Steward, Session, And Service Auth

| Key | Status | Required for |
| --- | --- | --- |
| `STEWARD_API_URL`, `NEXT_PUBLIC_STEWARD_API_URL` | configured | Steward auth API client/server routing. |
| `STEWARD_SESSION_SECRET` | configured | Verifying Steward JWT/session cookies. |
| `STEWARD_JWT_SECRET` | mirrored locally from `STEWARD_SESSION_SECRET` | Preferred alternate Steward JWT secret name. |
| `STEWARD_TENANT_ID`, `NEXT_PUBLIC_STEWARD_TENANT_ID` | configured | Tenant claim checks. |
| `STEWARD_PLATFORM_KEYS` | example only | Steward platform/tenant admin operations only. |
| `STEWARD_TENANT_API_KEY` | configured | Tenant-scoped Steward operations. |
| `STEWARD_MASTER_PASSWORD` | missing | Steward vault/wallet operations when required. Not needed for baseline session/auth E2E. |
| `STEWARD_API_KEY` | mirrored locally from `STEWARD_TENANT_API_KEY` | Older/local Steward sidecar tenant auth. |
| `STEWARD_AGENT_TOKEN`, `STEWARD_AGENT_ID`, `ELIZA_STEWARD_AGENT_ID` | missing | Steward agent-specific wallet sidecar paths. |
| `ELIZA_API_TOKEN` | generated locally / remote target token may differ | Protected local/remote agent API auth and LifeOps remote callbacks. |
| `JWT_SIGNING_PRIVATE_KEY`, `JWT_SIGNING_PUBLIC_KEY`, `JWT_SIGNING_KEY_ID` | configured / generated | Gateway JWT issuance and verification. |
| `GATEWAY_BOOTSTRAP_SECRET` | configured | Gateway startup JWT bootstrap. |
| `GATEWAY_INTERNAL_SECRET` | generated locally / deploy secret required | Gateway webhook/internal event delivery auth. |

## Secret Storage And Encryption

| Key | Status | Required for |
| --- | --- | --- |
| `SECRETS_MASTER_KEY` | configured | Cloud secrets service, field encryption, sensitive request secret storage. |
| `AWS_KMS_KEY_ID` | missing | AWS KMS-backed secret envelope encryption. |
| `AWS_REGION` | configured | AWS KMS/S3 clients when used. |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | configured | AWS KMS/S3 explicit credentials when used outside IAM. |

Notes:

- `SECRETS_MASTER_KEY` is enough for local and production local-KMS mode.
- AWS KMS is optional unless the deployment chooses KMS-backed encryption.
- Sensitive request callback metadata is redacted in code; callback secrets are request fields, not env vars.

## LLM, Media, And Live Agent Providers

| Key | Status | Required for |
| --- | --- | --- |
| `CEREBRAS_API_KEY` | configured | Default fast live/post-merge test LLM. |
| `OPENAI_API_KEY` | configured | OpenAI live tests and Cerebras OpenAI-compatible wiring. |
| `ANTHROPIC_API_KEY` | configured | Anthropic live tests and coding/security agent paths. |
| `OPENROUTER_API_KEY` | placeholder | OpenRouter live tests. |
| `AI_GATEWAY_API_KEY` | configured | Vercel AI Gateway route/provider tests. |
| `GROQ_API_KEY` | example only | Groq live tests. |
| `GOOGLE_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY` | missing / example only | Gemini/Google AI live tests. |
| `XAI_API_KEY` | example only | xAI live tests. |
| `ELEVENLABS_API_KEY` | configured | Voice clone/TTS live tests. |
| `FAL_KEY`, `FAL_API_KEY` | configured / mirrored locally | Image/video generation live tests. |
| `CLAUDE_CODE_OAUTH_TOKEN` | missing | Claude Code live task-agent smoke fallback. |
| `OPENAI_API_KEY_REAL` | missing | Real OpenAI trajectory tests that intentionally avoid Cerebras aliasing. |

## Payment Links, Settlement, And Callbacks

### Stripe

| Key | Status | Required for |
| --- | --- | --- |
| `STRIPE_SECRET_KEY` | configured | Stripe checkout/session creation and webhook processing. |
| `STRIPE_WEBHOOK_SECRET` | configured | `/api/stripe/webhook` signature verification. |
| `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | configured | Browser Stripe checkout UI. |
| `STRIPE_CURRENCY` | missing | Optional; defaults to `usd`. |
| `STRIPE_SMALL_PACK_PRICE_ID`, `STRIPE_MEDIUM_PACK_PRICE_ID`, `STRIPE_LARGE_PACK_PRICE_ID` | configured | Credit pack checkout when seeded/used. |
| `STRIPE_SMALL_PACK_PRODUCT_ID`, `STRIPE_MEDIUM_PACK_PRODUCT_ID`, `STRIPE_LARGE_PACK_PRODUCT_ID` | configured | Credit pack product metadata when seeded/used. |

### OxaPay

| Key | Status | Required for |
| --- | --- | --- |
| `OXAPAY_MERCHANT_API_KEY` | configured | Crypto invoices, inquiry, webhook HMAC audit hashing. |
| `OXAPAY_CALLBACK_URL` | missing | Optional local callback override. |
| `OXAPAY_RETURN_URL` | missing | Optional local return URL override. |
| `OXAPAY_WEBHOOK_IPS` | missing | Optional webhook source IP allowlist. |

### x402

| Key | Status | Required for |
| --- | --- | --- |
| `ENABLE_X402_PAYMENTS` | configured | x402 feature exposure. |
| `X402_NETWORK` | configured | Default x402 network. |
| `X402_NETWORKS`, `EVM_NETWORKS` | configured / missing | Enabled x402/facilitator network allowlist. |
| `X402_RECIPIENT_ADDRESS` | configured | EVM payment recipient. |
| `X402_SOLANA_RECIPIENT_ADDRESS`, `SOLANA_PAYOUT_WALLET_ADDRESS` | configured | Solana payment recipient. |
| `FACILITATOR_PRIVATE_KEY`, `X402_FACILITATOR_PRIVATE_KEY` | configured | EVM x402 settlement if not stored in secrets service. |
| `X402_SOLANA_FACILITATOR_PRIVATE_KEY`, `SOLANA_FACILITATOR_PRIVATE_KEY`, `SOLANA_PAYOUT_PRIVATE_KEY` | configured / missing / configured | Solana x402 settlement. |
| `X402_PUBLIC_BASE_URL`, `X402_BASE_URL` | missing | Optional public payment request base URL. |
| `X402_PLATFORM_FEE_BPS`, `X402_SERVICE_FEE_USD` | missing | Optional fee tuning; code has defaults. |
| `ALCHEMY_API_KEY`, `INFURA_API_KEY` | configured / missing | EVM RPC reliability for x402 settlement. |
| `X402_PAYMENT_PERMIT_ADDRESS_BSC`, `X402_PAYMENT_PERMIT_ADDRESS_BSC_TESTNET` | missing | Optional BSC permit contract overrides. |

### App Charge Callbacks

| Key | Status | Required for |
| --- | --- | --- |
| `callback_url` | request field | App charge webhook callback destination. |
| `callback_secret` | request field | Optional HMAC signing secret for callback delivery. |
| `callback_channel` | request field | Optional in-chat room/channel callback context. |
| `callback_metadata` | request field | Optional callback metadata; sensitive keys are redacted. |

App charge live checkout depends on Stripe and/or OxaPay keys. Callback delivery
has no global env secret.

## OAuth And Account Connections

### Generic Cloud OAuth Providers

| Provider | Keys | Status |
| --- | --- | --- |
| Google | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | configured |
| Microsoft | `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET` | configured |
| Linear | `LINEAR_CLIENT_ID`, `LINEAR_CLIENT_SECRET` | configured |
| Notion | `NOTION_CLIENT_ID`, `NOTION_CLIENT_SECRET` | configured |
| GitHub | `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | configured |
| Slack | `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET` | configured |
| HubSpot | `HUBSPOT_CLIENT_ID`, `HUBSPOT_CLIENT_SECRET` | configured |
| Asana | `ASANA_CLIENT_ID`, `ASANA_CLIENT_SECRET` | configured |
| Dropbox | `DROPBOX_CLIENT_ID`, `DROPBOX_CLIENT_SECRET` | configured |
| Salesforce | `SALESFORCE_CLIENT_ID`, `SALESFORCE_CLIENT_SECRET` | configured |
| Airtable | `AIRTABLE_CLIENT_ID`, `AIRTABLE_CLIENT_SECRET` | configured |
| Zoom | `ZOOM_CLIENT_ID`, `ZOOM_CLIENT_SECRET` | configured |
| Jira | `JIRA_CLIENT_ID`, `JIRA_CLIENT_SECRET` | configured |
| LinkedIn | `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET` | missing |
| Twitter/X legacy OAuth | `TWITTER_API_KEY`, `TWITTER_API_SECRET_KEY`, optional `TWITTER_CLIENT_ID`, `TWITTER_CLIENT_SECRET` | configured |

### Vendor OAuth Registry

| Provider | Keys | Status |
| --- | --- | --- |
| Linear vendor OAuth | `LINEAR_OAUTH_CLIENT_ID`, `LINEAR_OAUTH_CLIENT_SECRET` | missing |
| Shopify vendor OAuth | `SHOPIFY_OAUTH_CLIENT_ID`, `SHOPIFY_OAUTH_CLIENT_SECRET` | missing |
| Calendly vendor OAuth | `CALENDLY_OAUTH_CLIENT_ID`, `CALENDLY_OAUTH_CLIENT_SECRET` | missing |

### Google Plugin OAuth

| Key | Status | Required for |
| --- | --- | --- |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | configured | Google Workspace OAuth. |
| `GOOGLE_REDIRECT_URI` | generated locally from `NEXT_PUBLIC_API_URL` | Plugin-google connector account provider. |
| `GOOGLE_OAUTH_TEST_TOKEN` | missing | Real Google Drive integration test. |
| `GOOGLE_OAUTH_REFRESH_TOKEN` | example only | Post-merge SaaS connector coverage. |

## DM, Private Delivery, And Connector Verification

### Discord

| Key | Status | Required for |
| --- | --- | --- |
| `DISCORD_BOT_TOKEN` | configured | Cloud bot, notifications, many live tests. |
| `DISCORD_API_TOKEN` | mirrored locally from `DISCORD_BOT_TOKEN` | Runtime `@elizaos/plugin-discord` bot token name. |
| `DISCORD_APPLICATION_ID` | mirrored locally from `DISCORD_CLIENT_ID` | Runtime Discord install/slash command registration. |
| `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET` | configured | Cloud Discord OAuth/install. |
| `DISCORD_CHANNEL_ID` | configured | System/payment notification target. |
| `DISCORD_TEST_GUILD_ID`, `DISCORD_TEST_CHANNEL_ID` | inferred locally | Live Discord QA roundtrip target. |
| `ELIZA_APP_DISCORD_BOT_ENABLED` | configured | Enables Eliza App Discord gateway bot when true. |
| `ELIZA_APP_DISCORD_BOT_TOKEN` | configured | Eliza App Discord DM bot. |
| `ELIZA_APP_DISCORD_APPLICATION_ID`, `ELIZA_APP_DISCORD_CLIENT_SECRET` | configured | Eliza App Discord login verification. |
| `ELIZA_APP_DISCORD_ENABLED` | missing | Production config validation toggle. |

### Other Private Channels

| Channel | Keys | Status |
| --- | --- | --- |
| Telegram runtime | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_ID`, `TELEGRAM_BOT_USERNAME`, `TELEGRAM_WEBHOOK_SECRET`; `TELEGRAM_TEST_CHAT_ID` | mirrored/inferred locally; test chat missing |
| Telegram Eliza App | `ELIZA_APP_TELEGRAM_BOT_TOKEN`, `ELIZA_APP_TELEGRAM_WEBHOOK_SECRET` | configured |
| WhatsApp root/post-merge | `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID` | mirrored locally from Eliza App WhatsApp |
| WhatsApp org fallback | `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_APP_SECRET` | mirrored locally from Eliza App WhatsApp |
| WhatsApp Eliza App | `ELIZA_APP_WHATSAPP_ACCESS_TOKEN`, `ELIZA_APP_WHATSAPP_PHONE_NUMBER_ID`, `ELIZA_APP_WHATSAPP_APP_SECRET`, `ELIZA_APP_WHATSAPP_VERIFY_TOKEN`, `ELIZA_APP_WHATSAPP_PHONE_NUMBER` | configured |
| Blooio org-level | `BLOOIO_API_KEY`, `BLOOIO_WEBHOOK_SECRET`, `BLOOIO_FROM_NUMBER` | mirrored locally from Eliza App Blooio |
| Blooio Eliza App | `ELIZA_APP_BLOOIO_API_KEY`, `ELIZA_APP_BLOOIO_WEBHOOK_SECRET`, `ELIZA_APP_BLOOIO_PHONE_NUMBER` | configured |
| Twilio org-level | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER`, `TWILIO_PUBLIC_URL` | example only / missing |
| Twilio Eliza App gateway | `ELIZA_APP_TWILIO_ACCOUNT_SID`, `ELIZA_APP_TWILIO_AUTH_TOKEN`, `ELIZA_APP_TWILIO_PHONE_NUMBER` | example only |
| Slack bot | `SLACK_BOT_TOKEN`, `SLACK_TEST_CHANNEL_ID` | example only |
| X/Twitter bearer | `X_BEARER_TOKEN` | mirrored locally from `TWITTER_BEARER_TOKEN` |

## Tunnel And Local Exposure

Pick one local-exposure backend for a given E2E run. Requiring headscale,
Tailscale, and ngrok at the same time overstates the blocker.

| Key | Status | Required for |
| --- | --- | --- |
| `TAILSCALE_BACKEND` | defaults to `auto` | Selects local/cloud/auto tailscale backend. |
| `TAILSCALE_AUTH_KEY` | optional / missing | Direct Tailscale auth-key path when not using an existing local login or cloud auth-key minting. |
| `TAILSCALE_TAGS`, `TAILSCALE_FUNNEL`, `TAILSCALE_DEFAULT_PORT` | defaulted | Tailscale/tunnel defaults. |
| `TUNNEL_TAGS`, `TUNNEL_FUNNEL`, `TUNNEL_DEFAULT_PORT` | defaulted | `plugin-tunnel` local Tailscale CLI aliases. |
| `NGROK_AUTH_TOKEN` | missing | Real ngrok tunnel tests. |
| `NGROK_DOMAIN` | missing | Optional reserved ngrok domain. |
| `HEADSCALE_PUBLIC_URL`, `HEADSCALE_API_URL`, `HEADSCALE_API_KEY`, `HEADSCALE_USER` | missing | Cloud customer tunnel auth-key issuance. |
| `HEADSCALE_INTERNAL_TOKEN` | missing | Reverse-proxy headscale IP lookup auth. |
| `TUNNEL_PROXY_HOST`, `TUNNEL_TAILNET_DOMAIN` | missing | Public tunnel proxy routing. |
| `TUNNEL_PROXY_TS_AUTHKEY` | missing | Tunnel proxy Tailscale/headscale enrollment. |

## Object Storage, Containers, Domains, And Build Infra

Pick either Cloudflare R2 naming or generic S3-compatible `STORAGE_*` naming
for Node-side storage E2E. Worker-local R2 bindings and Docker local storage do
not need these provider API keys.

| Key | Status | Required for |
| --- | --- | --- |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_TRAJECTORIES_BUCKET`, `R2_BLOB_DEFAULT_BUCKET` | missing | Node-side Cloudflare R2 object storage. |
| `STORAGE_PROVIDER`, `STORAGE_ENDPOINT`, `STORAGE_ACCESS_KEY_ID`, `STORAGE_SECRET_ACCESS_KEY`, `STORAGE_TRAJECTORIES_BUCKET`, `STORAGE_BLOB_DEFAULT_BUCKET` | missing | Generic S3-compatible storage outside Worker bindings. |
| `CONTAINERS_SSH_KEY` | configured | Docker node SSH control plane. |
| `CONTAINERS_SSH_KEY_PATH`, `CONTAINERS_SSH_USER`, `CONTAINERS_DOCKER_NODES` | missing | Alternate Docker node inventory/SSH config. |
| `CONTAINER_CONTROL_PLANE_URL`, `CONTAINER_CONTROL_PLANE_TOKEN` | configured | Container lifecycle bridge. |
| `CONTAINERS_AUTOSCALE_PUBLIC_SSH_KEY`, `CONTAINERS_BOOTSTRAP_SECRET` | configured | Autoscaled node bootstrap. |
| `HCLOUD_TOKEN` | example only | Hetzner real autoscaling. |
| `CONTAINERS_PUBLIC_BASE_DOMAIN` | example only | Public container domains. |
| `AGENT_SERVER_SHARED_SECRET` | generated locally / deploy secret required | Internal agent-server control API. |
| `GIT_ACCESS_TOKEN` | configured | App Builder GitHub repo operations. |
| `GITHUB_ORG_NAME`, `GITHUB_TEMPLATE_REPO` | configured | App Builder repo creation defaults. |
| `GITHUB_TOKEN` | example only | Root post-merge GitHub SaaS tests. |
| `NEON_API_KEY` | configured | Per-app database provisioning. |
| `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN` | example only | DNS/domain purchase/update tests. |

## Web3, Payouts, RPC, And Market Data

| Key | Status | Required for |
| --- | --- | --- |
| `EVM_PAYOUT_PRIVATE_KEY`, `EVM_PAYOUT_WALLET_ADDRESS` | configured | EVM payout tests. |
| `EVM_PRIVATE_KEY` | missing | Alternate EVM payout/facilitator key. |
| `SOLANA_PAYOUT_PRIVATE_KEY`, `SOLANA_PAYOUT_WALLET_ADDRESS` | configured | Solana payout tests and x402 fallback. |
| `ELIZA_TOKEN_BASE_SEPOLIA` | example only | Testnet token payout config. |
| `BASE_SEPOLIA_RPC_URL`, `SEPOLIA_RPC_URL`, `SOLANA_DEVNET_RPC_URL` | example only | Explicit testnet RPC overrides. |
| `SOLANA_RPC_PROVIDER_API_KEY` | missing | Helius/Solana RPC proxy tests. |
| `MARKET_DATA_PROVIDER_API_KEY` | missing | Market data proxy tests. |
| `ALCHEMY_API_KEY` | configured | EVM RPC proxy and x402 reliability. |
| `COINGECKO_API_KEY` | configured | Crypto pricing/TWAP. |
| `BRAVE_SEARCH_API_KEY` | example only | Agent web search provider. |
| `REDEMPTION_ALERT_SLACK_WEBHOOK`, `REDEMPTION_ALERT_PAGERDUTY_KEY` | example only | Payout alerting. |

## Post-Merge External SaaS And Domain-Specific Keys

The canonical post-merge warning list is `scripts/post-merge-secrets.txt`.
These are not all required for the sensitive-request flow, but are needed for
the repository's full live post-merge surface.

| Key | Status | Required for |
| --- | --- | --- |
| `LINEAR_API_KEY` | example only | Linear API tests outside OAuth. |
| `CALENDLY_API_KEY` | example only | Calendly API tests outside OAuth. |
| `BLUESKY_PASSWORD` | example only | Bluesky connector tests. |
| `FARCASTER_NEYNAR_API_KEY` | example only | Farcaster connector tests. |
| `SHOPIFY_API_KEY` | example only | Shopify connector tests outside OAuth. |
| `HYPERLIQUID_PRIVATE_KEY` | example only | Hyperliquid/web3 tests. |
| `POLYMARKET_API_KEY` | example only | Polymarket tests. |
| `DUFFEL_API_KEY` | missing | LifeOps flight/travel live integration. |
| `NTFY_BASE_URL` | missing | LifeOps push notification live integration. |
| `ELIZA_BROWSER_WORKSPACE_URL`, `ELIZA_BROWSER_WORKSPACE_TOKEN` | missing | Browser-workspace LifeOps journeys. |
| `LOCAL_EMBEDDING_RUN_E2E`, `MODELS_DIR` | missing | Local embedding real GGUF E2E. |

## Minimal Real E2E Sets

### Sensitive Secret Request In Cloud

Required:

- `DATABASE_URL`
- `SECRETS_MASTER_KEY`
- `NEXT_PUBLIC_APP_URL`
- `STEWARD_API_URL` or `NEXT_PUBLIC_STEWARD_API_URL`
- `STEWARD_SESSION_SECRET` or `STEWARD_JWT_SECRET`
- `STEWARD_TENANT_ID`
- At least one verified delivery/auth path: cloud app session, Discord app login,
  or a private DM connector.

Currently configured enough for cloud app/session storage. The remaining
coverage gaps are runtime private DM aliases, test channel/account targets, and
one real tunnel/callback path when testing local mode.

### Payment Link With Callback

Required:

- Cloud core keys above.
- Stripe path: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, and browser publishable key.
- OxaPay path: `OXAPAY_MERCHANT_API_KEY`, plus public callback URL when testing from local.
- x402 path: `ENABLE_X402_PAYMENTS`, `X402_NETWORK`, recipient address, facilitator private key,
  and a reliable RPC key.
- Per-request `callback_url` and optional `callback_secret`.

Stripe, OxaPay, and x402 core keys are configured. Real local OxaPay callbacks
still need a public `ELIZA_API_URL` or `OXAPAY_CALLBACK_URL`.

### Public Discord Payment/Secret Verification

Required:

- `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `DISCORD_BOT_TOKEN`
- `ELIZA_APP_DISCORD_APPLICATION_ID`, `ELIZA_APP_DISCORD_CLIENT_SECRET`
- `ELIZA_APP_DISCORD_BOT_TOKEN`
- `GATEWAY_BOOTSTRAP_SECRET`, `GATEWAY_INTERNAL_SECRET`
- `JWT_SIGNING_PRIVATE_KEY`, `JWT_SIGNING_PUBLIC_KEY`
- Test target: `DISCORD_TEST_GUILD_ID`, `DISCORD_TEST_CHANNEL_ID`

Cloud Discord keys are configured and runtime aliases are mirrored locally.
Target guild/channel IDs are inferred locally. `GATEWAY_INTERNAL_SECRET` is
generated locally but still needs to be installed consistently across deployed
gateway/cloud services.

### Local Mode With Tunnel Fallback

Required:

- Local agent auth: `ELIZA_API_TOKEN`
- Tailscale/headscale path: `ELIZAOS_CLOUD_API_KEY` for cloud backend, or
  `TAILSCALE_AUTH_KEY`/local Tailscale login for local backend.
- Ngrok path: `NGROK_AUTH_TOKEN`.
- Public callback base: `ELIZA_API_URL` or equivalent tunnel URL.

Only one tunnel backend is required per run. The cloud API key is configured
locally and the local protected-agent token is generated; the remaining gaps are
a real tunnel credential/login and the public callback URL.

## Recommended Next Verification Order

1. Export or load the existing ignored env files before running live tests; the
   current shell does not export the audited keys.
2. Add one tunnel backend and public callback URL for the local-callback pass.
   Add `TELEGRAM_TEST_CHAT_ID` only when Telegram private-chat E2E is in scope.
3. Run cloud local DB/Worker E2E with `bun run --cwd cloud test:e2e:worker`.
4. Run cloud API E2E with `bun run --cwd cloud test:e2e:all`.
5. Run root live E2E with `eval \"$(node scripts/test-env.mjs --lane=post-merge)\"`
   and then `bun run test:e2e:live`.
6. Run connector-specific private-channel tests only after test accounts,
   guilds, channels, phone numbers, and webhook callback URLs are confirmed.
