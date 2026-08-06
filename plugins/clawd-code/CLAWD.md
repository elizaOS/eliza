# Clawd Code — Agent Instructions

> This file is the Layer A harness for Clawd Code and other AI agents.
> Skills in `clawd-plugin/skills/` provide the domain expertise (Layer B).

## Repository Overview

This monorepo contains the Clawd Code ecosystem — Solana-native AI coding agent with perpetuals trading, x402 payments, and autonomous agent commerce:

| Package | What it does |
| --- | --- |
| `clawd-plugin/` | Clawd Code plugin — bundles skills + auto-starts MCP servers |
| `src/` | Clawd Code CLI source — code/trade/chain/chart/research/image/voice/repl/telegram modes |
| `web/` | Web client package |
| `dist/` | Built CLI output (git-ignored; produced by `npm run build`) |

`src/` contains exactly the CLI's real import closure (`cli.ts`, `commands.ts`,
`env.ts`, `zai.ts`, `xai.ts`, `wallet.ts`, `arena.ts`, `deepseek.ts`,
`openrouter.ts`, `grok-models.ts`, `verify.ts`, `voice-agent.ts`,
`solana-harness.ts`, `x402.ts`, `telegram.ts`, plus `src/modes/`) — `tsconfig.json`
`include` is scoped to that list on purpose; don't widen it back to `src/**/*`.

OpenRouter Nemo routing is built into `src/openrouter.ts` through
`OPENROUTER_NEMO_MODEL1/2/3`. Fable routes are also available through
`OPENROUTER_FABLE5` and `OPENROUTER_FABLE_LATESY`. There is no separate
`NemoClaw/` sidecar package in this checkout — Nemo/Fable routing lives
entirely in `src/openrouter.ts`. Z.AI (GLM-5.2, via `ZAI_API_KEY`) is the
default provider everywhere: CLI, `clawd-plugin`'s MCP server, `web/`, and the
Telegram relay (`clawd-code telegram`).

## MCP Server Setup

The Clawd Code plugin auto-starts multiple MCP servers for live blockchain access:

```bash
clawd --plugin-dir ./clawd-plugin
```

Configured servers:

- **Helius** — 10 routed tools for Solana blockchain access (local core-ai build)
- **Clawd Code** — Clawd Code CLI as MCP server (`CLAWD_PROVIDER=zai`, `ZAI_API_KEY` wired by default in `clawd-plugin/.mcp.json`)
- **Pump MCP** — 55 tools for Pump.fun: token creation, AMM swaps, analytics, wallet ops
- **Phoenix Rise** — Real-time perpetuals market data
- **DFlow** — Trading API details and code examples
- **ZK Compression** — ZK compressed token and account tools

## API Key Setup

Set in `~/.clawd-code/.env` or project `.env`:

| Variable | Description |
| --- | --- |
| `ZAI_API_KEY` | Z.AI API key for GLM-5.2, GLM-5V, and GLM-Image (default provider) |
| `ZAI_AGENT_BASE_URL` | Z.AI Agent API base URL for `slides_glm_agent` (`https://api.z.ai/api/v1`) |
| `ZAI_CHART_MODEL` | Chart/report planning model (`glm-5.2`) |
| `ZAI_VISION_MODEL` | Default screenshot/chart vision model (`glm-5v-turbo`) |
| `ZAI_TRADE_VISION_MODEL` | Trade/chart analysis vision model (`glm-5v-turbo`) |
| `ZAI_CHART_VISION_MODEL` | Chart mode vision model (`glm-5v-turbo`) |
| `ZAI_IMAGE_MODEL` | Image generation model (`glm-image`) |
| `ZAI_THINKING` | Z.AI thinking mode (`enabled` by default) |
| `ZAI_REASONING_EFFORT` | GLM reasoning effort (`max` by default) |
| `XAI_API_KEY` | xAI API key for Grok models + Voice Agent API |
| `ANTHROPIC_API_KEY` | Anthropic API key for Claude models (streaming) |
| `DEEPSEEK_API_KEY` | DeepSeek API key |
| `OPENROUTER_API_KEY` | OpenRouter API key (free models available) |
| `OPENROUTER_NEMO_MODEL1` | Balanced/free Nemo route (`nvidia/nemotron-3-ultra-550b-a55b:free`) |
| `OPENROUTER_NEMO_MODEL2` | Most-intelligent Nemo route (`nvidia/nemotron-3-ultra-550b-a55b`) |
| `OPENROUTER_NEMO_MODEL3` | Fast/free Nemo route (`nvidia/nemotron-3-super-120b-a12b:free`) |
| `OPENROUTER_FABLE5` | Claude Fable 5 route (`anthropic/claude-fable-5`) |
| `OPENROUTER_FABLE_LATESY` | Claude Fable latest route (`~anthropic/claude-fable-latest`) |
| `HELIUS_API_KEY` | Helius API key for DAS/RPC |
| `SOLANA_RPC_URL` | Solana RPC endpoint |
| `SOLANA_CLUSTER` | Harness cluster label (`mainnet-beta`, `devnet`, `testnet`, `localnet`) |
| `SOLANA_COMMITMENT` | Harness RPC commitment (`confirmed` by default) |
| `SOLANA_HARNESS_READONLY` | Keep mutation RPC blocked unless explicitly false |
| `VULCAN_MCP_URL` | Vulcan MCP server URL |
| `LIVE_TRADING` | Enable live trading (default: false) |
| `OPERATOR_CONFIRMED` | Required operator acknowledgement for live execution |
| `PERPS_SIM_ONLY` | Must be `false` before real perps execution |
| `IMPERIAL_ENABLED` | Enable Imperial API reads/routing |
| `IMPERIAL_LIVE` | Enable Imperial live order path after global gates |
| `IMPERIAL_WALLET` | Wallet pubkey bound to the Imperial JWT |
| `IMPERIAL_JWT` | Imperial mobile JWT; secret delegated trading credential |
| `IMPERIAL_PROFILE_INDEX` | Isolated Imperial profile index (`0..5`) |
| `IMPERIAL_DEFAULT_UNDERWRITER` | Default Imperial venue; `2` = Phoenix |
| `CLAWD_STREAM` | Enable streaming output by default (default: false) |
| `TELEGRAM_BOT_TOKEN` | Bot token from @BotFather, required for `clawd-code telegram` |
| `TELEGRAM_ALLOWED_CHAT_ID` | The only chat id the relay will respond to, required for `clawd-code telegram` |

