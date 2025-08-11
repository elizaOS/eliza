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
  type TemplateType,
} from '@elizaos/core';
import { formatUnits } from 'viem'; // Changed from ethers to viem
import { PolygonRpcService, ValidatorStatus } from '../services/PolygonRpcService';
import {
  ValidationError,
  ServiceError,
  ContractError,
  formatErrorMessage,
  parseErrorMessage,
} from '../errors';
import { getValidatorInfoTemplate } from '../templates';

// Define input schema for the LLM-extracted parameters
interface ValidatorParams {
  validatorId: number;
  error?: string; // To catch error messages from LLM
}

// Helper function to attempt extraction of validator ID from text or XML
async function attemptParamExtraction(responseText: string): Promise<ValidatorParams> {
  coreLogger.debug('Raw responseText for extraction:', responseText);

  // First try to extract as JSON
  try {
    // Look for JSON code blocks
    const jsonMatch = responseText.match(/```(?:json)?\s*({[\s\S]*?})\s*```/);
    if (jsonMatch?.[1]) {
      const params = JSON.parse(jsonMatch[1]);
      coreLogger.debug(`Extracted params from JSON code block: ${JSON.stringify(params)}`);
      return params;
    }

    // Try JSON without code blocks
    if (responseText.trim().startsWith('{') && responseText.trim().endsWith('}')) {
      const params = JSON.parse(responseText.trim());
      coreLogger.debug(`Extracted params from plain JSON: ${JSON.stringify(params)}`);
      return params;
    }
  } catch (jsonError) {
    coreLogger.debug('Failed to parse as JSON, trying direct extraction');
  }

  // Direct approach - look for validator number mentions anywhere in the text
  const validatorPattern = /validator\s+(?:id\s+)?(\d+)|validator[^\d]*?(\d+)|validator.*?(\d+)/i;
  const validatorMatch = responseText.match(validatorPattern);

  coreLogger.debug('Validator match:', validatorMatch);

  if (validatorMatch) {
    // Find the first non-undefined group (the actual number)
    const numberGroup = validatorMatch.slice(1).find((g) => g !== undefined);
    if (numberGroup) {
      const validatorId = Number.parseInt(numberGroup, 10);
      coreLogger.debug(`Extracted validatorId ${validatorId} from text pattern match`);
      return { validatorId };
    }
  }

  // Last resort: extract any number from the text as a potential validator ID
  const anyNumberMatch = responseText.match(/\b(\d+)\b/);
  if (anyNumberMatch?.[1]) {
    const validatorId = Number.parseInt(anyNumberMatch[1], 10);
    coreLogger.debug(`Found potential validatorId ${validatorId} from text as last resort`);
    return { validatorId };
  }

  throw new ValidationError('Could not extract validator ID from response');
}

