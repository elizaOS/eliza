# Polymarket Plugin for ElizaOS

This plugin provides integration with Polymarket prediction markets through the CLOB (Central Limit Order Book) API, enabling AI agents to interact with prediction markets.

## Features

- Retrieve all available prediction markets
- Get simplified market data with reduced schema
- Query market data and pricing information
- Support for market filtering and pagination
- Real-time market data access
- TypeScript support with comprehensive error handling

## Installation

This plugin is part of the ElizaOS ecosystem. To use it:

```bash
# Install dependencies
npm install

# Build the plugin
npm run build
```

## Configuration

### Required Environment Variables

- **`CLOB_API_URL`**: Polymarket CLOB API endpoint URL
  - Default: `https://clob.polymarket.com`
  - Example: `CLOB_API_URL=https://clob.polymarket.com`
  - **Note**: This environment variable activates the plugin in the main Eliza character

### Optional Environment Variables

- **`CLOB_API_KEY`**: API key for authenticated requests (optional for read-only operations)
- **`POLYMARKET_PRIVATE_KEY`**: Private key for trading operations (required for order placement)

### Environment Setup

Create a `.env` file in your project root:

```env
CLOB_API_URL=https://clob.polymarket.com
CLOB_API_KEY=your_api_key_here
POLYMARKET_PRIVATE_KEY=your_private_key_here
```

### Plugin Activation

The plugin is automatically activated when `CLOB_API_URL` is set in your environment. This follows the same pattern as other ElizaOS plugins:

```typescript
// In eliza.ts character configuration
...(process.env.CLOB_API_URL ? ['@elizaos/plugin-polymarket'] : []),
```

This means:

- ✅ **With CLOB_API_URL set**: Plugin loads automatically, all actions available
- ❌ **Without CLOB_API_URL**: Plugin remains inactive

## Available Actions

### GET_ALL_MARKETS

Retrieves all available prediction markets from Polymarket.

**Triggers**: `LIST_MARKETS`, `SHOW_MARKETS`, `GET_MARKETS`, `FETCH_MARKETS`, `ALL_MARKETS`, `AVAILABLE_MARKETS`

**Usage Examples**:

- "Show me all available prediction markets"
- "What markets can I trade on Polymarket?"
- "List all active prediction markets"

**Response**: Returns formatted list of markets with:

- Market questions and categories
- Active status and end dates
- Token information and trading details
- Pagination support for large result sets

**Example Response**:

```
📊 Retrieved 150 Polymarket prediction markets

Sample Markets:
1. Will BTC reach $100k by end of 2024?
   • Category: crypto
   • Active: ✅
   • End Date: 12/31/2024

2. Who will win the 2024 US Presidential Election?
   • Category: politics
   • Active: ✅
   • End Date: 11/5/2024

... and 148 more markets

Summary:
• Total Markets: 150
• Data includes: question, category, tokens, rewards, and trading details
```

### GET_MARKETS (Simplified View)

Retrieves a simplified market list as a parameterized view of `GET_MARKETS`.

**Triggers**: Same as `GET_MARKETS` when the user asks for a simplified or quick overview.

**Usage Examples**:

- "Show me simplified market data"
- "Get a quick overview of markets"
- "I need a simple market list for analysis"

**Benefits**:

- Reduced data payload for faster responses
- Lower bandwidth usage
- Streamlined fields for basic market information

**Simplified View Includes**:

- Condition ID and question
- Active/closed status
- End date (when available)
- Outcomes count

**TypeScript Usage**:

```typescript
import { retrieveAllMarketsAction } from "@elizaos/plugin-polymarket";

// Use in your ElizaOS agent (message should request simplified view)
const result = await retrieveAllMarketsAction.handler(
  runtime,
  message,
  state,
);
```

### GET_PRICE_HISTORY

Retrieves historical price data for a Polymarket token, providing time-series data with timestamps and prices for technical analysis and trend identification.

**Triggers**: `PRICE_HISTORY`, `GET_PRICE_HISTORY`, `PRICES_HISTORY`, `HISTORICAL_PRICES`, `PRICE_CHART`, `PRICE_DATA`, `CHART_DATA`, `HISTORICAL_DATA`, `TIME_SERIES`, `PRICE_TIMELINE`, `MARKET_HISTORY`, `TOKEN_HISTORY`, `PRICE_TREND`, `HISTORICAL_CHART`, `SHOW_PRICE_HISTORY`, `FETCH_PRICE_HISTORY`, `GET_HISTORICAL_PRICES`, `SHOW_HISTORICAL_PRICES`

