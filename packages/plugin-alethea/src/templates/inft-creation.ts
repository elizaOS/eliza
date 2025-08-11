/**
 * Template for creating an iNFT by fusing a base NFT with a Personality Pod.
 */
export const createInftTemplate = {
  name: 'CREATE_INFT',
  description:
    'Create an iNFT by fusing a base NFT with a Personality Pod, requiring an initial lock of ALI tokens.',
  parameters: {
    type: 'object',
    properties: {
      nftContract: {
        type: 'string',
        description: "The contract address of the base NFT (the 'body').",
      },
      nftId: {
        type: 'string',
        description: 'The token ID of the base NFT.',
      },
      podContract: {
        type: 'string',
        description: "The contract address of the Personality Pod NFT (the 'soul').",
      },
      podId: {
        type: 'string',
        description: 'The token ID of the Personality Pod.',
      },
      aliValue: {
        type: 'string',
        description:
          "The initial amount of ALI tokens to lock with the iNFT, specified in ether (e.g., '100').",
      },
    },
    required: ['nftContract', 'nftId', 'podContract', 'podId', 'aliValue'],
  },
};
