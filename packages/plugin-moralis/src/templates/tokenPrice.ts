export const getTokenPriceTemplate = `Given the most recent message only, extract the Solana token address that we need to fetch price for. This is specifically for Solana blockchain only.

Format the response as a single JSON object with this field:
- tokenAddress: the Solana token address (a base58 string)

Example response:
For "Get current price of Solana token 6Rwcmkz9yiYVM5EzyMcr4JsQPGEAWhcUvLvfBperYnUt":
\`\`\`json
{
  "tokenAddress": "6Rwcmkz9yiYVM5EzyMcr4JsQPGEAWhcUvLvfBperYnUt"
}
\`\`\`

{{recentMessages}}
Extract the Solana token address from the LAST message only and respond with a SINGLE JSON object. If the message is asking about tokens on other chains (like Ethereum/EVM), return null for tokenAddress.`;