**Usage Examples**:

- "Get price history for token 123456 with 1d interval"
- "Show me 1h price chart for token 456789"
- "PRICE_HISTORY 789012"
- "Historical prices for token 345678 over 1 week"

**Required Parameters**:

- **tokenId**: The specific token ID for which to retrieve price history (numeric string)
- **interval**: Time interval for data points (optional, defaults to "1d")
  - Supported intervals: "1m", "5m", "1h", "6h", "1d", "1w", "max"

**Response**: Returns comprehensive price history analysis including:

- Time-series data with timestamps and prices
- Price trend calculation (percentage change over period)
- Highest and lowest prices in the dataset
- Recent price points (last 5 data points)
- Time range coverage
- Data point count

**Example Response**:

```
📈 **Price History for Token 123456**

⏱️ **Interval**: 1d
📊 **Data Points**: 30

**Recent Price Points:**
• 2024-01-15 12:00:00 - $0.6523 (65.23%)
• 2024-01-14 12:00:00 - $0.6445 (64.45%)
• 2024-01-13 12:00:00 - $0.6387 (63.87%)
• 2024-01-12 12:00:00 - $0.6234 (62.34%)
• 2024-01-11 12:00:00 - $0.6156 (61.56%)

📈 **Price Trend**: +2.78% over the period
💹 **Highest**: $0.6789 (67.89%)
📉 **Lowest**: $0.5923 (59.23%)

🕒 **Time Range**: Jan 15, 2024 - Dec 16, 2023
```

**TypeScript Usage**:

```typescript
import { getPriceHistory } from "@elizaos/plugin-polymarket";

// Use in your ElizaOS agent
const result = await getPriceHistory.handler(runtime, message, state);

// Access price history data
const priceHistory = result.data.priceHistory; // PricePoint[]
const tokenId = result.data.tokenId; // string
const interval = result.data.interval; // string
const pointsCount = result.data.pointsCount; // number
```

**Price History Schema**:

```typescript
interface PricePoint {
  t: number; // Unix timestamp
  p: number; // Price (0-1 representing probability)
}

interface PriceHistoryResponse {
  tokenId: string;
  interval: string;
  priceHistory: PricePoint[];
  pointsCount: number;
  timestamp: string;
}
```

**Key Features**:

- **Multiple Intervals**: Support for various time granularities
- **Trend Analysis**: Automatic calculation of price trends
- **Statistical Summary**: High, low, and percentage changes
- **Recent Data Focus**: Highlights most recent price movements
- **Time Range Display**: Clear indication of data coverage
- **Null Handling**: Graceful handling of missing or empty data

**Benefits**:

- Technical analysis and charting capabilities
- Trend identification for trading decisions
- Historical performance evaluation
- Price volatility assessment
- Market timing analysis
- Integration with trading algorithms

### GET_ORDER_BOOK

Retrieves order book summary (bids and asks) for a specific Polymarket token.

**Triggers**: `ORDER_BOOK`, `BOOK_SUMMARY`, `GET_BOOK`, `SHOW_BOOK`, `FETCH_BOOK`, `ORDER_BOOK_SUMMARY`, `BOOK_DATA`, `BID_ASK`, `MARKET_DEPTH`, `ORDERBOOK`

**Usage Examples**:

- "Show order book for token 123456"
- "Get order book summary for 789012"
- "ORDER_BOOK 345678"
- "What's the bid/ask spread for this token?"

**Required Parameter**:

- **tokenId**: The specific token ID for which to retrieve the order book (numeric string)

**Response**: Returns detailed order book information including:

- Token and market information
- Market depth statistics (bid/ask counts, total sizes)
- Best bid/ask prices and sizes
- Bid-ask spread calculation
- Top 5 bids and asks with prices and sizes

**Example Response**:

```
📖 Order Book Summary

Token Information:
• Token ID: 123456
• Market: 0x1234567890abcdef1234567890abcdef12345678901234567890abcdef12345678
• Asset ID: 123456

Market Depth:
• Bid Orders: 5
• Ask Orders: 5
• Total Bid Size: 776.50
• Total Ask Size: 461.50

Best Prices:
• Best Bid: $0.65 (Size: 100.5)
• Best Ask: $0.66 (Size: 80.5)
• Spread: $0.0100

Top 5 Bids:
1. $0.65 - Size: 100.5
2. $0.64 - Size: 250.0
3. $0.63 - Size: 150.75
4. $0.62 - Size: 75.25
5. $0.61 - Size: 200.0

Top 5 Asks:
1. $0.66 - Size: 80.5
2. $0.67 - Size: 120.0
3. $0.68 - Size: 90.25
4. $0.69 - Size: 60.0
5. $0.70 - Size: 110.75
```

