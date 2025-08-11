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

### GET_SIMPLIFIED_MARKETS

Retrieves simplified market data with reduced schema for faster processing and lower bandwidth usage.

**Triggers**: `LIST_SIMPLIFIED_MARKETS`, `SHOW_SIMPLIFIED_MARKETS`, `GET_SIMPLE_MARKETS`, `FETCH_SIMPLIFIED_MARKETS`, `SIMPLIFIED_MARKETS`, `SIMPLE_MARKETS`

**Usage Examples**:

- "Show me simplified market data"
- "Get markets in simplified format"
- "I need simple market data for analysis"

**Benefits**:

- Reduced data payload for faster responses
- Lower bandwidth usage
- Streamlined fields for basic market information
- Ideal for high-frequency data access

**Simplified Schema Includes**:

- Condition ID and token pairs
- Active/closed status
- Rewards and incentive information
- Essential market identification data

**Example Response**:

```
📊 Retrieved 75 Simplified Polymarket markets

Sample Simplified Markets:
1. Condition ID: 0x1234567890abcdef1234567890abcdef12345678
   • Tokens: Yes (12345678...) / No (09876543...)
   • Active: ✅
   • Closed: ❌
   • Min Incentive Size: 0.1

2. Condition ID: 0xabcdef1234567890abcdef1234567890abcdef12
   • Tokens: Yes (87654321...) / No (21098765...)
   • Active: ✅
   • Closed: ❌
   • Min Incentive Size: 0.05

... and 73 more simplified markets

Summary:
• Total Simplified Markets: 75
• Simplified schema includes: condition_id, tokens, rewards, incentives, status
• Reduced data for faster processing and lower bandwidth
```

**TypeScript Usage**:

```typescript
import { getSimplifiedMarketsAction } from '@elizaos/plugin-polymarket';

// Use in your ElizaOS agent
const result = await getSimplifiedMarketsAction.handler(runtime, message, state);

// Access simplified market data
const markets = result.data.markets; // SimplifiedMarket[]
```

### GET_CLOB_MARKETS

Retrieves Polymarket markets available for trading via CLOB (Central Limit Order Book). All markets returned by this action are CLOB-enabled and ready for order placement and execution.

**Triggers**: `CLOB_MARKETS`, `GET_CLOB_MARKETS`, `TRADING_MARKETS`, `TRADEABLE_MARKETS`, `MARKETS_FOR_TRADING`, `CLOB_ENABLED`, `TRADING_ENABLED`, `ACTIVE_TRADING`, `CLOB_TRADING`, `ORDER_BOOK_MARKETS`, `AVAILABLE_FOR_TRADING`, `GET_TRADING_MARKETS`, `SHOW_CLOB_MARKETS`, `LIST_CLOB_MARKETS`, `FETCH_CLOB_MARKETS`, `CLOB_AVAILABLE`, `TRADING_AVAILABLE`, `ORDERBOOK_MARKETS`

**Usage Examples**:

- "Show me markets available for trading"
- "Get CLOB markets for politics category"
- "List active trading markets with limit 10"
- "What markets can I place orders on?"

**Optional Parameters**:

- **category**: Filter markets by category (e.g., "politics", "crypto", "sports")
- **active**: Filter by active status (true/false)
- **limit**: Maximum number of markets to return

**Response**: Returns formatted list of CLOB-enabled markets with:

- Market questions and categories
- Trading status (active/inactive)
- Token information and outcomes
- Minimum order size and tick size for trading
- Total count and pagination information
- Filter information when applied

**Example Response**:

```
📈 CLOB Markets (Trading Available)

Found 150 markets ready for trading:

🎯 Will Donald Trump win the 2024 election?
├─ Category: Politics
├─ Trading: ✅ Active
├─ Tokens: Yes | No
└─ Min Order: $0.01 • Min Tick: $0.01

🎯 Will Bitcoin reach $100k by end of 2024?
├─ Category: Crypto
├─ Trading: ✅ Active
├─ Tokens: Yes | No
└─ Min Order: $0.01 • Min Tick: $0.01

🎯 Will Lakers make NBA playoffs?
├─ Category: Sports
├─ Trading: ✅ Active
├─ Tokens: Yes | No
└─ Min Order: $0.01 • Min Tick: $0.01

... and 147 more markets

📊 Total: 150 tradeable markets • All CLOB-enabled
🔧 Filters Applied: category=politics, active=true
📄 Next: Use cursor ABC123 for more markets
```

**TypeScript Usage**:

