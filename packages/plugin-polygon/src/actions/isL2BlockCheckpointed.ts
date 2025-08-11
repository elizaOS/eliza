import {
  type Action,
  type IAgentRuntime,
  type Memory,
  type State,
  type Content,
  type HandlerCallback,
  logger,
  composePromptFromState,
  ModelType,
  parseJSONObjectFromText,
} from '@elizaos/core';
import { PolygonRpcService } from '../services/PolygonRpcService.js';
import { isL2BlockCheckpointedTemplate } from '../templates/index.js';

// Add type declaration for missing method
declare module '../services/PolygonRpcService.js' {
  interface PolygonRpcService {
    isL2BlockCheckpointed(l2BlockNumber: number | bigint): Promise<boolean>;
  }
}

// Define input schema for the LLM-extracted parameters
interface CheckpointParams {
  l2BlockNumber?: number;
  error?: string;
}

export const isL2BlockCheckpointedAction: Action = {
  name: 'POLYGON_IS_L2_BLOCK_CHECKPOINTED',
  description: 'Checks if a Polygon L2 block has been checkpointed on Ethereum L1.',

  validate: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state: State | undefined
  ): Promise<boolean> => {
    logger.debug('Validating POLYGON_IS_L2_BLOCK_CHECKPOINTED action...');

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
          `Required setting ${setting} not configured for POLYGON_IS_L2_BLOCK_CHECKPOINTED action.`
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
    logger.info('Handling POLYGON_IS_L2_BLOCK_CHECKPOINTED action for message:', message.id);

    try {
      const rpcService = runtime.getService<PolygonRpcService>(PolygonRpcService.serviceType);
      if (!rpcService) throw new Error('PolygonRpcService not available');

      // Extract parameters using LLM with proper template
      const prompt = composePromptFromState({
        state: state ? state : { values: {}, data: {}, text: '' },
        template: isL2BlockCheckpointedTemplate,
      });

      // Try using the model to extract block number
      const modelResponse = await runtime.useModel(ModelType.TEXT_SMALL, {
        prompt,
      });
      let params: CheckpointParams;

      try {
        params = parseJSONObjectFromText(modelResponse) as CheckpointParams;
        logger.debug('POLYGON_IS_L2_BLOCK_CHECKPOINTED: Extracted params:', params);

        // Check if the model response contains an error
        if (params.error) {
          logger.warn(
            `POLYGON_IS_L2_BLOCK_CHECKPOINTED: Model responded with error: ${params.error}`
          );
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

      if (params.l2BlockNumber === undefined) {
        throw new Error('L2 block number parameter not extracted properly.');
      }

      // Convert to bigint for the service
      const l2BlockNumber = BigInt(params.l2BlockNumber);

      logger.info(`Action: Checking checkpoint status for L2 block ${l2BlockNumber}`);

      const lastCheckpointedBlock = await rpcService.getLastCheckpointedL2Block();

      // Check if the specified block is checkpointed
      const isCheckpointed = await rpcService.isL2BlockCheckpointed(l2BlockNumber);

      // Format the response content
      const currentL2Block = await rpcService.getCurrentBlockNumber();
      const responseMsg = `Block ${l2BlockNumber} ${
        isCheckpointed ? 'is' : 'is not'
      } checkpointed on Ethereum L1. Last checkpointed block: ${lastCheckpointedBlock}`;

      logger.info(responseMsg);

      const responseContent: Content = {
        text: responseMsg,
        actions: ['POLYGON_IS_L2_BLOCK_CHECKPOINTED'],
        source: message.content.source,
        data: {
          l2BlockNumber: Number(l2BlockNumber),
          currentBlockNumber: currentL2Block,
          lastCheckpointedBlock: lastCheckpointedBlock.toString(),
          isCheckpointed,
        },
      };

      if (callback) {
        await callback(responseContent);
      }
      return responseContent;
    } catch (error: unknown) {
      // Handle checkpoint retrieval errors
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('Failed to check if block is checkpointed:', error);

      const userFriendlyMessage = `Unable to verify checkpoint status. The CheckpointManager contract on Ethereum L1 encountered an error: ${errorMessage}. This could be due to a network issue or a contract configuration problem.`;

      const responseContent: Content = {
        text: userFriendlyMessage,
        actions: ['POLYGON_IS_L2_BLOCK_CHECKPOINTED'],
        source: message.content.source,
        data: {
          error: errorMessage,
        },
      };

      if (callback) {
        await callback(responseContent);
      }
      return responseContent;
    }
  },

  examples: [
    [
      {
        name: '{{user1}}',
        content: {
          text: 'Is Polygon block 15000000 checkpointed on Ethereum yet?',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'Checking if Polygon block 15000000 is checkpointed on Ethereum.',
          action: 'POLYGON_IS_L2_BLOCK_CHECKPOINTED',
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: {
          text: 'Check if L2 block 42123456 has been checkpointed on Polygon',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'Checking if L2 block 42123456 has been checkpointed on Polygon.',
          action: 'POLYGON_IS_L2_BLOCK_CHECKPOINTED',
        },
      },
    ],
  ],
};
