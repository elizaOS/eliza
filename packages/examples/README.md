# Examples Test Credentials

This directory contains examples that range from fully local demos to live
integrations that post to external services, deploy cloud functions, or submit
real blockchain transactions.

The normal local validation path does not need API keys:

```bash
# From the repository root, run each package's available build/typecheck/lint/test scripts.
# The individual package READMEs contain app-specific start commands.
bun install
```

For total live testing, configure the credentials below. Never commit `.env`
files, private keys, app passwords, or bot tokens.

## Model Provider Keys

Many examples accept one model provider. To test every provider path, configure
all of these; otherwise set the provider used by the example you are running.

| Variable | Used by | Notes |
| --- | --- | --- |
| `OPENAI_API_KEY` | Most server, chat, cloud, social, MCP, REST, and deployment examples | Required for examples that only use OpenAI. Some examples fall back to local ELIZA mode when unset. |
| `ANTHROPIC_API_KEY` | `chat`, `form`, `code`, `convex`, `discord`, `bluesky`, `trader` | Required when forcing Anthropic or testing Anthropic provider flows. |
| `XAI_API_KEY` | `chat`, `form`, `convex`, `twitter-xai` | Required for the X/Grok example. |
| `GOOGLE_GENERATIVE_AI_API_KEY` | `chat`, `form`, `convex`, app examples, browser extension, avatar | Required for Google GenAI provider flows. |
| `GROQ_API_KEY` | `chat`, `form`, `convex`, app examples, browser extension, avatar | Required for Groq provider flows. |
| `OPENROUTER_API_KEY` / `LLM_API_KEY` | `moltbook`, app examples, optional model-provider paths | `moltbook` reads `LLM_API_KEY` first, then `OPENROUTER_API_KEY`, then `OPENAI_API_KEY`. |
| `ELEVENLABS_API_KEY` | `avatar` | Required for voice output in the avatar demo. |

## Database And Deployment Keys

| Variable / setup | Used by | Notes |
| --- | --- | --- |
| `POSTGRES_URL` | `next`, `rest-api/*`, `telegram`, `discord`, `bluesky`, `twitter-xai`, `text-adventure`, `tic-tac-toe` | Optional in many examples because PGLite is used by default; required for production-like persistence. |
| `DATABASE_URL` | `farcaster` | Optional PostgreSQL URL for the Farcaster agent. |
| `CONVEX_URL` | `convex` test client | HTTP Actions URL printed by `convex dev` or from a deployed Convex project. |
| Convex env keys | `convex` | Set one model provider in Convex with `convex env set OPENAI_API_KEY ...` or equivalent. |
| `SUPABASE_FUNCTION_URL`, `SUPABASE_ANON_KEY` | `supabase` test client | Required to test deployed Supabase Edge Functions. |
| Supabase secrets | `supabase` | Set `OPENAI_API_KEY` with `supabase secrets set OPENAI_API_KEY=...`. |
| Vercel env | `vercel` | Set `OPENAI_API_KEY` in Vercel env. `VERCEL_URL` can point the test client at a deployment. |
| Cloudflare secret | `cloudflare` | Set `OPENAI_API_KEY` with `wrangler secret put OPENAI_API_KEY`. |
| AWS CLI/SAM credentials | `aws` | Required for deploy testing; also set `OPENAI_API_KEY` as the Lambda parameter/secret. |
| GCP project credentials | `gcp` | Required for deploy testing. Use `PROJECT_ID`, `GCP_REGION`, and `OPENAI_API_KEY`; `ELIZA_WORKER_URL` points tests at a deployed worker. |

## Platform And Bot Credentials

