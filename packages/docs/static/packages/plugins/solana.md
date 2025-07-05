# @elizaos/plugin-solana

## Purpose

Core Solana blockchain plugin for Eliza OS that provides essential services and actions for token operations, trading, and DeFi integrations.

## Key Features

- Token Operations: Creation, transfers, balance management, portfolio analytics
- Trading Operations: Token swaps, order management, price monitoring, automated trading
- DeFi Integration: Liquidity analysis, market making, yield optimization, risk management
- Trust & Security: Trust scoring, risk assessment, performance tracking, simulation mode
- Security Features: Wallet management, permission scoping, TEE integration, trade limits

## Installation

```bash
bun install @elizaos/plugin-solana
```

## Configuration

```typescript
const solanaEnvSchema = {
  WALLET_SECRET_SALT: string(optional),
  WALLET_SECRET_KEY: string,
  WALLET_PUBLIC_KEY: string,
  SOL_ADDRESS: string,
  SLIPPAGE: string,
  SOLANA_RPC_URL: string,
  HELIUS_API_KEY: string,
  BIRDEYE_API_KEY: string,
};
```

## Integration

The plugin connects with ElizaOS through various services and actions, including TokenProvider, WalletProvider, and TrustScoreProvider, enabling token operations, swaps, transfers, and other Solana transactions.

## Example Usage

```typescript
import { solanaPlugin } from '@elizaos/plugin-solana';

// Initialize the plugin
const runtime = await initializeRuntime({
  plugins: [solanaPlugin],
});

// Execute a token swap
const result = await runtime.executeAction('EXECUTE_SWAP', {
  inputTokenSymbol: 'SOL',
  outputTokenSymbol: 'USDC',
  amount: 0.1,
});
```
