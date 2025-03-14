# @elizaos/plugin-form

A plugin for integrating Form chain capabilities within the ElizaOS ecosystem, providing direct access to curves-based token economics and ERC20 conversions.

## Description

[Form Chain](https://form.network/) is a blockchain platform that implements curves-based token economics, allowing users to interact with bonding curves for token creation, trading, and management. This plugin integrates Form chain with Eliza, giving your agent the ability to:

- Buy and sell curves tokens
- Convert between curves and ERC20 tokens
- Manage token holdings
- Query prices and balances
- Create new ERC20 tokens for curves

The plugin supports both QUADRATIC and LOGRITHMIC formulas, optimizing for different use cases and trading volumes.

## Installation

```bash
pnpm install @elizaos/plugin-form
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
import { formPlugin } from "@elizaos/plugin-form";

const character = {
    plugins: [formPlugin],
    // ... other configuration
};
```

## Actions

### BUY_CURVES_TOKEN
Buy curves tokens for a subject address.
```typescript
await runtime.processAction("BUY_CURVES_TOKEN", {
    subject: "0x742d35Cc6634C0532925a3b844Bc454e4438f44e",
    amount: 1,
    formula: "QUADRATIC"  // or "LOGRITHMIC" for high volume
});
```

### SELL_CURVES_TOKEN
Sell curves tokens back to the protocol.
```typescript
await runtime.processAction("SELL_CURVES_TOKEN", {
    subject: "0x742d35Cc6634C0532925a3b844Bc454e4438f44e",
    amount: 1,
    formula: "QUADRATIC"
});
```

### WITHDRAW_CURVES_TOKEN
Convert curves tokens to their ERC20 equivalent.
```typescript
await runtime.processAction("WITHDRAW_CURVES_TOKEN", {
    subject: "0x742d35Cc6634C0532925a3b844Bc454e4438f44e",
    amount: 1,
    formula: "QUADRATIC"
});
```

### DEPOSIT_CURVES_TOKEN
Convert ERC20 tokens back to curves.
```typescript
await runtime.processAction("DEPOSIT_CURVES_TOKEN", {
    subject: "0x742d35Cc6634C0532925a3b844Bc454e4438f44e",
    amount: "1000000000000000000", // 1 token in 18 decimals
    formula: "QUADRATIC"
});
```

### MINT_CURVES_ERC20
Mint new ERC20 token for curves holdings.
```typescript
await runtime.processAction("MINT_CURVES_ERC20", {
    name: "My Token",
    symbol: "MTK",
    formula: "QUADRATIC"
});
```

### GET_CURVES_BALANCE
Check curves token balance.
```typescript
await runtime.processAction("GET_CURVES_BALANCE", {
    subject: "0x742d35Cc6634C0532925a3b844Bc454e4438f44e",
    formula: "QUADRATIC"
});
```

### GET_CURVES_BUY_PRICE
Get price quote for buying curves.
```typescript
await runtime.processAction("GET_CURVES_BUY_PRICE", {
    subject: "0x742d35Cc6634C0532925a3b844Bc454e4438f44e",
    amount: 1,
    formula: "QUADRATIC"
});
```

### GET_CURVES_SELL_PRICE
Get price quote for selling curves.
```typescript
await runtime.processAction("GET_CURVES_SELL_PRICE", {
    subject: "0x742d35Cc6634C0532925a3b844Bc454e4438f44e",
    amount: 1,
    formula: "QUADRATIC"
});
```

## Formula Selection

The plugin supports two bonding curve formulas:

### QUADRATIC

- Default formula for standard operations
- Suitable for personal and small group usage
- Balanced price impact

### LOGRITHMIC

- Optimized for high volume trading
- Better price stability
- Recommended for large-scale operations

## Best Practices
### Security

- Store private keys securely using environment variables
- Never expose keys in code or commits
- Validate addresses before transactions
- Check balances before operations

### Performance

- Use caching for repeated price checks

Trading

- Always check price quotes before trading
- Use appropriate formula for volume
- Monitor price impact

## Error Handling
The plugin provides detailed error messages for common issues:
```typescript
try {
    await runtime.processAction("BUY_CURVES_TOKEN", {...});
} catch (error) {
    if (error.message.includes("insufficient balance")) {
        // Handle insufficient funds
    } else if (error.message.includes("price impact too high")) {
        // Handle excessive price impact
    }
}
```

## Contributing
This plugin is part of the ElizaOS project. See the main project repository Contributing Guide for details.

## License
This plugin is part of the ElizaOS project. See the main project repository for license information.