export const getValidatorInfoAction: Action = {
  name: 'POLYGON_GET_VALIDATOR_INFO',
  similes: ['QUERY_VALIDATOR', 'VALIDATOR_DETAILS', 'GET_L1_VALIDATOR_INFO'].map(
    (s) => `POLYGON_${s}`
  ),
  description: 'Retrieves information about a specific Polygon validator.',

  validate: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state: State | undefined
  ): Promise<boolean> => {
    coreLogger.debug('Validating POLYGON_GET_VALIDATOR_INFO action...');

    // Check for required settings
    const requiredSettings = [
      'PRIVATE_KEY',
      'ETHEREUM_RPC_URL', // L1 RPC needed for validator info
      'POLYGON_RPC_URL', // L2 RPC for completeness
      'POLYGON_PLUGINS_ENABLED',
    ];

    for (const setting of requiredSettings) {
      if (!runtime.getSetting(setting)) {
        coreLogger.error(
          `Required setting ${setting} not configured for POLYGON_GET_VALIDATOR_INFO action.`
        );
        return false;
      }
    }

    // Verify PolygonRpcService is available
    try {
      const service = runtime.getService<PolygonRpcService>(PolygonRpcService.serviceType);
      if (!service) {
        throw new ServiceError('PolygonRpcService not initialized', 'PolygonRpcService');
      }
    } catch (error: unknown) {
      const errorMsg = parseErrorMessage(error);
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
    coreLogger.info('Handling POLYGON_GET_VALIDATOR_INFO action for message:', message.id);

    try {
      // Get the PolygonRpcService
      const polygonService = runtime.getService<PolygonRpcService>(PolygonRpcService.serviceType);
      if (!polygonService) {
        throw new ServiceError('PolygonRpcService not available', 'PolygonRpcService');
      }

      // Extract parameters using template prompt
      const prompt = composePromptFromState({
        state,
        template: getValidatorInfoTemplate,
      });

      let params: ValidatorParams;

      try {
        // First try using OBJECT_LARGE model type for structured output
        try {
          // The plugin-evm approach is to directly use ModelType.OBJECT_LARGE
          // and handle any potential errors in the catch block
          params = (await runtime.useModel(ModelType.OBJECT_LARGE, {
            prompt,
          })) as ValidatorParams;
          coreLogger.debug('[GET_VALIDATOR_INFO_ACTION] Parsed LLM parameters:', params);

          // Check if the model returned an error field
          if (params.error) {
            throw new ValidationError(params.error);
          }
        } catch (error) {
          // If OBJECT_LARGE fails, fall back to TEXT_LARGE
          coreLogger.debug(
            '[GET_VALIDATOR_INFO_ACTION] OBJECT_LARGE model failed, falling back to TEXT_LARGE',
            error instanceof Error ? error : undefined
          );

          const responseText = await runtime.useModel(ModelType.LARGE, {
            prompt,
          });
          coreLogger.debug('[GET_VALIDATOR_INFO_ACTION] Raw text response from LLM:', responseText);

          // Extract parameters from text
          params = await attemptParamExtraction(responseText);
        }

        // Validate params after extraction
        if (params.validatorId === undefined) {
          throw new ValidationError('Validator ID parameter not extracted properly');
        }

        if (typeof params.validatorId !== 'number' || params.validatorId <= 0) {
          throw new ValidationError(
            `Invalid validator ID: ${params.validatorId}. Must be a positive integer.`
          );
        }

        coreLogger.debug('Validator parameters:', params);
      } catch (error: unknown) {
        const errorMsg = parseErrorMessage(error);
        coreLogger.error(
          'Failed to parse LLM response for validator parameters:',
          error instanceof Error ? error.message : String(error),
          error
        );

        const errorContent: Content = {
          text: formatErrorMessage(
            'Parameter extraction',
            'Could not understand validator parameters. Please provide a valid validator ID (number).',
            errorMsg.details || undefined
          ),
          actions: ['POLYGON_GET_VALIDATOR_INFO'],
          source: message.content?.source,
          data: {
            success: false,
            error: 'Invalid validator ID parameter',
          },
          success: false,
        };

        if (callback) {
          await callback(errorContent);
        }
        return errorContent;
      }

      // Get validator information
      try {
        const validatorInfo = await polygonService.getValidatorInfo(params.validatorId);

        if (!validatorInfo) {
          throw new ContractError(
            `Validator with ID ${params.validatorId} not found or is inactive.`,
            'STAKE_MANAGER_ADDRESS_L1',
            'validators'
          );
        }

        // Format the validator status as a string
        const statusLabels = {
          [ValidatorStatus.Inactive]: 'Inactive',
          [ValidatorStatus.Active]: 'Active',
          [ValidatorStatus.Unbonding]: 'Unbonding',
          [ValidatorStatus.Jailed]: 'Jailed',
        };

        const statusLabel = statusLabels[validatorInfo.status] || 'Unknown';

        // Format total stake as human-readable MATIC
        // viem formatUnits takes bigint and number directly, no need for .toString()
        const totalStakeMatic = formatUnits(validatorInfo.totalStake, 18);
        const selfStakeMatic = formatUnits(validatorInfo.selfStake, 18);
        const delegatedStakeMatic = formatUnits(validatorInfo.delegatedStake, 18);

        // Prepare response message
        const responseMsg = `Validator #${params.validatorId} Info:
- Status: ${statusLabel}
- Total Staked: ${totalStakeMatic} MATIC
- Self Stake: ${selfStakeMatic} MATIC
- Delegated Stake: ${delegatedStakeMatic} MATIC
- Uptime Percent: ${validatorInfo.uptimePercent}%
- Commission Rate: ${validatorInfo.commissionRate}%
- Signer Address: ${validatorInfo.signerAddress}
- Contract Address: ${validatorInfo.contractAddress}`;

        coreLogger.info(`Retrieved validator info for validator ID ${params.validatorId}`);

        // Format the response content
        const responseContent: Content = {
          text: responseMsg,
          actions: ['POLYGON_GET_VALIDATOR_INFO'],
          source: message.content.source,
          data: {
            validatorId: params.validatorId,
            validator: {
              ...validatorInfo,
              status: statusLabel,
              totalStake: validatorInfo.totalStake.toString(),
              totalStakeFormatted: totalStakeMatic,
              activationEpoch: validatorInfo.activationEpoch.toString(),
              deactivationEpoch: validatorInfo.deactivationEpoch.toString(),
              jailEndEpoch: validatorInfo.jailEndEpoch.toString(),
              lastRewardUpdateEpoch: validatorInfo.lastRewardUpdateEpoch.toString(),
            },
          },
        };

        if (callback) {
          await callback(responseContent);
        }
        return responseContent;
      } catch (error: unknown) {
        const errorMsg = parseErrorMessage(error);
        coreLogger.error(
          `Error getting validator info: ${errorMsg.message}`,
          error instanceof Error ? error : undefined
        );

        const errorContent: Content = {
          text: formatErrorMessage(
            'Validator info retrieval',
            `Failed to get validator #${params.validatorId} info from Ethereum L1`
          ),
          actions: ['POLYGON_GET_VALIDATOR_INFO'],
          source: message.content?.source,
          data: {
            success: false,
            error: `Failed to retrieve validator ${params.validatorId} info: ${errorMsg.message}`,
            STAKE_MANAGER_ADDRESS_L1: true,
            method: 'validators',
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
      coreLogger.error(`Error in POLYGON_GET_VALIDATOR_INFO handler: ${parsedErrorObj.message}`);

      if (parsedErrorObj.details) {
        coreLogger.error(`Details: ${parsedErrorObj.details}`);
      }

      if (error instanceof Error) {
        coreLogger.error('Original error object for stack trace:', error);
      } else if (typeof error === 'object' && error !== null) {
        // If it was an object but not an Error instance, and we haven't logged details yet
        // or want to see the full object structure.
        if (!parsedErrorObj.details) {
          coreLogger.error('Raw error object (stringified):', JSON.stringify(error));
        }
      }

      const formattedError = formatErrorMessage(
        'POLYGON_GET_VALIDATOR_INFO',
        parsedErrorObj.message,
        parsedErrorObj.details || undefined
      );

      const errorContent: Content = {
        text: `Error retrieving validator information: ${formattedError}`,
        actions: ['POLYGON_GET_VALIDATOR_INFO'],
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
          text: 'Get info for validator 42 on Polygon',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'Getting info for validator 42 on Polygon',
          action: 'POLYGON_GET_VALIDATOR_INFO',
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: {
          text: 'Show me details for Polygon validator #157',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'Showing details for validator 157 on Polygon',
          action: 'POLYGON_GET_VALIDATOR_INFO',
        },
      },
    ],
  ],
};
