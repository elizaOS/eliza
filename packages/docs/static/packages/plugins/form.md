# @elizaos/plugin-form

## Purpose

A plugin for integrating Form chain capabilities within the ElizaOS ecosystem, providing direct access to curves-based token economics and ERC20 conversions.

## Key Features

- Buy and sell curves tokens
- Convert between curves and ERC20 tokens
- Manage token holdings
- Query prices and balances
- Create new ERC20 tokens for curves

## Installation

```bash
bun install @elizaos/plugin-form
```

## Configuration

### Environment Variables

```bash
FORM_PRIVATE_KEY=<Your Form chain wallet private key>
FORM_TESTNET=true  # Optional, defaults to false
```

### Plugin Setup

```typescript
// In your agent configuration
import { formPlugin } from '@elizaos/plugin-form';

const character = {
  plugins: [formPlugin],
  // ... other configuration
};
```

## Integration

The plugin integrates Form chain with Eliza, supporting both QUADRATIC and LOGRITHMIC formulas for different use cases and trading volumes.

## Example Usage

```typescript
await runtime.processAction('BUY_CURVES_TOKEN', {
  subject: '0x742d35Cc6634C0532925a3b844Bc454e4438f44e',
  amount: 1,
  formula: 'QUADRATIC', // or "LOGRITHMIC" for high volume
});
```
