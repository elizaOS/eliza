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
import { PolygonRpcService } from '../services/PolygonRpcService.js';
import { restakeRewardsL1Template } from '../templates/index.js'; // Import the new template
import { parseErrorMessage } from '../errors.js';

// Define input schema for the LLM-extracted parameters
interface RestakeRewardsL1Params {
  validatorId?: number;
  error?: string;
}

// Helper function to extract params from text if LLM fails (simple version)
function extractParamsFromText(text: string): Partial<RestakeRewardsL1Params> {
  const params: Partial<RestakeRewardsL1Params> = {};
  const validatorIdMatch = text.match(/validator(?: id)?\s*[:#]?\s*(\d+)/i);
  if (validatorIdMatch?.[1]) {
    const id = Number.parseInt(validatorIdMatch[1], 10);
    if (id > 0) {
      params.validatorId = id;
    }
  }
  return params;
}

export const restakeRewardsL1Action: Action = {
  name: 'POLYGON_RESTAKE_REWARDS_L1',
  description: 'Restakes accumulated staking rewards on the L1 staking contract.',
  similes: ['COMPOUND_L1_REWARDS', 'REINVEST_STAKING_REWARDS_L1'].map((s) => `POLYGON_${s}`),
  validate: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state: State | undefined
  ): Promise<boolean> => {
    logger.debug('Validating POLYGON_RESTAKE_REWARDS_L1 action...');
    const requiredSettings = ['PRIVATE_KEY', 'ETHEREUM_RPC_URL', 'POLYGON_PLUGINS_ENABLED'];
    for (const setting of requiredSettings) {
      if (!runtime.getSetting(setting)) {
        logger.error(
          `Required setting ${setting} not configured for POLYGON_RESTAKE_REWARDS_L1 action.`
        );
        return false;
      }
    }
    try {
      const service = runtime.getService<PolygonRpcService>(PolygonRpcService.serviceType);
      if (!service) {
        logger.error('PolygonRpcService not initialized for POLYGON_RESTAKE_REWARDS_L1.');
        return false;
      }
    } catch (error: unknown) {
      logger.error(
        'Error accessing PolygonRpcService during POLYGON_RESTAKE_REWARDS_L1 validation:',
        error
      );
      return false;
    }
    return true;
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State | undefined,
    _options: unknown, // options are no longer used directly for params
    callback: HandlerCallback | undefined,
    _recentMessages: Memory[] | undefined
  ) => {
    logger.info('Handling POLYGON_RESTAKE_REWARDS_L1 action for message:', message.id);
    const rawMessageText = message.content.text || '';
    let params: RestakeRewardsL1Params | null = null;

    try {
      const polygonService = runtime.getService<PolygonRpcService>(PolygonRpcService.serviceType);
      if (!polygonService) {
        throw new Error('PolygonRpcService not available');
      }

      const prompt = composePromptFromState({
        state,
        template: restakeRewardsL1Template, // Use the new template
      });

      try {
        const result = await runtime.useModel(ModelType.TEXT_SMALL, { prompt });
        params = parseJSONObjectFromText(result) as RestakeRewardsL1Params;
        logger.debug('POLYGON_RESTAKE_REWARDS_L1: Extracted params via TEXT_SMALL:', params);
        if (params.error) {
          logger.warn(`POLYGON_RESTAKE_REWARDS_L1: Model responded with error: ${params.error}`);
          throw new Error(params.error);
        }
      } catch (e) {
        logger.warn(
          'POLYGON_RESTAKE_REWARDS_L1: Failed to parse JSON from model, trying manual extraction',
          e
        );
        const manualParams = extractParamsFromText(rawMessageText);
        if (manualParams.validatorId) {
          params = { validatorId: manualParams.validatorId };
          logger.debug(
            'POLYGON_RESTAKE_REWARDS_L1: Extracted params via manual text parsing:',
            params
          );
        } else {
          throw new Error('Could not determine validator ID from the message.');
        }
      }

      if (!params?.validatorId) {
        throw new Error('Validator ID is missing after extraction attempts.');
      }

      const { validatorId } = params;
      logger.info(`Action: Restaking rewards for validator ${validatorId} on L1`);

      const delegateTxHash = await polygonService.restakeRewards(validatorId);

      if (!delegateTxHash) {
        const noRewardsMsg = `No rewards found to restake for validator ${validatorId}.`;
        logger.info(noRewardsMsg);
        const responseContent: Content = {
          text: noRewardsMsg,
          actions: ['POLYGON_RESTAKE_REWARDS_L1'],
          source: message.content.source,
          data: { validatorId, status: 'no_rewards', success: true }, // success: true as operation completed as expected
        };
        if (callback) await callback(responseContent);
        return responseContent;
      }

      const successMsg = `Restake operation for validator ${validatorId} initiated. Final delegation transaction hash: ${delegateTxHash}.`;
      logger.info(successMsg);
      const responseContent: Content = {
        text: successMsg,
        actions: ['POLYGON_RESTAKE_REWARDS_L1'],
        source: message.content.source,
        data: {
          validatorId,
          transactionHash: delegateTxHash,
          status: 'initiated',
          success: true,
        },
      };
      if (callback) await callback(responseContent);
      return responseContent;
    } catch (error: unknown) {
      const parsedError = parseErrorMessage(error);
      logger.error('Error in POLYGON_RESTAKE_REWARDS_L1 handler:', parsedError);
      const errorContent: Content = {
        text: `Error restaking rewards (L1): ${parsedError.message}`,
        actions: ['POLYGON_RESTAKE_REWARDS_L1'],
        source: message.content.source,
        data: {
          success: false,
          error: parsedError.message,
          details: parsedError.details,
        },
      };
      if (callback) await callback(errorContent);
      return errorContent;
    }
  },
  examples: [
    [
      {
        name: '{{user1}}',
        content: {
          text: 'Restake my L1 rewards for validator 7 on Polygon.',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'Restaking rewards for validator 7 on Polygon.',
          action: 'POLYGON_RESTAKE_REWARDS_L1',
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: {
          text: 'Compound my staking rewards on Ethereum for validator ID 88 on Polygon.',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'Compounding staking rewards for validator 88 on Polygon.',
          action: 'POLYGON_RESTAKE_REWARDS_L1',
        },
      },
    ],
  ],
};
