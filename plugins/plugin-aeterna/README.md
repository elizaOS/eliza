# @elizaos/plugin-aeterna
### MEV-Protected Autonomous Execution & Intent Netting for Eliza Agents on Base

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![NPM](https://img.shields.io/badge/npm-@netswap__protocol/agent--wallet-green.svg)](https://www.npmjs.com/package/@netswap_protocol/agent-wallet)

This plugin equips Eliza agents with private intent netting and MEV-shielded liquidity execution on Base Mainnet, saving 1% to 3% on swap slippage and preventing mempool sandwich bot exploitation.

---

## Features
- **0% Sandwich Slippage:** Uses peer-to-peer intent batch netting before routing to public DEXes.
- **Pre-execution Simulation:** Prevents wasted gas on reverted swaps.
- **Autonomous Portfolio Rebalancing:** Balances agent treasury according to target asset weights.

---

## Configuration

In your `character.json`:

```json
{
  "name": "DeFiAlphaAgent",
  "plugins": ["@elizaos/plugin-aeterna"],
  "settings": {
    "secrets": {
      "AETERNA_AGENT_PRIVATE_KEY": "0x..."
    }
  }
}
```

---

## Actions Provided
1. `EXECUTE_PROTECTED_SWAP`: Executes private, slippage-shielded token swaps on Base.
2. `REBALANCE_AGENT_PORTFOLIO`: Audits agent balances and calculates protected rebalancing routes.

---

## Upstream Documentation
- SDK: [@netswap_protocol/agent-wallet](https://www.npmjs.com/package/@netswap_protocol/agent-wallet)
- Architecture: [Aeterna Agent OS](https://github.com/DIABLOX23/netswap-bot)