| Example | Required for full live test | Optional / safety flags |
| --- | --- | --- |
| `discord` | `DISCORD_APPLICATION_ID`, `DISCORD_API_TOKEN`, plus one model key | `TELEGRAM_BOT_TOKEN` for multi-platform setup, `POSTGRES_URL`, `LOG_LEVEL` |
| `telegram` | `TELEGRAM_BOT_TOKEN`, `OPENAI_API_KEY` | `POSTGRES_URL` |
| `bluesky` | `BLUESKY_HANDLE`, `BLUESKY_PASSWORD`, plus `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` | `BLUESKY_SERVICE`, `BLUESKY_DRY_RUN`, `BLUESKY_ENABLE_POSTING`, `BLUESKY_ENABLE_DMS`, `POSTGRES_URL` |
| `farcaster` | `OPENAI_API_KEY`, `FARCASTER_FID`, `FARCASTER_SIGNER_UUID`, `FARCASTER_NEYNAR_API_KEY` | Start with `FARCASTER_DRY_RUN=true`; set `ENABLE_CAST=true` only when ready to post. |
| `farcaster-miniapp` | `ELIZA_API_URL`, `FARCASTER_FID`, `FARCASTER_SIGNER_UUID`, `FARCASTER_NEYNAR_API_KEY` | `SOLANA_RPC_URL`, `SOLANA_PRIVATE_KEY`, `EVM_PRIVATE_KEY`, chain provider URLs, `LIFI_API_KEY` |
| `twitter-xai` | `XAI_API_KEY` and X auth | Recommended: `TWITTER_AUTH_MODE=broker` with `ELIZAOS_CLOUD_API_KEY` or `TWITTER_BROKER_TOKEN`. Env-token mode requires `TWITTER_API_KEY`, `TWITTER_API_SECRET_KEY`, `TWITTER_ACCESS_TOKEN`, `TWITTER_ACCESS_TOKEN_SECRET`; `TWITTER_BEARER_TOKEN` is read-only. Start with `TWITTER_DRY_RUN=true`. |
| `roblox` | `ROBLOX_API_KEY`, `ROBLOX_UNIVERSE_ID`, Roblox Studio place setup, and game-side bridge script | `ROBLOX_PLACE_ID`, `ROBLOX_MESSAGING_TOPIC`, `ROBLOX_DRY_RUN`, `ELIZA_ROBLOX_SHARED_SECRET`, `OPENAI_API_KEY` for full LLM behavior. |
| `moltbook` | `LLM_API_KEY` and `MOLTBOOK_TOKEN` for posting/commenting | `MOLTBOOK_TOKEN` unset gives read-only mode. |

## Wallet And Trading Credentials

These examples can move real assets. Use test wallets or tiny funded wallets
until the full flow is verified.

| Example | Required for full live test | Optional / notes |
| --- | --- | --- |
| `trader` | `SOLANA_PRIVATE_KEY`, `SOLANA_RPC_URL`, `BIRDEYE_API_KEY`, and `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` | Paper trading is the default. Live trading must be enabled deliberately in the UI/config. |
| `lp-manager` | `SOLANA_PRIVATE_KEY`, `SOLANA_RPC_URL`, `EVM_PRIVATE_KEY`, EVM RPC URLs | EVM RPCs include `ETHEREUM_RPC_URL`, `BASE_RPC_URL`, `ARBITRUM_RPC_URL`, `BSC_RPC_URL`, `POLYGON_RPC_URL`, `OPTIMISM_RPC_URL`. |
| `moltbook/bags-claimer` | Solana wallet/funding where required by the claim flow | `SOLANA_RPC_URL` defaults to public mainnet RPC but an authenticated RPC is recommended. |
| `farcaster-miniapp` | `SOLANA_PRIVATE_KEY`, `EVM_PRIVATE_KEY` for wallet transaction paths | `LIFI_API_KEY` improves route/rate coverage. |

## Example-Specific Checklist