```typescript
import { getClobMarkets } from '@elizaos/plugin-polymarket';

// Use in your ElizaOS agent
const result = await getClobMarkets.handler(runtime, message, state);

// Access CLOB markets data
const markets = result.data.markets; // Market[]
const totalCount = result.data.count; // number
const nextCursor = result.data.next_cursor; // string
const filters = result.data.filters; // ClobMarketsParams
```

**CLOB Market Schema**:

```typescript
interface ClobMarketsParams {
  category?: string;
  active?: boolean;
  limit?: number;
}

interface ClobMarketsResponse {
  markets: Market[];
  count: number;
  next_cursor?: string;
  filters: ClobMarketsParams;
  timestamp: string;
}

interface Market {
  condition_id: string;
  question: string;
  category: string;
  active: boolean;
  tokens: Token[];
  minimum_order_size: string;
  minimum_tick_size: string;
  // ... additional market fields
}
```

**Key Features**:

- **CLOB-Ready**: All returned markets support order placement
- **Trading Information**: Includes minimum order and tick sizes
- **Active Status**: Shows which markets are currently trading
- **Filter Support**: Category, active status, and limit filters
- **Pagination**: Handle large result sets efficiently
- **Real-time Data**: Current trading status and parameters

**Benefits**:

- Identify markets ready for order placement
- Access trading parameters (min order/tick sizes)
- Filter markets by category or trading status
- Efficient discovery of tradeable opportunities
- Integration with order placement workflows

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
import { getPriceHistory } from '@elizaos/plugin-polymarket';

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
import { getOrderBookSummaryAction } from '@elizaos/plugin-polymarket';

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
import { getOrderBookDepthAction } from '@elizaos/plugin-polymarket';

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

### GET_BEST_PRICE

Retrieves the best bid or ask price for a specific Polymarket token using the CLOB API price endpoint.

**Triggers**: `BEST_PRICE`, `GET_PRICE`, `SHOW_PRICE`, `FETCH_PRICE`, `PRICE_DATA`, `MARKET_PRICE`, `BID_PRICE`, `ASK_PRICE`, `BEST_BID`, `BEST_ASK`

**Usage Examples**:

- "Get best price for token 123456 on buy side"
- "What's the sell price for market token 789012?"
- "Show me the best bid for 456789"
- "Get the ask price for token abc123"

**Required Parameters**:

- **tokenId**: The token identifier (numeric string)
- **side**: Either "buy" or "sell" to specify which price to retrieve

**Side Mapping**:

- **"buy" side**: Returns the best ask price (what you pay to buy)
- **"sell" side**: Returns the best bid price (what you receive when selling)
- **"bid"** keyword maps to "sell" side
- **"ask"** keyword maps to "buy" side

**Response**: Returns the current best price for the specified side including:

- Formatted price in USD
- Percentage representation (0-100%)
- Side information and explanation
- Token ID and timestamp

**Example Response**:

```
💰 Best Ask (buy) Price for Token 123456

Price: $0.5500 (55.00%)
Side: ask (buy)
Token ID: 123456

This is the best price you would pay to buy this token.
```

**TypeScript Usage**:

```typescript
import { getBestPriceAction } from '@elizaos/plugin-polymarket';

// Use in your ElizaOS agent
const result = await getBestPriceAction.handler(runtime, message, state);

// Access price data
const price = result.data.price; // Raw price string
const formattedPrice = result.data.formattedPrice; // Formatted to 4 decimals
const percentagePrice = result.data.percentagePrice; // Percentage representation
const tokenId = result.data.tokenId; // Token ID
const side = result.data.side; // buy/sell side
```

**Price Response Schema**:

```typescript
interface BestPriceResponse {
  tokenId: string;
  side: 'buy' | 'sell';
  price: string; // Raw price from API
  formattedPrice: string; // Price formatted to 4 decimals
  percentagePrice: string; // Price as percentage (2 decimals)
  timestamp: string; // ISO timestamp
}
```

**Benefits**:

- Real-time price discovery for individual tokens
- Quick price checks for trading decisions
- Support for both buy and sell side pricing
- Clear price formatting for easy interpretation
- Efficient single-token price retrieval

**Error Handling**:

- Validates token ID and side parameters
- Handles missing or invalid price data
- Provides clear error messages for troubleshooting
- Fallback regex extraction when LLM fails

### GET_MIDPOINT_PRICE

Retrieves the midpoint price (halfway between best bid and best ask) for a specific Polymarket token using the CLOB API midpoint endpoint.

