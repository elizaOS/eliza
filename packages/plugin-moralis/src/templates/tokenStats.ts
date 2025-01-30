export const getTokenStatsTemplate = `Given the most recent message only, extract the Solana token address that we need to fetch aggregated stats for. This is specifically for Solana blockchain only.

Only extract information from the last message in the conversation. Ignore any previous messages or historical requests.

Format the response as a single JSON object with this field:
- tokenAddress: the Solana token address (a base58 string)

Example response:
For "Get aggregated stats for Solana token SRMuApVNdxXokk5GT7XD5cUUgXMBCoAz2LHeuAoKWRt":
\`\`\`json
{
  "tokenAddress": "SRMuApVNdxXokk5GT7XD5cUUgXMBCoAz2LHeuAoKWRt"
}
\`\`\`

{{recentMessages}}
Extract the Solana token address from the LAST message only and respond with a SINGLE JSON object. If the message is asking for tokens on other chains (like Ethereum/EVM), return null for tokenAddress.`;