| Path | Live testing requirement |
| --- | --- |
| `_plugin` | No external API key required for Vitest. Optional Cypress component tests need the Cypress/Vite harness to be compatible with the installed Vite/Cypress versions. |
| `a2a` | `OPENAI_API_KEY` for model-backed mode; otherwise deterministic local ELIZA mode. `A2A_URL` points the test client at a running server. |
| `app/capacitor` | Configure provider keys through the app/backend settings. `VITE_CHAT_BACKEND_URL` points the frontend at a backend. |
| `app/electron` | Configure provider keys through the app/backend settings. `ELECTRON_RENDERER_URL` is for frontend dev-server mode. |
| `autonomous` | No hosted model API required by default. Local model paths use `MODELS_DIR` and `LOCAL_SMALL_MODEL`; shell sandbox uses `SHELL_ALLOWED_DIRECTORY`. |
| `avatar` | Provider key for selected model; `ELEVENLABS_API_KEY` for TTS. |
| `aws` | `OPENAI_API_KEY` plus AWS/SAM credentials for deployment. Local tests skip live chat when no key is set. |
| `bluesky` | `BLUESKY_HANDLE`, `BLUESKY_PASSWORD`, and a model key. `LIVE_TEST=true` enables live integration tests. |
| `browser-extension` | Build needs no API key. Live browser use requires adding a provider API key in extension settings. Safari also requires Xcode signing/install. |
| `chat` | One of `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `XAI_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`, `GROQ_API_KEY`. |
| `cloudflare` | `OPENAI_API_KEY` as a Wrangler secret for deployed Worker tests. |
| `code` | `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`; `ELIZA_CODE_PROVIDER=openai|anthropic` can force a provider. |
| `convex` | Run `convex dev` or deploy Convex, set `CONVEX_URL`, and set one provider key in Convex env. |
| `discord` | Discord app ID/token plus a model provider key. |
| `elizagotchi` | No API keys; local game logic only. |
| `farcaster` | OpenAI key, Neynar key, FID, signer UUID. Keep dry-run enabled until posting is intended. |
| `farcaster-miniapp` | Eliza API URL, Farcaster/Neynar keys, and wallet/provider keys for transaction paths. |
| `form` | One model provider key from the shared provider list. |
| `game-of-life` | No API keys; local game logic only. |
| `gcp` | GCP credentials/project/region plus `OPENAI_API_KEY`; use `ELIZA_WORKER_URL` for deployed test client runs. |
| `html` | No API keys; browser ELIZA/localdb demo. |
| `lp-manager` | Wallet private keys and RPC endpoints for Solana/EVM live liquidity actions. |
| `mcp` | `OPENAI_API_KEY`; optional `MCP_PORT`, `OPENAI_BASE_URL`, model overrides. |
| `moltbook` | `LLM_API_KEY`; `MOLTBOOK_TOKEN` for write actions. |
| `moltbook/bags-claimer` | Solana RPC/wallet setup needed by the claim target. |
| `next` | `OPENAI_API_KEY`; `POSTGRES_URL` for production-like persistence. |
| `react` | No API keys; browser ELIZA/PGLite demo. |
| `rest-api/elysia`, `rest-api/express`, `rest-api/hono` | `OPENAI_API_KEY` for LLM responses; otherwise local ELIZA fallback. `POSTGRES_URL` optional. |
| `roblox` | Roblox Open Cloud key/universe, Studio place, bridge Lua script, shared secret/topic alignment. |
| `supabase` | Supabase CLI/project, `OPENAI_API_KEY` secret, deployed/local function URL and anon key for client tests. |
| `telegram` | `TELEGRAM_BOT_TOKEN`, `OPENAI_API_KEY`. |
| `text-adventure` | No API key required for local validation; `POSTGRES_URL`/`PGLITE_DATA_DIR` optional persistence settings. |
| `tic-tac-toe` | No API key required for local validation; `PGLITE_DATA_DIR` optional. |
| `trader` | Solana wallet/RPC, Birdeye key, and model key for LLM strategy. |
| `twitter-xai` | `XAI_API_KEY` plus X/Twitter auth. Start with `TWITTER_DRY_RUN=true`. |
| `vercel` | `OPENAI_API_KEY` in Vercel env; `VERCEL_URL` for test client target. |

## Known Human-Gated Items

- Roblox, Safari extension installation, AWS, GCP, Cloudflare, Vercel,
  Supabase, and Convex all require external accounts or desktop/cloud setup
  beyond local script execution.
- Social examples can post publicly. Keep dry-run flags enabled until the
  account, bot permissions, and content behavior are confirmed.
- Trading examples can transact with real funds. Use isolated wallets and
  minimal balances during live E2E testing.
