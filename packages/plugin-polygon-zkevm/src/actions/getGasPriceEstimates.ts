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
import { getGasPriceEstimatesTemplate } from '../templates';
import { JsonRpcProvider, formatUnits, parseUnits } from 'ethers';

interface GasPriceEstimates {
  low: string;
  medium: string;
  high: string;
  lowGwei: string;
  mediumGwei: string;
  highGwei: string;
  basePrice: string;
  basePriceGwei: string;
  method: 'alchemy' | 'rpc';
  timestamp: number;
}

/**
 * Get gas price estimates action for Polygon zkEVM
 * Provides low/medium/high gas price tiers for transaction planning
 */
export const getGasPriceEstimatesAction: Action = {
  name: 'POLYGON_ZKEVM_GET_GAS_PRICE_ESTIMATES',
  similes: [
    'GAS_PRICE_TIERS',
    'GAS_ESTIMATES',
    'GAS_PRICE_LEVELS',
    'ESTIMATE_GAS_PRICE',
    'GAS_FEES',
    'TRANSACTION_FEES',
    'GAS_COST',
    'FEE_ESTIMATES',
  ].map((s) => `POLYGON_ZKEVM_${s}`),
  description: 'Get gas price estimates with low/medium/high tiers for Polygon zkEVM transactions',

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
    try {
      logger.info('⛽ Handling GET_GAS_PRICE_ESTIMATES action');

      // Setup provider - prefer Alchemy, fallback to RPC
      let provider: JsonRpcProvider;
      let methodUsed: 'alchemy' | 'rpc' = 'rpc';
      const alchemyApiKey = runtime.getSetting('ALCHEMY_API_KEY');

      if (alchemyApiKey) {
        provider = new JsonRpcProvider(
          `${runtime.getSetting('ZKEVM_ALCHEMY_URL') || 'https://polygonzkevm-mainnet.g.alchemy.com/v2'}/${alchemyApiKey}`
        );
        methodUsed = 'alchemy';
        logger.info('🔗 Using Alchemy API for gas price estimates');
      } else {
        const zkevmRpcUrl =
          runtime.getSetting('ZKEVM_RPC_URL') ||
          runtime.getSetting('ZKEVM_RPC_URL') ||
          'https://zkevm-rpc.com';
        provider = new JsonRpcProvider(zkevmRpcUrl);
        logger.info('🔗 Using direct RPC for gas price estimates');
      }

      let baseGasPrice: bigint;
      let errorMessages: string[] = [];

      // Get base gas price
      try {
        logger.info('📊 Fetching current gas price...');

        // Try to get gas price using provider method first
        const gasPriceResult = await provider.send('eth_gasPrice', []);
        baseGasPrice = BigInt(gasPriceResult);

        logger.info(`✅ Base gas price retrieved: ${baseGasPrice.toString()} wei`);
      } catch (error) {
        const errorMsg = `Failed to get gas price: ${error instanceof Error ? error.message : String(error)}`;
        logger.error(errorMsg);
        errorMessages.push(errorMsg);

        // Try fallback method if using Alchemy
        if (methodUsed === 'alchemy') {
          logger.info('🔄 Attempting fallback to direct RPC...');
          try {
            const fallbackRpcUrl =
              runtime.getSetting('ZKEVM_RPC_URL') ||
              runtime.getSetting('ZKEVM_RPC_URL') ||
              'https://zkevm-rpc.com';
            const fallbackProvider = new JsonRpcProvider(fallbackRpcUrl);

            const fallbackGasPrice = await fallbackProvider.send('eth_gasPrice', []);
            baseGasPrice = BigInt(fallbackGasPrice);
            methodUsed = 'rpc';
            logger.info('✅ Fallback successful');
          } catch (fallbackError) {
            const fallbackErrorMsg = `Fallback also failed: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`;
            logger.error(fallbackErrorMsg);
            errorMessages.push(fallbackErrorMsg);

            // Use a reasonable default for zkEVM (typically lower than mainnet)
            baseGasPrice = parseUnits('0.25', 'gwei'); // 0.25 gwei default
            logger.warn(`Using default gas price: ${baseGasPrice.toString()} wei`);
          }
        } else {
          // Use a reasonable default for zkEVM
          baseGasPrice = parseUnits('0.25', 'gwei'); // 0.25 gwei default
          logger.warn(`Using default gas price: ${baseGasPrice.toString()} wei`);
        }
      }

      // Calculate gas price tiers
      // zkEVM typically has lower gas prices than mainnet, so we use smaller increments
      const oneGwei = parseUnits('1', 'gwei');
      const halfGwei = parseUnits('0.5', 'gwei');
      const twoGwei = parseUnits('2', 'gwei');
      const fiveGwei = parseUnits('5', 'gwei');

      // For zkEVM, we use more conservative increments
      let lowGasPrice: bigint;
      let mediumGasPrice: bigint;
      let highGasPrice: bigint;

      // If base price is very low (< 1 gwei), use smaller increments
      if (baseGasPrice < oneGwei) {
        lowGasPrice = baseGasPrice + parseUnits('0.1', 'gwei');
        mediumGasPrice = baseGasPrice + parseUnits('0.25', 'gwei');
        highGasPrice = baseGasPrice + halfGwei;
      } else if (baseGasPrice < fiveGwei) {
        // For moderate prices (1-5 gwei), use standard increments
        lowGasPrice = baseGasPrice + halfGwei;
        mediumGasPrice = baseGasPrice + oneGwei;
        highGasPrice = baseGasPrice + twoGwei;
      } else {
        // For higher prices (>5 gwei), use larger increments
        lowGasPrice = baseGasPrice + oneGwei;
        mediumGasPrice = baseGasPrice + twoGwei;
        highGasPrice = baseGasPrice + fiveGwei;
      }

      // Format prices in both wei and gwei
      const result: GasPriceEstimates = {
        low: lowGasPrice.toString(),
        medium: mediumGasPrice.toString(),
        high: highGasPrice.toString(),
        lowGwei: formatUnits(lowGasPrice, 'gwei'),
        mediumGwei: formatUnits(mediumGasPrice, 'gwei'),
        highGwei: formatUnits(highGasPrice, 'gwei'),
        basePrice: baseGasPrice.toString(),
        basePriceGwei: formatUnits(baseGasPrice, 'gwei'),
        method: methodUsed,
        timestamp: Date.now(),
      };

      // Calculate percentage increases for display
      const lowIncrease = Number(((lowGasPrice - baseGasPrice) * 100n) / baseGasPrice);
      const mediumIncrease = Number(((mediumGasPrice - baseGasPrice) * 100n) / baseGasPrice);
      const highIncrease = Number(((highGasPrice - baseGasPrice) * 100n) / baseGasPrice);

      // Format response text
      let responseText = `⛽ **Gas Price Estimates for Polygon zkEVM**\n\n`;

      responseText += `**Current Base Price:**\n`;
      responseText += `📊 ${result.basePriceGwei} gwei (${result.basePrice} wei)\n\n`;

      responseText += `**Recommended Tiers:**\n`;
      responseText += `🐌 **Low Priority:** ${result.lowGwei} gwei (+${lowIncrease.toFixed(1)}%)\n`;
      responseText += `   └─ ${result.low} wei\n`;
      responseText += `⚡ **Medium Priority:** ${result.mediumGwei} gwei (+${mediumIncrease.toFixed(1)}%)\n`;
      responseText += `   └─ ${result.medium} wei\n`;
      responseText += `🚀 **High Priority:** ${result.highGwei} gwei (+${highIncrease.toFixed(1)}%)\n`;
      responseText += `   └─ ${result.high} wei\n\n`;

      // Add usage recommendations
      responseText += `**Usage Recommendations:**\n`;
      responseText += `🐌 Low: Non-urgent transactions, can wait 1-2 minutes\n`;
      responseText += `⚡ Medium: Standard transactions, ~30-60 seconds\n`;
      responseText += `🚀 High: Urgent transactions, fastest confirmation\n\n`;

      // Add method and error info
      responseText += `🔗 Retrieved via ${methodUsed === 'alchemy' ? 'Alchemy API' : 'Direct RPC'}`;

      if (errorMessages.length > 0) {
        responseText += `\n\n⚠️ Some errors occurred:\n${errorMessages
          .slice(0, 2)
          .map((msg) => `• ${msg}`)
          .join('\n')}`;
        if (errorMessages.length > 2) {
          responseText += `\n• ... and ${errorMessages.length - 2} more errors`;
        }
      }

      // Add zkEVM specific note
      responseText += `\n\n💡 *zkEVM gas prices are typically lower than Ethereum mainnet*`;

      const responseContent: Content = {
        text: responseText,
        actions: ['POLYGON_GET_GAS_PRICE_ESTIMATES_ZKEVM'],
        source: message.content.source,
        data: result,
      };

      await callback(responseContent);
      return responseContent;
    } catch (error) {
      logger.error('❌ Error in GET_GAS_PRICE_ESTIMATES action:', error);

      const errorContent: Content = {
        text: `❌ Error getting gas price estimates: ${error instanceof Error ? error.message : 'Unknown error'}`,
        actions: ['POLYGON_GET_GAS_PRICE_ESTIMATES_ZKEVM'],
        source: message.content.source,
      };

      await callback(errorContent);
      return errorContent;
    }
  },

  examples: [
    [
      {
        name: '{{user1}}',
        content: {
          text: 'Get gas price estimates for Polygon zkEVM',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: '⛽ **Gas Price Estimates for Polygon zkEVM**\n\n**Current Base Price:**\n📊 0.2500 gwei (250000000 wei)\n\n**Recommended Tiers:**\n🐌 **Low Priority:** 0.3500 gwei (+40.0%)\n   └─ 350000000 wei\n⚡ **Medium Priority:** 0.5000 gwei (+100.0%)\n   └─ 500000000 wei\n🚀 **High Priority:** 0.7500 gwei (+200.0%)\n   └─ 750000000 wei\n\n**Usage Recommendations:**\n🐌 Low: Non-urgent transactions, can wait 1-2 minutes\n⚡ Medium: Standard transactions, ~30-60 seconds\n🚀 High: Urgent transactions, fastest confirmation\n\n🔗 Retrieved via Alchemy API\n\n💡 *zkEVM gas prices are typically lower than Ethereum mainnet*',
          action: 'POLYGON_GET_GAS_PRICE_ESTIMATES_ZKEVM',
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: {
          text: 'what are the gas fees on polygon zkevm',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: "I'll get the gas fee estimates for you on Polygon zkEVM.",
          action: 'POLYGON_GET_GAS_PRICE_ESTIMATES_ZKEVM',
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: {
          text: 'Show me low medium high gas price tiers',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: '⛽ **Gas Price Estimates for Polygon zkEVM**\n\n**Current Base Price:**\n📊 0.8 gwei (800000000 wei)\n\n**Recommended Tiers:**\n🐌 **Low Priority:** 1.3 gwei (+62.5%)\n   └─ 1300000000 wei\n⚡ **Medium Priority:** 1.8 gwei (+125.0%)\n   └─ 1800000000 wei\n🚀 **High Priority:** 2.8 gwei (+250.0%)\n   └─ 2800000000 wei\n\n**Usage Recommendations:**\n🐌 Low: Non-urgent transactions, can wait 1-2 minutes\n⚡ Medium: Standard transactions, ~30-60 seconds\n🚀 High: Urgent transactions, fastest confirmation\n\n🔗 Retrieved via Alchemy API\n\n💡 *zkEVM gas prices are typically lower than Ethereum mainnet*',
          actions: ['POLYGON_GET_GAS_PRICE_ESTIMATES_ZKEVM'],
        },
      },
    ],
  ],
};