**TypeScript Usage**:

```typescript
import { getOrderBookSummaryAction } from "@elizaos/plugin-polymarket";

// Use in your ElizaOS agent
const result = await getOrderBookSummaryAction.handler(runtime, message, state);

// Access order book data
const orderBook = result.data.orderBook; // OrderBook with bids/asks
const summary = result.data.summary; // Summary statistics
```

**Order Book Schema**:

```typescript
interface OrderBook {
  market: string; // Market condition ID
  asset_id: string; // Token ID
  bids: BookEntry[]; // Buy orders
  asks: BookEntry[]; // Sell orders
}

interface BookEntry {
  price: string; // Price level
  size: string; // Size at this price level
}
```

**Benefits**:

- Real-time market depth analysis
- Price discovery for trading decisions
- Liquidity assessment
- Spread analysis for market efficiency
- Order flow visualization

### GET_ORDER_BOOK_DEPTH

Retrieves order book depth data for one or more Polymarket tokens using bulk API calls.

**Triggers**: `ORDER_BOOK_DEPTH`, `BOOK_DEPTH`, `GET_DEPTH`, `SHOW_DEPTH`, `FETCH_DEPTH`, `ORDER_DEPTH`, `DEPTH_DATA`, `MULTIPLE_BOOKS`, `BULK_BOOKS`, `BOOKS_DEPTH`

**Usage Examples**:

- "Show order book depth for token 123456"
- "Get depth for tokens 123456, 789012"
- "ORDER_BOOK_DEPTH 345678 999999"
- "Fetch bulk order books for multiple tokens"

**Required Parameter**:

- **tokenIds**: Array of token IDs for which to retrieve order book depth (accepts single or multiple IDs)

**Response**: Returns array of order book objects with summary statistics including:

- Number of tokens requested vs found
- Active order books count
- Total bid/ask levels across all books
- Individual order book data for each token

**Example Response**:

```
📊 Order Book Depth Summary

Tokens Requested: 2
Order Books Found: 2

Token 1: `123456`
• Market: 0x1234567890abcdef1234567890abcdef12345678901234567890abcdef12345678
• Bid Levels: 5
• Ask Levels: 5
• Best Bid: $0.65 (100.5)
• Best Ask: $0.66 (80.5)

Token 2: `789012`
• Market: 0x9876543210fedcba9876543210fedcba98765432109876543210fedcba98765432
• Bid Levels: 3
• Ask Levels: 4
• Best Bid: $0.45 (200.0)
• Best Ask: $0.46 (175.0)

Summary:
• Active Order Books: 2/2
• Total Bid Levels: 8
• Total Ask Levels: 9
```

**TypeScript Usage**:

```typescript
import { getOrderBookDepthAction } from "@elizaos/plugin-polymarket";

// Use in your ElizaOS agent
const result = await getOrderBookDepthAction.handler(runtime, message, state);

// Access order book array and summary
const orderBooks = result.data.orderBooks; // OrderBook[]
const summary = result.data.summary; // Bulk statistics
const tokenIds = result.data.tokenIds; // Requested token IDs
```

**Order Book Depth Schema**:

```typescript
interface OrderBookDepthResponse {
  orderBooks: OrderBook[];
  tokenIds: string[];
  summary: {
    tokensRequested: number;
    orderBooksFound: number;
    activeBooks: number;
    totalBids: number;
    totalAsks: number;
  };
  timestamp: string;
}

interface OrderBook {
  market: string; // Market condition ID
  asset_id: string; // Token ID
  bids: BookEntry[]; // Buy orders (empty array if no bids)
  asks: BookEntry[]; // Sell orders (empty array if no asks)
  hash?: string; // Order book hash
  timestamp?: string; // Book generation timestamp
}
```

**Benefits**:

- Bulk data retrieval for multiple tokens
- Cross-market depth analysis
- Portfolio-level liquidity assessment
- Efficient API usage for multiple tokens
- Comparative market analysis

### DELETE_API_KEY

Revokes/deletes an existing API key to disable L2 authentication for that specific key. This permanently invalidates the API credentials and any active sessions using them.

**Triggers**: `DELETE_API_KEY`, `REVOKE_API_KEY`, `DELETE_POLYMARKET_API_KEY`, `REMOVE_API_CREDENTIALS`, `REVOKE_CLOB_CREDENTIALS`, `DELETE_API_ACCESS`, `DISABLE_API_KEY`

