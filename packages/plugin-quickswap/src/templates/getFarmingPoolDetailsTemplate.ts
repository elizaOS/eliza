export const getFarmingPoolDetailsTemplate = `{
  "action": "getFarmingPoolDetails",
  "examples": [
    {
      "user": "Get farming pool details for pool ID 1",
      "thought": "The user wants to get farming pool details. I should use the \`getFarmingPoolDetails\` action.",
      "parameters": {
        "poolId": "1"
      }
    },
    {
      "user": "Show me the details of the WMATIC-USDC farm",
      "thought": "The user is asking for farming pool details by token pair. I should use the \`getFarmingPoolDetails\` action with the token pair.",
      "parameters": {
        "token0SymbolOrAddress": "WMATIC",
        "token1SymbolOrAddress": "USDC"
      }
    },
    {
      "user": "What are the current metrics for the Quickswap farm between ETH and DAI?",
      "thought": "The user is asking for farming pool details by token pair. I should use the \`getFarmingPoolDetails\` action with the token pair.",
      "parameters": {
        "token0SymbolOrAddress": "ETH",
        "token1SymbolOrAddress": "DAI"
      }
    }
  ]
}`;
