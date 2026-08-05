# Clawd Code

Curl-installable Solana-native AI coding CLI with local wallet creation and
paper-gated perpetuals workflows.

`clawd-code` is a headless command-line agent for generating TypeScript/Solana
code, checking perps market workflows, creating local Solana keypairs, and
running research/image/voice modes from one binary.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/Solizardking/solana-clawd/main/clawd-code/install.sh | sh
```

The installer checks for Node.js 18+, installs the `clawd-code` binary, and
creates `~/.clawd-code/.env` if one does not already exist.

> **Note:** The xAI Voice Agent (`clawd-code voice --agent`) requires Node.js 22+ for native WebSocket support.

Manual install:

```bash
git clone https://github.com/Solizardking/solana-clawd.git
cd solana-clawd/clawd-code
cp .env.example ~/.clawd-code/.env
npm install
npm run build
npm link
```

## Quick Start

```bash
clawd-code code "Build a Jupiter swap bot in TypeScript"
clawd-code wallet create
clawd-code wallet list
clawd-code perps
clawd-code funding
clawd-code trade "funding rate on SOL perps"
clawd-code research --agents 16 "Solana perps funding arb"
clawd-code repl
clawd-code arena status
```

## Commands

| Command | Purpose |
| --- | --- |
| `clawd-code code "<prompt>"` | Generate TypeScript/Solana code (streaming with `--stream`) |
| `clawd-code trade "<intent>"` | Run perps market, paper trade, and position workflows |
| `clawd-code wallet create [name]` | Create a local Solana keypair |
| `clawd-code wallet list` | List local wallet public keys |
| `clawd-code perps` | Show perps dashboard |
| `clawd-code funding` | Show funding-rate dashboard |
| `clawd-code research "<prompt>"` | Run multi-agent research (streaming with `--stream`) |
| `clawd-code image "<prompt>"` | Generate images when configured |
| `clawd-code voice "<text>"` | Generate voice via local TTS or xAI Voice Agent API |
| `clawd-code voice --agent` | Real-time Solana voice agent (requires `XAI_API_KEY`, Node 22+) |
| `clawd-code repl` | Interactive multi-turn conversation REPL |
| `clawd-code arena <subcommand>` | Agent Arena — on-chain identity, discovery, reputation |
| `clawd-code verify` | Run environment checks |

Slash aliases such as `clawd-code /wallet create` and `clawd-code /perps` still
work for compatibility.

## Configuration

Runtime configuration lives in `~/.clawd-code/.env`. Start from
[.env.example](./.env.example).

| Variable | Description | Default |
| --- | --- | --- |
| `CLAWD_PROVIDER` | AI provider: `xai`, `anthropic`, `openrouter`, or `deepseek` | `xai` |
| `CLAWD_MODEL` | Model used by the selected provider | `grok-4.20-multi-agent` |
| `XAI_API_KEY` | xAI API key for Grok models + Voice Agent API | empty |
| `ANTHROPIC_API_KEY` | Anthropic API key for Claude models (streaming) | empty |
| `DEEPSEEK_API_KEY` | DeepSeek API key | empty |
| `OPENROUTER_API_KEY` | OpenRouter API key (free models supported) | empty |
| `CLAWD_STREAM` | Enable streaming output by default | `false` |
| `SOLANA_RPC_URL` | Solana RPC endpoint | mainnet-beta |
| `HELIUS_API_KEY` | Optional Helius key for RPC/DAS workflows | empty |
| `VULCAN_MCP_URL` | Vulcan MCP server URL | `http://localhost:3001` |
| `LIVE_TRADING` | Enables live trading path when true | `false` |
| `OPERATOR_CONFIRMED` | Required operator acknowledgement for live trading | `false` |
| `PERPS_SIM_ONLY` | Keeps perps execution simulated | `true` |

Never commit `.env`, wallet files, API keys, private keys, or generated outputs.
The repository ignore rules exclude `.env`, `.clawd/`, `node_modules/`,
`dist/`, and `outputs/`.

## Wallets

```bash
clawd-code wallet create
clawd-code wallet create trader-1
clawd-code wallet list
```

Wallets are stored as Solana CLI-compatible keypair JSON files under
`~/.clawd-code/wallets` with `0600` permissions. Treat those files like private
keys.

## Perps Safety

Perps workflows default to paper mode. Live trading requires all of these:

```bash
LIVE_TRADING=true
OPERATOR_CONFIRMED=true
PERPS_SIM_ONLY=false
```

The trade mode also applies local preflight constraints such as allowed symbols,
maximum notional, maximum leverage, and maximum spread. Review the code and your
configuration before enabling live execution.

