export const estimateGasFeesTemplate = `{
  "action": "estimateGasFees",
  "examples": [
    {
      "user": "Estimate gas fees for a swap",
      "thought": "The user wants to estimate gas fees for a swap. I should use the \`estimateGasFees\` action.",
      "parameters": {
        "transactionType": "swap"
      }
    },
    {
      "user": "How much gas will it cost to add liquidity?",
      "thought": "The user wants to estimate gas fees for adding liquidity. I should use the \`estimateGasFees\` action.",
      "parameters": {
        "transactionType": "addLiquidity"
      }
    },
    {
      "user": "What are the fees for approving USDC?",
      "thought": "The user wants to estimate gas fees for approving a token. I should use the \`estimateGasFees\` action.",
      "parameters": {
        "transactionType": "approve",
        "inputTokenSymbolOrAddress": "USDC"
      }
    },
    {
      "user": "Estimate gas for removing liquidity from WMATIC-USDC pool",
      "thought": "The user wants to estimate gas fees for removing liquidity. I should use the \`estimateGasFees\` action.",
      "parameters": {
        "transactionType": "removeLiquidity",
        "inputTokenSymbolOrAddress": "WMATIC",
        "outputTokenSymbolOrAddress": "USDC"
      }
    },
    {
      "user": "Estimate gas for a swap of 10 WMATIC to USDC",
      "thought": "The user wants to estimate gas fees for a swap with specific tokens and amount. I should use the \`estimateGasFees\` action.",
      "parameters": {
        "transactionType": "swap",
        "amount": "10",
        "inputTokenSymbolOrAddress": "WMATIC",
        "outputTokenSymbolOrAddress": "USDC"
      }
    }
  ]
}`;
