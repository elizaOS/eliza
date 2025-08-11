import { Action, IAgentRuntime, Memory, State, HandlerCallback, logger } from '@elizaos/core';
import { z } from 'zod';

// Schema for validator info query parameters
const validatorInfoSchema = z.object({
  validatorId: z.string().describe('The validator ID to query information for'),
});

export const heimdallValidatorInfoAction: Action = {
  name: 'POLYGON_HEIMDALL_VALIDATOR_INFO',
  similes: [
    'GET_HEIMDALL_VALIDATOR_INFO',
    'HEIMDALL_VALIDATOR_DETAILS',
    'QUERY_VALIDATOR_INFO',
    'VALIDATOR_INFO_HEIMDALL',
    'CHECK_VALIDATOR_HEIMDALL',
  ].map((s) => `POLYGON_${s}`),
  description: 'Queries validator information from Heimdall network (read-only operation)',
  validate: async (runtime: IAgentRuntime, message: Memory) => {
    logger.log('Validating Heimdall validator info query...');
    return true;
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: any,
    callback?: HandlerCallback
  ) => {
    logger.log('Executing Heimdall validator info query...');

    try {
      // Extract validator ID from message
      const params = validatorInfoSchema.parse({
        validatorId: options?.validatorId || extractValidatorId(message.content.text || ''),
      });

      // Get Heimdall RPC URL from environment
      const heimdallUrl =
        runtime.getSetting('HEIMDALL_RPC_URL') || 'https://heimdall-api.polygon.technology';

      // Query validator information
      const response = await fetch(`${heimdallUrl}/staking/validator/${params.validatorId}`);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const validatorData = await response.json();

      const result = {
        success: true,
        validatorId: params.validatorId,
        data: validatorData,
        message: `Successfully retrieved validator ${params.validatorId} information`,
      };

      if (callback) {
        const validator = validatorData.result;
        callback({
          text:
            `**Heimdall Validator Info**\n\n` +
            `**Validator ID:** ${params.validatorId}\n` +
            `**Power:** ${validator?.power || 'N/A'}\n` +
            `**Jailed:** ${validator?.jailed ? 'Yes' : 'No'}\n` +
            `**Signer Address:** ${validator?.signer || 'N/A'}\n` +
            `**Start Epoch:** ${validator?.startEpoch || 'N/A'}\n` +
            `**End Epoch:** ${validator?.endEpoch || 'N/A'}\n` +
            `**Last Updated:** ${validator?.last_updated || 'N/A'}\n` +
            `**Nonce:** ${validator?.nonce || 'N/A'}\n\n` +
            `Query successful`,
          content: result,
        });
      }

      return result;
    } catch (error) {
      logger.error('Error querying Heimdall validator info:', error);

      const errorResult = {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error occurred',
        message: 'Failed to query validator information from Heimdall',
      };

      if (callback) {
        callback({
          text:
            `**Heimdall Validator Query Failed**\n\n` +
            `**Error:** ${errorResult.error}\n\n` +
            `This could be due to:\n` +
            `• Invalid validator ID\n` +
            `• Network connectivity issues\n` +
            `• Heimdall endpoint unavailable`,
          content: errorResult,
        });
      }

      return errorResult;
    }
  },
  examples: [
    [
      {
        name: '{{user1}}',
        content: { text: 'Get validator info for validator 1 on Heimdall on Polygon' },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'Getting validator info for validator 1 on Heimdall on Polygon',
          action: 'POLYGON_HEIMDALL_VALIDATOR_INFO',
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: { text: 'Show me details for Heimdall validator 42 on Polygon' },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'Showing details for Heimdall validator 42 on Polygon',
          action: 'POLYGON_HEIMDALL_VALIDATOR_INFO',
        },
      },
    ],
  ],
};

// Helper function to extract validator ID from text
function extractValidatorId(text: string): string {
  // Try multiple patterns to extract validator ID
  const patterns = [
    /validator\s+(\d+)/i, // "validator 42"
    /validator\s+ID\s+(\d+)/i, // "validator ID 42"
    /ID\s+(\d+)/i, // "ID 42"
    /\b(\d+)\b/, // any standalone number (fallback)
  ];

  for (const pattern of patterns) {
    const matches = text.match(pattern);
    if (matches && matches[1]) {
      return matches[1];
    }
  }

  return '1'; // Default to validator 1
}
