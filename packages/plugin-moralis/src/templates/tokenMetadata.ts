export const getTokenMetadataTemplate = `Given the most recent message only, extract the Solana token address to fetch metadata for. This is specifically for Solana blockchain only.

Format the response as a single JSON object with:
- tokenAddress: the Solana token address (a base58 string)

Example:
For "What's the FDV and total supply of SRMuApVNdxXokk5GT7XD5cUUgXMBCoAz2LHeuAoKWRt?":
\`\`\`json
{
  "tokenAddress": "SRMuApVNdxXokk5GT7XD5cUUgXMBCoAz2LHeuAoKWRt"
}
\`\`\`

{{recentMessages}}
Extract the Solana token address from the LAST message only and respond with a SINGLE JSON object. If asking about tokens on other chains (like Ethereum/EVM), return null for tokenAddress.`;
