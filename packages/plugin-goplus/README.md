# @elizaos/plugin-goplus

A plugin that enables on-chain security checks through the GoPlus API integration.

## Installation

```bash
pnpm add @elizaos/plugin-goplus
```

## Configuration

### Required Environment Variables

```env
GOPLUS_API_KEY=your_api_key  # Required: GoPlus API key for authentication
```

## Usage

Add the plugin to your character configuration:

```typescript
import { goplusPlugin } from "@elizaos/plugin-goplus";

const character = {
    plugins: [goplusPlugin]
};
```

## Features

### Security Checks

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

The plugin supports various networks including:
- Ethereum (1)
- BSC (56)
- Polygon (137)
- Arbitrum (42161)
- Avalanche (43114)
- Optimism (10)
- Base (8453)
- And many more (see specific check types for supported networks)

## Security Check Types

### Token Security
- `EVMTOKEN_SECURITY_CHECK`: ERC20 token contract security analysis
- `SOLTOKEN_SECURITY_CHECK`: SPL token security verification
- `SUITOKEN_SECURITY_CHECK`: Sui token contract analysis

### Contract & NFT Security
- `RUGPULL_SECURITY_CHECK`: Rugpull risk detection
- `NFT_SECURITY_CHECK`: NFT contract security analysis
- `APPROVAL_SECURITY_CHECK`: Smart contract approval analysis

### Account & Address Security
- `ADRESS_SECURITY_CHECK`: Malicious address detection
- `ACCOUNT_ERC20_SECURITY_CHECK`: ERC20 token security
- `ACCOUNT_ERC721_SECURITY_CHECK`: NFT asset security
- `ACCOUNT_ERC1155_SECURITY_CHECK`: Multi-token asset security

### Additional Checks
- `SIGNATURE_SECURITY_CHECK`: Signature verification
- `URL_SECURITY_CHECK`: Phishing and malicious URL detection

## Dependencies

- @elizaos/core: workspace:*
- ws: ^8.18.0
