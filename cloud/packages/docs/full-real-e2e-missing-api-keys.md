# Full Real E2E Missing API Keys And Configuration

Last updated: 2026-05-10

This is the cleaned action list after consolidating duplicates and removing
local/generated shared secrets from the missing API-key bucket. No secret values
belong in this file.

## Private Delivery And Account Verification

- Telegram runtime/test target:
  - `TELEGRAM_TEST_CHAT_ID`
- Organization-level Twilio:
  - `TWILIO_ACCOUNT_SID`
  - `TWILIO_AUTH_TOKEN`
  - `TWILIO_PHONE_NUMBER`
  - `TWILIO_PUBLIC_URL`
- Optional post-merge social channels:
  - `SLACK_BOT_TOKEN`
  - `SLACK_TEST_CHANNEL_ID`

## Tunnel And Callback Reachability

Choose one tunnel backend for local callback E2E:

- Headscale/customer tunnel:
  - `HEADSCALE_PUBLIC_URL`
  - `HEADSCALE_API_URL`
  - `HEADSCALE_API_KEY`
  - `HEADSCALE_USER`
  - `HEADSCALE_INTERNAL_TOKEN`
  - `TUNNEL_PROXY_HOST`
  - `TUNNEL_TAILNET_DOMAIN`
  - `TUNNEL_PROXY_TS_AUTHKEY`
- Tailscale:
  - `TAILSCALE_AUTH_KEY`, only if not using an existing local Tailscale login
    or Cloud Tailscale auth-key minting
  - local `tailscale` CLI installed and authenticated
- Ngrok:
  - `NGROK_AUTH_TOKEN`
  - `NGROK_DOMAIN`

Callback URL configuration:

- `ELIZA_API_URL`
- `OXAPAY_CALLBACK_URL`

## OAuth Account Connections

- Google live Drive/OAuth test extras:
  - `GOOGLE_OAUTH_TEST_TOKEN`
- Vendor OAuth clients:
  - `SHOPIFY_OAUTH_CLIENT_ID`
  - `SHOPIFY_OAUTH_CLIENT_SECRET`
  - `CALENDLY_OAUTH_CLIENT_ID`
  - `CALENDLY_OAUTH_CLIENT_SECRET`
  - `LINKEDIN_CLIENT_ID`
  - `LINKEDIN_CLIENT_SECRET`

## Storage

Choose one Node-side object storage backend. Worker-local R2 bindings do not
require these provider keys. Local Supabase storage can use the non-secret
defaults in `cloud/docker-compose.yml`, but it still requires the Docker service
and seeded buckets.

- Cloudflare R2:
  - `R2_ACCOUNT_ID`
  - `R2_ACCESS_KEY_ID`
  - `R2_SECRET_ACCESS_KEY`
  - `R2_TRAJECTORIES_BUCKET`
  - `R2_BLOB_DEFAULT_BUCKET`
  - `R2_HEAVY_PAYLOADS_BUCKET`
- Generic S3-compatible storage:
  - `STORAGE_PROVIDER`
  - `STORAGE_ENDPOINT`
  - `STORAGE_REGION`
  - `STORAGE_ACCESS_KEY_ID`
  - `STORAGE_SECRET_ACCESS_KEY`
  - `STORAGE_TRAJECTORIES_BUCKET`
  - `STORAGE_BLOB_DEFAULT_BUCKET`
  - `STORAGE_HEAVY_PAYLOADS_BUCKET`

## Steward Admin And Vault Paths

Baseline Steward session/tenant auth is already configured. These are only
needed for platform admin, tenant provisioning, or vault/wallet tests:

- `STEWARD_PLATFORM_KEYS`
- `STEWARD_MASTER_PASSWORD`
- `STEWARD_AGENT_TOKEN`
- `STEWARD_AGENT_ID`
- `ELIZA_STEWARD_AGENT_ID`

## Optional Live Provider Coverage

- LLM providers:
  - `OPENROUTER_API_KEY`
  - `GROQ_API_KEY`
  - `GOOGLE_API_KEY`
  - `GOOGLE_GENERATIVE_AI_API_KEY`
  - `XAI_API_KEY`
  - `CLAUDE_CODE_OAUTH_TOKEN`
  - `OPENAI_API_KEY_REAL`
- Cloud/domain/build infra:
  - `CLOUDFLARE_ACCOUNT_ID`
  - `CLOUDFLARE_API_TOKEN`
  - `HCLOUD_TOKEN`
  - `CONTAINERS_SSH_KEY_PATH`
  - `CONTAINERS_SSH_USER`
  - `CONTAINERS_DOCKER_NODES`
  - `CONTAINERS_PUBLIC_BASE_DOMAIN`
- Web3/RPC/market data:
  - `EVM_PRIVATE_KEY`
  - `ELIZA_TOKEN_BASE_SEPOLIA`
  - `BASE_SEPOLIA_RPC_URL`
  - `SEPOLIA_RPC_URL`
  - `SOLANA_DEVNET_RPC_URL`
  - `SOLANA_RPC_PROVIDER_API_KEY`
  - `MARKET_DATA_PROVIDER_API_KEY`
  - `BRAVE_SEARCH_API_KEY`
