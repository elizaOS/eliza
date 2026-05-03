# DeFi News Plugin

A comprehensive plugin for the Spartan AI agent that provides DeFi and cryptocurrency market data, news, and analytics.

## Features

### 1. Global DeFi Market Data
- DeFi market capitalization
- Trading volume (24h)
- DeFi/ETH ratio
- DeFi dominance percentage
- Top DeFi coin statistics

### 2. Global Crypto Market Data
- Active cryptocurrencies count
- Total market capitalization
- 24h trading volume
- Market cap changes
- Top coins by market dominance

### 3. Token-Specific Data
- Real-time price information
- Market cap and trading volume
- Price change percentages (24h, 7d, 30d)
- Community statistics (Twitter, Reddit, Telegram)
- Developer activity (GitHub stars, forks, PRs)
- Token description and metadata

### 4. DEX Liquidity Analytics
- Trading pairs across multiple DEXes
- Pool analytics and liquidity data
- Trust scores and volume metrics
- Real-time price feeds

### 5. OHLCV Chart Data
- Open, High, Low, Close, Volume data
- Multiple timeframes support
- Historical data for trend analysis

### 6. Real-World News & Events
- Latest cryptocurrency news from Brave New Coin
- DeFi-specific updates
- Blockchain technology news
- Price predictions and market analysis
- Technical analysis and trading insights

## Installation

### 1. Prerequisites

This plugin uses the CoinGecko service from the **analytics plugin**. Make sure:
- The analytics plugin is loaded **before** the defi-news plugin in your configuration
- The CoinGecko API key is configured in your environment

### 2. Environment Variables

Create or update your `.env` file with the following API key:

```bash
# CoinGecko API Key (shared with analytics plugin)
COINGECKO_API_KEY=your_coingecko_api_key_here
```

#### Getting API Keys

