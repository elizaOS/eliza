# @elizaos/plugin-solana-agent-kit

## Purpose

A plugin that integrates Solana Agent Kit functionality into Eliza, enabling token operations, swaps, lending, and staking on Solana.

## Installation

```bash
bun add @elizaos/plugin-solana-agent-kit
```

## Configuration

### Required Environment Variables

```env
# Required: Either private key or public key
SOLANA_PRIVATE_KEY=your_private_key
# OR
SOLANA_PUBLIC_KEY=your_public_key

# Optional: Custom RPC URL (defaults to mainnet)
SOLANA_RPC_URL=your_rpc_url

# Required for TEE mode
WALLET_SECRET_SALT=your_salt  # Only if TEE_MODE is enabled
```

## Features

- **Token Operations**: Create tokens, transfer tokens, get token information, manage token supply
- **DeFi Operations**: Swap tokens via Jupiter, lend assets, stake tokens, create GibWork tasks

## Example Usage

### Token Creation

```plaintext
"Create token, name is Example Token, symbol is EXMPL, decimals is 9"
```

### Token Transfers

```plaintext
"Send 69 EZSIS to <wallet_address>"
```

### Token Swaps

```plaintext
"Swap 0.1 SOL for USDC"
```

## Dependencies

- @coral-xyz/anchor: 0.30.1
- @solana/spl-token: 0.4.9
- @solana/web3.js: 1.95.8
- solana-agent-kit: ^1.2.0
- bignumber.js: 9.1.2

## Links

[solana-agent-kit documentation](https://github.com/solana-labs/agent-kit)
