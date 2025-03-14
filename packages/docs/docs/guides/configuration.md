---
sidebar_position: 9
---

# ⚙️ Configuration Guide

This guide covers how to configure Eliza for different use cases and environments. We'll walk through all available configuration options and best practices.

## Environment Configuration

### Basic Setup

The first step is creating your environment configuration file:

```bash
cp .env.example .env
```

Then edit the `.env` file to add your specific configuration values.

---


## Character Configuration

Character files define your agent's personality and behavior. Create them in the `characters/` directory:

```json
{
    "name": "AgentName",
    "clients": ["discord", "twitter"],
    "modelProvider": "openrouter",
    "settings": {
        "model": "openai/gpt-4o",
        "temperature": 0.7,
        "maxTokens": 2000,
        "secrets": {
            "OPENAI_API_KEY": "character-specific-key",
            "DISCORD_TOKEN": "bot-specific-token"
        }
    }
}
```

### Secrets for Multiple Characters

If you don't want to have secrets in your character files because you would
like to utilize source control for collaborative development on multiple
characters, then you can put all character secrets in `.env` by prepending
`CHARACTER.NAME.` before the key name and value. For example:

```bash
# C3PO
CHARACTER.C3PO.DISCORD_APPLICATION_ID=abc
CHARACTER.C3PO.DISCORD_API_TOKEN=xyz

# DOBBY
CHARACTER.DOBBY.DISCORD_APPLICATION_ID=123
CHARACTER.DOBBY.DISCORD_API_TOKEN=369
```

---

## Custom Actions

### Adding Custom Actions

1. Create a `custom_actions` directory
2. Add your action files there
3. Configure in `elizaConfig.yaml`:

```yaml
actions:
    - name: myCustomAction
      path: ./custom_actions/myAction.ts
```

See the [actions](/docs/core/actions) page for more info.

---

## Advanced Configuration

### Cloudflare AI Gateway Integration

