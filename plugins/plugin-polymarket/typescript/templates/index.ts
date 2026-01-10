/**
 * @elizaos/plugin-polymarket LLM Templates
 *
 * Prompt templates for extracting parameters from natural language
 * using LLM-based parsing.
 */

// =============================================================================
// Market Templates
// =============================================================================

export const retrieveAllMarketsTemplate = `You are an AI assistant. Your task is to extract optional filter parameters for retrieving Polymarket prediction markets.

Review the recent messages:
<recent_messages>
{{recentMessages}}
</recent_messages>

Based on the conversation, identify any filters the user wants to apply:
- category: Market category filter (e.g., "politics", "sports", "crypto") - optional
- active: Whether to only show active markets (true/false) - optional  
- limit: Maximum number of results to return - optional

Respond with a JSON object containing only the extracted values.
The JSON should have this structure:
{
    "category"?: string,
    "active"?: boolean,
    "limit"?: number
}

If no specific filters are mentioned, respond with an empty object: {}
`;

export const getSimplifiedMarketsTemplate = `You are an AI assistant. Your task is to extract optional pagination parameters for retrieving simplified Polymarket markets.

Review the recent messages:
<recent_messages>
{{recentMessages}}
</recent_messages>

Based on the conversation, identify any pagination cursor:
- next_cursor: Pagination cursor for fetching next page (if mentioned)

Respond with a JSON object containing only the extracted values.
The JSON should have this structure:
{
    "next_cursor"?: string
}

If no pagination cursor is mentioned, respond with an empty object: {}
`;

export const getSamplingMarketsTemplate = `You are an AI assistant. Your task is to extract optional pagination parameters for retrieving Polymarket markets with rewards enabled.

Review the recent messages:
<recent_messages>
{{recentMessages}}
</recent_messages>

Based on the conversation, identify any pagination cursor:
- next_cursor: Pagination cursor for fetching next page (if mentioned)

Respond with a JSON object containing only the extracted values.
The JSON should have this structure:
{
    "next_cursor"?: string
}

If no pagination cursor is mentioned, respond with an empty object: {}
`;

export const getMarketTemplate = `You are an AI assistant. Your task is to extract market identification parameters from the user's message.

Review the recent messages:
<recent_messages>
{{recentMessages}}
</recent_messages>

Based on the conversation, identify:
- marketId: The specific market condition ID (if mentioned) - usually a 0x... hex string
- query: Search terms or keywords to find markets
- tokenId: Specific token ID (if mentioned) - numeric string

Respond with a JSON object containing only the extracted values.
The JSON should have this structure:
{
    "marketId"?: string,
    "query"?: string,
    "tokenId"?: string
}

If no valid market identifier is found, respond with:
{
    "error": "Market identifier not found. Please specify a market ID, search terms, or token ID."
}
`;

// =============================================================================
// Order Templates
// =============================================================================

export const orderTemplate = `You are an AI assistant. Your task is to extract order parameters from the user's message.

Review the recent messages:
<recent_messages>
{{recentMessages}}
</recent_messages>

Based on the conversation, identify:
- tokenId: The token ID for the market position (required) - can be explicit ID or extracted from market name
- side: "buy" or "sell" (required)
- price: The price per share (0-1.0) (required)
- size: The quantity/size of the order (required)
- orderType: "limit" or "market" (optional, defaults to "limit")

**Token ID Extraction Rules:**
1. Look for explicit token IDs (long numeric strings)
2. Look for market names if no explicit ID provided
3. Accept shorter token IDs for testing purposes

Respond with a JSON object containing the extracted values:
{
    "tokenId": string,
    "side": "buy" | "sell",
    "price": number,
    "size": number,
    "orderType"?: "limit" | "market",
    "marketName"?: string
}

If any required parameters are missing, respond with:
{
    "error": "Missing required order parameters. Please specify tokenId, side (buy/sell), price, and size."
}
`;

// =============================================================================
// Order Book Templates
// =============================================================================

export const getOrderBookTemplate = `You are an AI assistant. Your task is to extract token identification parameters for retrieving order book data.

Review the recent messages:
<recent_messages>
{{recentMessages}}
</recent_messages>

Based on the conversation, identify:
- tokenId: The specific token ID for which to retrieve the order book (required)

Look for numbers following words like "token", "for token", "token ID", etc.

Respond with a JSON object:
{
    "tokenId"?: string
}

If no valid token identifier is found, respond with:
{
    "error": "Token identifier not found. Please specify a token ID for the order book."
}
`;

export const getOrderBookDepthTemplate = `You are an AI assistant. Your task is to extract token identification parameters for retrieving order book depth data.

Review the recent messages:
<recent_messages>
{{recentMessages}}
</recent_messages>

Based on the conversation, identify:
- tokenIds: Array of token IDs for which to retrieve order book depth (required)

Look for multiple token IDs separated by commas, spaces, or other delimiters.

Respond with a JSON object:
{
    "tokenIds"?: string[]
}

If no valid token identifiers are found, respond with:
{
    "error": "Token identifiers not found. Please specify one or more token IDs for order book depth."
}
`;

