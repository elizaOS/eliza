# plugin-undesirables

![The Undesirables Banner](./images/banner.jpg)

[![npm version](https://img.shields.io/npm/v/plugin-undesirables.svg)](https://www.npmjs.org/package/plugin-undesirables)
[![npm downloads](https://img.shields.io/npm/dw/plugin-undesirables.svg)](https://www.npmjs.org/package/plugin-undesirables)
[![License: BUSL-1.1](https://img.shields.io/badge/License-BUSL--1.1-blue.svg)](LICENSE)
[![elizaOS](https://img.shields.io/badge/elizaOS-v2_Compatible-purple.svg)](https://elizaos.ai)
[![MCP Server](https://img.shields.io/badge/MCP_Server-35+_Tools-green.svg)](https://github.com/sailorpepe/undesirables-mcp-server)
[![x402](https://img.shields.io/badge/x402-Oracle_API-orange.svg)](https://oracle.the-undesirables.com)

> Personality-as-Code for elizaOS agents. Live market data from 370K+ indexed products. Zero config required.

---

## What This Does

`plugin-undesirables` gives any elizaOS agent a structured personality, live TCG market data, and 26 specialized skills — with zero configuration required.

Install the plugin, and your agent immediately gets:

- **A working personality** — a demo soul loads automatically. NFT holders get their unique AI identity.
- **Live market data** — real product prices from 370K+ indexed TCG products, injected into every relevant conversation.
- **26 skills** — market analysis, portfolio checks, entry signals, exit strategies, risk assessment, content creation, and more.
- **Passive market intelligence** — an evaluator that detects card/market topics and enriches the agent's context with live pricing data automatically.

---

## Architecture

The Undesirables ecosystem has three tiers. The plugin is the free entry point.

```
┌─────────────────────────────────────────────────────────┐
│  PLUGIN (npm install plugin-undesirables)                │
│  Free — no keys, no wallets, no payments                 │
│                                                          │
│  ✓ Demo soul (loads automatically, zero config)          │
│  ✓ All 26 skills                                         │
│  ✓ 9 personality-driven actions                          │
│  ✓ Live Oracle data (search + daily market snapshot)     │
│  ✓ Passive market intelligence evaluator                 │
│  ✓ NFT holder souls (unique personality + memory)        │
├──────────────────────────────────────────────────────────┤
│  ORACLE API (oracle.the-undesirables.com)                │
│  Paid — x402 micropayments, USDC on Base                 │
│                                                          │
│  $0.10  AI card grading (PSA/Beckett via vision model)   │
│  $0.015 Monte Carlo price simulation (Heston/Merton/Kou) │
│  $0.05  NFT floor price oracle + forecast                │
│  $0.05  Token price simulation (CoinGecko + Monte Carlo) │
│  $1.00  Cross-platform prediction market arbitrage       │
│  $0.50  Multi-outcome basket arbitrage                   │
│  $0.25  Weather derivatives edge scanning                │
├──────────────────────────────────────────────────────────┤
│  MCP SERVER (pip install undesirables-mcp-server)        │
│  Local — runs on your machine, 35+ tools                 │
│                                                          │
│  Full tool suite for Claude, Cursor, or any MCP client.  │
│  All processing happens locally. Nothing leaves your     │
│  machine unless you configure external API access.       │
└─────────────────────────────────────────────────────────┘
```

The plugin provides free personality and data. The Oracle API provides paid computational intelligence. The MCP server provides local tool access. Each tier works independently.

---

## Quick Start

### Option A: Zero Config (Demo Soul)

```bash
npm install plugin-undesirables
```

Add to your elizaOS `character.json`:

```json
{
  "plugins": ["plugin-undesirables"]
}
```

That's it. Your agent loads a demo personality with all 26 skills and live Oracle data. No wallet, no API key, no workspace download needed.

### Option B: NFT Holder (Unique Soul)

If you own an Undesirable NFT, download your soul workspace from [the-undesirables.com](https://the-undesirables.com) and point the plugin to it:

```json
{
  "plugins": ["plugin-undesirables"],
  "settings": {
    "UNDESIRABLES_WORKSPACE": "/path/to/your/soul_workspace"
  }
}
```

Your agent gets a unique personality derived from your NFT's visual traits — Big Five psychology scores, an archetype, a strategy style, persistent memory, and a predictions ledger. No two souls are alike.

---

## What's Included

### Providers (2)

| Provider | What It Does |
|----------|-------------|
| `undesirables-oracle` | Fetches live product prices from 370K+ indexed TCG products and daily market snapshots. Triggers automatically when the conversation mentions cards, prices, or market topics. |
| `undesirables-soul` | Injects the agent's personality context into every response. Loads demo soul by default or the NFT holder's unique soul when configured. |

### Evaluators (1)

| Evaluator | What It Does |
|-----------|-------------|
| `UNDESIRABLE_MARKET_INTELLIGENCE` | Runs passively on every message. When the conversation touches TCG card topics, it auto-enriches the agent's context with live pricing from the Oracle API. The agent becomes market-aware without anyone explicitly asking. |

### Actions (9)

| Action | What It Does |
|--------|-------------|
| `UNDESIRABLE_MARKET_ANALYSIS` | Personality-driven market analysis with conviction scoring and risk guardrails |
| `UNDESIRABLE_BUSINESS_PILOT` | AI business automation — phone answering, SMS, invoicing, scheduling |
| `UNDESIRABLE_MEME_MACHINE` | Content creation — meme concepts, brand voice, content calendars |
| `UNDESIRABLE_LOAD_SKILL` | Routes user messages to the best-matching skill from the 24 available |
| `UNDESIRABLE_WHALE_TRACKER` | Whale wallet movement analysis and smart money flow tracking |
| `UNDESIRABLE_ENTRY_SIGNAL` | Entry evaluation — GO / WAIT / NO-GO with support/resistance levels |
| `UNDESIRABLE_PORTFOLIO_CHECK` | Portfolio health assessment with A–F rating and concentration risk |
| `UNDESIRABLE_EXIT_STRATEGY` | Exit planning — TP1/TP2/TP3 levels, stop losses, time-based rules |
| `UNDESIRABLE_RISK_ASSESSMENT` | Risk rating 1–10 with SAFE / CAUTION / DANGER verdict |

### Skills (26)

All 26 skills are available to every user — demo and NFT holder alike.

| Category | Skills |
|----------|--------|
| **Trading** | Market Analysis, Entry Signal, Exit Strategy, Conviction Score, Position Sizing |
| **Portfolio** | Portfolio Check, Rebalance Check, Diversification, Sector Rotation |
| **Risk** | Risk Assessment, Volatility Scan, Liquidation Watch, MEV Detection |
| **DeFi** | Farm Yield, Compound Strategy, Snipe Launch, Memecoin Scanner, Ape Checklist |
| **Social** | Whale Tracker, Copy Trade, Prediction Log |
| **Content** | Content Creation, Image Generation, Music Generation, Video Production, Meme Machine |

---

## Access Model

| Feature | Demo (Free) | NFT Holder |
|---------|:-----------:|:----------:|
| All 26 skills | ✓ | ✓ |
| Live Oracle data | ✓ | ✓ |
| Market intelligence evaluator | ✓ | ✓ |
| All 9 actions | ✓ | ✓ |
| **Unique personality** | — | ✓ |
| **Persistent memory** | — | ✓ |
| **Predictions ledger** | — | ✓ |
| **Custom voice & archetype** | — | ✓ |

Skills are the distribution. Personality is the NFT value.

- **4,444** total souls on Ethereum
- **273** minted
- **4,171** unclaimed at [scatter.art/the-undesirables](https://scatter.art/the-undesirables)

---

## How Personality Works

Each soul workspace contains a `SOUL.md` with structured personality data:

```yaml
name: "Doña Crypto"
archetype: "The Oracle"
strategy: "Long-term accumulation with high conviction"
adjectives: ["analytical", "patient", "contrarian"]
openness: 82
conscientiousness: 91
extraversion: 34
agreeableness: 45
neuroticism: 28
```

The `undesirables-soul` provider injects this context into **every** agent response. Two different Undesirable agents will give completely different takes on the same question, filtered through their individual psychology.

Workspaces are keyed by `runtime.agentId`. Multiple Undesirable agents can run in the same elizaOS instance without personality collision.

---

## Security

| Measure | Implementation |
|---------|---------------|
| Path traversal protection | `getSafePath()` validates boundaries + resolves symlinks via `fs.realpathSync` |
| YAML injection | Parsed with `js-yaml` `JSON_SCHEMA` (no function execution). `__proto__`, `constructor`, `prototype` keys stripped. |
| Prompt isolation | Skill content wrapped with security warning — treated as inert reference material |
| Oracle fetch | 8-second timeout via `AbortSignal`, `redirect: "error"` prevents SSRF |
| Error handling | LLM failures return safe user-facing message — no prompt context leaked |
| Multi-agent safety | Workspace state keyed by `agentId` — no cross-agent state leakage |

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| `Workspace /path/ does not exist` | Check the path in your `character.json`. Must be an absolute path. Windows: use double backslashes `\\`. |
| No personality detected | If no `UNDESIRABLES_WORKSPACE` is set, the demo soul loads automatically. Check the console for `🐸` log messages. |
| Oracle data not appearing | The Oracle provider triggers on TCG-related keywords. Try asking about a specific card by name. |

---

## Ecosystem

### Plugins & SDKs
- **[plugin-undesirables](https://www.npmjs.com/package/plugin-undesirables)** — elizaOS personality + market data (this package)
- **[undesirables-mcp-server](https://pypi.org/project/undesirables-mcp-server/)** — 35+ tool MCP server ([GitHub](https://github.com/sailorpepe/undesirables-mcp-server) · [Glama](https://glama.ai/mcp/servers/sailorpepe/undesirables-mcp-server) · [Official MCP Registry](https://registry.modelcontextprotocol.io))
- **[tcg-oracle-tools](https://pypi.org/project/tcg-oracle-tools/)** — Python SDK for the Oracle API

### APIs
- **[Oracle API](https://oracle.the-undesirables.com)** — x402 pay-per-request intelligence ([Swagger Docs](https://oracle.the-undesirables.com/docs))

### Apps
- **[TCG Oracle Desktop](https://github.com/sailorpepe/undesirables-desktop/releases)** — macOS, Linux, Windows installer with AI card grading UI

### Data & Research
- **[Kaggle Dataset](https://www.kaggle.com/datasets/sailorpepe/tcg-market-intelligence)** — 370K+ TCG products across 25 games
- **[Dev.to Tutorial](https://dev.to/sailor_pepe_7920f552c5b9a/build-an-autonomous-pokemon-card-trading-agent-with-ai-grading-monte-carlo-pricing-2b86)** — Build guide

### Collection
- **[The Undesirables](https://the-undesirables.com)** — 4,444 AI agents on Ethereum
- **[Scatter.art](https://scatter.art/the-undesirables)** — Mint page
- **[Etherscan](https://etherscan.io/address/0xa893648a701c03b14bf2fb767b72b2c55ed5c17a)** — Contract

---

## License

[BUSL-1.1](LICENSE) — Business Source License 1.1. Copyright © 2026 The Undesirables LLC.
