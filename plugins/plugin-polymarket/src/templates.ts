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

If no specific filters are mentioned, you MUST respond with the following JSON structure:
{
    "error": "No specific filters requested. Fetching all available markets."
}
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

If no pagination cursor is mentioned, you MUST respond with the following JSON structure:
{
    "error": "No pagination cursor requested. Fetching first page."
}
`;

export const getSamplingMarketsTemplate = `You are an AI assistant. Your task is to extract optional pagination parameters for retrieving Polymarket markets with rewards enabled (sampling markets).

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

If no pagination cursor is mentioned, you MUST respond with the following JSON structure:
{
    "error": "No pagination cursor requested. Fetching first page of sampling markets."
}
`;

export const getMarketTemplate = `You are an AI assistant. Your task is to extract market identification parameters from the user's message.

Review the recent messages:
<recent_messages>
{{recentMessages}}
</recent_messages>

Based on the conversation, identify:
- marketId: The specific market condition ID (if mentioned)
- query: Search terms or keywords to find markets
- tokenId: Specific token ID (if mentioned)

Respond with a JSON object containing only the extracted values.
The JSON should have this structure:
{
    "marketId"?: string,
    "query"?: string,
    "tokenId"?: string
}

If no valid market identifier is found, you MUST respond with the following JSON structure:
{
    "error": "Market identifier not found. Please specify a market ID, search terms, or token ID."
}
`;

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
1. Look for explicit token IDs (long numeric strings like "71321045679252212594626385532706912750332728571942532289631379312455583992563")
2. Look for market names like "Nuggets NBA Champion", "Chiefs vs Raiders", "Ant-Man movie"
3. If only market name is provided, set tokenId to "MARKET_NAME_LOOKUP" and include the market name in the response
4. Accept shorter token IDs (like "123456") for testing purposes

**Examples:**
- "Buy 5 shares at $0.75 for the Nuggets NBA Champion market" → tokenId: "MARKET_NAME_LOOKUP", marketName: "Nuggets NBA Champion"
- "Place buy order for token 71321045679252212594626385532706912750332728571942532289631379312455583992563" → tokenId: "71321045679252212594626385532706912750332728571942532289631379312455583992563"
- "Buy tokens at 50 cents for Chiefs vs Raiders" → tokenId: "MARKET_NAME_LOOKUP", marketName: "Chiefs vs Raiders"

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
    "error": "Missing required order parameters. Please specify tokenId (or market name), side (buy/sell), price, and size."
}`;

export const getOrderBookTemplate = `You are an AI assistant. Your task is to extract token identification parameters for retrieving order book data.

Review the recent messages:
<recent_messages>
{{recentMessages}}
</recent_messages>

Based on the conversation, identify:
- tokenId: The specific token ID for which to retrieve the order book (required)
- query: Search terms or keywords that might contain a token ID

Look for:
- Numbers following words like "token", "for token", "token ID", etc.
- Standalone numbers that could be token IDs

Examples:
- "Show order book for token 123456" → tokenId: "123456"
- "Get order book 789012" → tokenId: "789012"
- "ORDER_BOOK 345678" → tokenId: "345678"
- "token 999999" → tokenId: "999999"

Respond with a JSON object containing only the extracted values.
The JSON should have this structure:
{
    "tokenId"?: string,
    "query"?: string
}

If you find a token ID, always include it in the tokenId field.
If no valid token identifier is found, you MUST respond with the following JSON structure:
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
- query: Search terms or keywords that might contain token IDs

Look for:
- Numbers following words like "token", "tokens", "for token", "token ID", etc.
- Standalone numbers that could be token IDs
- Multiple token IDs separated by commas, spaces, or other delimiters
- Any numeric identifiers in the message

Examples:
- "Show order book depth for token 123456" → tokenIds: ["123456"]
- "Get depth for tokens 123456, 789012" → tokenIds: ["123456", "789012"]
- "ORDER_BOOK_DEPTH 345678 999999" → tokenIds: ["345678", "999999"]
- "tokens 111111 222222 333333" → tokenIds: ["111111", "222222", "333333"]

Respond with a JSON object containing only the extracted values.
The JSON should have this structure:
{
    "tokenIds"?: string[],
    "query"?: string
}

If you find token IDs, always include them in the tokenIds array.
If no valid token identifiers are found, you MUST respond with the following JSON structure:
{
    "error": "Token identifiers not found. Please specify one or more token IDs for order book depth."
}
`;

