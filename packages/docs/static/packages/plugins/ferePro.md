# @elizaos/plugin-ferepro

## Purpose

A plugin for enabling WebSocket communication with FerePro API to provide AI-driven market insights within the ElizaOS ecosystem.

## Key Features

- Real-time WebSocket communication
- Streaming and non-streaming response support
- Market data analysis and comparisons
- Cryptocurrency insights
- Debug mode for detailed responses
- Automatic connection management
- Comprehensive error handling
- Credit tracking and management

## Installation

```bash
bun install @elizaos/plugin-ferepro
```

## Configuration

### Required Environment Variables

- FEREAI_USER_ID: FereAI User ID
- FEREAI_API_KEY: FereAI API key
- REQUEST_TIMEOUT (Optional): Number of milliseconds before a request times out

## Integration

The plugin enables real-time communication with the FerePro API through WebSocket connections within the ElizaOS ecosystem.

## Example Usage

```typescript
// Get top cryptocurrencies
'What are the top 5 cryptocurrencies?';

// Compare specific cryptocurrencies
'Compare Ethereum and Bitcoin for the past 6 months';

// Get historical performance
'Compare top 3 coins against Bitcoin in the last 3 months';
```

## Links

- [FereAI Website](https://www.fereai.xyz/)
- [FereAI Agents Documentation](https://docs.fereai.xyz/docs/product/ai-versions)
