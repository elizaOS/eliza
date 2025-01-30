export const getPairStatsTemplate = `Given the most recent message only, extract the Solana pair address that we need to fetch stats for. This is specifically for Solana blockchain only.

Only extract information from the last message in the conversation. Ignore any previous messages or historical requests.

Format the response as a single JSON object with this field:
- pairAddress: the Solana pair address (a base58 string)

Example response:
For "Get stats for Solana pair A8nPhpCJqtqHdqUk35Uj9Hy2YsGXFkCZGuNwvkD3k7VC":
\`\`\`json
{
  "pairAddress": "A8nPhpCJqtqHdqUk35Uj9Hy2YsGXFkCZGuNwvkD3k7VC"
}
\`\`\`

{{recentMessages}}
Extract the Solana pair address from the LAST message only and respond with a SINGLE JSON object. If the message is asking for pairs on other chains (like Ethereum/EVM), return null for pairAddress.`;
