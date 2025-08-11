import {
  type Action,
  type Content,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  type State,
  logger,
  composePromptFromState,
  ModelType,
  parseJSONObjectFromText,
} from '@elizaos/core';
import { PolygonRpcService } from '../services/PolygonRpcService';
import { getCheckpointStatusTemplate } from '../templates';

// Define the structure for checkpoint status information
interface CheckpointStatus {
  blockNumber: number;
  isCheckpointed: boolean;
  lastCheckpointedBlock: bigint;
}

// Define input schema for the LLM-extracted parameters
interface CheckpointParams {
  blockNumber?: number;
  error?: string;
}

export const getCheckpointStatusAction: Action = {
  name: 'POLYGON_GET_CHECKPOINT_STATUS',
  similes: ['CHECK_CHECKPOINT', 'CHECKPOINT_STATE'].map((s) => `POLYGON_${s}`),
  description: 'Gets the status of the latest checkpoint.',

  validate: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state: State | undefined
  ): Promise<boolean> => {
    logger.debug('Validating POLYGON_GET_CHECKPOINT_STATUS action...');

    // Check for required settings
    const requiredSettings = [
      'PRIVATE_KEY',
      'ETHEREUM_RPC_URL', // L1 RPC needed for checkpoint verification
      'POLYGON_RPC_URL', // L2 RPC for completeness
      'POLYGON_PLUGINS_ENABLED',
    ];

    for (const setting of requiredSettings) {
      if (!runtime.getSetting(setting)) {
        logger.error(
          `Required setting ${setting} not configured for POLYGON_GET_CHECKPOINT_STATUS action.`
        );
        return false;
      }
    }

    // Verify PolygonRpcService is available
    try {
      const service = runtime.getService<PolygonRpcService>(PolygonRpcService.serviceType);
      if (!service) {
        logger.error('PolygonRpcService not initialized.');
        return false;
      }
    } catch (error: unknown) {
      logger.error('Error accessing PolygonRpcService during validation:', error);
      return false;
    }

    return true;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State | undefined,
    _options: unknown,
    callback: HandlerCallback | undefined,
    _responses: Memory[] | undefined
  ) => {
    logger.info('Handling POLYGON_GET_CHECKPOINT_STATUS action for message:', message.id);

    try {
      // Get the PolygonRpcService
      const polygonService = runtime.getService<PolygonRpcService>(PolygonRpcService.serviceType);
      if (!polygonService) {
        throw new Error('PolygonRpcService not available');
      }

      // Extract parameters using LLM with proper template
      const prompt = composePromptFromState({
        state,
        template: getCheckpointStatusTemplate,
      });

      // Try using the model to extract block number
      const modelResponse = await runtime.useModel(ModelType.TEXT_SMALL, {
        prompt,
      });
      let params: CheckpointParams;

      try {
        params = parseJSONObjectFromText(modelResponse) as CheckpointParams;
        logger.debug('POLYGON_GET_CHECKPOINT_STATUS: Extracted params:', params);

        if (params.error) {
          // Check if the model response contains an error
          logger.warn(`POLYGON_GET_CHECKPOINT_STATUS: Model responded with error: ${params.error}`);
          throw new Error(params.error);
        }
      } catch (error: unknown) {
        logger.error(
          'Failed to parse LLM response for checkpoint parameters:',
          modelResponse,
          error
        );
        throw new Error('Could not understand checkpoint parameters.');
      }

      if (params.blockNumber === undefined) {
        throw new Error('Block number parameter not extracted properly.');
      }

      logger.debug('Checkpoint parameters:', params);

      // Get latest L2 block number if needed for context
      const currentBlockNumber = await polygonService.getCurrentBlockNumber();

      // Get the last checkpoint block
      const lastCheckpointedBlock = await polygonService.getLastCheckpointedL2Block();

      // Check if the specified block is checkpointed
      const isCheckpointed = await polygonService.isL2BlockCheckpointed(params.blockNumber);

      // Build the status object
      const status: CheckpointStatus = {
        blockNumber: params.blockNumber,
        isCheckpointed,
        lastCheckpointedBlock,
      };

      // Prepare response message
      let responseMsg = `Polygon block ${params.blockNumber} ${isCheckpointed ? 'is' : 'is not'} checkpointed on Ethereum.`;
      responseMsg += ` Last checkpointed block: ${lastCheckpointedBlock.toString()}`;

      if (!isCheckpointed && params.blockNumber > Number(lastCheckpointedBlock)) {
        const blocksRemaining = params.blockNumber - Number(lastCheckpointedBlock);
        responseMsg += ` (${blocksRemaining} blocks pending)`;
      }

      if (params.blockNumber > currentBlockNumber) {
        responseMsg += ` Note: Block ${params.blockNumber} is in the future (current block: ${currentBlockNumber})`;
      }

      logger.info(responseMsg);

      // Format the response content
      const responseContent: Content = {
        text: responseMsg,
        actions: ['POLYGON_GET_CHECKPOINT_STATUS'],
        source: message.content.source,
        data: {
          blockNumber: params.blockNumber,
          currentBlockNumber,
          lastCheckpointedBlock: lastCheckpointedBlock.toString(),
          isCheckpointed,
        },
      };

      if (callback) {
        await callback(responseContent);
      }
      return responseContent;
    } catch (error: unknown) {
      // Handle errors
      const errMsg = error instanceof Error ? error.message : String(error);
      logger.error('Error in POLYGON_GET_CHECKPOINT_STATUS handler:', errMsg, error);

      // Format error response
      const errorContent: Content = {
        text: `Error checking checkpoint status: ${errMsg}`,
        actions: ['POLYGON_GET_CHECKPOINT_STATUS'],
        source: message.content.source,
        data: { success: false, error: errMsg },
      };

      if (callback) {
        await callback(errorContent);
      }
      return errorContent;
    }
  },

  examples: [
    [
      {
        name: '{{user1}}',
        content: {
          text: 'Check if Polygon block 42000000 has been checkpointed',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'Checking if Polygon block 42000000 has been checkpointed.',
          action: 'POLYGON_GET_CHECKPOINT_STATUS',
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: {
          text: 'Has block 41500000 on Polygon been checkpointed to Ethereum yet?',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'Checking if block 41500000 on Polygon has been checkpointed to Ethereum.',
          action: 'POLYGON_GET_CHECKPOINT_STATUS',
        },
      },
    ],
  ],
};