- Post-merge SaaS/domain integrations:
  - `LINEAR_API_KEY`
  - `CALENDLY_API_KEY`
  - `BLUESKY_PASSWORD`
  - `FARCASTER_NEYNAR_API_KEY`
  - `SHOPIFY_API_KEY`
  - `HYPERLIQUID_PRIVATE_KEY`
  - `POLYMARKET_API_KEY`
  - `DUFFEL_API_KEY`
  - `NTFY_BASE_URL`
  - `ELIZA_BROWSER_WORKSPACE_URL`
  - `ELIZA_BROWSER_WORKSPACE_TOKEN`
  - `LOCAL_EMBEDDING_RUN_E2E`
  - `MODELS_DIR`

## Not Missing After Cleanup

- `INTERNAL_SECRET`
- `GATEWAY_INTERNAL_SECRET`
- `AGENT_SERVER_SHARED_SECRET`
- `PLAYWRIGHT_TEST_AUTH_SECRET`
- `STEWARD_API_URL`
- `NEXT_PUBLIC_STEWARD_API_URL`
- `STEWARD_SESSION_SECRET`
- `STEWARD_JWT_SECRET`, mirrored locally from `STEWARD_SESSION_SECRET`
- `STEWARD_TENANT_ID`
- `NEXT_PUBLIC_STEWARD_TENANT_ID`
- `STEWARD_TENANT_API_KEY`
- `STEWARD_API_KEY`, mirrored locally from `STEWARD_TENANT_API_KEY`
- `ELIZAOS_CLOUD_API_KEY`, minted through SIWE and stored locally
- `ELIZA_CLOUD_API_KEY`, mirrored locally from `ELIZAOS_CLOUD_API_KEY`
- `ELIZA_API_TOKEN`, generated locally for protected local agent/API tests
- `DISCORD_API_TOKEN`, mirrored locally from `DISCORD_BOT_TOKEN`
- `DISCORD_APPLICATION_ID`, mirrored locally from `DISCORD_CLIENT_ID`
- `DISCORD_TEST_CHANNEL_ID`, mirrored locally from `DISCORD_CHANNEL_ID`
- `DISCORD_TEST_GUILD_ID`, inferred via Discord channel API
- `TELEGRAM_BOT_TOKEN`, mirrored locally from `ELIZA_APP_TELEGRAM_BOT_TOKEN`
- `TELEGRAM_BOT_ID`, inferred via Telegram `getMe`
- `TELEGRAM_BOT_USERNAME`, inferred via Telegram `getMe`
- `TELEGRAM_WEBHOOK_SECRET`, mirrored locally from `ELIZA_APP_TELEGRAM_WEBHOOK_SECRET`
- `WHATSAPP_TOKEN`, mirrored locally from `ELIZA_APP_WHATSAPP_ACCESS_TOKEN`
- `WHATSAPP_ACCESS_TOKEN`, mirrored locally from `ELIZA_APP_WHATSAPP_ACCESS_TOKEN`
- `WHATSAPP_PHONE_NUMBER_ID`, mirrored locally from `ELIZA_APP_WHATSAPP_PHONE_NUMBER_ID`
- `WHATSAPP_APP_SECRET`, mirrored locally from `ELIZA_APP_WHATSAPP_APP_SECRET`
- `WHATSAPP_VERIFY_TOKEN`, mirrored locally from `ELIZA_APP_WHATSAPP_VERIFY_TOKEN`
- `WHATSAPP_BUSINESS_PHONE`, mirrored locally from `ELIZA_APP_WHATSAPP_PHONE_NUMBER`
- `BLOOIO_API_KEY`, mirrored locally from `ELIZA_APP_BLOOIO_API_KEY`
- `BLOOIO_WEBHOOK_SECRET`, mirrored locally from `ELIZA_APP_BLOOIO_WEBHOOK_SECRET`
- `BLOOIO_FROM_NUMBER`, mirrored locally from `ELIZA_APP_BLOOIO_PHONE_NUMBER`
- `GOOGLE_REDIRECT_URI`, generated locally from `NEXT_PUBLIC_API_URL`
- `FAL_API_KEY`, mirrored locally from `FAL_KEY`
- `UPSTASH_REDIS_REST_URL`, mirrored locally from `KV_REST_API_URL`
- `UPSTASH_REDIS_REST_TOKEN`, mirrored locally from `KV_REST_API_TOKEN`
- `X_BEARER_TOKEN`, mirrored locally from `TWITTER_BEARER_TOKEN`
- `GITHUB_TOKEN`, mirrored locally from `GIT_ACCESS_TOKEN`
- `LINEAR_OAUTH_CLIENT_ID`, mirrored locally from `LINEAR_CLIENT_ID`
- `LINEAR_OAUTH_CLIENT_SECRET`, mirrored locally from `LINEAR_CLIENT_SECRET`
- `TAILSCALE_BACKEND`, defaults to `auto`
- `TAILSCALE_TAGS`, `TAILSCALE_FUNNEL`, `TAILSCALE_DEFAULT_PORT`
- `TUNNEL_TAGS`, `TUNNEL_FUNNEL`, `TUNNEL_DEFAULT_PORT`
- Stripe/OxaPay/x402 core payment credentials already present locally
- `ELIZA_LIFEOPS_REMOTE_E2E_TOKEN`; prefer `ELIZA_API_TOKEN` if a protected
  remote agent target is required
