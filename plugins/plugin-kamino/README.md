# @elizaos/plugin-kamino

> Kamino Finance integration for [elizaOS](https://elizaos.ai) — lend, borrow, repay, and manage DeFi positions on Solana through natural language.

## Overview

`plugin-kamino` connects your elizaOS agent to [Kamino Finance](https://kamino.finance), the leading Solana lending and liquidity protocol. Once installed, your agent can execute on-chain lending operations, report live market rates, and monitor collateral health — all from a conversation.

## Features

| Feature | What it does |
|---------|-------------|
| **Lend / Supply** | Supply tokens to Kamino to earn yield |
| **Lend Withdraw** | Redeem supplied tokens back to your wallet |
| **Deposit Collateral** | Deposit tokens as collateral to enable borrowing |
| **Withdraw Collateral** | Withdraw deposited collateral from an obligation |
| **Borrow** | Borrow tokens against deposited collateral |
| **Repay** | Repay outstanding loans (supports "repay max") |
| **Market Rates** | Live APY, liquidity, and LTV data injected into every response |
| **Position Health** | Check health factor, LTV, borrow limit, and liquidation risk |

## Installation

```bash
# npm
npm install @elizaos/plugin-kamino

# bun
bun add @elizaos/plugin-kamino
```

## Configuration

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `SOLANA_RPC_URL` | ✅ | Solana RPC endpoint (mainnet recommended: Helius, QuickNode, Triton) |
| `SOLANA_PRIVATE_KEY` | ✅ | Base58-encoded private key of the wallet the agent will sign with |
| `SOLANA_WS_URL` | ⬜ | WebSocket endpoint for tx confirmations. Auto-derived from `SOLANA_RPC_URL` if not set. Set explicitly for local validators (e.g. `ws://127.0.0.1:8900`) |
| `SOLANA_KEYPAIR_PATH` | ⬜ | Path to a Solana keypair JSON file (alternative to `SOLANA_PRIVATE_KEY`) |
| `KAMINO_MARKETS` | ⬜ | JSON array of custom markets to load. Defaults to Kamino's Main market |
| `KAMINO_REFRESH_MS` | ⬜ | Reserve data refresh interval in milliseconds (default: `30000`) |

Copy `.env.example` and fill in your values:

```bash
cp .env.example .env
```

### Character File

Add the plugin to your agent's character JSON. `@elizaos/plugin-bootstrap` is required for the action system to work:

```json
{
  "name": "MyAgent",
  "plugins": [
    "@elizaos/plugin-bootstrap",
    "@elizaos/plugin-openrouter",
    "@elizaos/plugin-kamino"
  ],
  "settings": {
    "modelProvider": "openrouter",
    "model": "google/gemini-2.5-flash"
  }
}
```

> Any elizaOS-compatible model provider works (OpenAI, Anthropic, Google, Groq, etc.). Replace `@elizaos/plugin-openrouter` with your preferred provider plugin.

## Actions

### `KAMINO_LEND`
Supply tokens to Kamino's lending market to earn yield.

**Trigger phrases:**
- `"Lend 100 USDC"`
- `"Supply 5 SOL for yield"`
- `"Earn yield on my USDT"`

---

### `KAMINO_LEND_WITHDRAW`
Redeem previously supplied (lent) tokens back to your wallet.

**Trigger phrases:**
- `"Withdraw 50 USDC from lending"`
- `"Redeem all my SOL supply"`
- `"Take back my supplied USDT"`

---

### `KAMINO_DEPOSIT`
Deposit tokens as collateral into a Kamino obligation. Required before borrowing.

**Trigger phrases:**
- `"Deposit 1 SOL as collateral"`
- `"Put 100 USDC as collateral on Kamino"`

---

### `KAMINO_WITHDRAW`
Withdraw deposited collateral from an obligation.

**Trigger phrases:**
- `"Withdraw my SOL collateral"`
- `"Remove 50 USDC collateral"`
- `"Take out all my collateral"`

---

### `KAMINO_BORROW`
Borrow tokens against deposited collateral.

**Trigger phrases:**
- `"Borrow 200 USDC"`
- `"Take a loan of 0.5 SOL"`
- `"Get a loan from Kamino"`

---

### `KAMINO_REPAY`
Repay outstanding borrowed tokens. Supports full repayment.

**Trigger phrases:**
- `"Repay 100 USDC"`
- `"Payback 0.5 SOL"`
- `"Repay max USDT"` / `"Repay all my USDC debt"`

---

### `KAMINO_RESERVES`
List all available reserves with live supply APY, borrow APY, available liquidity, and LTV.

**Trigger phrases:**
- `"Show me available reserves"`
- `"What can I borrow on Kamino?"`
- `"List Kamino markets"`

---

### `KAMINO_HEALTH`
Check your current position health — health factor, LTV, borrow limit, and liquidation risk across all obligations.

**Trigger phrases:**
- `"How is my position?"`
- `"Am I at risk of liquidation?"`
- `"Show me my loans"`
- `"What's my health factor?"`

## Market Data Provider

The plugin injects live Kamino market data into every LLM context automatically via the `KAMINO_MARKET` provider. This means the agent can answer market questions (`"What's the best yield on Solana right now?"`) without explicitly triggering an action.

## Custom Markets

By default, the plugin loads Kamino's **Main market** (`7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF`). You can override this with `KAMINO_MARKETS`:

```env
KAMINO_MARKETS=[{"name":"main","address":"7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF"},{"name":"jlp","address":"DxXdAyU3kCjnyggvHmY5nAwg5cRbbmdyX3npfDMjjMek"}]
```

## REST API

The plugin exposes a health-check endpoint:

```
GET /api/status
→ { "status": "ok", "plugin": "plugin-kamino", "timestamp": "..." }
```

## Security

- The agent's private key has full signing authority. Use a **dedicated wallet** with only the funds you intend the agent to manage.
- Never commit your `.env` file. Add it to `.gitignore`.
- For production deployments, use a secrets manager or encrypted environment variables.

## Requirements

- Node.js ≥ 24 / Bun
- elizaOS ≥ 1.7.0
- A funded Solana wallet (SOL for transaction fees + tokens to lend/borrow)
- A Solana RPC endpoint (Helius, QuickNode, Triton, or any Solana-compatible provider)

## License

MIT