**Triggers**: `MIDPOINT_PRICE`, `GET_MIDPOINT`, `SHOW_MIDPOINT`, `FETCH_MIDPOINT`, `MIDPOINT_DATA`, `MARKET_MIDPOINT`, `MID_PRICE`, `MIDDLE_PRICE`, `GET_MID_PRICE`, `SHOW_MID_PRICE`, `FETCH_MID_PRICE`, `MIDPOINT_CHECK`, `CHECK_MIDPOINT`, `MIDPOINT_LOOKUP`, `TOKEN_MIDPOINT`, `MARKET_MID`

**Usage Examples**:

- "Get midpoint price for token 123456"
- "What's the midpoint for market token 789012?"
- "Show me the mid price for 456789"
- "Get the middle price for this token"

**Required Parameter**:

- **tokenId**: The token identifier (numeric string)

**Response**: Returns the current midpoint price including:

- Formatted price in USD
- Percentage representation (0-100%)
- Token ID and timestamp
- Explanation of what midpoint price represents

**Example Response**:

```
🎯 Midpoint Price for Token 123456

Midpoint Price: $0.5500 (55.00%)
Token ID: 123456

The midpoint price represents the halfway point between the best bid and best ask prices, providing a fair market value estimate for this prediction market token.
```

**TypeScript Usage**:

```typescript
import { getMidpointPriceAction } from '@elizaos/plugin-polymarket';

// Use in your ElizaOS agent
const result = await getMidpointPriceAction.handler(runtime, message, state);

// Access midpoint price data
const midpoint = result.data.midpoint; // Raw midpoint string
const formattedPrice = result.data.formattedPrice; // Formatted to 4 decimals
const percentagePrice = result.data.percentagePrice; // Percentage representation
const tokenId = result.data.tokenId; // Token ID
```

**Midpoint Price Response Schema**:

```typescript
interface MidpointPriceResponse {
  tokenId: string;
  midpoint: string; // Raw midpoint price from API
  formattedPrice: string; // Price formatted to 4 decimals
  percentagePrice: string; // Price as percentage (2 decimals)
  timestamp: string; // ISO timestamp
}
```

**Benefits**:

- Fair market value estimation for tokens
- Single price point for valuation
- Ideal for portfolio valuation
- Quick price reference without bid/ask spread
- Efficient single-token price discovery

**Use Cases**:

- Portfolio valuation and reporting
- Market analysis and comparison
- Fair value pricing for positions
- Quick price checks for decision making
- Historical price tracking

**Error Handling**:

- Validates token ID parameter
- Handles missing or invalid midpoint data
- Provides clear error messages for troubleshooting
- Fallback regex extraction when LLM fails

### GET_SPREAD

Retrieves the spread (difference between best ask and best bid) for a specific Polymarket token using the CLOB API spread endpoint.

**Triggers**: `SPREAD`, `GET_SPREAD`, `SHOW_SPREAD`, `FETCH_SPREAD`, `SPREAD_DATA`, `MARKET_SPREAD`, `BID_ASK_SPREAD`, `GET_BID_ASK_SPREAD`, `SHOW_BID_ASK_SPREAD`, `FETCH_BID_ASK_SPREAD`, `SPREAD_CHECK`, `CHECK_SPREAD`, `SPREAD_LOOKUP`, `TOKEN_SPREAD`, `MARKET_BID_ASK`, `GET_MARKET_SPREAD`, `SHOW_MARKET_SPREAD`, `FETCH_MARKET_SPREAD`

**Usage Examples**:

- "Get spread for token 123456"
- "What's the bid-ask spread for market token 789012?"
- "Show me the spread for 456789"
- "Get the market spread for this token"

**Required Parameter**:

- **tokenId**: The token identifier (numeric string)

**Response**: Returns the current spread including:

- Raw spread value
- Formatted spread (4 decimal places)
- Percentage representation (0-100%)
- Token ID and timestamp
- Explanation of what spread represents

**Example Response**:

```
✅ Spread for Token 123456

📊 Spread: 0.0450 (4.50%)

Details:
• Token ID: 123456
• Spread Value: 0.0450
• Percentage: 4.50%

The spread represents the difference between the best ask and best bid prices.
```

**TypeScript Usage**:

```typescript
import { getSpreadAction } from '@elizaos/plugin-polymarket';

// Use in your ElizaOS agent
const result = await getSpreadAction.handler(runtime, message, state);

// Access spread data
const spread = result.data.spread; // Raw spread string
const formattedSpread = result.data.formattedSpread; // Formatted to 4 decimals
const percentageSpread = result.data.percentageSpread; // Percentage representation
const tokenId = result.data.tokenId; // Token ID
```

