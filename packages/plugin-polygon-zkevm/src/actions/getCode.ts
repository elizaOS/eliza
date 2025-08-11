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
import { getCodeTemplate } from '../templates';
import { callLLMWithTimeout } from '../utils/llmHelpers';

/**
 * Get code action for Polygon zkEVM
 * Retrieves the contract code for a specific address
 */
export const getCodeAction: Action = {
  name: 'POLYGON_ZKEVM_GET_CODE',
  similes: ['GET_CONTRACT_CODE', 'CONTRACT_CODE', 'BYTECODE', 'CODE'].map(
    (s) => `POLYGON_ZKEVM_${s}`
  ),
  description: 'Gets the code for a given contract address on Polygon zkEVM.',

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
    logger.info('[getCodeAction] Handler called!');

    const alchemyApiKey = runtime.getSetting('ALCHEMY_API_KEY');
    const zkevmRpcUrl = runtime.getSetting('ZKEVM_RPC_URL');

    if (!alchemyApiKey && !zkevmRpcUrl) {
      const errorMessage = 'ALCHEMY_API_KEY or ZKEVM_RPC_URL is required in configuration.';
      logger.error(`[getCodeAction] Configuration error: ${errorMessage}`);
      const errorContent: Content = {
        text: errorMessage,
        actions: ['POLYGON_GET_CODE_ZKEVM'],
        data: { error: errorMessage },
      };

      if (callback) {
        await callback(errorContent);
      }
      throw new Error(errorMessage);
    }

    let addressInput: any | null = null;

    // Extract address using LLM with OBJECT_LARGE model
    try {
      addressInput = await callLLMWithTimeout<{ address: string }>(
        runtime,
        state,
        getCodeTemplate,
        'getCodeAction'
      );

      if (addressInput?.error) {
        logger.error('[getCodeAction] LLM returned an error:', addressInput?.error);
        throw new Error(addressInput?.error);
      }

      if (!addressInput?.address || typeof addressInput.address !== 'string') {
        throw new Error('Invalid address received from LLM.');
      }
    } catch (error) {
      logger.debug(
        '[getCodeAction] OBJECT_LARGE model failed',
        error instanceof Error ? error : undefined
      );
      throw new Error(
        `[getCodeAction] Failed to extract address from input: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    const address = addressInput.address;

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

    // Get contract code
    const code = await provider.getCode(address);

    let responseText = `📋 **Contract Code for ${address}**

**Network:** Polygon zkEVM
**Method:** ${methodUsed}

`;

    if (code === '0x' || code === '0x0') {
      responseText += `❌ **No contract code found** - This is an Externally Owned Account (EOA)`;
    } else {
      const codeSize = (code.length - 2) / 2; // Remove '0x' prefix and divide by 2 for bytes
      responseText += `✅ **Contract detected!**
📏 **Code Size:** ${codeSize} bytes
🔗 **Code Length:** ${code.length} characters (including 0x prefix)`;

      // Show first few bytes for verification
      if (code.length > 10) {
        const preview = code.substring(0, 42); // Show first 20 bytes
        responseText += `\n👀 **Code Preview:** \`${preview}...\``;
      }

      // Detect common contract patterns
      if (code.includes('6080604052')) {
        responseText += `\n🔍 **Detected:** Solidity contract (common compiler pattern)`;
      }
      if (code.includes('a165627a7a72305820')) {
        responseText += `\n📝 **Contains:** Swarm hash metadata`;
      }
    }

    const responseContent: Content = {
      text: responseText,
      actions: ['POLYGON_GET_CODE_ZKEVM'],
      data: {
        address,
        code,
        codeSize: code === '0x' ? 0 : (code.length - 2) / 2,
        isContract: code !== '0x' && code !== '0x0',
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
          text: 'Get contract code for 0x742d35Cc6634C0532925a3b8D4C9db96C4b4d8b6 on Polygon zkEVM',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: "I'll get the contract code for that address on Polygon zkEVM.",
          action: 'POLYGON_GET_CODE_ZKEVM',
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: {
          text: 'Check if 0x1234567890123456789012345678901234567890 is a contract on Polygon zkEVM',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'Let me check if that address contains contract code on Polygon zkEVM.',
          action: 'POLYGON_GET_CODE_ZKEVM',
        },
      },
    ],
  ],
};
