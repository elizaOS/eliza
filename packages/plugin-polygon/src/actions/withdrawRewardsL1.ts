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
import { withdrawRewardsTemplate } from '../templates';
import { parseErrorMessage } from '../errors';

// Define input schema for the LLM-extracted parameters
interface WithdrawRewardsParams {
  validatorId?: number;
  error?: string;
}

// Helper function to extract params from text if LLM fails
function extractParamsFromText(text: string): Partial<WithdrawRewardsParams> {
  const params: Partial<WithdrawRewardsParams> = {};

  // Extract validator ID (positive integer)
  const validatorIdMatch = text.match(/validator(?: id)?\\s*[:#]?\\s*(\\d+)/i);
  if (validatorIdMatch?.[1]) {
    const id = Number.parseInt(validatorIdMatch[1], 10);
    if (id > 0) {
      params.validatorId = id;
    }
  }

  return params;
}

export const withdrawRewardsAction: Action = {
  name: 'POLYGON_WITHDRAW_REWARDS_L1',
  description:
    'Withdraws accumulated staking rewards for a delegator from the L1 staking contract.',
  similes: ['CLAIM_L1_STAKING_REWARDS', 'COLLECT_VALIDATOR_REWARDS_L1'].map((s) => `POLYGON_${s}`),

  validate: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state: State | undefined
  ): Promise<boolean> => {
    logger.debug('Validating POLYGON_WITHDRAW_REWARDS_L1 action...');

    const requiredSettings = [
      'PRIVATE_KEY',
      'ETHEREUM_RPC_URL', // L1 RPC needed for rewards withdrawal
      'POLYGON_PLUGINS_ENABLED',
    ];

    for (const setting of requiredSettings) {
      if (!runtime.getSetting(setting)) {
        logger.error(
          `Required setting ${setting} not configured for POLYGON_WITHDRAW_REWARDS_L1 action.`
        );
        return false;
      }
    }

    try {
      const service = runtime.getService<PolygonRpcService>(PolygonRpcService.serviceType);
      if (!service) {
        logger.error('PolygonRpcService not initialized for POLYGON_WITHDRAW_REWARDS_L1.');
        return false;
      }
    } catch (error: unknown) {
      logger.error(
        'Error accessing PolygonRpcService during POLYGON_WITHDRAW_REWARDS_L1 validation:',
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
    _options: unknown,
    callback: HandlerCallback | undefined,
    _recentMessages: Memory[] | undefined
  ) => {
    logger.info('Handling POLYGON_WITHDRAW_REWARDS_L1 action for message:', message.id);
    const rawMessageText = message.content.text || '';
    let params: WithdrawRewardsParams | null = null;

    try {
      const polygonService = runtime.getService<PolygonRpcService>(PolygonRpcService.serviceType);
      if (!polygonService) {
        throw new Error('PolygonRpcService not available');
      }

      const prompt = composePromptFromState({
        state,
        template: withdrawRewardsTemplate,
      });

      // Try using parseJSONObjectFromText with TEXT_SMALL model
      try {
        const result = await runtime.useModel(ModelType.TEXT_SMALL, {
          prompt,
        });

        params = parseJSONObjectFromText(result) as WithdrawRewardsParams;
        logger.debug('POLYGON_WITHDRAW_REWARDS_L1: Extracted params via TEXT_SMALL:', params);

        // Check if the model response contains an error
        if (params.error) {
          logger.warn(`POLYGON_WITHDRAW_REWARDS_L1: Model responded with error: ${params.error}`);
          throw new Error(params.error);
        }
      } catch (e) {
        logger.warn(
          'POLYGON_WITHDRAW_REWARDS_L1: Failed to parse JSON from model response, trying manual extraction',
          e
        );

        // Fallback to manual extraction from raw message text
        const manualParams = extractParamsFromText(rawMessageText);
        if (manualParams.validatorId) {
          params = {
            validatorId: manualParams.validatorId,
          };
          logger.debug(
            'POLYGON_WITHDRAW_REWARDS_L1: Extracted params via manual text parsing:',
            params
          );
        } else {
          throw new Error('Could not determine validator ID from the message.');
        }
      }

      // Validate the extracted parameters
      if (!params?.validatorId) {
        throw new Error('Validator ID is missing after extraction attempts.');
      }

      const { validatorId } = params;
      logger.debug(`POLYGON_WITHDRAW_REWARDS_L1 parameters: validatorId: ${validatorId}`);

      // Call the service to withdraw rewards
      const txHash = await polygonService.withdrawRewards(validatorId);

      const successMsg = `Successfully initiated withdrawal of rewards from validator ${validatorId} on L1. Transaction hash: ${txHash}`;
      logger.info(successMsg);

      const responseContent: Content = {
        text: successMsg,
        actions: ['POLYGON_WITHDRAW_REWARDS_L1'],
        source: message.content.source,
        data: {
          transactionHash: txHash,
          status: 'pending',
          validatorId: validatorId,
        },
      };

      if (callback) {
        await callback(responseContent);
      }
      return responseContent;
    } catch (error: unknown) {
      const parsedError = parseErrorMessage(error);
      logger.error('Error in POLYGON_WITHDRAW_REWARDS_L1 handler:', parsedError);

      const errorContent: Content = {
        text: `Error withdrawing rewards: ${parsedError.message}`,
        actions: ['POLYGON_WITHDRAW_REWARDS_L1'],
        source: message.content.source,
        data: {
          success: false,
          error: parsedError.message,
          details: parsedError.details,
        },
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
          text: 'Withdraw my staking rewards from validator 123 on Polygon L1.',
        },
      },
      {
        name: '{{agent}}',
        content: {
          text: 'I have initiated the withdrawal of staking rewards from validator 123 on L1 via Polygon. The transaction hash is [tx_hash].',
          actions: ['POLYGON_WITHDRAW_REWARDS_L1'],
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: {
          text: 'Claim rewards from Polygon validator ID 42 on the Ethereum mainnet.',
        },
      },
      {
        name: '{{agent}}',
        content: {
          text: 'I am claiming the staking rewards for validator 42 on L1 via Polygon. The transaction hash is [tx_hash].',
          actions: ['POLYGON_WITHDRAW_REWARDS_L1'],
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: {
          text: 'Can you collect my rewards for my Polygon validator?',
        },
      },
      {
        name: '{{agent}}',
        content: {
          text: "I can help with that. Please provide the validator ID from which you'd like to withdraw rewards on L1 for Polygon.",
          actions: ['POLYGON_WITHDRAW_REWARDS_L1'],
        },
      },
    ],
  ],
};
