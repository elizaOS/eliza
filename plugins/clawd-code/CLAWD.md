# Clawd Code — Agent Instructions

> This file is the Layer A harness for Clawd Code and other AI agents.
> Skills in `clawd-plugin/skills/` provide the domain expertise (Layer B).

## Repository Overview

This monorepo contains the Clawd Code ecosystem — Solana-native AI coding agent with perpetuals trading, x402 payments, and autonomous agent commerce:

| Package | What it does |
| --- | --- |
| `clawd-plugin/` | Clawd Code plugin — bundles skills + auto-starts MCP servers |
| `src/` | Clawd Code CLI source — code/trade/research/image/voice modes |
| `dist/` | Built CLI output |

## MCP Server Setup

The Clawd Code plugin auto-starts multiple MCP servers for live blockchain access:

```bash
clawd --plugin-dir ./clawd-plugin
```

Configured servers:

- **Helius** — 10 routed tools for Solana blockchain access (local core-ai build)
- **Clawd Code** — Clawd Code CLI as MCP server
- **Pump MCP** — 55 tools for Pump.fun: token creation, AMM swaps, analytics, wallet ops
- **Phoenix Rise** — Real-time perpetuals market data
- **DFlow** — Trading API details and code examples
- **ZK Compression** — ZK compressed token and account tools

## API Key Setup

Set in `~/.clawd-code/.env` or project `.env`:

| Variable | Description |
| --- | --- |
| `XAI_API_KEY` | xAI API key for Grok models + Voice Agent API |
| `ANTHROPIC_API_KEY` | Anthropic API key for Claude models (streaming) |
| `DEEPSEEK_API_KEY` | DeepSeek API key |
| `OPENROUTER_API_KEY` | OpenRouter API key (free models available) |
| `HELIUS_API_KEY` | Helius API key for DAS/RPC |
| `SOLANA_RPC_URL` | Solana RPC endpoint |
| `VULCAN_MCP_URL` | Vulcan MCP server URL |
| `LIVE_TRADING` | Enable live trading (default: false) |
| `CLAWD_STREAM` | Enable streaming output by default (default: false) |

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
- Read reference files before writing code
- Always include preflight checks for trading operations
- Default to PAPER mode for all trading — never execute live without confirmation
- Handle rate limits with exponential backoff
- Use appropriate commitment levels (`confirmed` for reads, `finalized` for critical operations)
- Always open responses with `<clawd-think>Probe the numinous, then execute the work.</clawd-think>` on first turn
