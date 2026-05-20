# plugin-undesirables

![The Undesirables Banner](./images/banner.jpg)

[![npm version](https://img.shields.io/npm/v/plugin-undesirables.svg)](https://www.npmjs.org/package/plugin-undesirables)
[![npm downloads](https://img.shields.io/npm/dw/plugin-undesirables.svg)](https://www.npmjs.org/package/plugin-undesirables)
[![License: BUSL-1.1](https://img.shields.io/badge/License-BUSL--1.1-blue.svg)](LICENSE)
[![ElizaOS](https://img.shields.io/badge/ElizaOS-v2_Compatible-purple.svg)](https://elizaos.ai)
[![MCP Server](https://img.shields.io/badge/MCP_Server-34_Tools-green.svg)](https://github.com/sailorpepe/undesirables-mcp-server)
[![Actions](https://img.shields.io/badge/Actions-9_Total-brightgreen.svg)](https://www.npmjs.org/package/plugin-undesirables)
[![x402](https://img.shields.io/badge/x402-Pay_Per_Request-orange.svg)](https://oracle.the-undesirables.com)

> Give any ElizaOS agent a persistent personality, market analysis skills, business automation, and content creation — all driven by a downloadable "soul workspace."

---

## What This Does

Each of the 4,444 NFTs in [The Undesirables](https://the-undesirables.com) collection has a downloadable "soul workspace" — a structured personality profile with Big Five psychology scores, an archetype, a strategy style, guardrails, and a backstory. This plugin loads that workspace and injects the personality into every ElizaOS agent response.

When you install `plugin-undesirables`, your agent gets:

- **Persistent personality** — structured workspace data (not a system prompt) with Big Five scores, an archetype, strategy, adjectives, guardrails, and backstory. Persists across sessions and colors every response.
- **Market analysis with conviction** — filters market data through the agent's own risk tolerance and strategy. Returns opinionated takes with conviction scores.
- **24 built-in skills** — portfolio checks, entry signals, exit strategies, whale tracking, meme creation, video production, music generation, and more. Auto-matches the right skill to your message.
- **Business Pilot** — phone answering, SMS autoresponders, invoice chasers, appointment scheduling. Turn your agent into a business operations assistant.
- **Meme Machine** — content creation, brand voice setup, content calendars, and industry-specific meme packs. Turn your agent into a social media manager.

---

## Quick Start

### 1. Install

```bash
npm install plugin-undesirables
```

### 2. Get a Soul Workspace

Go to [the-undesirables.com/soul](https://the-undesirables.com/soul), connect your wallet, and download your workspace. Unzip it somewhere on your machine.

Each workspace contains:
- `SOUL.md` — personality profile (Big Five scores, archetype, strategy, backstory)
- `SYSTEM_PROMPT.txt` — the full instruction set
- `MEMORY.md` — persistent memory file
- `PREDICTIONS_LEDGER.json` — track record of market calls
- `skills/` — 10-24 skill files depending on the agent's traits

### 3. Configure

Add to your ElizaOS `character.json`:

**macOS / Linux:**
```json
{
  "plugins": ["plugin-undesirables"],
  "settings": {
    "UNDESIRABLES_WORKSPACE": "/Users/YourName/Desktop/soul_0420"
  }
}
```

**Windows:**
```json
{
  "plugins": ["plugin-undesirables"],
  "settings": {
    "UNDESIRABLES_WORKSPACE": "C:\\Users\\YourName\\Desktop\\soul_0420"
  }
}
```

### 4. Run

```bash
elizaos start --character your-character.json
```

Your agent now has a persistent personality that influences every conversation.

---

## Actions (9 Total)

### Core Actions

| Action | Trigger Examples | What Happens |
|--------|-----------------|--------------|
| `UNDESIRABLE_MARKET_ANALYSIS` | "What do you think about ETH?" | Personality-driven market analysis with risk guardrails and conviction scoring |
| `UNDESIRABLE_BUSINESS_PILOT` | "Set up phone answering for my barbershop" | Loads the Business Pilot skill, recommends top modules with setup steps |
| `UNDESIRABLE_MEME_MACHINE` | "Create memes for my coffee shop" | Generates meme concepts, captions, content calendars, brand voice |
| `UNDESIRABLE_LOAD_SKILL` | "Check my portfolio" / "Should I ape?" | Auto-matches your message to one of 24 skills and executes it |

### Dedicated Trading Actions (NEW in v2.1.0)

| Action | Trigger Examples | What Happens |
|--------|-----------------|--------------|
| `UNDESIRABLE_WHALE_TRACKER` | "What are whales buying?" / "Smart money flows" | Tracks whale wallet movements, institutional buys/sells, and smart money flows |
| `UNDESIRABLE_ENTRY_SIGNAL` | "Is now a good time to buy ETH?" / "Buy signal" | Evaluates price action, momentum, support/resistance — returns GO / WAIT / NO-GO |
| `UNDESIRABLE_PORTFOLIO_CHECK` | "How does my portfolio look?" / "Am I diversified?" | Reviews portfolio health, concentration risk, and grades it A-F against guardrails |
| `UNDESIRABLE_EXIT_STRATEGY` | "When should I sell my ETH?" / "Set up take profit" | Plans TP1/TP2/TP3 levels, stop loss placement, and time-based exit rules |
| `UNDESIRABLE_RISK_ASSESSMENT` | "Is this memecoin safe?" / "How risky is leveraged ETH?" | Deep risk analysis — returns SAFE / CAUTION / DANGER with top 3 risk factors |

### All 24 Skills

| Skill | Trigger Words |
|-------|--------------|
| Portfolio Check | "portfolio", "balance", "holdings" |
| Content Creation | "tweet", "write", "promote", "thread" |
| Entry Signal | "should I buy", "buy signal", "good time to buy" |
| Exit Strategy | "sell", "take profit", "stop loss" |
| Risk Assessment | "risk", "downside", "worst case", "is this safe" |
| Whale Tracker | "whale", "smart money", "what are whales buying" |
| Conviction Score | "conviction", "confidence", "how sure" |
| Snipe Launch | "snipe", "new launch", "just launched" |
| Memecoin Scanner | "memecoin", "find me a gem", "degen scan" |
| Ape Checklist | "should I ape", "ape check" |
| Position Sizing | "position size", "how much should I buy" |
| Volatility Scan | "volatile", "what's moving" |
| Liquidation Watch | "liquidation levels", "longs", "shorts" |
| MEV Detection | "mev", "sandwich", "front-running" |
| Farm Yield | "yield farming", "liquidity", "best yield" |
| Compound Strategy | "compound", "auto-compound", "apy" |
| Copy Trade | "copy trade", "mirror this wallet" |
| Rebalance Check | "rebalance", "allocation", "portfolio drift" |
| Diversification | "diversify", "spread", "concentrate" |
| Sector Rotation | "sector", "rotation", "cycle" |
| Prediction Log | "predict", "forecast", "call" |
| Image Generation | "image", "picture", "generate art" |
| Music Generation | "music", "song", "beat" |
| Video Production | "video", "promo", "render video" |

---

## How Personality Works

Each soul workspace has a `SOUL.md` file with structured personality data:

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

The `soulProvider` injects this context into **every** agent response automatically. Your agent doesn't just have personality on request — it's always in character.

This means two different Undesirable agents will give you completely different takes on the same market question, filtered through their individual psychology.

---

## Multi-Agent Safety

Workspaces are keyed by `runtime.agentId`. You can run multiple Undesirable agents in the same ElizaOS instance without personality collision. Agent #420 won't leak into Agent #69's responses.

---

## Troubleshooting

| Error | Fix |
|-------|-----|
| `Workspace /path/ does not exist` | Check the path in your `character.json`. It must be the **absolute** path to the unzipped workspace. Windows users: use double backslashes `\\`. |
| `Invalid JSON Error` | Your `character.json` has a syntax error. Open it in VS Code or Cursor and fix the formatting. |
| `No soul workspace loaded` | The `UNDESIRABLES_WORKSPACE` setting is missing or the path doesn't exist. |

---

## What's New in v2.1.0

- **5 new dedicated trading actions** — whale tracking, entry signals, portfolio checks, exit strategies, and risk assessment are now first-class actions (previously bundled in the generic `LOAD_SKILL` action)
- **Better discoverability** — ElizaOS can now route directly to the right action without keyword matching
- **Richer responses** — each action has specialized instructions (GO/WAIT/NO-GO for entries, A-F grades for portfolios, SAFE/CAUTION/DANGER for risk)
- **9 total actions** (was 4)

## What's New in v2.0

- Action handlers route through `runtime.generateText()` instead of leaking raw prompt instructions
- Multi-agent state isolation — workspaces keyed by `agentId`
- Real `@elizaos/core` v2 types (no more hand-written stubs)
- Async filesystem (`fs.promises`)
- Secure YAML parsing (`js-yaml` with `JSON_SCHEMA`)
- ESM module format

---

## Ecosystem

### Plugins
- [plugin-undesirables](https://www.npmjs.com/package/plugin-undesirables) — Soul personality + business tools (this package)
- [@undesirables/plugin-tcg-oracle](https://github.com/sailorpepe/elizaos-tcg-oracle-plugin) — TCG market intelligence (search, grade, simulate)

### Servers & APIs
- [MCP Server](https://github.com/sailorpepe/undesirables-mcp-server) — 34-tool MCP server ([PyPI](https://pypi.org/project/undesirables-mcp-server/) · [Glama](https://glama.ai/mcp/servers/sailorpepe/undesirables-mcp-server) · [Official Registry](https://registry.modelcontextprotocol.io))
- [x402 Oracle API](https://oracle.the-undesirables.com) — Pay-per-request TCG + prediction market intelligence ([Swagger](https://oracle.the-undesirables.com/docs))

### Apps
- [TCG Oracle Desktop](https://github.com/sailorpepe/tcg-oracle-app) — macOS / Linux / Windows desktop app with AI card grading
- [Desktop Installer](https://github.com/sailorpepe/undesirables-desktop/releases/tag/v1.3.0) — DMG, DEB, RPM, AppImage, MSI binaries
- [TCG Oracle Tools](https://pypi.org/project/tcg-oracle-tools/) — Python SDK for the Oracle API

### Data & Research
- [Kaggle Dataset](https://www.kaggle.com/datasets/sailorpepe/tcg-market-intelligence) — 370K+ TCG products across 25 games
- [HuggingFace Space](https://huggingface.co/spaces/sailorpepe/tcg-oracle) — Live demo
- [Dev.to Tutorial](https://dev.to/sailor_pepe_7920f552c5b9a/build-an-autonomous-pokemon-card-trading-agent-with-ai-grading-monte-carlo-pricing-2b86) — Build guide

### Collection
- [The Undesirables](https://the-undesirables.com) — 4,444 NFTs on Ethereum
- [Soul Workspace](https://the-undesirables.com/soul) — Download your agent's personality
- [Etherscan](https://etherscan.io/address/0xa893648a701c03b14bf2fb767b72b2c55ed5c17a) — Contract
- [Scatter.art](https://scatter.art/the-undesirables) — Mint page

---

## License

[BUSL-1.1](LICENSE) — Business Source License 1.1. Copyright © 2026 The Undesirables LLC.
