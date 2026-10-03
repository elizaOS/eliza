# @elizaos/plugin-wallet

Non-custodial wallet for elizaOS agents: EVM + Solana signing, x402 micropayments, CCTP bridge, Li.Fi swap/bridge routing, Jupiter routing, multi-DEX LP management, on-chain spend policies, analytics (Birdeye, DexScreener, token info), and the wallet inventory UI surface (shell page, standalone view, chat-sidebar widget).

All financial effects require runtime confirmation. Preparing or dry-running a transaction must not sign or submit it; model parameters cannot bypass the gate.

Build, test, and setup: [README.md](README.md).
