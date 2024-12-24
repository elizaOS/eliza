# Eliza Birdeye Plugin

A powerful plugin for Eliza that integrates with Birdeye's comprehensive DeFi and token analytics API. This plugin provides real-time access to blockchain data, token metrics, and DeFi analytics across multiple networks.

## Features

- **DeFi Analytics**

    - Real-time price and trading data
    - Historical price tracking
    - OHLCV (Open, High, Low, Close, Volume) data
    - Trade analysis for tokens and pairs

- **Token Intelligence**

    - Comprehensive token metadata
    - Security information
    - Token holder analytics
    - Mint and burn tracking
    - Market trends and new listings

- **Wallet Analysis**

    - Multi-chain portfolio tracking
    - Token balance monitoring
    - Transaction history analysis
    - Cross-chain analytics

- **Market Research**
    - Gainers and losers tracking
    - Trending tokens
    - Top trader analysis
    - Market pair analytics

## Installation

```bash
npm install @eliza/plugin-birdeye
```

## Configuration

Add the following to your Eliza configuration:

```typescript
import { BirdeyePlugin } from "@eliza/plugin-birdeye";

export default {
    plugins: [
        new BirdeyePlugin({
            apiKey: "YOUR_BIRDEYE_API_KEY",
        }),
    ],
};
```

## Environment Variables

```
BIRDEYE_API_KEY=your_api_key_here
```

## Usage

Once configured, the plugin provides access to Birdeye data through Eliza's interface.

## API Reference

The plugin provides access to all Birdeye API endpoints through structured interfaces. For detailed API documentation, visit [Birdeye's API Documentation](https://public-api.birdeye.so).

## License

MIT

## Contributing

Contributions are welcome! Please read our contributing guidelines before submitting pull requests.
