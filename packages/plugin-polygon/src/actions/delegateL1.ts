import {
  type Action,
  type Content,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  type State,
  logger,
  composePrompt,
  ModelType,
  composePromptFromState,
  parseJSONObjectFromText,
} from '@elizaos/core';
import { ethers, parseUnits } from 'ethers';
import { PolygonRpcService } from '../services/PolygonRpcService';
import { delegateL1Template } from '../templates';
import { parseErrorMessage } from '../errors';

// Define input schema for the LLM-extracted parameters
interface DelegateL1Params {
  validatorId?: number;
  amountWei?: string; // Amount in smallest unit (Wei)
  error?: string;
}

// Helper function to extract params from text if LLM fails
// This is a simplified example; a more robust regex might be needed.
function extractParamsFromText(text: string): Partial<DelegateL1Params> {
  const params: Partial<DelegateL1Params> = {};

  // Extract validator ID (positive integer)
  const validatorIdMatch = text.match(/validator(?: id)?\\s*[:#]?\\s*(\\d+)/i);
  if (validatorIdMatch?.[1]) {
    const id = Number.parseInt(validatorIdMatch[1], 10);
    if (id > 0) {
      params.validatorId = id;
    }
  }

  // Extract amount (e.g., "10 MATIC", "5.5 MATIC", "0.25 ether")
  // This regex requires a number followed by a unit keyword
  const amountMatch = text.match(/(\d+(?:\.\d+)?)\s*(MATIC|ETH|ether)\b/i);
  if (amountMatch?.[1]) {
    try {
      // Convert to Wei. Assumes 18 decimal places for MATIC/ETH.
      params.amountWei = parseUnits(amountMatch[1], 18).toString();
    } catch (e) {
      logger.warn(`Could not parse amount from text: ${amountMatch[1]}`, e);
    }
  }

  return params;
}

export const delegateL1Action: Action = {
  name: 'POLYGON_DELEGATE_L1',
  description: 'Delegates MATIC tokens to a validator on the L1 staking contract.',
  similes: ['STAKE_L1_MATIC', 'DELEGATE_TO_VALIDATOR_L1', 'STAKE_ON_ETHEREUM_L1'].map(
    (s) => `POLYGON_${s}`
  ),
  validate: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state: State | undefined
  ): Promise<boolean> => {
    logger.debug('Validating DELEGATE_L1 action...');

    const requiredSettings = [
      'PRIVATE_KEY',
      'ETHEREUM_RPC_URL', // L1 RPC needed for delegation
      'POLYGON_PLUGINS_ENABLED', // Ensure main plugin toggle is on
    ];
    for (const setting of requiredSettings) {
      if (!runtime.getSetting(setting)) {
        logger.error(`Required setting ${setting} not configured for DELEGATE_L1 action.`);
        return false;
      }
    }
    try {
      const service = runtime.getService<PolygonRpcService>(PolygonRpcService.serviceType);
      if (!service) {
        logger.error('PolygonRpcService not initialized for DELEGATE_L1.');
        return false;
      }
    } catch (error: unknown) {
      logger.error('Error accessing PolygonRpcService during DELEGATE_L1 validation:', error);
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
    logger.info('Handling DELEGATE_L1 action for message:', message.id);
    const rawMessageText = message.content.text || '';
    let params: DelegateL1Params | null = null;

    try {
      const polygonService = runtime.getService<PolygonRpcService>(PolygonRpcService.serviceType);
      if (!polygonService) {
        throw new Error('PolygonRpcService not available');
      }

      const prompt = composePromptFromState({
        state,
        template: delegateL1Template,
      });

      // Try using parseJSONObjectFromText with TEXT_SMALL model
      try {
        const result = await runtime.useModel(ModelType.TEXT_SMALL, {
          prompt,
        });

        params = parseJSONObjectFromText(result) as DelegateL1Params;
        logger.debug('DELEGATE_L1: Extracted params via TEXT_SMALL:', params);

        // Check if the model response contains an error
        if (params.error) {
          logger.warn(`DELEGATE_L1: Model responded with error: ${params.error}`);
          throw new Error(params.error);
        }
      } catch (e) {
        logger.warn(
          'DELEGATE_L1: Failed to parse JSON from model response, trying manual extraction',
          e
        );

        // Fallback to manual extraction from raw message text
        const manualParams = extractParamsFromText(rawMessageText);
        if (manualParams.validatorId && manualParams.amountWei) {
          params = {
            validatorId: manualParams.validatorId,
            amountWei: manualParams.amountWei,
          };
          logger.debug('DELEGATE_L1: Extracted params via manual text parsing:', params);
        } else {
          throw new Error('Could not determine validator ID or amount from the message.');
        }
      }

      // Validate the extracted parameters
      if (!params?.validatorId || !params.amountWei) {
        throw new Error('Validator ID or amount is missing after extraction attempts.');
      }

      const { validatorId, amountWei } = params;
      logger.debug(`DELEGATE_L1 parameters: validatorId: ${validatorId}, amountWei: ${amountWei}`);

      // Convert the amount to BigInt for the service
      const amountBigInt = BigInt(amountWei);
      const txHash = await polygonService.delegate(validatorId, amountBigInt);
      const amountFormatted = ethers.formatEther(amountWei);

      const successMsg = `Successfully initiated delegation of ${amountFormatted} MATIC to validator ${validatorId}. Transaction hash: ${txHash}`;
      logger.info(successMsg);

      const responseContent: Content = {
        text: successMsg,
        actions: ['DELEGATE_L1'],
        source: message.content.source,
        data: {
          transactionHash: txHash,
          status: 'pending',
          validatorId: validatorId,
          amountDelegatedMatic: amountFormatted,
          amountDelegatedWei: amountWei,
        },
      };

      if (callback) {
        await callback(responseContent);
      }
      return responseContent;
    } catch (error: unknown) {
      const parsedError = parseErrorMessage(error);
      logger.error('Error in DELEGATE_L1 handler:', parsedError);

      // Check if it's an "insufficient funds" error and provide more specific guidance
      let errorText = parsedError.message;

      if (errorText.includes('insufficient funds')) {
        try {
          // Try to extract amounts from error message if possible
          const matches = errorText.match(/address (0x[a-fA-F0-9]+) have ([\d.]+) want ([\d.]+)/i);
          if (matches && matches.length >= 4) {
            const have = ethers.parseEther(matches[2]);
            const want = ethers.parseEther(matches[3]);
            const missing = want - have;

            errorText = `Insufficient ETH for delegation. You have ${ethers.formatEther(have)} ETH but need ${ethers.formatEther(want)} ETH (missing ${ethers.formatEther(missing)} ETH). Please fund your wallet with more ETH to cover the transaction cost.`;

            // Add diagnostic information when the requested amount seems unusually high
            if (want > ethers.parseEther('0.05')) {
              errorText +=
                '\n\nNOTE: The required ETH amount appears unusually high. This typically indicates one of two issues:\n' +
                '1. Your MATIC amount is being sent as transaction value instead of using token approval\n' +
                "2. Gas price is being calculated incorrectly (possibly using 18 decimals instead of 'gwei')\n" +
                'The normal gas cost for delegation is ~0.005-0.015 ETH.';
            }
          } else {
            // Generic improved message for insufficient funds
            errorText =
              'Insufficient ETH to cover transaction fees. Please fund your wallet with more ETH (typically 0.005-0.015 ETH is enough) and try again.';
          }
        } catch (parseErr) {
          logger.warn('Error parsing amounts from insufficient funds error:', parseErr);
          // Fall back to generic message if parsing fails
          errorText =
            'Insufficient ETH to cover transaction fees. Please fund your wallet with ~0.01 ETH and try again.';
        }
      }

      const errorContent: Content = {
        text: `Error delegating MATIC (L1): ${errorText}`,
        actions: ['DELEGATE_L1'],
        source: message.content.source,
        data: {
          success: false,
          error: parsedError.message,
          details: parsedError.details,
          // Add diagnostic information about the transaction parameters
          diagnostics: {
            validatorId: params?.validatorId,
            amountMaticRequested: params?.amountWei
              ? ethers.formatEther(params.amountWei)
              : 'unknown',
            amountWei: params?.amountWei || 'unknown',
          },
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
        name: 'user',
        content: {
          text: 'I want to delegate 10 MATIC to validator 123 on L1',
        },
      },
    ],
    [
      {
        name: 'user',
        content: {
          text: 'Stake 5.5 MATIC with the Polygon validator ID 42 for L1 staking',
        },
      },
    ],
  ],
};
