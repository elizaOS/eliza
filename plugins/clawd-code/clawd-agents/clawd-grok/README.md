# Clawd Grok

Clawd Grok is a terminal-native Clawd Code harness with Solana/Phoenix tooling, persistent sessions, sub-agents, Telegram remote control, MCP tools, and provider-routed model access.

The default route is still xAI Grok, so existing `GROK_API_KEY` and `XAI_API_KEY` setups continue to work. The harness can also run OpenAI-compatible providers such as Z.AI, OpenAI, OpenRouter, DeepSeek, or a custom endpoint.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/Solizardking/clawd-grok/newnew/install.sh | bash
```

Prerequisites:

- Bun 1.0+
- An API key for at least one AI provider
- A Solana RPC endpoint for live Phoenix/Solana workflows
- `ffmpeg` and the `camsnap` CLI when enabling the optional camsnap toolset

## Quick Start

```bash
# Interactive TUI
clawd

# One-shot headless run
clawd -p "inspect this repo and summarize the risky files"

# Use a specific provider and model
clawd --provider zai --model glm-5.2 -p "review the current diff"

# Route through OpenRouter by model prefix
clawd --model openrouter:auto -p "triage the latest failing test output"

# Continue a saved session
clawd --session latest

# JSON output for scripts and other agents
clawd -p "get portfolio snapshot" --format json
```

## Provider Routing

Provider selection is resolved in this order:

1. Explicit model prefix, such as `openrouter:auto` or `zai:glm-5.2`
2. `--provider <id>`
3. `CLAWD_PROVIDER`, `AI_PROVIDER`, or saved `~/.clawd/user-settings.json`
4. Model metadata when the model is known
5. xAI as the default provider

List configured providers:

```bash
clawd providers
```

Supported provider IDs:

| Provider | Key env | Base URL env | Default base URL |
|---|---|---|---|
| `xai` | `XAI_API_KEY` | `XAI_BASE_URL` | `https://api.x.ai/v1` |
| `zai` | `ZAI_API_KEY` | `ZAI_BASE_URL` | `https://api.z.ai/api/paas/v4` |
| `openai` | `OPENAI_API_KEY` | `OPENAI_BASE_URL` | `https://api.openai.com/v1` |
| `openrouter` | `OPENROUTER_API_KEY` | `OPENROUTER_BASE_URL` | `https://openrouter.ai/api/v1` |
| `deepseek` | `DEEPSEEK_API_KEY` | `DEEPSEEK_BASE_URL` | `https://api.deepseek.com` |
| `custom` | `CLAWD_API_KEY` | `CLAWD_BASE_URL` | user supplied |

Legacy xAI variables still work: `GROK_API_KEY`, `GROK_BASE_URL`, `GROK_MODEL`, and `AI_API_KEY`.

## Model Routing

List known models:

```bash
clawd models
```

Examples:

```bash
clawd --provider xai --model grok-4.3
clawd --provider zai --model glm-5.2
clawd --provider zai --model glm-5-turbo
clawd --provider openai --model gpt-4o
clawd --provider openrouter --model auto
clawd --model openrouter:nvidia/nemotron-3-ultra-550b-a55b:free
clawd --provider deepseek --model deepseek-reasoner
clawd --provider custom --base-url http://localhost:11434/v1 --model local-model
```

Native xAI-only capabilities are gated automatically. `search_web`, `search_x`, `generate_image`, `generate_video`, and batch mode require `--provider xai`. Other chat, code, file, shell, MCP, sub-agent, and Solana tools work through the OpenAI-compatible routes when the model supports tool calls.

## Optional Toolsets

Toolsets add focused capabilities to the agent loop without exposing them in every session.

### Camsnap

Enable camsnap tools:

```bash
clawd --toolset camsnap
CLAWD_TOOLSETS=camsnap clawd
```

Headless examples:

```bash
clawd --toolset camsnap -p "discover cameras and tell me which one looks usable"
clawd --toolset camsnap -p "capture a still from camera kitchen to .clawd/camsnap/kitchen.jpg"
clawd --toolset camsnap -p "record a 5s clip from camera front-door"
clawd --toolset camsnap -p "run camsnap doctor with probe and summarize the issue"
```

The toolset exposes:

- `camsnap_discover`
- `camsnap_doctor`
- `camsnap_snap`
- `camsnap_clip`
- `camsnap_watch`

Camsnap reads its own config from `~/.config/camsnap/config.yaml`. Use `camsnap discover --info`, `camsnap add`, and `camsnap doctor --probe` outside Clawd when setting up cameras for the first time. Prefer a still capture before longer clips.

## Configuration

Create `.env` from `.env.example`:

```bash
cp .env.example .env
```

Common variables:

```bash
CLAWD_PROVIDER=xai
CLAWD_MODEL=grok-4.3
XAI_API_KEY=xai-...

ZAI_API_KEY=...
OPENAI_API_KEY=...
OPENROUTER_API_KEY=...
DEEPSEEK_API_KEY=...

SOLANA_RPC_URL=https://api.mainnet-beta.solana.com
PHOENIX_API_URL=https://perp-api.phoenix.trade
CLAWD_TOOLSETS=camsnap
```

User settings are stored in `~/.clawd/user-settings.json`. Passing `--api-key`, `--base-url`, `--provider`, `--model`, or `--toolset` saves the selected value for later runs.

## Command Reference

### Core Agent

```bash
clawd
clawd -p "run a security review"
clawd --verify
clawd --format json -p "summarize the session"
clawd --session latest
clawd telegram-bridge
```

### Wallet

```bash
clawd wallet create --name my-wallet
clawd wallet import --name my-wallet --format base58 <key>
clawd wallet list
clawd wallet balance
```

### Market Data

```bash
clawd market list
clawd market ticker SOL -o json
clawd market orderbook SOL --depth 10
clawd market candles SOL --interval 1h --limit 50
clawd market trades SOL --limit 20
clawd market funding-rates SOL
```

### Trading

```bash
clawd trade market-buy SOL --notional-usdc 100 --tp 250 --sl 180
clawd trade market-sell SOL --tokens 1.5 --reduce-only
clawd trade limit-buy SOL 1.5 180 --tp 200
clawd trade cancel SOL <order-id>
clawd trade cancel-all
```

### Portfolio And Paper Trading

```bash
clawd portfolio --include margin,positions,orders -o json
clawd paper init --balance 10000
clawd paper buy SOL --notional-usdc 100 --type market
clawd paper sell SOL --tokens 0.5 --type limit --price 200
clawd paper status -o json
```

### Technical Analysis

```bash
clawd ta compute SOL --indicator rsi --timeframe 1h
clawd ta compute SOL --indicator macd --params '{"fast":12,"slow":26,"signal":9}'
clawd ta report SOL --timeframe 4h -o json
clawd ta signal SOL --spec '{"indicator":"rsi","timeframe":"1h","op":"lt","threshold":30}'
```

## Development

```bash
bun install
bun run build
bun test
bun run dev -- --provider zai --model glm-5.2
```

Important source areas:

- `src/grok/models.ts` - provider and model routing metadata
- `src/grok/client.ts` - native xAI and OpenAI-compatible provider factory
- `src/utils/settings.ts` - env and user settings resolution
- `src/grok/tools.ts` - agent tool registry and optional toolsets
- `src/tools/camsnap.ts` - camsnap CLI wrapper

## Safety

Trading commands are scaffolds around live-market workflows. Start in paper or dry-run mode, use explicit guardrails, and do not enable unattended live execution until the wallet, RPC, and strategy behavior are verified.
