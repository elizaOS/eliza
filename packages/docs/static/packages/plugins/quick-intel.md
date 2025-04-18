# @elizaos/plugin-quickintel

## Purpose

A plugin for performing token security audits and market analysis within the ElizaOS ecosystem.

## Key Features

- Multi-chain support (EVM chains, Solana, etc.)
- Comprehensive security analysis
- Market data integration
- Natural language responses
- Detailed risk assessments

## Installation

```bash
bun install @elizaos/plugin-quickintel
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

## Integration

Processes natural language queries for token audits across multiple chains, combining QuickIntel's API for security analysis with market data from DexScreener.

## Example Usage

```typescript
'Can you check if this token is safe? 0x742d35Cc6634C0532925a3b844Bc454e4438f44e on BSC';
'Analyze this token on Ethereum: 0x1234...';
'Is this Solana token safe? Hep4ZQ3MSSXFuLnT4baBFVBrC3677ntjrfaqE9zEt4rX';
```

## Links

https://docs.quickintel.io/quick-intel-scanner/supported-chains