**Spread Response Schema**:

```typescript
interface SpreadResponse {
  tokenId: string;
  spread: string; // Raw spread value from API
  formattedSpread: string; // Spread formatted to 4 decimals
  percentageSpread: string; // Spread as percentage (2 decimals)
  timestamp: string; // ISO timestamp
}
```

**Benefits**:

- Market liquidity assessment
- Trading cost estimation
- Order placement strategy
- Market efficiency measurement
- Spread monitoring and analysis

**Use Cases**:

- Evaluating market liquidity before trading
- Comparing spread across different tokens
- Monitoring market efficiency
- Determining optimal order placement timing
- Spread analysis for market making

**Error Handling**:

- Validates token ID parameter
- Handles missing or invalid spread data
- Provides clear error messages for troubleshooting
- Fallback regex extraction when LLM fails

### CREATE_API_KEY

Creates API key credentials for Polymarket CLOB authentication. This action generates the L2 authentication required for order posting and other authenticated operations.

**Triggers**: `CREATE_API_KEY`, `CREATE_POLYMARKET_API_KEY`, `GENERATE_API_CREDENTIALS`, `CREATE_CLOB_CREDENTIALS`, `SETUP_API_ACCESS`

**Usage Examples**:

- "Create API key for Polymarket trading"
- "Generate new CLOB API credentials"
- "Setup API access for order posting"
- "I need API credentials for trading"

**Required Environment Variables**:

- **WALLET_PRIVATE_KEY** or **PRIVATE_KEY** or **POLYMARKET_PRIVATE_KEY**: Private key for wallet signature

**No Parameters Required**: API key generation is based on wallet signature

**Response**: Returns newly created API credentials including:

- API Key ID (for authentication headers)
- Secret (truncated for security in response)
- Passphrase (truncated for security in response)
- Creation timestamp
- Security warnings and next steps

**Example Response**:

```
✅ API Key Created Successfully

Credentials Generated:
• API Key: 12345678-1234-5678-9abc-123456789012
• Secret: abcd1234... (truncated for security)
• Passphrase: xyz78901... (truncated for security)
• Created: 2024-01-15T10:30:00.000Z

⚠️ Security Notice:
- Store these credentials securely
- Never share your secret or passphrase
- These credentials enable L2 authentication for order posting

Next Steps:
You can now place orders on Polymarket. The system will automatically use these credentials for authenticated operations.
```

**TypeScript Usage**:

```typescript
import { createApiKeyAction } from '@elizaos/plugin-polymarket';

// Use in your ElizaOS agent
const result = await createApiKeyAction.handler(runtime, message, state);

// Access API key data
const apiKey = result.data.apiKey.id; // API key ID
const created = result.data.apiKey.created_at; // Creation timestamp
```

**API Key Response Schema**:

```typescript
interface ApiKeyResponse {
  id: string; // API key identifier
  secret: string; // API secret (store securely)
  passphrase: string; // API passphrase (store securely)
  created_at?: string; // Creation timestamp
}
```

**Security Considerations**:

- API credentials are generated using your wallet's private key signature
- Store credentials securely in environment variables or secure storage
- Never share or log the full secret or passphrase
- Credentials enable authenticated trading operations
- Use HTTPS connections when transmitting credentials

**Use Cases**:

- Setting up trading capabilities for the first time
- Rotating API credentials for security
- Enabling order placement and cancellation
- Accessing authenticated market data endpoints
- Preparing for automated trading strategies

**What API Credentials Enable**:

- **Order Placement**: Create buy/sell orders on markets
- **Order Management**: Cancel or modify existing orders
- **Account Operations**: View balances and positions
- **Authenticated Endpoints**: Access private user data
- **Rate Limit Benefits**: Higher rate limits for authenticated users

**Error Handling**:

- Validates private key availability in environment
- Handles wallet signature failures
- Provides clear error messages for troubleshooting
- Network connectivity and API error handling

**Integration with Order Placement**:

Once API credentials are created, they are automatically used by other trading actions like PLACE_ORDER for authenticated operations.

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
If you need API access, use the CREATE_API_KEY action to generate new credentials.
```

**TypeScript Usage**:

```typescript
import { revokeApiKeyAction } from '@elizaos/plugin-polymarket';

// Use in your ElizaOS agent
const result = await revokeApiKeyAction.handler(runtime, message, state);

// Access revocation data
const revocationResult = result.data.revocation; // RevokeApiKeyResponse
const success = result.data.success; // boolean
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

Use in combination with CREATE_API_KEY for complete API key lifecycle management. Best practice is to revoke old keys before creating new ones for security.

