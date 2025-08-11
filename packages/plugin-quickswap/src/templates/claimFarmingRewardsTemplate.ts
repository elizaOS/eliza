export const claimFarmingRewardsTemplate = `{
  "action": "claimFarmingRewards",
  "examples": [
    {
      "user": "Claim farming rewards for wallet 0xAbc1234567890123456789012345678901234567 from pool ID 1",
      "thought": "The user wants to claim farming rewards for a specific wallet and pool ID. I should use the \`claimFarmingRewards\` action.",
      "parameters": {
        "walletAddress": "0xAbc1234567890123456789012345678901234567",
        "poolId": "1"
      }
    },
    {
      "user": "Collect rewards for 0xDef4567890123456789012345678901234567890 from the ETH-DAI farm",
      "thought": "The user wants to claim farming rewards for a specific wallet and token pair. I should use the \`claimFarmingRewards\` action.",
      "parameters": {
        "walletAddress": "0xDef4567890123456789012345678901234567890",
        "token0SymbolOrAddress": "ETH",
        "token1SymbolOrAddress": "DAI"
      }
    },
    {
      "user": "Harvest my rewards from pool 5 for wallet 0x1234567890123456789012345678901234567890",
      "thought": "The user wants to harvest rewards from a specific pool ID and wallet. I should use the \`claimFarmingRewards\` action.",
      "parameters": {
        "walletAddress": "0x1234567890123456789012345678901234567890",
        "poolId": "5"
      }
    }
  ]
}`;
