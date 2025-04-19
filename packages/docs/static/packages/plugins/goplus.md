# @elizaos/plugin-goplus

## Purpose

A plugin that enables on-chain security checks through the GoPlus API integration.

## Installation

```bash
bun add @elizaos/plugin-goplus
```

## Configuration

### Required Environment Variables

```env
GOPLUS_API_KEY=your_api_key  # Required: GoPlus API key for authentication
```

## Integration

Add the plugin to your character configuration:

```typescript
import { goplusPlugin } from '@elizaos/plugin-goplus';

const character = {
  plugins: [goplusPlugin],
};
```

## Key Features

- EVM Token Security
- Solana Token Security
- Sui Token Security
- Rugpull Detection
- NFT Security Analysis
- Address Security Verification
- Contract Approval Analysis
- Account Token Analysis (ERC20/721/1155)
- Signature Security
- URL/DApp Security

## Supported Networks

The plugin supports various networks including Ethereum (1), BSC (56), Polygon (137), Arbitrum (42161), Avalanche (43114), Optimism (10), Base (8453), and many more.
