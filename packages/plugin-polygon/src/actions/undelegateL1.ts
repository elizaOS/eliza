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
import { parseUnits } from 'ethers';
import { PolygonRpcService } from '../services/PolygonRpcService';
import { parseBigIntString } from '../utils';
import { undelegateL1Template } from '../templates';
import { parseErrorMessage } from '../errors';

// Define input schema for the LLM-extracted parameters
interface UndelegateL1Params {
  validatorId?: number;
  sharesAmountWei?: string;
  maticAmount?: string; // Human-readable MATIC amount (e.g., "0.1", "0.5")
  error?: string;
}

// Helper function to extract params from text if LLM fails
function extractParamsFromText(text: string): Partial<UndelegateL1Params> {
  const params: Partial<UndelegateL1Params> = {};

  // Extract validator ID (positive integer)
  const validatorIdMatch = text.match(/validator(?: id)?\\s*[:#]?\\s*(\\d+)/i);
  if (validatorIdMatch?.[1]) {
    const id = Number.parseInt(validatorIdMatch[1], 10);
    if (id > 0) {
      params.validatorId = id;
    }
  }

  // Extract MATIC amount (e.g., "0.5 MATIC", "1.5 matic", "10 MATIC")
  const maticMatch = text.match(/(\\d*\\.?\\d+)\\s*matic/i);
  if (maticMatch?.[1]) {
    try {
      // Convert to Wei (18 decimal places for MATIC)
      params.maticAmount = maticMatch[1];
    } catch (e) {
      logger.warn(`Could not parse MATIC amount from text: ${maticMatch[1]}`, e);
    }
  } else {
    // Extract shares amount (e.g., "10", "5.5", "100 shares", "0.25 validator shares")
    const sharesMatch = text.match(/(\\d*\\.?\\d+)\\s*(?:shares?|validator shares?)?/i);
    if (sharesMatch?.[1]) {
      try {
        // Convert to Wei. Assumes 18 decimal places for shares.
        params.sharesAmountWei = parseUnits(sharesMatch[1], 18).toString();
      } catch (e) {
        logger.warn(`Could not parse shares amount from text: ${sharesMatch[1]}`, e);
      }
    }
  }

  return params;
}

export const undelegateL1Action: Action = {
  name: 'POLYGON_UNDELEGATE_L1',
  description: 'Unstakes (unbonds) tokens from a validator on the L1 staking contract.',
  similes: ['UNSTAKE_L1', 'UNBOND_VALIDATOR_SHARES_L1', 'SELL_VALIDATOR_SHARES_L1'].map(
    (s) => `POLYGON_${s}`
  ),

  validate: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state: State | undefined
  ): Promise<boolean> => {
    logger.debug('Validating POLYGON_UNSTAKE_L1 action...');

    const requiredSettings = [
      'PRIVATE_KEY',
      'ETHEREUM_RPC_URL', // L1 RPC needed for undelegation
      'POLYGON_PLUGINS_ENABLED', // Ensure main plugin toggle is on
    ];

    for (const setting of requiredSettings) {
      if (!runtime.getSetting(setting)) {
        logger.error(`Required setting ${setting} not configured for POLYGON_UNSTAKE_L1 action.`);
        return false;
      }
    }

    try {
      const service = runtime.getService<PolygonRpcService>(PolygonRpcService.serviceType);
      if (!service) {
        logger.error('PolygonRpcService not initialized for POLYGON_UNSTAKE_L1.');
        return false;
      }
    } catch (error: unknown) {
      logger.error(
        'Error accessing PolygonRpcService during POLYGON_UNSTAKE_L1 validation:',
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
    logger.info('Handling POLYGON_UNSTAKE_L1 action for message:', message.id);
    const rawMessageText = message.content.text || '';
    let params: UndelegateL1Params | null = null;

    try {
      const rpcService = runtime.getService<PolygonRpcService>(PolygonRpcService.serviceType);
      if (!rpcService) {
        throw new Error('PolygonRpcService not available');
      }

      const prompt = composePromptFromState({
        state,
        template: undelegateL1Template,
      });

      // Try using parseJSONObjectFromText with TEXT_SMALL model
      try {
        const result = await runtime.useModel(ModelType.TEXT_SMALL, {
          prompt,
        });

        params = parseJSONObjectFromText(result) as UndelegateL1Params;
        logger.debug('POLYGON_UNSTAKE_L1: Extracted params via TEXT_SMALL:', params);

        // Check if the model response contains an error
        if (params.error) {
          logger.warn(`POLYGON_UNSTAKE_L1: Model responded with error: ${params.error}`);
          throw new Error(params.error);
        }
      } catch (e) {
        logger.warn(
          'POLYGON_UNSTAKE_L1: Failed to parse JSON from model response, trying manual extraction',
          e
        );

        // Fallback to manual extraction from raw message text
        const manualParams = extractParamsFromText(rawMessageText);
        if (
          manualParams.validatorId &&
          (manualParams.sharesAmountWei || manualParams.maticAmount)
        ) {
          params = {
            validatorId: manualParams.validatorId,
            sharesAmountWei: manualParams.sharesAmountWei,
            maticAmount: manualParams.maticAmount,
          };
          logger.debug('POLYGON_UNSTAKE_L1: Extracted params via manual text parsing:', params);
        } else {
          throw new Error('Could not determine validator ID or amount from the message.');
        }
      }

      // Validate the extracted parameters
      if (!params?.validatorId || (!params.sharesAmountWei && !params.maticAmount)) {
        throw new Error('Validator ID or amount is missing after extraction attempts.');
      }

      const { validatorId } = params;
      let sharesAmountBigInt: bigint;

      // Handle MATIC amount conversion to shares
      if (params.maticAmount) {
        logger.debug(`Converting MATIC amount to shares for validator ${validatorId}...`);
        // Convert human-readable MATIC to Wei first
        const maticAmountWei = parseUnits(params.maticAmount, 18).toString();
        const maticAmountBigInt = parseBigIntString(maticAmountWei, 'MATIC');
        sharesAmountBigInt = await rpcService.convertMaticToShares(validatorId, maticAmountBigInt);
        logger.debug(`Converted ${params.maticAmount} MATIC to ${sharesAmountBigInt} shares`);
      } else {
        // Use shares amount directly
        sharesAmountBigInt = parseBigIntString(params.sharesAmountWei!, 'shares');
        logger.debug(`Using direct shares amount: ${sharesAmountBigInt}`);
      }

      logger.debug(
        `POLYGON_UNSTAKE_L1 parameters: validatorId: ${validatorId}, sharesAmount: ${sharesAmountBigInt}`
      );

      const txHash = await rpcService.undelegate(validatorId, sharesAmountBigInt);

      const successMsg = `Undelegation transaction sent to L1: ${txHash}. Unbonding period applies.`;
      logger.info(successMsg);

      const responseContent: Content = {
        text: successMsg,
        actions: ['POLYGON_UNSTAKE_L1'],
        source: message.content.source,
        data: {
          transactionHash: txHash,
          status: 'pending',
          validatorId: validatorId,
          sharesAmountWei: sharesAmountBigInt.toString(),
          ...(params.maticAmount && {
            maticAmount: params.maticAmount,
          }),
        },
      };

      if (callback) {
        await callback(responseContent);
      }
      return responseContent;
    } catch (error: unknown) {
      const parsedError = parseErrorMessage(error);
      logger.error('Error in POLYGON_UNSTAKE_L1 handler:', parsedError);

      const errorContent: Content = {
        text: `Error undelegating shares (L1): ${parsedError.message}`,
        actions: ['POLYGON_UNSTAKE_L1'],
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
          text: 'I want to undelegate 10 shares from validator 123 on L1 on Polygon.',
        },
      },
      {
        name: '{{agent}}',
        content: {
          text: 'I am initiating the undelegation of 10 shares from validator 123 on L1 via Polygon. The transaction hash is [tx_hash]. Please note that there is an unbonding period before the funds are available.',
          actions: ['POLYGON_UNDELEGATE_L1'],
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: {
          text: 'Can you sell my validator shares for validator 456 on L1? Sell about 50 MATIC worth.',
        },
      },
      {
        name: '{{agent}}',
        content: {
          text: 'I am initiating the sale (undelegation) of your validator shares for validator 456 on L1, equivalent to approximately 50 MATIC, via Polygon. The transaction hash is [tx_hash].',
          actions: ['POLYGON_UNDELEGATE_L1'],
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: {
          text: 'Help me unstake from validator 789 on the Ethereum layer for Polygon.',
        },
      },
      {
        name: '{{agent}}',
        content: {
          text: "I need a bit more information to help you unstake. Please provide the amount of shares or the equivalent MATIC value you'd like to unstake from validator 789 on L1 for Polygon.",
          actions: ['POLYGON_UNDELEGATE_L1'],
        },
      },
    ],
  ],
};
