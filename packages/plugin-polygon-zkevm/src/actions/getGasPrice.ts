import {
  type Action,
  type Content,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  type State,
  logger,
  ModelType,
  composePromptFromState,
} from '@elizaos/core';
import { JsonRpcProvider } from 'ethers';
import { getGasPriceTemplate } from '../templates';

/**
 * Get gas price action for Polygon zkEVM
 * Retrieves current gas price
 */
export const getGasPriceAction: Action = {
  name: 'POLYGON_ZKEVM_GET_GAS_PRICE',
  similes: ['GAS_PRICE', 'CURRENT_GAS', 'GAS_FEE', 'GWEI'].map((s) => `POLYGON_ZKEVM_${s}`),
  description: 'Get current gas price on Polygon zkEVM',

  validate: async (runtime: IAgentRuntime, message: Memory, state?: State): Promise<boolean> => {
    const alchemyApiKey = runtime.getSetting('ALCHEMY_API_KEY');
    const zkevmRpcUrl = runtime.getSetting('ZKEVM_RPC_URL');

    if (!alchemyApiKey && !zkevmRpcUrl) {
      return false;
    }

    return true;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: { [key: string]: unknown },
    callback?: HandlerCallback
  ): Promise<Content> => {
    logger.info('[getGasPriceAction] Handler called!');

    const alchemyApiKey = runtime.getSetting('ALCHEMY_API_KEY');
    const zkevmRpcUrl = runtime.getSetting('ZKEVM_RPC_URL');

    if (!alchemyApiKey && !zkevmRpcUrl) {
      const errorMessage = 'ALCHEMY_API_KEY or ZKEVM_RPC_URL is required in configuration.';
      logger.error(`[getGasPriceAction] Configuration error: ${errorMessage}`);
      const errorContent: Content = {
        text: errorMessage,
        actions: ['POLYGON_GET_GAS_PRICE_ZKEVM'],
        data: { error: errorMessage },
      };

      if (callback) {
        await callback(errorContent);
      }
      throw new Error(errorMessage);
    }

    // Use LLM to validate this is a gas price request
    try {
      const gasRequestInput = (await runtime.useModel(ModelType.OBJECT_LARGE, {
        prompt: composePromptFromState({
          state,
          template: getGasPriceTemplate,
        }),
      })) as { requestGasPrice?: boolean; error?: string };

      if (gasRequestInput?.error) {
        throw new Error(gasRequestInput.error);
      }
    } catch (error) {
      logger.debug('[getGasPriceAction] LLM validation failed, proceeding anyway');
    }

    // Setup provider - prefer Alchemy, fallback to RPC
    let provider: JsonRpcProvider;
    let methodUsed: 'alchemy' | 'rpc' = 'rpc';
    const zkevmAlchemyUrl =
      runtime.getSetting('ZKEVM_ALCHEMY_URL') || 'https://polygonzkevm-mainnet.g.alchemy.com/v2';

    if (alchemyApiKey) {
      provider = new JsonRpcProvider(`${zkevmAlchemyUrl}/${alchemyApiKey}`);
      methodUsed = 'alchemy';
    } else {
      provider = new JsonRpcProvider(zkevmRpcUrl);
    }

    // Get gas price
    const gasPrice = await provider.send('eth_gasPrice', []);
    const gasPriceInWei = BigInt(gasPrice);
    const gasPriceInGwei = Number(gasPriceInWei) / 1e9;

    // Get fee data for more comprehensive information
    let feeData;
    try {
      feeData = await provider.getFeeData();
    } catch (error) {
      logger.warn('Could not get fee data, using basic gas price only');
    }

    let responseText = `⛽ **Current Gas Price (Polygon zkEVM)**

💸 **Gas Price:** ${gasPriceInGwei.toFixed(4)} Gwei (${gasPriceInWei.toString()} wei)
🔗 **Method:** ${methodUsed}`;

    if (feeData) {
      if (feeData.maxFeePerGas) {
        const maxFeeGwei = Number(feeData.maxFeePerGas) / 1e9;
        responseText += `\n🔝 **Max Fee Per Gas:** ${maxFeeGwei.toFixed(4)} Gwei`;
      }
      if (feeData.maxPriorityFeePerGas) {
        const maxPriorityFeeGwei = Number(feeData.maxPriorityFeePerGas) / 1e9;
        responseText += `\n⚡ **Max Priority Fee:** ${maxPriorityFeeGwei.toFixed(4)} Gwei`;
      }
    }

    // Add cost estimates for common operations
    const transferCost = (gasPriceInGwei * 21000) / 1e9; // ETH cost for simple transfer
    const swapCost = (gasPriceInGwei * 150000) / 1e9; // Approximate cost for DEX swap

    responseText += `\n\n💰 **Estimated Transaction Costs:**
📤 Simple Transfer: ~${transferCost.toFixed(6)} ETH
🔄 Token Swap: ~${swapCost.toFixed(6)} ETH`;

    const responseContent: Content = {
      text: responseText,
      actions: ['POLYGON_GET_GAS_PRICE_ZKEVM'],
      data: {
        gasPrice: gasPriceInWei.toString(),
        gasPriceGwei: gasPriceInGwei,
        feeData,
        network: 'polygon-zkevm',
        method: methodUsed,
      },
    };

    if (callback) {
      await callback(responseContent);
    }

    return responseContent;
  },

  examples: [
    [
      {
        name: '{{user1}}',
        content: {
          text: 'What is the current gas price on Polygon zkEVM?',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: "I'll get the current gas price for Polygon zkEVM.",
          action: 'POLYGON_GET_GAS_PRICE_ZKEVM',
        },
      },
    ],
  ],
};