Eliza supports routing API calls through [Cloudflare AI Gateway](https://developers.cloudflare.com/ai-gateway/), which provides several benefits:

- Detailed analytics and monitoring of message traffic and response times
- Cost optimization through request caching and usage tracking across providers
- Improved latency through Cloudflare's global network
- Comprehensive visibility into message content and token usage

When enabled, Eliza will automatically route requests through your Cloudflare AI Gateway endpoint. If the gateway configuration is incomplete or disabled, Eliza will fall back to direct API calls.

### Logging

```bash
DEFAULT_LOG_LEVEL=info  # Options: debug, info, warn, error
LOG_JSON_FORMAT=false   # Set to true for JSON formatted logs
```

### Performance Settings

Fine-tune runtime behavior:

```typescript
const settings = {
    // Performance
    MAX_CONCURRENT_REQUESTS: 5,
    REQUEST_TIMEOUT: 30000,

    // Memory
    MEMORY_TTL: 3600,
    MAX_MEMORY_ITEMS: 1000,
};
```

---


## Environment Variables Reference

<details>
<summary>Click to expand .env.example file</summary>

```bash
# Eliza Environment Variables - Compact Reference

## SERVER & DATABASE
CACHE_STORE=database # Options: database|redis|filesystem
CACHE_DIR=./data/cache # For filesystem cache
REDIS_URL= # Redis connection string
PGLITE_DATA_DIR= # ../pgLite/ or memory://
SERVER_URL=http://localhost # Base URL
SERVER_PORT=3000 # Port number
SUPABASE_URL= # Supabase URL
SUPABASE_ANON_KEY= # Supabase key
MONGODB_CONNECTION_STRING= # MongoDB connection
MONGODB_DATABASE= # Default: elizaAgent
REMOTE_CHARACTER_URLS= # Comma-separated URLs
USE_CHARACTER_STORAGE=false # Store characters in data/character
DEFAULT_LOG_LEVEL=info # Log level
LOG_JSON_FORMAT=false # JSON format for logs

## CLIENT INTEGRATIONS
# BitMind
BITMIND=true # Enable BitMind
BITMIND_API_TOKEN= # API token

# Discord
DISCORD_APPLICATION_ID= # App ID
DISCORD_API_TOKEN= # Bot token
DISCORD_VOICE_CHANNEL_ID= # Voice channel

# Devin
DEVIN_API_TOKEN= # API token

# Gelato
GELATO_RELAY_API_KEY= # API key

# Farcaster
FARCASTER_FID= # FID for account
FARCASTER_NEYNAR_API_KEY= # API key
FARCASTER_NEYNAR_SIGNER_UUID= # Signer UUID
FARCASTER_DRY_RUN=false # Run without publishing
FARCASTER_POLL_INTERVAL=120 # Check interval (sec)

# Telegram
TELEGRAM_BOT_TOKEN= # Bot token
TELEGRAM_ACCOUNT_PHONE= # Phone number
TELEGRAM_ACCOUNT_APP_ID= # App API ID
TELEGRAM_ACCOUNT_APP_HASH= # App API hash
TELEGRAM_ACCOUNT_DEVICE_MODEL= # Device model
TELEGRAM_ACCOUNT_SYSTEM_VERSION= # System version

# Twitter/X
TWITTER_DRY_RUN=false # Simulate without posting
TWITTER_USERNAME= # Account username
TWITTER_PASSWORD= # Account password
TWITTER_EMAIL= # Account email
TWITTER_2FA_SECRET= # 2FA secret
TWITTER_COOKIES_AUTH_TOKEN= # Auth token
TWITTER_COOKIES_CT0= # Cookie CT0
TWITTER_COOKIES_GUEST_ID= # Guest ID cookie
TWITTER_POLL_INTERVAL=120 # Check interval (sec)
TWITTER_SEARCH_ENABLE=FALSE # Enable timeline search
TWITTER_TARGET_USERS= # Usernames to interact with
TWITTER_RETRY_LIMIT= # Max retry attempts
TWITTER_SPACES_ENABLE=false # Enable Spaces
ENABLE_TWITTER_POST_GENERATION=true # Auto tweet generation
POST_INTERVAL_MIN= # Min post interval (min), default: 90
POST_INTERVAL_MAX= # Max post interval (min), default: 180
POST_IMMEDIATELY= # Post immediately, default: false
ACTION_INTERVAL= # Action processing interval (min), default: 5
ENABLE_ACTION_PROCESSING=false # Enable action processing
MAX_ACTIONS_PROCESSING=1 # Max actions per cycle
ACTION_TIMELINE_TYPE=foryou # Timeline type: foryou|following
TWITTER_APPROVAL_DISCORD_CHANNEL_ID= # Discord channel ID
TWITTER_APPROVAL_DISCORD_BOT_TOKEN= # Discord bot token
TWITTER_APPROVAL_ENABLED= # Enable approval, default: false
TWITTER_APPROVAL_CHECK_INTERVAL=60000 # Check interval (ms)

# WhatsApp
WHATSAPP_ACCESS_TOKEN= # Access token
WHATSAPP_PHONE_NUMBER_ID= # Phone number ID
WHATSAPP_BUSINESS_ACCOUNT_ID= # Business Account ID
WHATSAPP_WEBHOOK_VERIFY_TOKEN= # Webhook token
WHATSAPP_API_VERSION=v17.0 # API version

# Alexa
ALEXA_SKILL_ID= # Skill ID
ALEXA_CLIENT_ID= # OAuth2 Client ID
ALEXA_CLIENT_SECRET= # OAuth2 Client Secret

# SimsAI
SIMSAI_API_KEY= # API key
SIMSAI_AGENT_ID= # Agent ID
SIMSAI_USERNAME= # Username
SIMSAI_DRY_RUN= # Test without API calls

# Direct Client
EXPRESS_MAX_PAYLOAD= # Max payload, default: 100kb

# Instagram
INSTAGRAM_DRY_RUN=false # Simulate without posting
INSTAGRAM_USERNAME= # Username
INSTAGRAM_PASSWORD= # Password
INSTAGRAM_APP_ID= # App ID (required)
INSTAGRAM_APP_SECRET= # App Secret (required)
INSTAGRAM_BUSINESS_ACCOUNT_ID= # Business Account ID
INSTAGRAM_POST_INTERVAL_MIN=60 # Min interval (min)
INSTAGRAM_POST_INTERVAL_MAX=120 # Max interval (min)
INSTAGRAM_ENABLE_ACTION_PROCESSING=false # Enable actions
INSTAGRAM_ACTION_INTERVAL=5 # Action interval (min)
INSTAGRAM_MAX_ACTIONS=1 # Max actions per cycle

## MODEL PROVIDERS
# OpenAI
OPENAI_API_KEY= # API key (sk-*)
OPENAI_API_URL= # API endpoint, default: https://api.openai.com/v1
SMALL_OPENAI_MODEL= # Default: gpt-4o-mini
MEDIUM_OPENAI_MODEL= # Default: gpt-4o
LARGE_OPENAI_MODEL= # Default: gpt-4o
EMBEDDING_OPENAI_MODEL= # Default: text-embedding-3-small
IMAGE_OPENAI_MODEL= # Default: dall-e-3
USE_OPENAI_EMBEDDING= # TRUE for OpenAI embeddings
ENABLE_OPEN_AI_COMMUNITY_PLUGIN=false # Enable community plugin
OPENAI_DEFAULT_MODEL= # Default model
OPENAI_MAX_TOKENS= # Max tokens
OPENAI_TEMPERATURE= # Temperature

# Atoma SDK
ATOMASDK_BEARER_AUTH= # Bearer token
ATOMA_API_URL= # Default: https://api.atoma.network/v1
SMALL_ATOMA_MODEL= # Default: meta-llama/Llama-3.3-70B-Instruct
MEDIUM_ATOMA_MODEL= # Default: meta-llama/Llama-3.3-70B-Instruct
LARGE_ATOMA_MODEL= # Default: meta-llama/Llama-3.3-70B-Instruct

# Eternal AI
ETERNALAI_URL= # Service URL
ETERNALAI_MODEL= # Default: NousResearch/Hermes-3-Llama-3.1-70B-FP8
ETERNALAI_CHAIN_ID=8453 # Default: 8453
ETERNALAI_RPC_URL= # RPC URL
ETERNALAI_AGENT_CONTRACT_ADDRESS= # Contract address
ETERNALAI_AGENT_ID= # Agent ID
ETERNALAI_API_KEY= # API key
ETERNALAI_LOG=false # Enable logging

# Hyperbolic
HYPERBOLIC_API_KEY= # API key
HYPERBOLIC_MODEL= # Model name
IMAGE_HYPERBOLIC_MODEL= # Default: FLUX.1-dev
SMALL_HYPERBOLIC_MODEL= # Default: meta-llama/Llama-3.2-3B-Instruct
MEDIUM_HYPERBOLIC_MODEL= # Default: meta-llama/Meta-Llama-3.1-70B-Instruct
LARGE_HYPERBOLIC_MODEL= # Default: meta-llama/Meta-Llama-3.1-405-Instruct
HYPERBOLIC_ENV=production # Environment
HYPERBOLIC_GRANULAR_LOG=true # Granular logging
HYPERBOLIC_SPASH=true # Show splash
HYPERBOLIC_LOG_LEVEL=debug # Log level

# Infera
INFERA_API_KEY= # API key
INFERA_MODEL= # Default: llama3.2:latest
INFERA_SERVER_URL= # Default: https://api.infera.org/
SMALL_INFERA_MODEL= # Recommended: llama3.2:latest
MEDIUM_INFERA_MODEL= # Recommended: mistral-nemo:latest
LARGE_INFERA_MODEL= # Recommended: mistral-small:latest

# Venice
VENICE_API_KEY= # API key
SMALL_VENICE_MODEL= # Default: llama-3.3-70b
MEDIUM_VENICE_MODEL= # Default: llama-3.3-70b
LARGE_VENICE_MODEL= # Default: llama-3.1-405b
IMAGE_VENICE_MODEL= # Default: fluently-xl

# Nineteen.ai
NINETEEN_AI_API_KEY= # API key
SMALL_NINETEEN_AI_MODEL= # Default: unsloth/Llama-3.2-3B-Instruct
MEDIUM_NINETEEN_AI_MODEL= # Default: unsloth/Meta-Llama-3.1-8B-Instruct
LARGE_NINETEEN_AI_MODEL= # Default: hugging-quants/Meta-Llama-3.1-70B-Instruct-AWQ-INT4
IMAGE_NINETEEN_AI_MODE= # Default: dataautogpt3/ProteusV0.4-Lightning

# Akash Chat API
AKASH_CHAT_API_KEY= # API key
SMALL_AKASH_CHAT_API_MODEL= # Default: Meta-Llama-3-2-3B-Instruct
MEDIUM_AKASH_CHAT_API_MODEL= # Default: Meta-Llama-3-3-70B-Instruct
LARGE_AKASH_CHAT_API_MODEL= # Default: Meta-Llama-3-1-405B-Instruct-FP8

# Livepeer
LIVEPEER_GATEWAY_URL=https://dream-gateway.livepeer.cloud # Gateway URL
IMAGE_LIVEPEER_MODEL= # Default: ByteDance/SDXL-Lightning
SMALL_LIVEPEER_MODEL= # Default: meta-llama/Meta-Llama-3.1-8B-Instruct
MEDIUM_LIVEPEER_MODEL= # Default: meta-llama/Meta-Llama-3.1-8B-Instruct
LARGE_LIVEPEER_MODEL= # Default: meta-llama/Meta-Llama-3.1-8B-Instruct

# Speech & Transcription
ELEVENLABS_XI_API_KEY= # ElevenLabs API key
ELEVENLABS_MODEL_ID=eleven_multilingual_v2 # Model ID
ELEVENLABS_VOICE_ID=21m00Tcm4TlvDq8ikWAM # Voice ID
ELEVENLABS_VOICE_STABILITY=0.5 # Stability
ELEVENLABS_VOICE_SIMILARITY_BOOST=0.9 # Similarity boost
ELEVENLABS_VOICE_STYLE=0.66 # Style value
ELEVENLABS_VOICE_USE_SPEAKER_BOOST=false # Speaker boost
ELEVENLABS_OPTIMIZE_STREAMING_LATENCY=4 # Latency level
ELEVENLABS_OUTPUT_FORMAT=pcm_16000 # Output format
TRANSCRIPTION_PROVIDER= # Default: local, options: openai|deepgram|local
DEEPGRAM_API_KEY= # Deepgram API key

# OpenRouter
OPENROUTER_API_KEY= # API key
OPENROUTER_MODEL= # Default: uses hermes 70b/405b
SMALL_OPENROUTER_MODEL= # Small model
MEDIUM_OPENROUTER_MODEL= # Medium model
LARGE_OPENROUTER_MODEL= # Large model

# REDPILL
REDPILL_API_KEY= # API key
REDPILL_MODEL= # Model name
SMALL_REDPILL_MODEL= # Default: gpt-4o-mini
MEDIUM_REDPILL_MODEL= # Default: gpt-4o
LARGE_REDPILL_MODEL= # Default: gpt-4o

# Grok
GROK_API_KEY= # API key
SMALL_GROK_MODEL= # Default: grok-2-1212
MEDIUM_GROK_MODEL= # Default: grok-2-1212
LARGE_GROK_MODEL= # Default: grok-2-1212
EMBEDDING_GROK_MODEL= # Default: grok-2-1212

# Ollama
OLLAMA_SERVER_URL= # Default: localhost:11434
OLLAMA_MODEL= # Model name
USE_OLLAMA_EMBEDDING= # TRUE for Ollama embeddings
OLLAMA_EMBEDDING_MODEL= # Default: mxbai-embed-large
SMALL_OLLAMA_MODEL= # Default: llama3.2
MEDIUM_OLLAMA_MODEL= # Default: hermes3
LARGE_OLLAMA_MODEL= # Default: hermes3:70b

# Google
GOOGLE_MODEL= # Model name
SMALL_GOOGLE_MODEL= # Default: gemini-1.5-flash-latest
MEDIUM_GOOGLE_MODEL= # Default: gemini-1.5-flash-latest
LARGE_GOOGLE_MODEL= # Default: gemini-1.5-pro-latest
EMBEDDING_GOOGLE_MODEL= # Default: text-embedding-004
GOOGLE_GENERATIVE_AI_API_KEY= # Gemini API key

# Mistral
MISTRAL_MODEL= # Model name
SMALL_MISTRAL_MODEL= # Default: mistral-small-latest
MEDIUM_MISTRAL_MODEL= # Default: mistral-large-latest
LARGE_MISTRAL_MODEL= # Default: mistral-large-latest

# Groq
GROQ_API_KEY= # API key (gsk_*)
SMALL_GROQ_MODEL= # Default: llama-3.1-8b-instant
MEDIUM_GROQ_MODEL= # Default: llama-3.3-70b-versatile
LARGE_GROQ_MODEL= # Default: llama-3.2-90b-vision-preview
EMBEDDING_GROQ_MODEL= # Default: llama-3.1-8b-instant

# LlamaLocal
LLAMALOCAL_PATH= # Default: current directory

# NanoGPT
SMALL_NANOGPT_MODEL= # Default: gpt-4o-mini
MEDIUM_NANOGPT_MODEL= # Default: gpt-4o
LARGE_NANOGPT_MODEL= # Default: gpt-4o
NANOGPT_API_KEY= # API key

# Anthropic
ANTHROPIC_API_KEY= # API key
ANTHROPIC_API_URL= # API URL
SMALL_ANTHROPIC_MODEL= # Default: claude-3-haiku-20240307
MEDIUM_ANTHROPIC_MODEL= # Default: claude-3-5-sonnet-20241022
LARGE_ANTHROPIC_MODEL= # Default: claude-3-5-sonnet-20241022

# Heurist
HEURIST_API_KEY= # API key
SMALL_HEURIST_MODEL= # Default: meta-llama/llama-3-70b-instruct
MEDIUM_HEURIST_MODEL= # Default: meta-llama/llama-3-70b-instruct
LARGE_HEURIST_MODEL= # Default: meta-llama/llama-3.3-70b-instruct
HEURIST_IMAGE_MODEL= # Default: FLUX.1-dev
HEURIST_EMBEDDING_MODEL= # Default: BAAI/bge-large-en-v1.5
USE_HEURIST_EMBEDDING= # TRUE for Heurist embeddings

# Gaianet
GAIANET_MODEL= # Model name
GAIANET_SERVER_URL= # Server URL
SMALL_GAIANET_MODEL= # Default: llama3b
SMALL_GAIANET_SERVER_URL= # Default: https://llama3b.gaia.domains/v1
MEDIUM_GAIANET_MODEL= # Default: llama
MEDIUM_GAIANET_SERVER_URL= # Default: https://llama8b.gaia.domains/v1
LARGE_GAIANET_MODEL= # Default: qwen72b
LARGE_GAIANET_SERVER_URL= # Default: https://qwen72b.gaia.domains/v1
GAIANET_EMBEDDING_MODEL= # Embedding model
USE_GAIANET_EMBEDDING= # TRUE for Gaianet embeddings

# Volcengine
VOLENGINE_API_URL= # Default: https://open.volcengineapi.com/api/v3/
VOLENGINE_MODEL= # Model name
SMALL_VOLENGINE_MODEL= # Default: doubao-lite-128k
MEDIUM_VOLENGINE_MODEL= # Default: doubao-pro-128k
LARGE_VOLENGINE_MODEL= # Default: doubao-pro-256k
VOLENGINE_EMBEDDING_MODEL= # Default: doubao-embedding

# DeepSeek
DEEPSEEK_API_KEY= # API key
DEEPSEEK_API_URL= # Default: https://api.deepseek.com
SMALL_DEEPSEEK_MODEL= # Default: deepseek-chat
MEDIUM_DEEPSEEK_MODEL= # Default: deepseek-chat
LARGE_DEEPSEEK_MODEL= # Default: deepseek-chat

# fal.ai
FAL_API_KEY= # API key
FAL_AI_LORA_PATH= # LoRA models path

# LetzAI
LETZAI_API_KEY= # API key
LETZAI_MODELS= # Models list (e.g., @modelname1, @modelname2)

# Galadriel
GALADRIEL_API_KEY= # API key (gal-*)
SMALL_GALADRIEL_MODEL= # Default: gpt-4o-mini
MEDIUM_GALADRIEL_MODEL= # Default: gpt-4o
LARGE_GALADRIEL_MODEL= # Default: gpt-4o
GALADRIEL_FINE_TUNE_API_KEY= # OpenAI key for fine-tuned models

# LM Studio
LMSTUDIO_SERVER_URL= # Default: http://localhost:1234/v1
LMSTUDIO_MODEL= # Model name
SMALL_LMSTUDIO_MODEL= # Default: hermes-3-llama-3.1-8b
MEDIUM_LMSTUDIO_MODEL= # Default: hermes-3-llama-3.1-8b
LARGE_LMSTUDIO_MODEL= # Default: hermes-3-llama-3.1-8b

# Secret AI
SECRET_AI_API_KEY= # API key
SECRET_AI_URL= # Default: https://ai1.scrtlabs.com:21434
SMALL_SECRET_AI_MODEL= # Default: deepseek-r1:70b
MEDIUM_SECRET_AI_MODEL= # Default: deepseek-r1:70b
LARGE_SECRET_AI_MODEL= # Default: deepseek-r1:70b

# NEAR AI
NEARAI_API_URL= # Default: https://api.near.ai/v1
NEARAI_API_KEY= # API key
NEARAI_MODEL= # Model name
SMALL_NEARAI_MODEL= # Default: fireworks::accounts/fireworks/models/llama-v3p2-3b-instruct
MEDIUM_NEARAI_MODEL= # Default: fireworks::accounts/fireworks/models/llama-v3p1-70b-instruct
LARGE_NEARAI_MODEL= # Default: fireworks::accounts/fireworks/models/llama-v3p1-405b-instruct
IMAGE_NEARAI_MODEL= # Default: fireworks::accounts/fireworks/models/playground-v2-5-1024px-aesthetic

# Other API Keys
ALI_BAILIAN_API_KEY= # Ali Bailian API key
TOGETHER_API_KEY= # Together API key

## CRYPTO PLUGINS
# Market Data APIs
COINMARKETCAP_API_KEY= # CoinMarketCap API key
ZERION_API_KEY= # Zerion API key
COINGECKO_API_KEY= # CoinGecko API key (free)
COINGECKO_PRO_API_KEY= # CoinGecko Pro API key
MORALIS_API_KEY= # Moralis API key
CHAINBASE_API_KEY= # Chainbase API key (demo for free tier)
BIRDEYE_API_KEY= # Birdeye API key

# EVM Chains
EVM_PRIVATE_KEY= # Private key (with 0x prefix)
EVM_PROVIDER_URL= # RPC provider URL
ALCHEMY_HTTP_TRANSPORT_URL= # Alchemy HTTP URL
ZERO_EX_API_KEY= # 0x API key

# Zilliqa
ZILLIQA_PRIVATE_KEY= # Private key
ZILLIQA_PROVIDER_URL= # Provider URL

# Avalanche
AVALANCHE_PRIVATE_KEY= # Private key
AVALANCHE_PUBLIC_KEY= # Public key

# Arthera
ARTHERA_PRIVATE_KEY= # Private key

# Solana
SOLANA_PRIVATE_KEY= # Private key
SOLANA_PUBLIC_KEY= # Public key
SOLANA_CLUSTER= # Options: devnet|testnet|mainnet-beta, default: devnet
SOLANA_ADMIN_PRIVATE_KEY= # Admin private key for NFT verification
SOLANA_ADMIN_PUBLIC_KEY= # Admin public key for NFT verification
SOLANA_VERIFY_TOKEN= # Verification API token
SOL_ADDRESS=So11111111111111111111111111111111111111112 # SOL token address
SLIPPAGE=1 # Slippage percentage
BASE_MINT=So11111111111111111111111111111111111111112 # Base token address
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com # RPC URL
HELIUS_API_KEY= # Helius API key

# Injective
INJECTIVE_PRIVATE_KEY= # Private key
INJECTIVE_PUBLIC_KEY= # Public key
INJECTIVE_NETWORK= # Network setting

# Legacy Wallet (deprecated)
WALLET_PRIVATE_KEY= # Private key
WALLET_PUBLIC_KEY= # Public key

# Abstract
ABSTRACT_ADDRESS= # Address
ABSTRACT_PRIVATE_KEY= # Private key
ABSTRACT_RPC_URL=https://api.testnet.abs.xyz # RPC URL

# Starknet
STARKNET_ADDRESS= # Address
STARKNET_PRIVATE_KEY= # Private key
STARKNET_RPC_URL=https://rpc.starknet-testnet.lava.build # RPC URL

# Lens Network
LENS_ADDRESS= # Address
LENS_PRIVATE_KEY= # Private key

# Viction
VICTION_ADDRESS= # Address
VICTION_PRIVATE_KEY= # Private key
VICTION_RPC_URL= # RPC URL

# Form Chain
FORM_PRIVATE_KEY= # Character account private key
FORM_TESTNET=true # true=Testnet, false=Mainnet

# Coinbase
COINBASE_COMMERCE_KEY= # Commerce key
COINBASE_API_KEY= # API key
COINBASE_PRIVATE_KEY= # Private key
COINBASE_GENERATED_WALLET_ID= # Generated wallet ID
COINBASE_GENERATED_WALLET_HEX_SEED= # Wallet hex seed
COINBASE_NOTIFICATION_URI= # Webhook URI

# Coinbase AgentKit
CDP_API_KEY_NAME= # API key name
CDP_API_KEY_PRIVATE_KEY= # Private key
CDP_AGENT_KIT_NETWORK=base-sepolia # Default: base-sepolia

# Charity
IS_CHARITABLE=false # Enable charity donations
CHARITY_ADDRESS_BASE= # Base network address
CHARITY_ADDRESS_SOL= # Solana address
CHARITY_ADDRESS_ETH= # Ethereum address
CHARITY_ADDRESS_ARB= # Arbitrum address
CHARITY_ADDRESS_POL= # Polygon address

# Thirdweb
THIRDWEB_SECRET_KEY= # Secret key

# Conflux
CONFLUX_CORE_PRIVATE_KEY= # Core private key
CONFLUX_CORE_SPACE_RPC_URL= # Core RPC URL
CONFLUX_ESPACE_PRIVATE_KEY= # eSpace private key
CONFLUX_ESPACE_RPC_URL= # eSpace RPC URL
CONFLUX_MEME_CONTRACT_ADDRESS= # Meme contract address

# Mind Network
MIND_HOT_WALLET_PRIVATE_KEY= # Hot wallet private key
MIND_COLD_WALLET_ADDRESS= # Cold wallet address

# ZeroG
ZEROG_INDEXER_RPC= # Indexer RPC
ZEROG_EVM_RPC= # EVM RPC
ZEROG_PRIVATE_KEY= # Private key
ZEROG_FLOW_ADDRESS= # Flow address

# IQ6900
IQ_WALLET_ADDRESS= # Wallet address
IQSOlRPC= # Solana RPC

# Squid Router
SQUID_SDK_URL=https://apiplus.squidrouter.com # Default SDK URL
SQUID_INTEGRATOR_ID= # Integrator ID
SQUID_EVM_ADDRESS= # EVM address
SQUID_EVM_PRIVATE_KEY= # EVM private key
SQUID_API_THROTTLE_INTERVAL=1000 # Throttle interval (ms)

# TEE Configuration
TEE_MODE=OFF # Options: LOCAL|DOCKER|PRODUCTION|OFF
WALLET_SECRET_SALT= # Salt for wallet secrets
TEE_LOG_DB_PATH= # Default: ./data/tee_log.sqlite
VLOG= # Enable TEE Verifiable Log if "true"
ENABLE_TEE_LOG=false # Enable TEE logging (TEE mode only)
TEE_MARLIN= # Set "yes" to enable Marlin plugin
TEE_MARLIN_ATTESTATION_ENDPOINT= # Default: http://127.0.0.1:1350

# Flow Blockchain
FLOW_ADDRESS= # Flow address
FLOW_PRIVATE_KEY= # Private key for SHA3-256 + P256 ECDSA
FLOW_NETWORK= # Default: mainnet
FLOW_ENDPOINT_URL= # Default: https://mainnet.onflow.org

# Internet Computer Protocol
INTERNET_COMPUTER_PRIVATE_KEY= # ICP private key
INTERNET_COMPUTER_ADDRESS= # ICP address

# Cloudflare AI
CLOUDFLARE_GW_ENABLED= # Enable Cloudflare AI Gateway
CLOUDFLARE_AI_ACCOUNT_ID= # Account ID
CLOUDFLARE_AI_GATEWAY_ID= # Gateway ID

# Aptos
APTOS_PRIVATE_KEY= # Private key
APTOS_NETWORK= # Options: mainnet|testnet

# MultiversX
MVX_PRIVATE_KEY= # Private key
MVX_NETWORK= # Options: mainnet|devnet|testnet
ACCESS_TOKEN_MANAGEMENT_TO=everyone # Limit token management

# NEAR
NEAR_WALLET_SECRET_KEY= # Secret key
NEAR_WALLET_PUBLIC_KEY= # Public key
NEAR_ADDRESS= # Address
NEAR_SLIPPAGE=1 # Slippage percentage
NEAR_RPC_URL=https://near-testnet.lava.build # RPC URL
NEAR_NETWORK=testnet # Options: testnet|mainnet

# ZKsync Era
ZKSYNC_ADDRESS= # Address
ZKSYNC_PRIVATE_KEY= # Private key

# HoldStation
HOLDSTATION_PRIVATE_KEY= # Private key

# Avail DA
AVAIL_ADDRESS= # Address
AVAIL_SEED= # Seed
AVAIL_APP_ID=0 # App ID
AVAIL_RPC_URL=wss://avail-turing.public.blastapi.io/ # Default RPC URL

# TON
TON_PRIVATE_KEY= # Mnemonic joined with empty string
TON_RPC_URL= # RPC URL
TON_RPC_API_KEY= # RPC API key
TON_NFT_IMAGES_FOLDER= # NFT images folder
TON_NFT_METADATA_FOLDER= # NFT metadata folder
PINATA_API_KEY= # Pinata API key
PINATA_API_SECRET= # Pinata API secret
PINATA_JWT= # Pinata JWT

# Sui
SUI_PRIVATE_KEY= # Private key/mnemonic
SUI_NETWORK= # Options: mainnet|testnet|devnet|localnet

# Mina
MINA_PRIVATE_KEY= # Mnemonic seed phrase
MINA_NETWORK=devnet # Options: mainnet|testnet|devnet|localnet

# Story
STORY_PRIVATE_KEY= # Private key
STORY_API_BASE_URL= # API base URL
STORY_API_KEY= # API key

# Cosmos
COSMOS_RECOVERY_PHRASE= # 12-word recovery phrase
COSMOS_AVAILABLE_CHAINS= # Chain list (comma-separated)

# Cronos zkEVM
CRONOSZKEVM_ADDRESS= # Address
CRONOSZKEVM_PRIVATE_KEY= # Private key

# Fuel Ecosystem
FUEL_WALLET_PRIVATE_KEY= # Private key

# Spheron
SPHERON_PRIVATE_KEY= # Private key
SPHERON_PROVIDER_PROXY_URL= # Provider proxy URL
SPHERON_WALLET_ADDRESS= # Wallet address

# Stargaze
STARGAZE_ENDPOINT= # GraphQL endpoint

# GenLayer
GENLAYER_PRIVATE_KEY= # Private key (0x format)

# BNB Chain
BNB_PRIVATE_KEY= # Private key
BNB_PUBLIC_KEY= # Public key
BSC_PROVIDER_URL= # BNB Smart Chain RPC URL
OPBNB_PROVIDER_URL= # OPBNB RPC URL

# Allora
ALLORA_API_KEY= # API key (UP-* format)
ALLORA_CHAIN_SLUG= # Options: mainnet|testnet, default: testnet

# B2 Network
B2_PRIVATE_KEY= # Private key

# Opacity zkTLS
OPACITY_TEAM_ID=f309ac8ae8a9a14a7e62cd1a521b1c5f # Team ID
OPACITY_CLOUDFLARE_NAME=eigen-test # Cloudflare name
OPACITY_PROVER_URL=https://opacity-ai-zktls-demo.vercel.app # Prover URL

# SEI Network
SEI_PRIVATE_KEY= # Private key
SEI_NETWORK= # Options: mainnet|testnet|devnet
SEI_RPC_URL= # Custom RPC URL

# Omniflix
OMNIFLIX_API_URL= # https://rest.omniflix.network
OMNIFLIX_MNEMONIC= # 12/24-word mnemonic
OMNIFLIX_RPC_ENDPOINT= # https://rpc.omniflix.network
OMNIFLIX_PRIVATE_KEY= # Private key

# Hyperliquid
HYPERLIQUID_PRIVATE_KEY= # Private key
HYPERLIQUID_TESTNET= # true/false, default: false

# Lit Protocol
FUNDING_PRIVATE_KEY= # Funding private key
EVM_RPC_URL= # RPC URL

# EthStorage DA
ETHSTORAGE_PRIVATE_KEY= # Private key
ETHSTORAGE_ADDRESS=0x64003adbdf3014f7E38FC6BE752EB047b95da89A # Address
ETHSTORAGE_RPC_URL=https://rpc.beta.testnet.l2.quarkchain.io:8545 # RPC URL

# DCAP
DCAP_EVM_PRIVATE_KEY= # Private key
DCAP_MODE= # Options: OFF|PLUGIN-SGX|PLUGIN-TEE|MOCK

# QuickIntel
QUICKINTEL_API_KEY= # Token security analysis API key

# News API
NEWS_API_KEY= # From https://newsapi.org/

# BTCFUN
BTCFUN_API_URL= # Default: https://api-testnet-new.btc.fun
BTC_PRIVATE_KEY_WIF= # BTC private key in WIF format
BTC_ADDRESS= # BTC address
BTC_MINT_CAP=10000 # Maximum mint amount
BTC_MINT_DEADLINE=864000 # Deadline in seconds
BTC_FUNDRAISING_CAP=100 # Maximum fundraising amount

# Trikon
TRIKON_WALLET_ADDRESS= # Valid 64-char hex with 0x prefix
TRIKON_INITIAL_BALANCE= # Optional, default: 0

# Arbitrage
ARBITRAGE_ETHEREUM_WS_URL= # Ethereum WebSocket URL
ARBITRAGE_EVM_PROVIDER_URL= # Ethereum RPC URL
ARBITRAGE_EVM_PRIVATE_KEY= # Private key for transactions
FLASHBOTS_RELAY_SIGNING_KEY= # Flashbots signing key
BUNDLE_EXECUTOR_ADDRESS= # Bundle executor contract address

# DESK Exchange
DESK_EXCHANGE_PRIVATE_KEY= # Private key
DESK_EXCHANGE_NETWORK= # mainnet or testnet

# Compass
COMPASS_WALLET_PRIVATE_KEY= # Private key
COMPASS_ARBITRUM_RPC_URL= # Arbitrum RPC URL
COMPASS_ETHEREUM_RPC_URL= # Ethereum RPC URL
COMPASS_BASE_RPC_URL= # Base RPC URL

# d.a.t.a
DATA_API_KEY= # API key
DATA_AUTH_TOKEN= # Auth token

# NKN
NKN_CLIENT_PRIVATE_KEY= # Required client private key
NKN_CLIENT_ID= # Optional client ID

# Router Nitro EVM
ROUTER_NITRO_EVM_ADDRESS= # Address
ROUTER_NITRO_EVM_PRIVATE_KEY= # Private key

# OriginTrail DKG
DKG_ENVIRONMENT= # Options: development|testnet|mainnet
DKG_HOSTNAME= # Hostname
DKG_PORT=8900 # Port
DKG_PUBLIC_KEY= # Public key
DKG_PRIVATE_KEY= # Private key
DKG_BLOCKCHAIN_NAME= # Chain configs

# Initia
INITIA_PRIVATE_KEY= # Wallet private key
INITIA_NODE_URL= # Node URL, default: testnet
INITIA_CHAIN_ID=initia-test # Chain ID, default: testnet

# NVIDIA
NVIDIA_NIM_ENV=production # Environment
NVIDIA_NIM_SPASH=false # Show splash
NVIDIA_NIM_API_KEY= # NIM API key
NVIDIA_NGC_API_KEY= # NGC API key
NVIDIA_NIM_MAX_RETRIES=3 # Max retries
NVIDIA_NIM_RETRY_DELAY=1000 # Retry delay (ms)
NVIDIA_NIM_TIMEOUT=5000 # Timeout (ms)
NVIDIA_GRANULAR_LOG=true # Granular logging
NVIDIA_LOG_LEVEL=debug # Log level
NVIDIA_OFFTOPIC_SYSTEM= # Off-topic system
NVIDIA_OFFTOPIC_USER= # Off-topic user
NVIDIA_NIM_BASE_VISION_URL=https://ai.api.nvidia.com/v1/vlm # Vision URL
NVIDIA_COSMOS_MODEL=nvidia/cosmos-nemotron-34b # Model name
NVIDIA_COSMOS_INVOKE_URL=https://ai.api.nvidia.com/v1/vlm/nvidia/cosmos-nemotron-34b # Invoke URL
NVIDIA_COSMOS_ASSET_URL=https://api.nvcf.nvidia.com/v2/nvcf/assets # Asset URL
NVIDIA_COSMOS_MAX_TOKENS=1000 # Max tokens

# Email
EMAIL_OUTGOING_SERVICE=smtp # Options: smtp|gmail
EMAIL_OUTGOING_HOST=smtp.example.com # SMTP host
EMAIL_OUTGOING_PORT=465 # Default: 465 (secure), 587 (TLS)
EMAIL_OUTGOING_USER= # Username
EMAIL_OUTGOING_PASS= # Password/app password
EMAIL_INCOMING_SERVICE=imap # Service type
EMAIL_INCOMING_HOST=imap.example.com # IMAP host
EMAIL_INCOMING_PORT=993 # Default port for secure IMAP
EMAIL_INCOMING_USER= # Username
EMAIL_INCOMING_PASS= # Password

# Email Automation
RESEND_API_KEY= # Resend API key
DEFAULT_TO_EMAIL= # Default recipient
DEFAULT_FROM_EMAIL= # Default sender
EMAIL_AUTOMATION_ENABLED=false # Enable AI detection
EMAIL_EVALUATION_PROMPT= # Custom detection criteria

# ANKR
ANKR_ENV=production # Environment
ANKR_WALLET= # Wallet
ANKR_MAX_RETRIES=3 # Max retries
ANKR_RETRY_DELAY=1000 # Retry delay (ms)
ANKR_TIMEOUT=5000 # Timeout (ms)
ANKR_GRANULAR_LOG=true # Granular logging
ANKR_LOG_LEVEL=debug # Log level
ANKR_RUNTIME_CHECK_MODE=false # Check mode
ANKR_SPASH=true # Show splash

# Quai Network
QUAI_PRIVATE_KEY= # Private key
QUAI_RPC_URL=https://rpc.quai.network # RPC URL

# Tokenizer
TOKENIZER_MODEL= # Tokenizer model
TOKENIZER_TYPE= # Options: tiktoken|auto, default: tiktoken

# AWS Services
AWS_ACCESS_KEY_ID= # Access key ID
AWS_SECRET_ACCESS_KEY= # Secret access key
AWS_REGION= # AWS region
AWS_S3_BUCKET= # S3 bucket name
AWS_S3_UPLOAD_PATH= # S3 upload path
AWS_S3_ENDPOINT= # S3 endpoint
AWS_S3_SSL_ENABLED= # Enable SSL
AWS_S3_FORCE_PATH_STYLE= # Force path style

# Deva
DEVA_API_KEY= # API key from deva.me/settings/apps
DEVA_API_BASE_URL=https://api.deva.me # Default URL

# Verifiable Inference
VERIFIABLE_INFERENCE_ENABLED=false # Enable verification
VERIFIABLE_INFERENCE_PROVIDER=opacity # Provider option

# Qdrant
QDRANT_URL= # Qdrant instance URL
QDRANT_KEY= # API key
QDRANT_PORT=443 # Port (443 cloud, 6333 local)
QDRANT_VECTOR_SIZE=1536 # Vector size

# Autonome
AUTONOME_JWT_TOKEN= # JWT token
AUTONOME_RPC=https://wizard-bff-rpc.alt.technology/v1/bff/aaa/apps # RPC URL

# Akash Network
AKASH_ENV=mainnet # Environment
AKASH_NET=https://raw.githubusercontent.com/ovrclk/net/master/mainnet # Network
RPC_ENDPOINT=https://rpc.akashnet.net:443 # RPC endpoint
AKASH_GAS_PRICES=0.025uakt # Gas prices
AKASH_GAS_ADJUSTMENT=1.5 # Gas adjustment
AKASH_KEYRING_BACKEND=os # Keyring backend
AKASH_FROM=default # From account
AKASH_FEES=20000uakt # Fees
AKASH_DEPOSIT=500000uakt # Deposit
AKASH_MNEMONIC= # Mnemonic
AKASH_WALLET_ADDRESS= # Wallet address
AKASH_PRICING_API_URL=https://console-api.akash.network/v1/pricing # Pricing API
AKASH_DEFAULT_CPU=1000 # Default CPU
AKASH_DEFAULT_MEMORY=1000000000 # Default memory
AKASH_DEFAULT_STORAGE=1000000000 # Default storage
AKASH_SDL=example.sdl.yml # SDL file
AKASH_CLOSE_DEP=closeAll # Close deployment
AKASH_CLOSE_DSEQ=19729929 # Close DSEQ
AKASH_PROVIDER_INFO=akash1ccktptfkvdc67msasmesuy5m7gpc76z75kukpz # Provider info
AKASH_DEP_STATUS=dseq # Deployment status
AKASH_DEP_DSEQ=19729929 # Deployment DSEQ
AKASH_GAS_OPERATION=close # Gas operation
AKASH_GAS_DSEQ=19729929 # Gas DSEQ
AKASH_MANIFEST_MODE=auto # Manifest mode
AKASH_MANIFEST_PATH= # Manifest path
AKASH_MANIFEST_VALIDATION_LEVEL=strict # Validation level

# Pyth
PYTH_NETWORK_ENV=mainnet # Network environment
PYTH_MAINNET_HERMES_URL=https://hermes.pyth.network # Mainnet Hermes URL
PYTH_MAINNET_WSS_URL=wss://hermes.pyth.network/ws # Mainnet WSS URL
PYTH_MAINNET_PYTHNET_URL=https://pythnet.rpcpool.com # Mainnet Pythnet URL
PYTH_MAINNET_CONTRACT_REGISTRY=https://pyth.network/developers/price-feed-ids # Registry
PYTH_MAINNET_PROGRAM_KEY= # Program key
PYTH_TESTNET_HERMES_URL=https://hermes.pyth.network # Testnet Hermes URL
PYTH_TESTNET_WSS_URL=wss://hermes.pyth.network/ws # Testnet WSS URL
PYTH_TESTNET_PYTHNET_URL=https://pythnet.rpcpool.com # Testnet Pythnet URL
PYTH_TESTNET_CONTRACT_REGISTRY=https://pyth.network/developers/price-feed-ids#testnet # Registry
PYTH_TESTNET_PROGRAM_KEY= # Program key
PYTH_MAX_RETRIES=3 # Max retries
PYTH_RETRY_DELAY=1000 # Retry delay (ms)
PYTH_TIMEOUT=5000 # Timeout (ms)
PYTH_GRANULAR_LOG=true # Granular logging
PYTH_LOG_LEVEL=debug # Log level for debugging
PYTH_LOG_LEVEL=info # Log level for production
PYTH_ENABLE_PRICE_STREAMING=true # Enable price streaming
PYTH_MAX_PRICE_STREAMS=2 # Max price streams
PYTH_TEST_ID01=0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43 # Test ID
PYTH_TEST_ID02=0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace # Test ID

# Misc Plugins
INTIFACE_WEBSOCKET_URL=ws://localhost:12345 # Intiface WebSocket URL
GIPHY_API_KEY= # API key from giphy
OPEN_WEATHER_API_KEY= # OpenWeather API key
PASSPORT_API_KEY= # Gitcoin Passport key
PASSPORT_SCORER= # Scorer number
TAVILY_API_KEY= # Web search API key
ECHOCHAMBERS_API_URL=http://127.0.0.1:3333 # API URL
ECHOCHAMBERS_API_KEY=testingkey0011 # API key
ECHOCHAMBERS_USERNAME=eliza # Username
ECHOCHAMBERS_ROOMS=general # Comma-separated room list
ECHOCHAMBERS_POLL_INTERVAL=60 # Poll interval (sec)
ECHOCHAMBERS_MAX_MESSAGES=10 # Max messages
ECHOCHAMBERS_CONVERSATION_STARTER_INTERVAL=300 # Check interval (sec)
ECHOCHAMBERS_QUIET_PERIOD=900 # Quiet period (sec)
SUNO_API_KEY= # Suno AI music generation
UDIO_AUTH_TOKEN= # Udio AI music generation
FOOTBALL_API_KEY= # Football-Data.org API key
IMGFLIP_USERNAME= # Imgflip username
IMGFLIP_PASSWORD= # Imgflip password
RUNTIME_CHECK_MODE=false # Runtime check mode
```
</details>

---

## FAQ

### How do I configure different model providers?
Set `modelProvider` in your character.json and add corresponding API keys in `.env` or character secrets. Supports Anthropic, OpenAI, DeepSeek, and others.

### How do I adjust the temperature setting in my character file?
The temperature setting controls response randomness and can be configured in your character's JSON file:

```json
{
    "modelProvider": "openrouter",
    "temperature": 0.7,
    "settings": {
        "model": "openai/gpt-4o-mini"
        "maxInputTokens": 200000,
        "maxOutputTokens": 8192
    }
}
```
Increase temperature for more creative responses, decrease for more consistent outputs.

### I'm getting an authentication error ("No auth credentials found"). What should I do?
Check these common issues:
1. Verify API keys in your .env file
2. Ensure keys are properly formatted (OpenAI keys start with `sk-`, Groq with `gsk_`, etc.)
3. Check logs for specific authentication errors
4. Try restarting the application after updating credentials
5. For character-specific providers, ensure they have access to the needed keys

### How do I debug when my agent isn't responding?
1. Enable debug logging: `DEBUG=eliza:*` in your .env file
2. Check database for saved messages
3. Verify model provider connectivity
4. Review logs for error messages

### How do I control my agent's behavior across platforms?
Configure platform-specific settings in `.env` (like `TWITTER_TARGET_USERS`) and adjust response templates in your character file.
