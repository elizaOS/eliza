---
id: sonic-svm
title: Sonic SVM
description: High-performance Solana Virtual Machine implementation.
image: /img/partners/sonic-svm.jpg
website: https://www.sonic.game/
twitter: https://x.com/SonicSVM
tags: ['Company']
hide_table_of_contents: true
---

# Sonic SVM

<div className="partner-logo">
  <img src="/img/partners/sonic-svm.jpg" alt="Sonic SVM logo" />
</div>

High-performance Solana Virtual Machine implementation.

## About Sonic SVM

Sonic SVM operates as the first **chain extension** on Solana, designed to process millions of transactions per second for games and social apps while settling finality on Solana’s Layer-1. Its flagship product, **SonicX**, is the industry’s first TikTok-integrated Web3 app layer, enabling click-to-earn mechanics for 1.5 billion TikTok users.

Key offerings include:

- **Game-specific rollups** for sovereign in-game economies
- **HyperGrid Framework**: A concurrent scaling system for horizontal throughput expansion
- **Atomic interoperability** with Solana’s base layer

The project has raised $29.35M total funding, including a $12M Series A led by Bitkraft Ventures, at a $100M fully diluted valuation.

---

## Technology

Sonic SVM’s stack combines three core innovations:

1. **HyperGrid Architecture**

   - Processes transactions in parallel across node grids
   - Achieves sub-second finality through optimistic rollups
   - Scales linearly by adding node clusters

2. **SVM Atomic Execution**

   - Directly accesses Solana’s state without re-deploying programs
   - Inherits Solana’s security and liquidity pools

3. **EVM ↔ SVM Interpreter**
   - Enables EVM dApps to deploy natively on Solana
   - Supports cross-chain asset bridging via WASM runtime

This solves critical gaps in blockchain gaming: high latency (~400ms vs Solana’s 2-3s), throughput limits (1M+ TPS per game shard), and development friction between EVM/SVM ecosystems.

---

## Key Features

- **Ultra-low latency**: 400ms transaction finality for real-time gameplay
- **Atomic composability**: Shared liquidity with Solana DeFi protocols
- **Game engine SDKs**: Unity/Unreal plugins for on-chain entity-component systems
- **TikTok App Layer**: Native support for viral social media integrations
- **Hybrid rollups**: Optimistic execution with ZK-proof finalization
- **Gasless model**: Developers subsidize fees via session keys
- **Modular DA**: Store game state off-chain with on-chain settlement

---

## Integration with Eliza

While no official ElizaOS plugin repository exists publicly, technical synergies emerge in:

1. **Shared VM Infrastructure**

   - ElizaOS smart contracts can deploy directly on Sonic SVM
   - Cross-chain calls via HyperGrid’s Inter-Blockchain Communication (IBC)

2. **Performance Enhancements**

   - Eliza dApps leverage Sonic’s 1M TPS capacity for high-frequency use cases
   - Shared staking mechanisms between $ELIZA and $SONIC

3. **User Experience**
   - Single-signer wallet integration across both platforms
   - Unified NFT standards for cross-platform asset portability

The partnership aims to position ElizaOS as the default interface for Sonic’s gaming vertical.

---

## Recent Developments

- **Jan 2025**: Launched $SONIC token on OKX/Bybit with 6.35x ROI for IEO participants
- **Dec 2024**: Completed 50,000-node sale for network validators
- **Oct 2024**: Rolled out SonicX TikTok layer to 2M+ active wallets
- **Q4 2024**: Partnered with 40+ game studios including Triple-A publishers

Upcoming milestones:

- Q2 2025: HyperGrid V2 with zk-Coprocessors
- Q3 2025: SVM-compatible Ethereum L2 testnet

---

## Market Position

**Competitive Edge**:

- 10x faster than Arbitrum Nitro for gaming apps
- 1/5th the cost of Immutable X for NFT minting

Strategic partners include:

- **TikTok** (SonicX integration)
- **Backpack Exchange** (primary liquidity pool)
- **Magic Eden** (cross-chain NFT marketplace)

With 2M+ MAUs and $13.3M in node sales, Sonic leads Solana’s SVM ecosystem alongside Eclipse and SOON.

---

## Links

- [Website](https://www.sonic.game/)
- [HyperGrid Documentation](https://docs.sonic.game/hypergrid)
- [Twitter](https://x.com/SonicSVM)
- [Tokenomics](https://gov.sonic.game/tokenomics)

_No public GitHub repositories for ElizaOS plugins discovered in official channels as of April 2025._
