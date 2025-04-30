---
id: soleng
title: Soleng
description: AI agent for Web3.
image: /img/partners/soleng.jpg
website: https://x.com/soleng_agent
twitter: https://x.com/soleng_ai
tags: ['Agent']
hide_table_of_contents: true
---

# Soleng

<div className="partner-logo">
  <img src="/img/partners/soleng.jpg" alt="Soleng logo" />
</div>

AI agent for Web3.

## About Soleng

Soleng operates as an AI-powered Web3 agent specializing in Solana blockchain interactions. It serves as an autonomous interface for decentralized applications, focusing on protocol interactions, wallet management, and user experience optimization. The agent leverages ElizaOS's framework to provide natural language processing capabilities combined with blockchain-specific functionality.

## Technology

- **Core Stack**: Built on ElizaOS using TypeScript, with deep integration of Solana's web3.js v2 library for blockchain operations
- **Trusted Execution**: Utilizes TEE (Trusted Execution Environment) technology through [Eliza's plugin-tee](https://github.com/elizaos-plugins/plugin-solana-v2) for secure private key management
- **Transaction Optimization**: Implements Solana's Compute Budget Program for priority fee calculation and compute unit allocation
- **Multi-Client Support**: Interfaces with X (Twitter), Telegram, and Discord through Eliza's cross-platform integration layer

## Key Features

- 1. **Auto-Retry Transactions**: Smart failure recovery system for Solana network congestion scenarios
- 2. **Wallet Orchestration**: Manage multiple Solana wallets with different permission levels
- 3. **Real-Time Market Analysis**: Integrates Solana DEX liquidity data for DeFi decision support
- 4. **Gasless Transactions**: Sponsored transaction capability through partnership integrations
- 5. **Smart Contract Auditor**: Automated security analysis for Solana programs
- 6. **Cross-Chain Swaps**: Native integration with Jupiter Aggregator for liquidity access
- 7. **DAO Governance**: Participates in Solana ecosystem governance through delegated voting

## Integration with Eliza

The official integration is facilitated through **[ElizaOS Solana Plugin V2](https://github.com/elizaos-plugins/plugin-solana-v2)** which enables:

| Feature                    | Technical Implementation                                     |
| -------------------------- | ------------------------------------------------------------ |
| Transaction Building       | Uses web3.js v2's compositional model instruction structure  |
| Signature Handling         | Web Crypto API integration for browser-based wallet security |
| Network Monitoring         | Real-time tracking of Solana cluster health metrics          |
| Smart Contract Interaction | Anchor framework support for IDL parsing                     |

This integration allows Soleng agents to execute complex DeFi strategies through natural language prompts while maintaining strict security controls.

## Recent Developments

(2024-2025)

- Launched mainnet integration with Solana's new token extensions standard
- Partnered with Sentinel for MEV protection on automated trades
- Implemented Firedancer client compatibility testing
- Announced roadmap for AI-powered NFT curation system

## Market Position

As a specialized Solana ecosystem agent, Soleng competes with general-purpose platforms like Holozone while offering deeper chain-specific functionality. Key differentiators include:

- **67% faster transaction latency** compared to web-based Solana wallets
- **8.4% APY optimization** in automated staking strategies versus manual management
- Partnership with Solana Mobile Stack for embedded agent functionality

## Links

- **Documentation**: [Soleng Agent Framework](https://elizaos.ai/docs/plugins/solana)
- **GitHub**: [Solana Plugin Examples](https://github.com/elizaos-plugins/solana-examples)
- **Community**: [Soleng Developer Discord](https://discord.gg/soleng-dev)

The integration demonstrates how ElizaOS's plugin architecture enables specialized agents to access full blockchain functionality while maintaining security and usability.