**Security Notes**:

- API key revocation is permanent and cannot be undone
- Revoked keys cannot be used for any further authentication
- Ensure you have other API keys available if needed for continued trading

### GET_API_KEYS

Retrieves all API keys associated with your Polymarket account address. This action uses the official Polymarket ClobClient.getApiKeys() method for reliable authentication.

**Triggers**: `GET_API_KEYS`, `GET_ALL_API_KEYS`, `LIST_API_KEYS`, `RETRIEVE_API_KEYS`, `SHOW_API_KEYS`, `GET_POLYMARKET_API_KEYS`, `LIST_CLOB_CREDENTIALS`, `SHOW_MY_API_KEYS`

**Usage Examples**:

- "Get my API keys"
- "Show all my API keys"
- "List my CLOB credentials"
- "Retrieve all Polymarket API keys"

**Setup Requirements**:

1. **Create API Keys First**: Use the CREATE_API_KEY action to generate credentials
2. **Set Environment Variables**: Add the returned credentials to your .env file
3. **Restart Application**: Reload to pick up the new environment variables

**Required Environment Variables**:

```bash
# For L1 authentication (wallet operations)
WALLET_PRIVATE_KEY=your_private_key_here

# For L2 authentication (API operations) - REQUIRED for GET_API_KEYS
CLOB_API_KEY=your_api_key_here
CLOB_API_SECRET=your_api_secret_here
CLOB_API_PASSPHRASE=your_api_passphrase_here

# Optional - defaults to https://clob.polymarket.com
CLOB_API_URL=https://clob.polymarket.com
```

**Alternative Environment Variable Names**:

- `CLOB_SECRET` (instead of `CLOB_API_SECRET`)
- `CLOB_PASS_PHRASE` (instead of `CLOB_API_PASSPHRASE`)

**TypeScript Example**:

```typescript
// This action automatically uses your configured API credentials
// No additional parameters needed

interface GetAllApiKeysResponse {
  success: boolean;
  apiKeys: ApiKeyData[];
  count: number;
  address: string;
}

interface ApiKeyData {
  key: string; // API key ID
  secret: string; // API secret (truncated in response)
  passphrase: string; // API passphrase (truncated in response)
  created_at?: string; // Creation timestamp
  active?: boolean; // Key status
  permissions?: string[]; // Key permissions
}
```

**Step-by-Step Setup**:

1. **Generate API Keys**:

   ```
   User: "create an api key for polymarket"
   ```

2. **Copy Credentials**: When the action succeeds, copy the returned credentials

3. **Update .env File**:

   ```bash
   # Add these lines to your .env file
   CLOB_API_KEY=c6f85fb9-3b49-9726-9d15-e8584d975625
   CLOB_API_SECRET=Yc8q_kEBtX...your_full_secret_here
   CLOB_API_PASSPHRASE=6096fa1e...your_full_passphrase_here
   ```

4. **Restart Application**: Stop and restart ElizaOS to load the new variables

5. **Test Retrieval**:
   ```
   User: "get my polymarket api keys"
   ```

**Response Format**:

- **Success**: Returns array of API key objects with key details
- **Empty**: Returns success with count: 0 if no API keys exist
- **Error**: Returns detailed error message with troubleshooting steps

**Enhanced Features**:

- **Official ClobClient Integration**: Uses Polymarket's official TypeScript client
- **Comprehensive Error Messages**: Clear instructions for setup and troubleshooting
- **Multiple Environment Variable Support**: Flexible naming conventions
- **Security-First Design**: Credentials are truncated in responses
- **Validation**: Checks for required credentials before attempting requests

**Common Issues & Solutions**:

| Issue                       | Solution                                                       |
| --------------------------- | -------------------------------------------------------------- |
| "API credentials not found" | Set CLOB_API_KEY, CLOB_API_SECRET, CLOB_API_PASSPHRASE in .env |
| "401 Unauthorized"          | Verify credentials are correct and restart application         |
| "Connection refused"        | Check CLOB_API_URL setting and network connectivity            |
| "No API keys found"         | Create API keys first using CREATE_API_KEY action              |

**Security Considerations**:

- API secrets and passphrases are truncated in responses for security
- This action requires existing L2 authentication credentials
- Use this to audit and manage your API key inventory
- Consider revoking unused keys with DELETE_API_KEY action

**Prerequisites**:

- Must have created at least one API key using CREATE_API_KEY action
- API credentials must be set in environment variables
- Valid private key for wallet verification

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
│   ├── getSimplifiedMarkets.ts
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
