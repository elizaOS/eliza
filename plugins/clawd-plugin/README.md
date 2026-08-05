# Clawd Code Plugin for Clawd Code

Build on Solana with Clawd Code — one install gives you live blockchain tools, expert coding patterns, perpetuals trading, x402 payments, and autonomous agent commerce.

## Install

### From a marketplace

```
/plugin marketplace add solizardking/clawd-plugins
/plugin install clawd-code@solizardking
```

### Local testing

```bash
clawd --plugin-dir ./clawd-code/clawd-plugin
```

## What's Included

**Helius MCP Server** — auto-starts with the plugin. 10 routed tools covering DAS API, RPC, webhooks, streaming, wallet analysis, and docs.

**Clawd Code MCP Server** — auto-starts the Clawd Code CLI as an MCP server for code generation, trading, research, images, and voice.

**Phoenix Rise MCP Server** — auto-starts for real-time perpetuals orderbook and funding rate data.

**DFlow MCP Server** — auto-starts for trading API details, response schemas, and code examples.

### Skills

| Skill | Invoke | What It Does |
|---|---|---|
| **Clawd Code** | `/clawd:code` | Makes your agent an expert at using the Clawd Code CLI — 5 modes (code, trade, research, image, voice), wallet ops, perps workflows |
| **Build** | `/clawd:build` | Makes your agent an expert Solana developer — Helius APIs, routing logic, SDK patterns |
| **DFlow** | `/clawd:dflow` | Makes your agent an expert at building Solana trading apps — DFlow swaps, prediction markets, KYC |
| **Phantom** | `/clawd:phantom` | Makes your agent an expert at building frontend dApps — Phantom Connect SDK, token gating, NFT minting |
| **Jupiter** | `/clawd:jupiter` | Makes your agent an expert at building DeFi apps — Jupiter swaps, lending, limit orders, DCA |
| **SVM** | `/clawd:svm` | Solana protocol expert — architecture, consensus, execution engine |

### Reference Files

Deep documentation bundled with each skill covering DAS API, Sender, Priority Fees, Webhooks, WebSockets, LaserStream, Wallet API, Enhanced Transactions, Onboarding, Clawd Code CLI usage, perps workflows, wallet operations, DFlow spot trading/prediction markets, Phantom SDKs, Jupiter APIs, and SVM architecture.

## API Key Setup

Set in `~/.clawd-code/.env`:

```bash
XAI_API_KEY=your-xai-key
HELIUS_API_KEY=your-helius-key
SOLANA_RPC_URL=https://mainnet.helius-rpc.com/?api-key=your-helius-key
```

## Usage

Once installed, just ask questions in plain English:

- "Build a Jupiter swap bot in TypeScript"
- "What's the funding rate on SOL perps?"
- "Research the latest AI agent frameworks"
- "Generate an image of a cyberpunk Solana trading desk"
- "What NFTs does this wallet own?"
- "Create wallet and show me my balance"
- "Set up webhooks to monitor my wallet"
- "Parse this transaction: 5abc..."

Your agent picks the right tools and reads the right reference files automatically.

## License

MIT. See [LICENSE](./LICENSE).

## Links

- [Clawd Code on GitHub](https://github.com/Solizardking/solana-clawd/tree/main/clawd-code)
- [x402 Protocol](https://x402.wtf)
- [Helius Documentation](https://www.helius.dev/docs)