export const getBestPriceTemplate = `You are an AI assistant. Your task is to extract token ID and side parameters for retrieving the best price.

Review the recent messages:
<recent_messages>
{{recentMessages}}
</recent_messages>

Based on the conversation, identify:
- tokenId: The token identifier (required)
- side: Either "buy" or "sell" (required) - note: "bid" maps to "sell", "ask" maps to "buy"

Respond with a JSON object:
{
    "tokenId"?: string,
    "side"?: "buy" | "sell"
}

If parameters not found, respond with:
{
    "error": "Token ID or side not found. Please specify a token ID and side (buy/sell)."
}
`;

export const getMidpointPriceTemplate = `You are an AI assistant. Your task is to extract token identification parameters for retrieving midpoint price data.

Review the recent messages:
<recent_messages>
{{recentMessages}}
</recent_messages>

Based on the conversation, identify:
- tokenId: The specific token ID for which to retrieve the midpoint price (required)

Respond with a JSON object:
{
    "tokenId"?: string
}

If no valid token identifier is found, respond with:
{
    "error": "Token identifier not found. Please specify a token ID for the midpoint price."
}
`;

export const getSpreadTemplate = `You are an AI assistant. Your task is to extract token identification parameters for retrieving spread data.

Review the recent messages:
<recent_messages>
{{recentMessages}}
</recent_messages>

Based on the conversation, identify:
- tokenId: The specific token ID for which to retrieve the spread (required)

Respond with a JSON object:
{
    "tokenId"?: string
}

If no valid token identifier is found, respond with:
{
    "error": "Token identifier not found. Please specify a token ID for the spread."
}
`;

// =============================================================================
// Order Management Templates
// =============================================================================

export const getOrderDetailsTemplate = `You are an AI assistant. Your task is to extract the order ID for retrieving order details.

Review the recent messages:
<recent_messages>
{{recentMessages}}
</recent_messages>

Based on the conversation, identify:
- orderId: The specific order ID (required)

Respond with a JSON object:
{
    "orderId"?: string
}

If no valid order ID is found, respond with:
{
    "error": "Order ID not found. Please specify an order ID."
}
`;

export const checkOrderScoringTemplate = `You are an AI assistant. Your task is to extract one or more order IDs for checking their scoring status.

Review the recent messages:
<recent_messages>
{{recentMessages}}
</recent_messages>

Based on the conversation, identify:
- orderIds: An array of specific order IDs (required)

Respond with a JSON object:
{
    "orderIds"?: string[]
}

If no valid order IDs are found, respond with:
{
    "error": "Order ID(s) not found. Please specify one or more order IDs."
}
`;

export const getActiveOrdersTemplate = `You are an AI assistant. Your task is to extract parameters for retrieving active orders.

Review the recent messages:
<recent_messages>
{{recentMessages}}
</recent_messages>

Based on the conversation, identify:
- marketId: The market condition ID (required)
- assetId: The specific asset ID (token ID) within that market (optional)

Respond with a JSON object:
{
    "marketId"?: string,
    "assetId"?: string
}

If the marketId is not found, respond with:
{
    "error": "Market ID not found. Please specify a market ID."
}
`;

// =============================================================================
// Trade History Template
// =============================================================================

export const getTradeHistoryTemplate = `You are an AI assistant. Your task is to extract parameters for retrieving trade history.

Review the recent messages:
<recent_messages>
{{recentMessages}}
</recent_messages>

Based on the conversation, identify any of the following optional filters:
- userAddress: The user's wallet address (e.g., 0x...)
- marketId: The specific market condition ID
- tokenId: The specific asset ID (token ID)
- fromDate: A start date or time period for the trades
- toDate: An end date or time period for the trades
- limit: Maximum number of trades to return
- nextCursor: Pagination cursor for fetching the next page

Respond with a JSON object containing only the extracted values:
{
    "userAddress"?: string,
    "marketId"?: string,
    "tokenId"?: string,
    "fromDate"?: string,
    "toDate"?: string,
    "limit"?: number,
    "nextCursor"?: string
}

If no specific filters are mentioned, respond with an empty object: {}
`;

// =============================================================================
// Account Template
// =============================================================================

export const getAccountAccessStatusTemplate = `You are an AI assistant. Your task is to confirm if the user wants to check their Polymarket account access status.

Review the recent messages:
<recent_messages>
{{recentMessages}}
</recent_messages>

If the intent is to get account access status (certification, API key status), respond with an empty object: {}

If the intent is unclear or unrelated, respond with:
{
    "error": "The query does not seem to be about account access status."
}
`;

// =============================================================================
// WebSocket Template
// =============================================================================

export const setupWebsocketTemplate = `Your task is to extract parameters for subscribing to Polymarket WebSocket channels.

Extract the following parameters if present:
- markets: An array of market condition IDs (strings, usually 0x prefixed hex strings)
- userId: The user's wallet address (a string, 0x prefixed hex string)

User query: """{{message.content.text}}"""

Respond with a JSON object:
{
  "markets"?: string[],
  "userId"?: string
}

If you cannot find required parameters, respond with:
{
  "error": "Brief explanation of what's missing"
}
`;
