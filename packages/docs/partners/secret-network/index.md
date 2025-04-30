---
id: secret-network
title: Secret Network
description: Privacy-preserving smart contracts for Web3.
image: /img/partners/secret-network.jpg
website: https://scrt.network/
twitter: https://x.com/SecretNetwork
tags: ['Company']
hide_table_of_contents: true
---

# Secret Network

<div className="partner-logo">
  <img src="/img/partners/secret-network.jpg" alt="Secret Network logo" />
</div>

Privacy-preserving smart contracts for Web3.

## About Secret Network

Secret Network is a pioneering blockchain platform specializing in privacy-preserving smart contracts, launched in 2020 as the first Layer 1 network to enable encrypted input, output, and state for decentralized applications (dApps). Its core mission is to provide customizable privacy, allowing users and developers to control what data is shared, with whom, and for how long. Built using the Cosmos SDK and Tendermint consensus engine, Secret Network supports interoperable, scalable, and permissionless smart contracts while maintaining data confidentiality.

**Main Products/Services**:

- **Secret Contracts**: Privacy-focused smart contracts using Rust-based CosmWasm, enabling encrypted computations.
- **Secret Tokens (SNIP-20)**: Privacy-preserving fungible tokens with hidden balances and transactional data.
- **Cross-Chain Privacy**: Integration with Ethereum, Cosmos, and other chains via bridges and Inter-Blockchain Communication (IBC).
- **Decentralized Applications**: Private DeFi (e.g., SecretSwap), encrypted data storage, and non-fungible tokens (NFTs) with concealed metadata.

**Significance in Web3**:  
Secret Network addresses critical privacy gaps in blockchain by combining programmability with confidentiality, enabling use cases like credit scoring, private voting, and medical data management that are impractical on transparent networks. Its technology serves as a foundational layer for the "confidential computing" ecosystem, positioning it as a key infrastructure provider for privacy-focused AI and Web3 applications.

---

## Technology

**Technology Stack**:

- **Cosmos SDK/Tendermint**: For modular blockchain development and Byzantine Fault-Tolerant (BFT) consensus.
- **Trusted Execution Environments (TEEs)**: Intel SGX secure enclaves to isolate and encrypt data during computation.
- **Encryption Protocols**: AES-256 for on-chain data and secure key management for selective data access.
- **Interchain Connectivity**: IBC protocol for cross-chain interoperability.

**Technical Approach**:  
Secret Contracts execute within TEEs, where data is decrypted, processed, and re-encrypted without exposing it to nodes or validators. This ensures end-to-end encryption while maintaining blockchain verifiability. Users grant access via "viewing keys," allowing selective disclosure of transactional details.

**Problems Solved**:

- Mitigates risks of sensitive data exposure on public blockchains.
- Enables compliant privacy by allowing auditable data sharing.
- Supports scalable private DeFi, gaming, and AI applications.

---

## Key Features

1. **Programmable Privacy**: Customizable data-access rules for smart contracts.
2. **Cross-Chain Confidentiality**: Secure data sharing across Ethereum, Cosmos, and more.
3. **Encrypted State Management**: All contract states are encrypted by default.
4. **SNIP-20 Tokens**: Privacy-preserving fungible assets with optional auditability.
5. **TEE-Backed Security**: Hardware-level protection for decentralized computations.
6. **Viewing Keys**: User-controlled permissioning for third-party data access.
7. **Gas Efficiency**: Optimized for high throughput (up to 10,000 TPS theoretical).

---

## Integration with Eliza

While no official ElizaOS plugin has been publicly documented, the partnership likely leverages Secret Network’s privacy infrastructure to enhance Eliza’s ecosystem. Potential integrations include:

- **Private Smart Contracts**: Eliza users could deploy Secret Contracts directly via ElizaOS interfaces.
- **Confidential Data Storage**: Securely encrypt user data on-chain while maintaining Eliza’s interoperability.
- **Cross-Chain Asset Privacy**: Bridging Eliza-supported assets to Secret Network for privacy-preserving transactions.  
  Synergies focus on merging Eliza’s user-centric design with Secret’s privacy layer, enabling compliant, enterprise-grade decentralized applications.

---

## Recent Developments

- **CCL Aurora Upgrade (May 2024)**: Enhanced confidential computing capabilities for AI and large-scale data processing.
- **Privacy-as-a-Service Tools**: Launched APIs for verifiable randomness and encrypted data oracles.
- **Ecosystem Grants**: A $400 million fund accelerated projects like Shade Protocol (private stablecoins) and Blizzard Finance (DeFi).

**Public Roadmap**:

- Zero-knowledge proof integration for hybrid privacy models.
- Expanded TEE support (ARM TrustZone, AMD SEV).

---

## Market Position

**Competitors**: Oasis Network, Dusk Network, and Aleo. Secret Network differentiates with live mainnet functionality and Cosmos interoperability.  
**Key Partnerships**: Binance, Kraken, HashKey, and DeFiance Capital.  
**Adoption**: Over 50 dApps deployed, including SecretSwap (AMM) and Alter (private NFTs).

---

## Links

- **Website**: [scrt.network](https://scrt.network/)
- **Documentation**: [docs.scrt.network](https://docs.scrt.network/)
- **GitHub**: [github.com/scrtlabs](https://github.com/scrtlabs)
- **Twitter**: [@SecretNetwork](https://x.com/SecretNetwork)
- **Blog**: [Ghost Blog](https://ghost.scrt.network/)