export const getBestPriceTemplate = `You are an AI assistant. Your task is to extract token ID and side parameters for retrieving the best price for a market.

Review the recent messages:
<recent_messages>
{{recentMessages}}
</recent_messages>

Based on the conversation, identify:
- tokenId: The token identifier (required)
- side: Either "buy" or "sell" (required)

Look for:
- Numbers following words like "token", "for token", "token ID", etc.
- Standalone numbers that could be token IDs
- Side indicators like "buy", "sell", "bid", "ask"
- Note: "bid" maps to "sell" side, "ask" maps to "buy" side

Examples:
- "Get best price for token 123456 on buy side" → tokenId: "123456", side: "buy"
- "What's the sell price for token 789012" → tokenId: "789012", side: "sell"
- "Show best bid for token 456789" → tokenId: "456789", side: "sell"
- "Get ask price for 999999" → tokenId: "999999", side: "buy"

Respond with a JSON object containing only the extracted values.
The JSON should have this structure:
{
    "tokenId"?: string,
    "side"?: "buy" | "sell"
}

If you find both tokenId and side, include them in the response.
If no valid parameters are found, you MUST respond with the following JSON structure:
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
- query: Search terms or keywords that might contain a token ID

Look for:
- Numbers following words like "token", "for token", "token ID", "market", etc.
- Standalone numbers that could be token IDs
- Any numeric identifiers in the message
- References to "midpoint", "mid price", "middle price"

Examples:
- "Get midpoint price for token 123456" → tokenId: "123456"
- "Show midpoint for market 789012" → tokenId: "789012"
- "MIDPOINT_PRICE 345678" → tokenId: "345678"
- "What's the mid price for token 999999" → tokenId: "999999"

Respond with a JSON object containing only the extracted values.
The JSON should have this structure:
{
    "tokenId"?: string,
    "query"?: string
}

If you find a token ID, always include it in the tokenId field.
If no valid token identifier is found, you MUST respond with the following JSON structure:
{
    "error": "Token identifier not found. Please specify a token ID for the midpoint price."
}
`;

export const getSpreadTemplate = `You are an AI assistant. Your task is to extract token identification parameters for retrieving spread data for a market.

Review the recent messages:
<recent_messages>
{{recentMessages}}
</recent_messages>

Based on the conversation, identify:
- tokenId: The specific token ID for which to retrieve the spread (required)
- query: Search terms or keywords that might contain a token ID

Look for:
- Numbers following words like "token", "for token", "token ID", "market", etc.
- Standalone numbers that could be token IDs
- Any numeric identifiers in the message
- References to "spread", "bid-ask spread", "market spread"

Examples:
- "Get spread for token 123456" → tokenId: "123456"
- "Show spread for market 789012" → tokenId: "789012"
- "SPREAD 345678" → tokenId: "345678"
- "What's the spread for token 999999" → tokenId: "999999"
- "Show me the bid-ask spread for 777777" → tokenId: "777777"

Respond with a JSON object containing only the extracted values.
The JSON should have this structure:
{
    "tokenId"?: string,
    "query"?: string
}

If you find a token ID, always include it in the tokenId field.
If no valid token identifier is found, you MUST respond with the following JSON structure:
{
    "error": "Token identifier not found. Please specify a token ID for the spread."
}
`;

export const getOrderDetailsTemplate = `You are an AI assistant. Your task is to extract the order ID for retrieving order details.

Review the recent messages:
<recent_messages>
{{recentMessages}}
</recent_messages>

Based on the conversation, identify:
- orderId: The specific order ID (required)

Look for:
- Alphanumeric strings following "order ID", "order", "ID"
- Phrases like "details for order XYZ", "get order ABC"

Examples:
- "Get details for order 123xyz"
  { "orderId": "123xyz" }
- "Show me order abc789"
  { "orderId": "abc789" }
- "What are the details for 0x123abc?"
  { "orderId": "0x123abc" }

Respond with a JSON object containing only the extracted values.
The JSON should have this structure:
{
    "orderId"?: string
}

If no valid order ID is found, you MUST respond with the following JSON structure:
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

Look for:
- Alphanumeric strings following "order ID", "orders", "IDs"
- Phrases like "check scoring for orders XYZ, ABC", "are orders 123 and 456 scoring?"
- Comma or space-separated lists of order IDs.

Examples:
- "Are orders 123xyz and abc789 scoring?"
  { "orderIds": ["123xyz", "abc789"] }
- "Check scoring status for order 0x123abc"
  { "orderIds": ["0x123abc"] }
- "Show me if myOrder1, myOrder2, myOrder3 are scoring"
  { "orderIds": ["myOrder1", "myOrder2", "myOrder3"] }

Respond with a JSON object containing only the extracted values.
The JSON should have this structure:
{
    "orderIds"?: string[]
}

If no valid order IDs are found, you MUST respond with the following JSON structure:
{
    "error": "Order ID(s) not found. Please specify one or more order IDs."
}
`;

export const getActiveOrdersTemplate = `You are an AI assistant. Your task is to extract parameters for retrieving active orders for a specific market.

Review the recent messages:
<recent_messages>
{{recentMessages}}
</recent_messages>

Based on the conversation, identify:
- marketId: The market condition ID (required)
- assetId: The specific asset ID (token ID) within that market (optional, but often implied or can be derived if not explicitly stated by user for a binary market - you can initially assume the first token if not clear or ask user to clarify if multiple tokens exist for the market and it's ambiguous)

Look for:
- "market ID", "market", "condition ID" followed by an identifier for marketId.
- "token ID", "asset ID", "token" followed by an identifier for assetId.
- Phrases like "active orders for market X and token Y", "open orders on market Z"

Examples:
- "Show active orders for market 0xMarket123 and token 0xTokenABC"
  { "marketId": "0xMarket123", "assetId": "0xTokenABC" }
- "Get open orders for market condition_def456 asset_xyz789"
  { "marketId": "condition_def456", "assetId": "asset_xyz789" }
- "What are the active orders on market someMarketID?"
  { "marketId": "someMarketID" } // assetId might be omitted if it can be inferred or if the user should be prompted for it

Respond with a JSON object containing only the extracted values.
The JSON should have this structure:
{
    "marketId"?: string,
    "assetId"?: string
}

If the marketId is not found, you MUST respond with the following JSON structure:
{
    "error": "Market ID not found. Please specify a market ID."
}

If marketId is found but assetId is ambiguous or missing and seems required, you can omit assetId or include an additional field like "clarification_needed": "assetId". For now, prioritize extracting what is available.
`;

