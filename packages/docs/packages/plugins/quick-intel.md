# @elizaos/plugin-quickintel

A plugin for performing token security audits and market analysis within the ElizaOS ecosystem.

## Description

This plugin enables comprehensive token security analysis using QuickIntel's API, combined with market data from DexScreener. It supports multiple chains and address formats, providing detailed security assessments and market insights in natural language responses.

## Installation

```bash
pnpm install @elizaos/plugin-quickintel
```

## Configuration

### Environment Variables

```typescript
QUICKINTEL_API_KEY=<Your QuickIntel API Key>
```

### Client Configuration

Add the plugin to your character.json file:

```json
{
    "name": "YourCharacter",
    "plugins": ["quickintel"],
    "settings": {
        "QUICKINTEL_API_KEY": "your-api-key-here"
    }
}
```

## Usage

### Basic Integration

```typescript
import { quickIntelPlugin } from "@elizaos/plugin-quickintel";
```

### Example Usage

The plugin processes natural language queries for token audits:

```typescript
"Can you check if this token is safe? 0x742d35Cc6634C0532925a3b844Bc454e4438f44e on BSC"
"Analyze this token on Ethereum: 0x1234..."
"Is this Solana token safe? Hep4ZQ3MSSXFuLnT4baBFVBrC3677ntjrfaqE9zEt4rX"
```

### Supported Features

- Multi-chain support (EVM chains, Solana, etc.)
- Comprehensive security analysis
- Market data integration
- Natural language responses
- Detailed risk assessments

## API Reference

### Actions

#### Audit Token Action

Performs security audits and market analysis on tokens.

**Response Type:**

```typescript
interface AuditResponse {
    success: boolean;
    data: {
        audit: any;    // QuickIntel audit data
        market?: any;  // DexScreener market data
    };
    params: {
        chain: string;
        tokenAddress: string;
    };
}
```

### Supported Chains

The plugin supports all chains available through QuickIntel, including:
- Ethereum (ETH)
- BNB Smart Chain (BSC)
- Polygon
- Arbitrum
- Avalanche
- Solana
- Full list available at https://docs.quickintel.io/quick-intel-scanner/supported-chains
- And many more...

## Common Issues & Troubleshooting

1. **API Issues**
   - Verify API key is correct
   - Check API endpoint accessibility
   - Ensure proper network connectivity

2. **Chain/Address Detection**
   - Ensure chain name is clearly specified (e.g., "on ETH")
   - Verify token address format
   - Check chain support in QuickIntel

3. **Market Data**
   - DexScreener data might be unavailable for some tokens
   - Some chains might have different market data availability
   - Liquidity information may vary by chain

## Security Best Practices

1. **API Configuration**
   - Store API key securely
   - Use environment variables
   - Implement proper error handling

2. **Response Handling**
   - Validate audit results
   - Handle timeouts gracefully
   - Process market data carefully

```

## Future Enhancements

- Enhanced market data analysis
- Historical audit tracking
- Custom audit templates
- Comparative analysis features

## Contributing

Contributions are welcome! Please see the main Eliza repository for contribution guidelines.

## Credits

This plugin integrates with:

- [QuickIntel](https://quickintel.io): Token security audit platform
- [DexScreener](https://dexscreener.com): DEX market data provider

Special thanks to:
- The QuickIntel team for their security analysis platform
- The DexScreener team for market data access
- The Eliza community for feedback and testing

## License

This plugin is part of the Eliza project. See the main project repository for license information.