/**
 * Template for fetching market data for an ALI Agent's keys.
 */
export const getAliAgentKeyMarketDataTemplate = {
  name: 'GET_MARKET_DATA',
  description: "Retrieve market data (price, volume, liquidity) for an ALI Agent's keys.",
  parameters: {
    type: 'object',
    properties: {
      agentId: {
        type: 'string',
        description: "The identifier of the ALI Agent, formatted as 'tokenAddress:tokenId'.",
      },
      network: {
        type: 'string',
        description: "The blockchain network to query, either 'base' or 'ethereum'.",
        enum: ['base', 'ethereum'],
      },
    },
    required: ['agentId', 'network'],
  },
};