## AI Providers

Clawd Code supports four AI providers with unified streaming:

| Provider | Alias | Models | Streaming |
| --- | --- | --- | --- |
| `xai` | *(default)* | `grok-4.3`, `grok-4.20-multi-agent` | blocking |
| `anthropic` | `claude`, `ant` | `claude-sonnet-4-6`, `claude-opus-4-8`, `claude-haiku-4-5-20251001` | native SSE |
| `openrouter` | `or` | `nex-agi/nex-n2-pro:free` + any OR model | native SSE |
| `deepseek` | `ds` | `deepseek-v4-pro`, `deepseek-v4-flash` | blocking |

```bash
# Stream code generation with Claude
clawd-code code --provider anthropic --stream "Build an Anchor staking program"

# Use free OpenRouter model
clawd-code code --provider openrouter "Review this TypeScript"

# Switch provider for session
clawd-code /provider anthropic

# List all models
clawd-code /models
```

## Interactive REPL

```bash
clawd-code repl
```

An interactive multi-turn conversation session. Dot commands:

| Command | Action |
| --- | --- |
| `.mode code\|research\|trade\|general` | Switch conversation mode |
| `.provider xai\|anthropic\|openrouter\|deepseek` | Switch AI provider |
| `.model <id>` | Switch model mid-session |
| `.clear` | Clear message history |
| `.history` | Print conversation history |
| `.help` | Show all dot commands |
| `.exit` / `.quit` | End session |

## xAI Voice Agent

Real-time Solana voice interactions powered by `grok-voice-think-fast-1.0` via the xAI Voice Agent API. Requires `XAI_API_KEY` and Node.js 22+.

```bash
# Start voice agent REPL (text I/O over WebSocket)
clawd-code voice --agent

# Choose a voice persona (eve, ara, rex, sal, leo)
clawd-code voice --agent --voice ara

# Pin to a specific model
clawd-code voice --agent --model grok-voice-think-fast-1.0
```

Built-in Solana function tools:

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

## Agent Arena

Clawd Code integrates the [Cheshire Terminal](https://cheshireterminal.ai) Agent Arena — on-chain AI agent identity via Metaplex Core NFTs on Solana with ATOM reputation, Google A2A + Anthropic MCP discovery cards, and $CLAWD payment verification.

```bash
# Check API health
clawd-code arena health

# Mint your agent NFT (costs ~0.01 SOL in tx fees)
clawd-code arena mint --wallet <YOUR_SOLANA_PUBKEY> --name "My Agent"

# Register capabilities, A2A and MCP cards
clawd-code arena register \
  --wallet <YOUR_PUBKEY> \
  --a2a https://my-agent.com/a2a \
  --mcp https://my-agent.com/mcp \
  --capabilities trading,research,solana

# Fetch any agent's profile
clawd-code arena fetch <assetAddress>

# Submit a verified review (requires $CLAWD payment proof)
clawd-code arena review <assetAddress> \
  --tx <txSignature> \
  --from <yourWallet> \
  --score 95

# View stored on-chain identity
clawd-code arena status
```

| Subcommand | Description |
| --- | --- |
| `arena health` / `arena ping` | Check Cheshire Terminal API health |
| `arena mint` | Mint agent NFT on Solana mainnet |
| `arena register` | Register capabilities + A2A/MCP discovery cards |
| `arena fetch <addr>` | Fetch any agent's on-chain profile |
| `arena review <addr>` | Submit a verified ATOM reputation review |
| `arena status` / `arena identity` | Show your stored on-chain identity |

After minting, identity is saved to `~/.clawd-code/arena-identity.json` with `0600`
permissions. Identity scheme: `svm://solana-mainnet/<metaplex-core-asset-address>`.

$CLAWD mint: `8cHzQHUS2s2h8TzCmfqPKYiM4dSt4roa3n7MyRLApump`

## Development

```bash
npm install
npm run build
npm test
npm audit
npm pack --dry-run
```

Project layout:

```text
clawd-code/
├── install.sh
├── package.json
├── README.md
├── LICENSE
├── clawd.json
├── src/
│   ├── cli.ts
│   ├── commands.ts
│   ├── wallet.ts
│   └── modes/
└── tsconfig.json
```

## Release Contents

The npm package allowlist includes only:

- `dist/`
- `install.sh`
- `README.md`
- `LICENSE`
- `.env.example`
- `clawd.json`

Local runtime files and secrets are intentionally excluded.

## License

MIT. See [LICENSE](./LICENSE).
