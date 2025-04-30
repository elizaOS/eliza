---
id: gelato
title: Gelato
description: Web3 infrastructure for automated smart contract execution.
image: /img/partners/gelato.jpg
website: https://www.gelato.network/
twitter: https://x.com/gelatonetwork
tags: ['Company']
hide_table_of_contents: true
---

# Gelato

<div className="partner-logo">
  <img src="/img/partners/gelato.jpg" alt="Gelato logo" />
</div>

Web3 infrastructure for automated smart contract execution.

## About Gelato

Gelato operates as Web3's decentralized backend, providing essential middleware for smart contract automation. Their platform enables developers to create self-executing contracts that react to predefined on-chain/off-chain conditions without maintaining infrastructure. Key offerings include:

- **Automate**: Multi-chain smart contract scheduler executing transactions based on time intervals, price thresholds, or custom logic
- **Relay**: Gasless transaction infrastructure with sponsored meta-transactions
- **Web3 Functions**: Serverless cloud environment connecting smart contracts to external APIs
- **Rollup-as-a-Service (RaaS)**: 1-click deployment of customized ZK/OP rollups with built-in automation

As the market leader controlling 78% of decentralized automation, Gelato processes millions of transactions monthly for 500+ projects including Aave, Uniswap, and MakerDAO.

## Technology

Gelato's architecture combines off-chain coordination with on-chain verification:

- **Executor Network**: Decentralized node operators execute tasks using a slot-based system to prevent gas auctions
- **Resolver Contracts**: On-chain validation of custom logic before execution
- **Meta-Transactions**: ERC-2771 compliant gas abstraction
- **Multi-Chain Support**: Unified API across 40+ EVM chains including Ethereum, Polygon, Arbitrum

Key technical differentiators include time-trigger automation down to 15-second intervals, cross-chain task management, and integrated AA wallet support through Safe compatibility.

## Key Features

- 1. **Dynamic Fee Model**: 0.9% fee on transaction value with $0.10 minimum
- 2. **No-Code Automation**: Web UI for creating recurring payments/notifications
- 3. **Hybrid Triggers**: Combine on-chain events with Web2 API data
- 4. **Gas Optimization**: Batch transactions & EIP-1559 fee market awareness
- 5. **Security Model**: 12-hour fraud proof window with slashing conditions
- 6. **Dedicated Rollups**: Gelato Chains offer 400ms block times with WASM compatibility
- 7. **Enterprise SLA**: 99.9% uptime guarantee for premium users

## Integration with Eliza

The partnership enables two core synergies:

1. **AI Agent Transactions**: ElizaOS AI agents leverage Gelato Relay for gasless multichain operations, demonstrated in the @inkonchain squid protocol integration
2. **Automated Workflows**:
   - Time-based agent memory updates via Cron triggers
   - Oracle-powered execution using Web3 Functions
   - Cross-chain state synchronization between Eliza instances

Developers can access Gelato's automation stack through Eliza's plugin architecture using the `@elizaos/gelato-adapter` SDK, enabling features like:

```typescript
eliza.createAutomation({
  chain: 'arbitrum',
  triggerType: 'price-feed',
  threshold: '1500',
  action: 'swapExactETHForTokens',
});
```

## Recent Developments

- **Jan 2025**: Gelato Relay integrated into ElizaOS core infrastructure
- **Q4 2024**: Launched Gelato Chains - customizable rollups with native AA
- **Q3 2024**: Expanded to 50M monthly transactions across 40+ chains
- **Roadmap**: Fully decentralized executor network (Q2 2025), ZK coprocessor integration (Q3 2025)

## Market Position

**Competitive Landscape**:  
| Feature | Gelato | Chainlink Automation |
|-----------------------|-------------------|----------------------|
| Supported Chains | 40+ EVM | 15 EVM |
| Minimum Interval | 15 seconds | 1 hour |
| Gasless Option | Native | Requires 3rd Party |
| Pricing Model | % + Fixed | Pure Gas |

Key partnerships with Safe (AA wallets), Redstone (oracles), and ETHGlobal (developer ecosystem). Gelato-powered contracts secure $4.2B TVL across DeFi protocols.

## Links

- [Website](https://www.gelato.network)
- [Documentation](https://docs.gelato.network)
- [GitHub](https://github.com/gelatodigital)
- [Twitter](https://x.com/gelatonetwork)
- [Developer Portal](https://app.gelato.network)
