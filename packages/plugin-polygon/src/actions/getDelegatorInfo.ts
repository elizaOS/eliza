import {
  type Action,
  type Content,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  type State,
  logger as coreLogger,
  composePromptFromState,
  ModelType,
} from '@elizaos/core';
import { formatUnits, Wallet } from 'ethers';
import { PolygonRpcService } from '../services/PolygonRpcService';
import { getDelegatorInfoTemplate } from '../templates';
import { ValidationError, ServiceError, formatErrorMessage, parseErrorMessage } from '../errors';

// Define input schema for the LLM-extracted parameters (matches JSON output from template)
interface DelegatorParams {
  validatorId?: number; // Make optional to catch errors from LLM more gracefully
  delegatorAddress?: string;
  error?: string; // To catch error messages from LLM
}

export const getDelegatorInfoAction: Action = {
  name: 'POLYGON_GET_DELEGATOR_INFO',
  similes: ['QUERY_STAKE', 'DELEGATOR_DETAILS', 'GET_MY_STAKE', 'GET_L1_DELEGATOR_INFO'].map(
    (s) => `POLYGON_${s}`
  ),
  description:
    'Retrieves staking information for a specific delegator address (defaults to agent wallet).',

  validate: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state: State | undefined
  ): Promise<boolean> => {
    coreLogger.debug('Validating POLYGON_GET_DELEGATOR_INFO action...');

    const requiredSettings = [
      'PRIVATE_KEY',
      'ETHEREUM_RPC_URL',
      'POLYGON_RPC_URL',
      'POLYGON_PLUGINS_ENABLED',
    ];

    for (const setting of requiredSettings) {
      if (!runtime.getSetting(setting)) {
        coreLogger.error(
          `Required setting ${setting} not configured for POLYGON_GET_DELEGATOR_INFO action.`
        );
        return false;
      }
    }

    try {
      const service = runtime.getService<PolygonRpcService>(PolygonRpcService.serviceType);
      if (!service) {
        coreLogger.error('PolygonRpcService not initialized.');
        return false;
      }
    } catch (error: unknown) {
      coreLogger.error('Error accessing PolygonRpcService during validation:', error);
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
    coreLogger.info('Handling POLYGON_GET_DELEGATOR_INFO action for message:', message.id);

    try {
      const polygonService = runtime.getService<PolygonRpcService>(PolygonRpcService.serviceType);
      if (!polygonService) {
        throw new ServiceError('PolygonRpcService not available', PolygonRpcService.serviceType);
      }

      const prompt = composePromptFromState({
        state,
        template: getDelegatorInfoTemplate,
      });

      let params: DelegatorParams;

      try {
        // First try using OBJECT_LARGE model type for structured output
        try {
          // The plugin-evm approach is to directly use ModelType.OBJECT_LARGE
          // and handle any potential errors in the catch block
          params = (await runtime.useModel(ModelType.OBJECT_LARGE, {
            prompt,
          })) as DelegatorParams;
          coreLogger.debug('[POLYGON_GET_DELEGATOR_INFO_ACTION] Parsed LLM parameters:', params);

          // Check if the model returned an error field
          if (params.error) {
            coreLogger.error(
              '[POLYGON_GET_DELEGATOR_INFO_ACTION] LLM returned an error:',
              params.error
            );
            throw new ValidationError(params.error);
          }
        } catch (error) {
          // If OBJECT_LARGE fails, fall back to TEXT_LARGE and manual parsing
          coreLogger.debug(
            '[POLYGON_GET_DELEGATOR_INFO_ACTION] OBJECT_LARGE model failed, falling back to TEXT_LARGE and manual parsing',
            error instanceof Error ? error : undefined
          );

          const textResponse = await runtime.useModel(ModelType.LARGE, {
            prompt,
          });
          coreLogger.debug(
            '[POLYGON_GET_DELEGATOR_INFO_ACTION] Raw text response from LLM:',
            textResponse
          );

          params = await extractParamsFromText(textResponse);
        }

        // Validate the extracted parameters
        if (
          typeof params.validatorId !== 'number' ||
          params.validatorId <= 0 ||
          !Number.isInteger(params.validatorId)
        ) {
          coreLogger.error(
            '[POLYGON_GET_DELEGATOR_INFO_ACTION] Invalid or missing validatorId from LLM:',
            params.validatorId
          );
          throw new ValidationError(
            `Validator ID not found or invalid. Received: ${params.validatorId}. Please provide a positive integer. `
          );
        }

        const validatorId = params.validatorId;
        let delegatorAddress = params.delegatorAddress;

        if (!delegatorAddress) {
          const privateKey = runtime.getSetting('PRIVATE_KEY');
          if (!privateKey) {
            throw new ServiceError(
              'Private key not available to determine agent wallet address.',
              'PRIVATE_KEY'
            );
          }
          const wallet = new Wallet(privateKey);
          delegatorAddress = wallet.address;
          coreLogger.info(
            `[POLYGON_GET_DELEGATOR_INFO_ACTION] No delegatorAddress provided, using agent's wallet: ${delegatorAddress}`
          );
        }

        coreLogger.info(
          `POLYGON_GET_DELEGATOR_INFO: Fetching info for V:${validatorId} / D:${delegatorAddress}...`
        );

        const delegatorInfo = await polygonService.getDelegatorInfo(validatorId, delegatorAddress);

        if (!delegatorInfo) {
          const notFoundMsg = `No delegation found for address ${delegatorAddress} with validator ID ${validatorId}.`;
          coreLogger.warn(notFoundMsg);
          throw new ValidationError(notFoundMsg);
        }

        const delegatedMatic = formatUnits(delegatorInfo.delegatedAmount, 18);
        const pendingRewardsMatic = formatUnits(delegatorInfo.pendingRewards, 18);

        const responseMsg = `Delegation Info for address ${delegatorAddress} with validator ${validatorId}:\n- Delegated Amount: ${delegatedMatic} MATIC\n- Pending Rewards: ${pendingRewardsMatic} MATIC`;

        coreLogger.info(`Retrieved delegator info for V:${validatorId} / D:${delegatorAddress}`);

        const responseContent: Content = {
          text: responseMsg,
          actions: ['POLYGON_GET_DELEGATOR_INFO'],
          source: message.content.source,
          data: {
            validatorId,
            delegatorAddress,
            delegation: {
              delegatedAmount: delegatorInfo.delegatedAmount.toString(),
              delegatedAmountFormatted: delegatedMatic,
              pendingRewards: delegatorInfo.pendingRewards.toString(),
              pendingRewardsFormatted: pendingRewardsMatic,
            },
            success: true,
          },
          success: true,
        };

        if (callback) {
          await callback(responseContent);
        }
        return responseContent;
      } catch (error: unknown) {
        const parsedErrorObj = parseErrorMessage(error);
        coreLogger.error(
          'Error in POLYGON_GET_DELEGATOR_INFO handler:',
          parsedErrorObj.message,
          error instanceof Error ? error : parsedErrorObj
        );

        const formattedError = formatErrorMessage(
          'POLYGON_GET_DELEGATOR_INFO',
          parsedErrorObj.message
        );

        const errorContent: Content = {
          text: `Error retrieving delegator information: ${formattedError}`,
          actions: ['POLYGON_GET_DELEGATOR_INFO'],
          source: message.content.source,
          data: {
            success: false,
            error: formattedError,
          },
          success: false,
        };

        if (callback) {
          await callback(errorContent);
        }
        return errorContent;
      }
    } catch (error: unknown) {
      const parsedErrorObj = parseErrorMessage(error);
      coreLogger.error(
        'Error in POLYGON_GET_DELEGATOR_INFO handler:',
        parsedErrorObj.message,
        error instanceof Error ? error : parsedErrorObj
      );

      const formattedError = formatErrorMessage(
        'POLYGON_GET_DELEGATOR_INFO',
        parsedErrorObj.message,
        parsedErrorObj.details || undefined
      );

      const errorContent: Content = {
        text: `Error retrieving delegator information: ${formattedError}`,
        actions: ['POLYGON_GET_DELEGATOR_INFO'],
        source: message.content.source,
        data: {
          success: false,
          error: formattedError,
        },
        success: false,
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
          text: 'Get my stake with validator 42 on Polygon',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'Getting your stake with validator 42 on Polygon',
          action: 'POLYGON_GET_DELEGATOR_INFO',
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: {
          text: 'Show me details for my delegation to Polygon validator #157',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'Showing details for your delegation to validator 157 on Polygon',
          action: 'POLYGON_GET_DELEGATOR_INFO',
        },
      },
    ],
  ],
};

