/**
 * Template for extracting parameters to upgrade an iNFT's intelligence level.
 */
export const upgradeInftIntelligenceTemplate = {
  name: 'UPGRADE_INFT_INTELLIGENCE',
  description:
    'Upgrade the intelligence level of an iNFT by locking a specified amount of ALI tokens.',
  parameters: {
    type: 'object',
    properties: {
      inftId: {
        type: 'string',
        description: 'The unique identifier (token ID) of the iNFT to upgrade.',
      },
      aliAmount: {
        type: 'string',
        description:
          "The amount of ALI tokens to lock for the upgrade, specified in ether (e.g., '3000').",
      },
    },
    required: ['inftId', 'aliAmount'],
  },
};
