# @elizaos/plugin-avalanche

## Purpose

A plugin for interacting with the Avalanche blockchain network within the ElizaOS ecosystem, enabling comprehensive DeFi operations including token transfers, YAK swaps, yield strategy management, and token creation.

## Installation

```bash
bun install @elizaos/plugin-avalanche
```

## Configuration

The plugin requires the following environment variable:

```typescript
AVALANCHE_PRIVATE_KEY=<Your Avalanche private key>
```

## Key Features

1. Token Transfers

   - Send native AVAX and ERC20 tokens
   - Support for multiple token standards
   - Built-in address validation

2. YAK Swaps

   - Decentralized token swaps
   - Automatic best path finding
   - Slippage protection (default: 0.2%)

3. Yield Strategies

   - Deposit tokens into yield-generating strategies
   - Support for multiple strategies (YAK staking, USDC Benqi, etc.)

4. Token Mill
   - Create new tokens
   - Configure custom tokenomics
   - Automatic market creation

## Example Usage

### Token Transfer

```typescript
'Send 10 AVAX to 0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7';
'Transfer 100 USDC to [address]';
```

### YAK Swap

```typescript
'Swap 1 AVAX for USDC';
'Swap 10 USDC for gmYAK';
```

### Yield Strategy

```typescript
'Deposit 1 USDC into the strategy';
'Deposit 10 gmYAK to earn yield';
```

### Token Creation

```typescript
"Create a new memecoin called 'Test Token' with the symbol 'TEST'";
```

## Links

- [Avalanche Documentation](https://docs.avax.network/)
- [YAK Protocol Docs](https://yak.exchange/docs)
- [Benqi Documentation](https://docs.benqi.fi/)
- [Token Mill Guide](https://docs.tokenmill.xyz/)
