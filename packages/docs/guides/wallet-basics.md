---
title: "Wallet basics"
sidebarTitle: "Wallet basics"
description: "EVM and Solana wallets in Eliza — create, import, balances, and quick troubleshooting."
---

# Wallet basics

Eliza includes **EVM** and **Solana** wallet flows. This page is a short operator checklist.

## 1. First use

- Generate or import an address from the wallet UI.
- Fund the address on-chain before expecting non-zero balances.
- Configure RPC / data provider keys when the UI or docs require them for your chain.

## 2. Handy API surfaces

- `GET /api/wallet/addresses` — list addresses
- `GET /api/wallet/balances` — balances
- `POST /api/wallet/import` — import a private key
- `POST /api/wallet/generate` — generate a new wallet

See the [REST reference](/rest/wallet) for full contracts.

## 3. Safety

- Never commit private keys or seed material to the repo or chat logs.
- Only export secrets in a trusted environment.
- Prefer least privilege and auditability for production setups.

## 4. Troubleshooting

### Balance shows zero

- Verify RPC / indexer keys (for example Alchemy or Helius) where required.
- Confirm the address received funds on the expected network.
- Retry; if it persists, check API logs for chain errors.

### Import fails

- **EVM** — private key is 64 hex digits (optional `0x` prefix).
- **Solana** — valid Base58 secret key length for the import path you use.

### Odd behavior after changing providers

- Rule out inference routing confusion first ([Cloud and provider routing](/guides/cloud-provider-routing)).
- Restart when the app prompts, then retest.

## 5. Deeper reading

- [Wallet & crypto](/guides/wallet)
- [Cloud and provider routing](/guides/cloud-provider-routing)
- [钱包基础（中文）](/zh/guides/wallet-basics)