export const getTradeHistoryTemplate = `You are an AI assistant. Your task is to extract parameters for retrieving a user's trade history.

Review the recent messages:
<recent_messages>
{{recentMessages}}
</recent_messages>

Based on the conversation, identify any of the following optional filters:
- userAddress: The user's wallet address (e.g., 0x...).
- marketId: The specific market condition ID.
- tokenId: The specific asset ID (token ID).
- fromDate: A start date or time period for the trades (e.g., "yesterday", "last week", "2023-01-15", "3 days ago").
- toDate: An end date or time period for the trades (e.g., "today", "2023-01-20").
- limit: Maximum number of trades to return (e.g., 25, 100).
- nextCursor: Pagination cursor for fetching the next page of results.

Look for:
- Wallet addresses (0x...).
- Identifiers for markets or tokens.
- Phrases like "trades for user X", "my trade history", "trades on market Y".
- Date/time references like "since last Monday", "between date A and date B", "in the last 24 hours".
- Keywords like "limit", "cursor", "page".

Examples:
- "Show my trade history for market 0xMarket123 from last week, limit 50"
  { "marketId": "0xMarket123", "fromDate": "last week", "limit": 50 }
- "Get trades for user 0xUserAddress on token 0xTokenABC since 2023-05-01 until 2023-05-10"
  { "userAddress": "0xUserAddress", "tokenId": "0xTokenABC", "fromDate": "2023-05-01", "toDate": "2023-05-10" }
- "Fetch next page of my trades with cursor XYZ123"
  { "nextCursor": "XYZ123" }
- "What were my trades yesterday?"
  { "fromDate": "yesterday", "toDate": "yesterday" } // Or just fromDate: "yesterday"

Respond with a JSON object containing only the extracted values.
All fields are optional. The JSON should have this structure:
{
    "userAddress"?: string,
    "marketId"?: string,
    "tokenId"?: string,
    "fromDate"?: string, // Extracted as string, will be parsed by the action
    "toDate"?: string,   // Extracted as string, will be parsed by the action
    "limit"?: number,
    "nextCursor"?: string
}

If no specific filters are mentioned that can be mapped to these parameters, you can respond with an empty JSON object {} or a JSON object indicating no filters, for example:
{
    "info": "No specific trade history filters identified. Will attempt to fetch recent trades for the current user if identifiable, or all trades if no user context."
}
`;

export const getAccountAccessStatusTemplate = `You are an AI assistant. Your task is to confirm if the user wants to check their Polymarket account access status, such as U.S. certification requirements.

Review the recent messages:
<recent_messages>
{{recentMessages}}
</recent_messages>

Based on the conversation, determine if the user is asking about:
- Account status
- Certification requirements (e.g., "Am I certified?", "Do I need U.S. certification?")
- API key details or access levels

If the intent is to get account access status, respond with an empty JSON object:
{}

If the intent is unclear or unrelated to account access status, respond with:
{
    "error": "The query does not seem to be about account access status. Please clarify if you want to check your Polymarket account certification or API key status."
}

Examples:
- "Check my account access"
  {}
- "Am I certified to trade on Polymarket?"
  {}
- "What's my API key status?"
  {}
- "Show me the weather tomorrow"
  { "error": "The query does not seem to be about account access status..." }
`;

export const setupWebsocketTemplate = `
Your task is to extract parameters for subscribing to Polymarket WebSocket channels from the user query.
Extract the following parameters if present:
- markets: An array of market condition IDs (strings, usually 0x prefixed hex strings).
- userId: The user's wallet address (a string, 0x prefixed hex string).

User query: """{{message.content.text}}"""

If you cannot find a required parameter, or if the query is ambiguous, set "error" to a brief explanation.
If the user explicitly states they want to connect without specific market or user subscriptions (e.g., just to open the connection), output empty arrays/strings for optional fields if not specified.

Example 1:
User query: "Subscribe to market 0x123 and 0x456, and my user ID 0xabc."
Output:
{
  "markets": ["0x123", "0x456"],
  "userId": "0xabc"
}

Example 2:
User query: "Listen to my trades."
Output:
{
  "error": "User ID (wallet address) is required to listen to your trades. Please provide it."
}

Example 3:
User query: "Connect to Polymarket websockets for market 0xdef."
Output:
{
  "markets": ["0xdef"]
}

Output JSON:
`;
