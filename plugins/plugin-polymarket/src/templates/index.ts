export const getBestPriceTemplate = `
Extract the token ID and side (buy/sell) from the user's request to get the best price for a market.

Recent messages:
{{recentMessages}}

The user might ask things like:
- "Get best price for token [TOKEN_ID] on the buy side"
- "What's the sell price for market token [TOKEN_ID]?"
- "Show me the best bid for [TOKEN_ID]"
- "Get the ask price for token [TOKEN_ID]"

Examples of extraction patterns:
- "Get price for token 123456 side buy" -> tokenId: "123456", side: "buy"
- "What's the sell price for 789012" -> tokenId: "789012", side: "sell"
- "Show best bid for token xyz789" -> tokenId: "xyz789", side: "buy"
- "Get ask price for 456" -> tokenId: "456", side: "sell"

Note: "buy" side gets the best ask price (what you pay to buy), "sell" side gets the best bid price (what you receive when selling).

From the recent messages above, please extract:
- tokenId: The token identifier from the user's actual message
- side: Either "buy" or "sell" from the user's actual message

Return a JSON object with these parameters extracted from the user's message, not from the examples.
`;
