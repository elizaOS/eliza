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
import { getLogsTemplate } from '../templates';
import { JsonRpcProvider } from 'ethers';
import { callLLMWithTimeout } from '../utils/llmHelpers';

/**
 * Get logs action for Polygon zkEVM
 * Retrieves event logs based on filter criteria
 */
export const getLogsAction: Action = {
  name: 'POLYGON_ZKEVM_GET_LOGS',
  similes: ['GET_EVENTS', 'EVENT_LOGS', 'LOGS', 'CONTRACT_EVENTS'].map((s) => `POLYGON_ZKEVM_${s}`),
  description: 'Gets logs/events for a given contract address on Polygon zkEVM.',

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
      logger.info('Handling GET_LOGS_ZKEVM action');

      const alchemyApiKey = runtime.getSetting('ALCHEMY_API_KEY');
      const zkevmRpcUrl = runtime.getSetting('ZKEVM_RPC_URL');

      if (!alchemyApiKey && !zkevmRpcUrl) {
        const errorMessage = 'ALCHEMY_API_KEY or ZKEVM_RPC_URL is required in configuration.';
        logger.error(`[getLogsAction] Configuration error: ${errorMessage}`);
        const errorContent: Content = {
          text: errorMessage,
          actions: ['POLYGON_GET_LOGS_ZKEVM'],
          data: { error: errorMessage },
        };

        if (callback) {
          await callback(errorContent);
        }
        throw new Error(errorMessage);
      }

      let logsInput: any | null = null;

      // Extract logs parameters using LLM with OBJECT_LARGE model
      try {
        logsInput = await callLLMWithTimeout<{
          address?: string;
          fromBlock?: string | number;
          toBlock?: string | number;
          topics?: string[];
          error?: string;
        }>(runtime, state, getLogsTemplate, 'getLogsAction');

        if (logsInput?.error) {
          logger.error('[getLogsAction] LLM returned an error:', logsInput?.error);
          throw new Error(logsInput?.error);
        }
      } catch (error) {
        logger.error(
          '[getLogsAction] OBJECT_LARGE model failed',
          error instanceof Error ? error : undefined
        );
        throw new Error(
          `[getLogsAction] Failed to extract logs parameters from input: ${error instanceof Error ? error.message : String(error)}`
        );
      }

      // Setup provider - prefer Alchemy, fallback to RPC
      let provider: JsonRpcProvider;
      const zkevmAlchemyUrl =
        runtime.getSetting('ZKEVM_ALCHEMY_URL') || 'https://polygonzkevm-mainnet.g.alchemy.com/v2';

      if (alchemyApiKey) {
        provider = new JsonRpcProvider(`${zkevmAlchemyUrl}/${alchemyApiKey}`);
      } else {
        provider = new JsonRpcProvider(zkevmRpcUrl);
      }

      // Build filter object
      const filter: any = {};

      // Use LLM-extracted address if available
      if (logsInput?.address) {
        filter.address = logsInput.address;
      }

      // Use LLM-extracted block range if available
      if (logsInput?.fromBlock !== undefined) {
        if (
          typeof logsInput.fromBlock === 'string' &&
          ['latest', 'earliest', 'pending'].includes(logsInput.fromBlock)
        ) {
          filter.fromBlock = logsInput.fromBlock;
        } else {
          const blockNum = Number(logsInput.fromBlock);
          filter.fromBlock = `0x${blockNum.toString(16)}`;
        }
      } else {
        // Default to recent blocks to avoid overwhelming response
        filter.fromBlock = 'latest';
      }

      if (logsInput?.toBlock !== undefined) {
        if (
          typeof logsInput.toBlock === 'string' &&
          ['latest', 'earliest', 'pending'].includes(logsInput.toBlock)
        ) {
          filter.toBlock = logsInput.toBlock;
        } else {
          const blockNum = Number(logsInput.toBlock);
          filter.toBlock = `0x${blockNum.toString(16)}`;
        }
      } else {
        filter.toBlock = 'latest';
      }

      // Add topics if provided
      if (logsInput?.topics && Array.isArray(logsInput.topics) && logsInput.topics.length > 0) {
        filter.topics = logsInput.topics;
      }

      // If no specific address and using latest blocks, limit the scope to avoid overwhelming results
      if (!filter.address && filter.fromBlock === 'latest' && filter.toBlock === 'latest') {
        const currentBlock = await provider.getBlockNumber();
        filter.fromBlock = `0x${Math.max(0, currentBlock - 100).toString(16)}`; // Last 100 blocks
        filter.toBlock = `0x${currentBlock.toString(16)}`;
      }

      // Get logs
      const logs = await provider.send('eth_getLogs', [filter]);

      let responseText = `📋 Event Logs Query Results:
🔍 Filter: ${JSON.stringify(filter, null, 2)}
📊 Found: ${logs.length} logs`;

      if (logs.length === 0) {
        responseText += `\n\n💡 No logs found matching the criteria. Try:
- Specifying a contract address
- Expanding the block range
- Checking if the contract emits events`;
      } else {
        responseText += `\n\n📝 Recent Logs:`;

        // Show first few logs
        const logsToShow = Math.min(5, logs.length);
        for (let i = 0; i < logsToShow; i++) {
          const log = logs[i];
          responseText += `\n\n🔸 Log ${i + 1}:
  📍 Address: ${log.address}
  🔗 Block: ${parseInt(log.blockNumber, 16)}
  📋 Transaction: ${log.transactionHash}
  🏷️ Topics: ${log.topics.length}`;

          if (log.topics.length > 0) {
            responseText += `\n  🎯 Event Signature: ${log.topics[0]}`;
          }

          if (log.data && log.data !== '0x') {
            const dataLength = (log.data.length - 2) / 2;
            responseText += `\n  📦 Data: ${dataLength} bytes`;
          }
        }

        if (logs.length > logsToShow) {
          responseText += `\n\n... and ${logs.length - logsToShow} more logs`;
        }
      }

      const responseContent: Content = {
        text: responseText,
        actions: ['POLYGON_GET_LOGS_ZKEVM'],
        data: {
          filter,
          logs: logs.slice(0, 10), // Include first 10 logs in data
          totalLogs: logs.length,
        },
      };

      if (callback) {
        await callback(responseContent);
      }
      return responseContent;
    } catch (error) {
      logger.error('Error in GET_LOGS_ZKEVM action:', error);

      const errorContent: Content = {
        text: `Error getting logs: ${error instanceof Error ? error.message : 'Unknown error'}`,
        actions: ['POLYGON_GET_LOGS_ZKEVM'],
        data: { error: error instanceof Error ? error.message : 'Unknown error' },
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
          text: 'Get logs for contract 0x742d35Cc6634C0532925a3b8D4C9db96C4b4d8b6 on Polygon zkEVM',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: `📋 Event Logs Query Results:
🔍 Filter: {
  "address": "0x742d35Cc6634C0532925a3b8D4C9db96C4b4d8b6",
  "fromBlock": "latest",
  "toBlock": "latest"
}
📊 Found: 3 logs

📝 Recent Logs:

🔸 Log 1:
  📍 Address: 0x742d35Cc6634C0532925a3b8D4C9db96C4b4d8b6
  🔗 Block: 12345
  📋 Transaction: 0xabc123...
  🏷️ Topics: 3
  🎯 Event Signature: 0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef
  📦 Data: 64 bytes`,
          action: 'POLYGON_GET_LOGS_ZKEVM',
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: {
          text: 'get events for 0x123... from block 1000 to 2000 on Polygon zkEVM',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: "I'll get the event logs for you on Polygon zkEVM.",
          action: 'POLYGON_GET_LOGS_ZKEVM',
        },
      },
    ],
  ],
};
