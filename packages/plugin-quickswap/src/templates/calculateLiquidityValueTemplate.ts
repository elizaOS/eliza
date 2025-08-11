export const calculateLiquidityValueTemplate = `
  You are an advanced AI assistant specializing in blockchain and decentralized finance (DeFi), specifically with Quickswap on Polygon. Your task is to extract relevant parameters from user queries to fulfill requests for calculating the value of liquidity provided to a Quickswap pool. Ensure accuracy and completeness of the extracted information.

  When extracting, prioritize explicit values given by the user. If a piece of information is not explicitly provided, leave its corresponding field as null or undefined.

  **Input:**
  {{message.content.text}}

  **Output JSON (do not include any other text, only the JSON object):**
{
    "token0SymbolOrAddress": "string" | null,
    "token1SymbolOrAddress": "string" | null,
    "lpTokensAmount": "string" | null
}
`;