// Helper function to extract parameters from text response (including XML format)
async function extractParamsFromText(responseText: string): Promise<DelegatorParams> {
  coreLogger.debug('Raw responseText:', responseText);

  // First try to extract as JSON
  try {
    // Look for JSON code blocks
    const jsonMatch = responseText.match(/```(?:json)?\s*({[\s\S]*?})\s*```/);
    if (jsonMatch?.[1]) {
      const result = JSON.parse(jsonMatch[1]);
      coreLogger.debug('Extracted from JSON block:', result);
      return result;
    }

    // Look for plain JSON
    if (responseText.trim().startsWith('{') && responseText.trim().endsWith('}')) {
      const result = JSON.parse(responseText);
      coreLogger.debug('Extracted from plain JSON:', result);
      return result;
    }
  } catch (jsonError) {
    coreLogger.debug('Could not parse response as JSON', jsonError);
  }

  // Direct approach: look for validator numbers and addresses
  // Look for any mention of validator followed by a number
  const validatorPattern = /validator\s+(?:id\s+)?(\d+)|validator[^\d]*?(\d+)|validator.*?(\d+)/i;
  const validatorMatch = responseText.match(validatorPattern);

  // Look for Ethereum addresses
  const addressPattern = /(0x[a-fA-F0-9]{40})/i;
  const addressMatch = responseText.match(addressPattern);

  coreLogger.debug('Validator match:', validatorMatch);
  coreLogger.debug('Address match:', addressMatch);

  const params: DelegatorParams = {};

  // Extract validator ID from any of the captured groups
  if (validatorMatch) {
    // Find the first non-undefined group (the actual number)
    const numberGroup = validatorMatch.slice(1).find((g) => g !== undefined);
    if (numberGroup) {
      params.validatorId = Number.parseInt(numberGroup, 10);
      coreLogger.debug(`Extracted validatorId ${params.validatorId} from text`);
    }
  }

  if (addressMatch?.[1]) {
    params.delegatorAddress = addressMatch[1];
    coreLogger.debug(`Extracted delegatorAddress ${params.delegatorAddress} from text`);
  }

  // If we managed to extract a validator ID, return the params
  if (params.validatorId) {
    return params;
  }

  // Last resort: extract any number from the text as a potential validator ID
  const anyNumberMatch = responseText.match(/\b(\d+)\b/);
  if (anyNumberMatch?.[1]) {
    const potentialId = Number.parseInt(anyNumberMatch[1], 10);
    coreLogger.debug(`Extracted potential validatorId ${potentialId} from text as last resort`);
    return { validatorId: potentialId };
  }

  // If we can't extract parameters
  return {
    error: 'Could not extract validator ID from the response. Please provide a valid validator ID.',
  };
}
