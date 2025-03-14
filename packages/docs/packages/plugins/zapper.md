# @elizaos/plugin-zapper

A plugin for Eliza that allows users to fetch portfolio data using the Zapper API.

## Features

- Get portfolio data from wallet addresses on [networks supported by the Zapper API](https://protocol.zapper.xyz/docs/api/supported-chains).
- Get portfolio data from addresses attached to Farcaster profiles.

## Installation

```bash
npm install @elizaos/plugin-zapper
```

## Configuration

1. Get your API key from [Zapper](https://protocol.zapper.xyz/)

2. Set up your environment variables:

```bash
ZAPPER_API_KEY=your_api_key
```

3. Register the plugin in your Eliza configuration:

```typescript
import { zapperPlugin } from "@elizaos/plugin-zapper";

// In your Eliza configuration
plugins: [
    zapperPlugin,
    // ... other plugins
];
```

## Usage

The plugin responds to natural language queries about wallet data. Here are some examples:

```plaintext
"Show me the holdings of @vitalik.eth"
"Show me the portfolio of these wallets 0xd8d...045, 0xadd...077"
"Get wallet holdings for HN7cA...WrH"
```

### Available Actions

#### portfolio

Fetch the current portfolio of provided addresses.

```typescript
// Example response format
portfolio: {
  tokenBalances: Array<{
    address: string;
    network: string;
    token: {
      balance: number;
      balanceUSD: number;
      baseToken: {
        name: string;
        symbol: string;
      };
    };
  }>;
  nftBalances: Array<{
    network: string;
    balanceUSD: number;
  }>;
  totals: {
    total: number;
    totalWithNFT: number;
    totalByNetwork: Array<{
      network: string;
      total: number;
    }>;
    holdings: Array<{
      label: string;
      balanceUSD: number;
      pct: number;
    }>;
  };
};
```

#### farcasterPortfoio

Fetch the portfolio of addresses attached to Farcaster profiles.

```typescript
// Example response format
farcasterProfile: {
username: string;
fid: number;
metadata: {
  displayName: string;
  description: string;
  imageUrl: string;
  warpcast: string;
};
connectedAddresses: string[];
custodyAddress: string;
};
```

## Development Guide
### Setting up the development environment
1. Clone the repository.
2. Install dependencies:
```bash
pnpm install
```
3. Build the plugin:
```bash
pnpm build
```

## API Reference

### Environment Variables

| Variable             | Description              | Required |
| -------------------- | ------------------------ | -------- |
| ZAPPER_API_KEY | Your Zapper API key | Yes      |

### Types

```typescript
export type ZapperPortfolioResponse = {
  data: {
    portfolio: {
      tokenBalances: Array<{
        address: string;
        network: string;
        token: {
          balance: number;
          balanceUSD: number;
          baseToken: {
            name: string;
            symbol: string;
          };
        };
      }>;
      nftBalances: Array<{
        network: string;
        balanceUSD: number;
      }>;
      totals: {
        total: number;
        totalWithNFT: number;
        totalByNetwork: Array<{
          network: string;
          total: number;
        }>;
        holdings: Array<{
          label: string;
          balanceUSD: number;
          pct: number;
        }>;
      };
    };
  };
};

export type ZapperFarcasterResponse = {
  data: {
    accounts: Array<{
      farcasterProfile: {
        username: string;
        fid: number;
        metadata: {
          displayName: string;
          description: string;
          imageUrl: string;
          warpcast: string;
        };
        connectedAddresses: string[];
        custodyAddress: string;
      };
    }>;
  };
};
```

## Links

- [Zapper API Documentation](https://protocol.zapper.xyz/docs/api/)
