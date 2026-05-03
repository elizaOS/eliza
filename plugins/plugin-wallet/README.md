# @elizaos/plugin-wallet

Unified non-custodial wallet for elizaOS agents. Replaces the legacy fan-out across `plugin-evm`, `plugin-solana`, `plugin-raydium`, `plugin-orca`, `plugin-meteora`, `plugin-jupiter`, `plugin-lp-manager`, `plugin-clanker`, and the former `elizaos-plugin-agentwallet` stub with one canonical action+provider surface governed by [`docs/architecture/wallet-and-trading.md`](../../../docs/architecture/wallet-and-trading.md).

## Surface

The plugin exposes **10 canonical planner-visible actions**:

| Action | Purpose |
|--------|---------|
| `TRADE` | Open positions, swap, bridge. Discriminated by `kind`: `perp` (Hyperliquid), `prediction` (Polymarket), `spot` / `swap` (Li.Fi on EVM, Jupiter on Solana), `bridge` (Li.Fi / CCTP). |
| `MANAGE_POSITION` | Close, modify, cancel orders. |
| `QUERY_MARKET` | Read-only price / depth / funding / chart / news / sentiment. No wallet required. |
| `QUERY_PORTFOLIO` | Balances, positions, P&L, history. |
| `LEND` | Supply / borrow / repay / withdraw on Aave or Morpho. |
| `MANAGE_LP` | Open / close / collect / rebalance LP positions. EVM (Uniswap V3, Aerodrome) + Solana (Raydium, Orca Whirlpools, Meteora DLMM) behind one surface. |
| `TRANSFER` | Move value to an arbitrary external address. EVM + Solana. Always policy-checked. |
| `SET_AUTOMATION` | DCA, threshold triggers, P&L exits. |
| `MANAGE_AUTOMATION` | List / pause / resume / delete automations. |
| `MINT` | Token launches via Clanker on Base. |

These dispatch into **typed providers** (one per venue / data source). Adding a new venue means adding a provider, **not** a new planner verb.

## Wallet abstraction

Two backends behind `WalletBackend`:

- **`LocalEoaBackend`** — desktop default. EOA private keys hydrated from the OS keychain. Optional ERC-6551 token-bound account mode (via the bundled SDK at `./sdk`) for on-chain spend policy enforcement.
- **`StewardBackend`** — cloud + mobile default. Multi-tenant Steward service is the only custody primitive in cloud. No fallback to local.

See `src/wallet/` for interface and impls. `ELIZA_WALLET_BACKEND=local|steward|auto` selects at runtime.

## Layout

```
src/
  index.ts                  # Plugin export
  plugin.ts                 # Plugin object: actions + providers + services
  sdk/                      # Lifted from agent-wallet-sdk (ERC-6551, x402, CCTP, swap, escrow, identity, multi-token, payment router)
  wallet/                   # WalletBackend interface + LocalEoa + Steward
  policy/                   # PolicyModule (local + steward bridge)
  providers/                # Canonical providers (one per venue / data source)
  actions/                  # Canonical actions (TRADE, MANAGE_POSITION, ...)
  audit/                    # Append-only hash-chained audit log
```

The `sdk/` subtree carries forward primitives from [agent-wallet-sdk](https://github.com/up2itnow0822/agent-wallet-sdk) (MIT). See `SDK-LICENSE`. The wallet/policy/providers/actions/audit subtrees implement the canonical architecture in the spec.

## Migration status

This plugin is being built incrementally. Tracked phases:

- **Phase 0** — interfaces (`WalletBackend`, `CanonicalProvider`, `CanonicalAction`, `PolicyModule`, audit log schema, failure-code unions).
- **Phase 1** — backend impls + `@elizaos/plugin-wallet` composes legacy `plugin-evm` + `plugin-solana`; migrate call sites to consume `WalletBackend` only.
- **Phase 2** — provider lifts (13+ providers).
- **Phase 3** — canonical action implementations.
- **Phase 4** — approval-queue surface (SSE + decision endpoint + tray + Capacitor bridge).
- **Phase 5** — EVM + Solana chain implementations live under `src/chains/`; migrate remaining callsites to `WalletBackend` only; expand test coverage.

See `docs/architecture/wallet-and-trading.md` §I for the dependency graph.

## License

MIT. Source code under `src/sdk/` originates from [agent-wallet-sdk](https://github.com/up2itnow0822/agent-wallet-sdk) (MIT, attribution preserved in `SDK-LICENSE`).
