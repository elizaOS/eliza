# @elizaos/plugin-solana-agent-kit

A plugin that integrates Solana Agent Kit functionality into Eliza, enabling token operations, swaps, lending, and staking on Solana.

## Installation

```bash
pnpm add @elizaos/plugin-solana-agent-kit
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

### Token Operations
- Create new tokens with custom parameters
- Transfer tokens between addresses
- Get token information and metadata
- Manage token supply and decimals

### DeFi Operations
- Swap tokens using Jupiter aggregator
- Lend assets on supported platforms
- Stake tokens
- Create GibWork tasks

## Usage Examples

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

### Lending
```plaintext
"Lend 100 USDC"
```

### Staking
```plaintext
"Stake 100 tokens"
```

### GibWork Tasks
```plaintext
"Create a GibWork task for building a Solana dApp, offering 100 USDC"
```

## Dependencies

- @coral-xyz/anchor: 0.30.1
- @solana/spl-token: 0.4.9
- @solana/web3.js: 1.95.8
- solana-agent-kit: ^1.2.0
- bignumber.js: 9.1.2

## Technical Details

### Security Features
- TEE mode support for secure key derivation
- Multiple key format support (base58, base64)
- Public key verification

### Address Management
- Supports both public key and full keypair operations
- Base58 and base64 private key formats
- TEE-based key derivation when enabled

For more information about Solana Agent Kit capabilities, see [solana-agent-kit documentation](https://github.com/solana-labs/agent-kit).