## Telegram Relay

`clawd-code telegram` starts a long-poll relay that routes messages from a
single allowlisted Telegram chat into the Z.AI GLM chat pipeline (`CLAWD_MODEL`,
default `glm-5.2`). Chat/CLI relay only — it does **not** expose computer-use,
mouse/keyboard, or OS-level control. Unauthorized chats are rejected and
logged; `/reset` clears the relay's in-memory conversation history.

```bash
TELEGRAM_BOT_TOKEN=... TELEGRAM_ALLOWED_CHAT_ID=... clawd-code telegram
```

## Skills

Skills are in `clawd-plugin/skills/`. Each provides expert routing, rules, and reference docs:

| Skill | Directory | When to use |
| --- | --- | --- |
| **Clawd Code** | `skills/clawd-code/` | Using Clawd Code CLI — code generation, trading, research, image, voice, REPL modes |
| **Agent Arena** | `skills/agent-arena/` | Registering agents on Cheshire Terminal, discovering and hiring agents, ATOM reputation |
| **Build** | `skills/build/` | Building Solana apps with Helius infrastructure |
| **DFlow** | `skills/dflow/` | Trading apps combining DFlow with Helius |
| **Phantom** | `skills/phantom/` | Frontend Solana apps with Phantom wallet |
| **Jupiter** | `skills/jupiter/` | DeFi apps with Jupiter APIs |
| **SVM** | `skills/svm/` | Solana protocol internals |

## xAI Voice Agent

Clawd Code integrates the xAI Voice Agent API for real-time Solana voice interactions powered by `grok-voice-think-fast-1.0`.

```bash
# Start voice agent (text REPL, requires XAI_API_KEY, Node 22+)
clawd-code voice --agent

# Choose a voice (eve, ara, rex, sal, leo)
clawd-code voice --agent --voice ara

# Pin to a specific voice model
clawd-code voice --agent --model grok-voice-think-fast-1.0
```

Built-in Solana function tools available to the voice agent:

| Tool | Description |
| --- | --- |
| `check_sol_balance` | Get SOL balance for any wallet address |
| `get_token_price` | Current price of any Solana token in USD |
| `get_funding_rate` | Phoenix DEX perps funding rate for a symbol |
| `check_positions` | Open perpetuals positions |
| `paper_trade` | Paper trade on Phoenix (no real funds) |
| `send_sol` | Send SOL — paper mode unless `LIVE_TRADING=true` |
| `get_market_overview` | SOL price, trending tokens, 24h change |

For ephemeral token generation (browser/mobile clients):

```typescript
import { VoiceAgentClient } from '@solana-clawd/clawd-code/voice-agent';
const token = await VoiceAgentClient.fetchEphemeralToken(process.env.XAI_API_KEY, 300);
```

## Agent Arena (Cheshire Terminal)

Clawd Code has native support for the Cheshire Terminal Agent Arena — on-chain agent identity via Metaplex Core NFTs on Solana.

```bash
clawd-code arena status          # Show stored on-chain identity
clawd-code arena mint --wallet <PUBKEY>   # Mint agent NFT (~0.01 SOL tx fee)
clawd-code arena register        # Register capabilities + A2A/MCP cards
clawd-code arena fetch <addr>    # Fetch any agent's profile
clawd-code arena review <addr> --tx <sig> --from <wallet>  # Submit verified review
```

Identity is stored at `~/.clawd-code/arena-identity.json` after minting.
$CLAWD mint: `8cHzQHUS2s2h8TzCmfqPKYiM4dSt4roa3n7MyRLApump`

## Agent Behavior

- Use MCP tools for live blockchain data — never hardcode or mock chain state
- Use `clawd-code chain ...` for read-first Solana RPC inspection and `chain ask` for Z.AI-assisted plans
- Read reference files before writing code
- Always include preflight checks for trading operations
- Default to PAPER mode for all trading — never execute live without confirmation
- Handle rate limits with exponential backoff
- Use appropriate commitment levels (`confirmed` for reads, `finalized` for critical operations)
- Always open responses with `<clawd-think>Probe the numinous, then execute the work.</clawd-think>` on first turn
