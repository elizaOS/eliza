import { Action, IAgentRuntime, logger, Memory } from '@elizaos/core';
import { z } from 'zod';
import { initializeQuickswapClient } from '../utils/quickswapClient.js';

/**
 * M5-10: Executes a limit order, stop-loss order, or take-profit order on Quickswap.
 */
export const executeLimitOrderStopLossTakeProfitAction: Action = {
  name: 'QUICKSWAP_EXECUTE_LIMIT_ORDER_STOP_LOSS_TAKE_PROFIT',
  description:
    'Executes a limit, stop-loss, or take-profit order for a specified token pair on Quickswap.',
  validate: async (runtime: IAgentRuntime, message: Memory) => {
    logger.info(
      `[executeLimitOrderStopLossTakeProfitAction] Validate called for message: "${message.content?.text}"`
    );

    const quickswapApiUrl = runtime.getSetting('QUICKSWAP_API_URL');

    if (!quickswapApiUrl) {
      logger.warn(
        '[executeLimitOrderStopLossTakeProfitAction] QUICKSWAP_API_URL is required but not provided'
      );
      return false;
    }

    logger.info('[executeLimitOrderStopLossTakeProfitAction] Validation passed');
    return true;
  },
  handler: async (runtime: IAgentRuntime, message: Memory) => {
    try {
      const parsedParams = z
        .object({
          tradeType: z
            .enum(['limit', 'stop-loss', 'take-profit'])
            .describe('The type of trade order (limit, stop-loss, or take-profit).'),
          inputTokenSymbolOrAddress: z
            .string()
            .describe('The symbol or address of the input token (e.g., WMATIC, USDC, 0x...).'),
          outputTokenSymbolOrAddress: z
            .string()
            .describe('The symbol or address of the output token (e.g., WMATIC, USDC, 0x...).'),
          amount: z.string().describe('The amount of input token to trade.'),
          price: z.string().describe('The price for the order (e.g., limit price).'),
          stopPrice: z.string().optional().describe('The stop-loss price, if applicable.'),
          takeProfitPrice: z.string().optional().describe('The take-profit price, if applicable.'),
        })
        .parse(message.content);

      const {
        tradeType,
        inputTokenSymbolOrAddress,
        outputTokenSymbolOrAddress,
        amount,
        price,
        stopPrice,
        takeProfitPrice,
      } = parsedParams;

      // Parse amount and price to numbers
      const parsedAmount = parseFloat(amount);
      const parsedPrice = parseFloat(price);

      if (isNaN(parsedAmount) || parsedAmount <= 0) {
        return {
          text: '❌ **Error**: Invalid amount. Please provide a positive number.',
          actions: ['executeLimitOrderStopLossTakeProfit'],
        };
      }
      if (isNaN(parsedPrice) || parsedPrice <= 0) {
        return {
          text: '❌ **Error**: Invalid price. Please provide a positive number.',
          actions: ['executeLimitOrderStopLossTakeProfit'],
        };
      }

      const quickswapClient = await initializeQuickswapClient(runtime);

      // Execute order logic using the client
      const orderResult = await quickswapClient.ExecuteOrder({
        tradeType,
        inputTokenSymbolOrAddress,
        outputTokenSymbolOrAddress,
        amount: parsedAmount.toString(),
        price: parsedPrice.toString(),
        stopPrice: stopPrice ? parseFloat(stopPrice).toString() : undefined,
        takeProfitPrice: takeProfitPrice ? parseFloat(takeProfitPrice).toString() : undefined,
      });

      if (orderResult.success) {
        const responseText = `✅ **${tradeType.toUpperCase()} Order Executed Successfully**\n\n**Order Details:**\n• **Trade Type**: ${tradeType.toUpperCase()}\n• **Input Token**: ${inputTokenSymbolOrAddress.toUpperCase()}\n• **Output Token**: ${outputTokenSymbolOrAddress.toUpperCase()}\n• **Amount**: ${amount}\n• **Price**: ${price}\n${stopPrice ? `• **Stop Price**: ${stopPrice}\n` : ''}${takeProfitPrice ? `• **Take Profit Price**: ${takeProfitPrice}\n` : ''}• **Transaction Hash**: ${orderResult.transactionHash}`;

        return {
          text: responseText,
          actions: ['executeLimitOrderStopLossTakeProfit'],
          data: {
            success: true,
            orderDetails: orderResult,
            timestamp: new Date().toISOString(),
          },
        };
      } else {
        return {
          text: `❌ **Error**: ${orderResult.error || `Executing ${tradeType} order failed.`}`,
          actions: ['executeLimitOrderStopLossTakeProfit'],
          data: {
            success: false,
            error: orderResult.error,
            tradeType,
            inputTokenSymbolOrAddress,
            outputTokenSymbolOrAddress,
            amount,
            price,
            stopPrice,
            takeProfitPrice,
            timestamp: new Date().toISOString(),
          },
        };
      }
    } catch (error) {
      const errorMessage =
        error instanceof z.ZodError
          ? `Invalid parameters: ${error.errors.map((e) => e.message).join(', ')}`
          : error instanceof Error
            ? error.message
            : 'Unknown error occurred while executing order';
      logger.error(`[executeLimitOrderStopLossTakeProfitAction] Error executing order:`, error);

      return {
        text: `❌ **Error**: ${errorMessage}`,
        actions: ['executeLimitOrderStopLossTakeProfit'],
        data: {
          error: errorMessage,
          timestamp: new Date().toISOString(),
        },
      };
    }
  },
};