**Usage Examples**:

- "Revoke API key 12345678-1234-5678-9abc-123456789012"
- "Delete API key abc12345-def6-7890-ghij-klmnopqrstuv"
- "Remove my CLOB API credentials"
- "Disable API access for key 98765432-1098-7654-3210-fedcba987654"

**Required Parameter**:

- **apiKeyId**: The UUID of the API key to revoke (format: 12345678-1234-5678-9abc-123456789012)

**Response**: Returns revocation confirmation including:

- Success/failure status
- API key ID that was revoked
- Revocation timestamp
- Important security notices about invalidated sessions

**Example Response**:

```
✅ API Key Revoked Successfully

Revocation Details:
• API Key ID: 12345678-1234-5678-9abc-123456789012
• Revoked At: 2024-01-15T10:45:00.000Z
• Status: Permanently disabled

⚠️ Important Notice:
- This API key can no longer be used for authentication
- Any existing authenticated sessions using this key will be invalidated
- You'll need to create a new API key for future trading operations

Next Steps:
If you need API access, generate new credentials via the Polymarket UI or CLI.
```


**Revocation Response Schema**:

```typescript
interface RevokeApiKeyResponse {
  success: boolean; // Whether revocation succeeded
  apiKeyId: string; // The revoked API key ID
  revokedAt: string; // ISO timestamp of revocation
  message: string; // Success message
}
```

**Security Considerations**:

- Revocation is permanent and cannot be undone
- All active sessions using the revoked key will be immediately invalidated
- This affects any automated systems or scripts using the revoked credentials
- Revoked keys cannot be reactivated - new keys must be created instead
- The revocation requires the private key for authentication (L1 auth)

**Use Cases**:

- **Security Incidents**: Immediately disable compromised API keys
- **Access Management**: Remove API access for specific applications
- **Key Rotation**: Disable old keys when implementing new ones
- **Account Cleanup**: Remove unused or outdated API credentials
- **Permission Changes**: Revoke access when authorization requirements change

**Error Handling**:

- Validates API key ID format (UUID)
- Handles non-existent or already revoked keys
- Provides clear error messages for troubleshooting
- Network connectivity and API error handling
- Authentication failure scenarios

**Integration with API Key Management**:

Use in combination with Polymarket's UI or CLI to rotate API keys. Best practice is to revoke old keys before creating new ones for security.

**Security Notes**:

- API key revocation is permanent and cannot be undone
- Revoked keys cannot be used for any further authentication
- Ensure you have other API keys available if needed for continued trading

## API Integration

This plugin uses the Polymarket CLOB API:

- **Base URL**: https://clob.polymarket.com
- **Documentation**: https://docs.polymarket.com/developers/CLOB/introduction
- **Rate Limits**: Follows Polymarket's standard rate limiting

## Development

### Project Structure

```
src/
├── actions/           # Action implementations
│   ├── retrieveAllMarkets.ts
│   ├── getMarketDetails.ts
│   ├── getOrderBookSummary.ts
│   ├── getOrderBookDepth.ts
│   ├── getBestPrice.ts
│   ├── getMidpointPrice.ts
│   └── getSpread.ts
├── utils/            # Utility functions
│   ├── clobClient.ts # CLOB API client
│   └── llmHelpers.ts # LLM parameter extraction
├── templates.ts      # LLM prompt templates
├── plugin.ts         # Main plugin definition
└── index.ts          # Plugin entry point
```

### Adding New Actions

1. Create action file in `src/actions/`
2. Follow the existing pattern with validate/handler methods
3. Add LLM templates for parameter extraction
4. Register action in `src/plugin.ts`
5. Write unit tests in `src/__tests__/`

### Testing

```bash
# Run unit tests
npm run test:component

# Run with coverage
npm run test:coverage

# Run end-to-end tests
npm run test:e2e
```

## Error Handling

The plugin includes comprehensive error handling:

- Configuration validation
- API connectivity checks
- Graceful degradation for network issues
- Detailed error messages for troubleshooting

## Supported Markets

This plugin works with all Polymarket prediction markets including:

- Political events and elections
- Cryptocurrency price predictions
- Sports outcomes
- Economic indicators
- Current events and news

## License

MIT License - see LICENSE file for details.

## Contributing

1. Follow the existing code patterns
2. Add comprehensive tests for new features
3. Update documentation
4. Ensure TypeScript compliance
5. Test against live Polymarket API

## Support

For issues and questions:

- Check the ElizaOS documentation
- Review Polymarket API documentation
- File issues in the project repository
