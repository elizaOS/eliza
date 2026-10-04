# @elizaos/plugin-wallet

Non-custodial wallet for elizaOS agents: EVM + Solana signing, x402 micropayments, CCTP
bridge, Li.Fi swap/bridge routing, Jupiter routing, multi-DEX LP management, on-chain
spend policies, analytics (Birdeye, DexScreener, token info), and the wallet inventory
UI surface (shell page, standalone view, chat-sidebar widget).

All financial writes require runtime confirmation through gateWalletFinancialExecution.
Keys remain behind WalletBackend. The root entry is server-only; import browser
components through the UI subpath. Configure the intended chain RPCs and signer before
submitting transactions.

`@elizaos/plugin-wallet/read` exposes read-only EVM balances, NFTs and DEX prices
without registering routes or loading signing services. Hosts supply resolved RPC
endpoints and provider credentials; the root barrel exports the same readers.

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd plugins/plugin-wallet build  # build
bun run --cwd plugins/plugin-wallet test   # tests
```

`@elizaos/plugin-wallet/transactions` exposes transaction operations and the shared
trade quota policy without route registration. The root exports the same symbols.
`@elizaos/plugin-wallet/watcher` owns balance-delta detection and scheduling; hosts
supply the credential-aware balance source. Trading-profile persistence and
analytics are also available through `read`; corrupt ledgers reject without
replacing the original file.
