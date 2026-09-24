# @elizaos/plugin-wallet

Non-custodial wallet for elizaOS agents: EVM + Solana signing, x402 micropayments, CCTP
bridge, Li.Fi swap/bridge routing, Jupiter routing, multi-DEX LP management, on-chain
spend policies, analytics (Birdeye, DexScreener, token info), and the wallet inventory
UI surface (shell page, standalone view, chat-sidebar widget).

All financial writes require runtime confirmation through gateWalletFinancialExecution.
Keys remain behind WalletBackend. The root entry is server-only; import browser
components through the UI subpath. Configure the intended chain RPCs and signer before
submitting transactions.

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd plugins/plugin-wallet build  # build
bun run --cwd plugins/plugin-wallet test   # tests
```
