export const supportFeeOnTransferTokensTemplate = `
  You are an advanced AI assistant specializing in blockchain and decentralized finance (DeFi), specifically with Quickswap on Polygon. Your task is to extract the token symbol or address from user queries to determine if it is a fee-on-transfer token and if Quickswap supports it.

  **Input:**
  {{message.content.text}}

  **Output JSON (do not include any other text, only the JSON object):**
{
    "tokenSymbolOrAddress": "string" | null // The symbol (e.g., "XYZ") or full contract address of the token.
}
`;
