import { Action, IAgentRuntime, Memory, State, HandlerCallback, logger } from '@elizaos/core';

export const heimdallCheckpointStatusAction: Action = {
  name: 'POLYGON_HEIMDALL_CHECKPOINT_STATUS',
  similes: [
    'GET_HEIMDALL_CHECKPOINT_STATUS',
    'HEIMDALL_CHECKPOINT_LATEST',
    'QUERY_CHECKPOINT_STATUS',
    'CHECKPOINT_STATUS_HEIMDALL',
    'CHECK_LATEST_CHECKPOINT',
  ].map((s) => `POLYGON_${s}`),
  description: 'Queries the latest checkpoint status from Heimdall network (read-only operation)',
  validate: async (runtime: IAgentRuntime, message: Memory) => {
    logger.log('Validating Heimdall checkpoint status query...');
    return true;
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: any,
    callback?: HandlerCallback
  ) => {
    logger.log('Executing Heimdall checkpoint status query...');

    try {
      // Get Heimdall RPC URL from environment
      const heimdallUrl =
        runtime.getSetting('HEIMDALL_RPC_URL') || 'https://heimdall-api.polygon.technology';

      // Query latest checkpoint status
      const response = await fetch(`${heimdallUrl}/checkpoints/latest`);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const checkpointData = await response.json();

      const result = {
        success: true,
        data: checkpointData,
        message: 'Successfully retrieved latest checkpoint status',
      };

      if (callback) {
        const checkpoint = checkpointData.result;
        callback({
          text:
            `**Heimdall Latest Checkpoint**\n\n` +
            `**Checkpoint ID:** ${checkpoint?.id || 'N/A'}\n` +
            `**Proposer:** ${checkpoint?.proposer || 'N/A'}\n` +
            `**Start Block:** ${checkpoint?.start_block || 'N/A'}\n` +
            `**End Block:** ${checkpoint?.end_block || 'N/A'}\n` +
            `**Root Hash:** ${checkpoint?.root_hash || 'N/A'}\n` +
            `**Bor Chain ID:** ${checkpoint?.bor_chain_id || 'N/A'}\n` +
            `**Timestamp:** ${checkpoint?.timestamp ? new Date(checkpoint.timestamp * 1000).toLocaleString() : 'N/A'}\n\n` +
            `Query successful`,
          content: result,
        });
      }

      return result;
    } catch (error) {
      logger.error('Error querying Heimdall checkpoint status:', error);

      const errorResult = {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error occurred',
        message: 'Failed to query checkpoint status from Heimdall',
      };

      if (callback) {
        callback({
          text:
            `**Heimdall Checkpoint Query Failed**\n\n` +
            `**Error:** ${errorResult.error}\n\n` +
            `This could be due to:\n` +
            `• Network connectivity issues\n` +
            `• Heimdall endpoint unavailable\n` +
            `• API structure changes`,
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
        content: { text: 'Get the latest checkpoint status from Heimdall on Polygon' },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'Getting the latest checkpoint status from Heimdall on Polygon',
          action: 'POLYGON_HEIMDALL_CHECKPOINT_STATUS',
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: { text: 'Show me the current Heimdall checkpoint info on Polygon' },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'Showing the current Heimdall checkpoint info on Polygon',
          action: 'POLYGON_HEIMDALL_CHECKPOINT_STATUS',
        },
      },
    ],
  ],
};