**CoinGecko:**
1. Visit [CoinGecko API](https://www.coingecko.com/en/api)
2. Sign up for a free account
3. Get your API key from the dashboard
4. Note: This API key is shared with the analytics plugin

**News Source:**
- The plugin uses the free Brave New Coin RSS feed - no API key required!

### 3. Register the Plugin

Add the plugin to your Spartan agent configuration. **Important:** Load analytics plugin first!

```typescript
import { analyticsPlugin } from './plugins/analytics';
import { defiNewsPlugin } from './plugins/defi-news';

// In your agent configuration
const agent = {
    // ... other config
    plugins: [
        analyticsPlugin,  // MUST be loaded first!
        defiNewsPlugin,   // Depends on analytics plugin's CoinGecko service
        // ... other plugins
    ]
};
```

## Usage Examples

### Query Global DeFi Data

```
User: What is the current state of the DeFi market?
Agent: [Fetches and displays global DeFi statistics]

User: Show me DeFi market statistics
Agent: [Displays DeFi market cap, volume, dominance, etc.]

User: How much is the total DeFi market cap?
Agent: [Shows comprehensive DeFi and crypto market data]
```

### Get Token Information

```
User: Tell me about Bitcoin news and market data
Agent: [Displays BTC price, market cap, community stats, etc.]

User: What is the latest information on Ethereum?
Agent: [Shows ETH comprehensive data]

User: Show me SOL token data with DEX pairs and OHLCV
Agent: [Displays Solana data with DEX liquidity and chart data]
```

### Fetch Real-World News

```
User: What are the latest crypto news?
Agent: [Shows recent cryptocurrency news articles]

User: Tell me about the latest DeFi news
Agent: [Displays DeFi-specific news and events]

User: Show me recent blockchain events
Agent: [Fetches and displays blockchain news]

User: What is happening in the crypto world?
Agent: [Provides general crypto market news and updates]
```

## Architecture

### Services

#### CoinGecko Service (from Analytics Plugin)
- **Source**: `@plugins/analytics/services/coingeckoService`
- **Purpose**: Provides CoinGecko API access
- **Features**:
  - Caching for improved performance
  - Rate limit management
  - Global DeFi and crypto market data
  - Token data, DEX pairs, and OHLC charts
- **Note**: Shared with other plugins that need CoinGecko data

#### NewsDataService (Defi-News Plugin)
- **Purpose**: Fetch real-world news from Brave New Coin RSS feed
- **Features**:
  - RSS feed parsing
  - Query-based filtering
  - No API key required
  - Real-time crypto market news and analysis

### Actions

#### getGlobalDefiData
- **Trigger**: Questions about DeFi market statistics
- **Returns**: Global DeFi and crypto market data

#### getTokenNews
- **Trigger**: Queries about specific tokens
- **Returns**: Token data, DEX pairs, OHLCV charts

#### getRealWorldEvents
- **Trigger**: Requests for crypto news and events
- **Returns**: Latest news articles with sentiment analysis

### Providers

#### defiNewsProvider
- **Purpose**: Automatically provide DeFi and crypto market context to conversations
- **Dynamic**: Yes - fetches fresh data on each request
- **Returns**: Comprehensive market report including:
  - Global DeFi market statistics
  - Global crypto market data with dominance
  - Latest crypto news (top 5 articles)
- **Usage**: The provider is automatically called by the agent to enrich context for DeFi/crypto-related conversations

## API Endpoints Used

### CoinGecko API

1. **GET /global/decentralized_finance_defi**
   - Global DeFi market data

2. **GET /global**
   - Global crypto market statistics

3. **GET /coins/{id}**
   - Detailed token information

4. **GET /coins/{id}/tickers**
   - DEX trading pairs and liquidity

5. **GET /coins/{id}/ohlc**
   - OHLCV candlestick data

6. **GET /search**
   - Token search by name or symbol

### Brave New Coin RSS Feed

1. **GET /rss/insights**
   - Latest crypto news, analysis, and price predictions
   - Source: https://bravenewcoin.com/rss/insights

## Best Practices

### Plugin Dependencies
- ✅ Always load the analytics plugin before defi-news plugin
- ✅ Share the same COINGECKO_API_KEY across plugins
- ✅ Use runtime.getService('COINGECKO_SERVICE') to access the service
- ❌ Never create duplicate CoinGecko service instances

### CoinGecko Service Usage
- ✅ The analytics plugin provides the CoinGecko service
- ✅ Caching is handled automatically for better performance
- ✅ All responses are properly typed
- ✅ Load API keys from environment variables
- ❌ Never hardcode API keys

### Error Handling
```typescript
try {
    const coinGeckoService = runtime.getService('COINGECKO_SERVICE');
    if (!coinGeckoService) {
        throw new Error('Analytics plugin not loaded');
    }
    const data = await coinGeckoService.getCoinData('bitcoin');
} catch (err) {
    console.error('Error fetching data:', err);
}
```

### Rate Limits
- **CoinGecko Free**: 10-50 calls/minute (shared across all plugins)
- **Caching**: 15-30 minutes for most endpoints (reduces API calls)
- **Brave New Coin RSS**: No rate limits (public RSS feed)

## Troubleshooting

### Common Issues

1. **"Rate limit exceeded"**
   - Solution: Upgrade to Pro API or wait before retrying
   - The SDK handles automatic retries

2. **"Token not found"**
   - Solution: Use correct token ID from CoinGecko (e.g., 'bitcoin', not 'BTC')

3. **No news articles returned**
   - Solution: Verify your internet connection
   - Check if Brave New Coin RSS feed is accessible

## Development

### Adding New Features

1. **New CoinGecko Endpoint**:
   - Add method to `CoinGeckoService`
   - Create type definitions in `interfaces/types.ts`
   - Use proper error handling

2. **New Action**:
   - Create action in `actions/` directory
   - Add validation logic
   - Register in `index.ts`

3. **New News Source**:
   - Create service in `services/` directory
   - Add RSS parsing or API integration
   - Create corresponding action

## License

Part of the Spartan AI project.

## Support

For issues and questions, please refer to the main Spartan AI documentation or create an issue in the repository.

