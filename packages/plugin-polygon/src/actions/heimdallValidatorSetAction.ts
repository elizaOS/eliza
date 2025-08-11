import { Action, IAgentRuntime, Memory, State, HandlerCallback, logger } from '@elizaos/core';

export const heimdallValidatorSetAction: Action = {
  name: 'POLYGON_HEIMDALL_VALIDATOR_SET',
  similes: [
    'GET_HEIMDALL_VALIDATOR_SET',
    'HEIMDALL_VALIDATORS',
    'QUERY_VALIDATOR_SET',
    'VALIDATOR_SET_HEIMDALL',
    'LIST_HEIMDALL_VALIDATORS',
  ].map((s) => `POLYGON_${s}`),
  description: 'Queries the current validator set from Heimdall network (read-only operation)',
  validate: async (runtime: IAgentRuntime, message: Memory) => {
    logger.log('Validating Heimdall validator set query...');
    return true;
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: any,
    callback?: HandlerCallback
  ) => {
    logger.log('Executing Heimdall validator set query...');

    try {
      // Get Heimdall RPC URL from environment
      const heimdallUrl =
        runtime.getSetting('HEIMDALL_RPC_URL') || 'https://heimdall-api.polygon.technology';

      // Query current validator set
      const response = await fetch(`${heimdallUrl}/staking/validator-set`);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const validatorSetData = await response.json();
      const validators = validatorSetData.result?.validators || [];

      const result = {
        success: true,
        validatorCount: validators.length,
        data: validatorSetData,
        message: `Successfully retrieved validator set with ${validators.length} validators`,
      };

      // Format validator list for display
      const validatorSummary = validators
        .slice(0, 10)
        .map(
          (validator: any, index: number) =>
            `${index + 1}. **Validator ${validator.ID || 'N/A'}**\n` +
            `   • Power: ${validator.power || 'N/A'}\n` +
            `   • Jailed: ${validator.jailed ? 'Yes' : 'No'}\n` +
            `   • Address: ${validator.signer || 'N/A'}`
        )
        .join('\n\n');

      const displayText =
        validators.length > 10
          ? `${validatorSummary}\n\n... and ${validators.length - 10} more validators`
          : validatorSummary;

      if (callback) {
        callback({
          text:
            `**Heimdall Validator Set**\n\n` +
            `**Total Validators:** ${validators.length}\n` +
            `**Active Set:** ${validators.filter((v: any) => !v.jailed).length}\n` +
            `**Jailed:** ${validators.filter((v: any) => v.jailed).length}\n\n` +
            `**Top Validators:**\n\n${displayText}\n\n` +
            `Query successful`,
          content: result,
        });
      }

      return result;
    } catch (error) {
      logger.error('Error querying Heimdall validator set:', error);

      const errorResult = {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error occurred',
        message: 'Failed to query validator set from Heimdall',
      };

      if (callback) {
        callback({
          text:
            `**Heimdall Validator Set Query Failed**\n\n` +
            `**Error:** ${errorResult.error}\n\n` +
            `This could be due to:\n` +
            `• Network connectivity issues\n` +
            `• Heimdall endpoint unavailable\n` +
            `• API response format changes`,
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
        content: { text: 'Show me the current Heimdall validator set on Polygon' },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'Showing the current Heimdall validator set on Polygon',
          action: 'POLYGON_HEIMDALL_VALIDATOR_SET',
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: { text: 'List all validators on Heimdall network on Polygon' },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'Listing all validators on Heimdall network on Polygon',
          action: 'POLYGON_HEIMDALL_VALIDATOR_SET',
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: { text: 'Get Heimdall validators on Polygon' },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'Getting Heimdall validators on Polygon',
          action: 'POLYGON_HEIMDALL_VALIDATOR_SET',
        },
      },
    ],
  ],
};
