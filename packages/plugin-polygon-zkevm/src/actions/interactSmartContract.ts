import {
  type Action,
  type IAgentRuntime,
  type Memory,
  type State,
  type HandlerCallback,
  type Content,
  logger,
  ModelType,
  composePromptFromState,
} from '@elizaos/core';
import { z } from 'zod';
import {
  JsonRpcProvider,
  Wallet,
  Contract,
  parseEther,
  parseUnits,
  formatEther,
  Interface,
} from 'ethers';
import { interactSmartContractTemplate } from '../templates';
import { callLLMWithTimeout } from '../utils/llmHelpers';

export const interactSmartContractAction: Action = {
  name: 'POLYGON_ZKEVM_INTERACT_SMART_CONTRACT',
  similes: [
    'CALL_CONTRACT',
    'INVOKE_CONTRACT',
    'EXECUTE_CONTRACT_METHOD',
    'CONTRACT_INTERACTION',
    'SEND_CONTRACT_TRANSACTION',
  ].map((s) => `POLYGON_ZKEVM_${s}`),
  description:
    'Interacts with a smart contract by calling a state-changing method on Polygon zkEVM.',

  validate: async (runtime: IAgentRuntime, message: Memory, state?: State): Promise<boolean> => {
    const alchemyApiKey = runtime.getSetting('ALCHEMY_API_KEY');
    const zkevmRpcUrl = runtime.getSetting('ZKEVM_RPC_URL');

    if (!alchemyApiKey && !zkevmRpcUrl) {
      return false;
    }

    const content = message.content?.text?.toLowerCase() || '';

    // Contract interaction keywords
    const contractKeywords = [
      'call contract',
      'interact with contract',
      'contract call',
      'invoke contract',
      'execute contract',
      'send to contract',
      'contract interaction',
      'smart contract',
      'call function',
      'contract function',
      'method call',
      'function call',
      'contract method',
      'abi call',
    ];

    // Check for contract address pattern (0x followed by 40 hex characters)
    const contractAddressPattern = /0x[a-fA-F0-9]{40}/;
    const hasContractAddress = contractAddressPattern.test(content);

    // Must contain contract interaction keywords OR have contract address pattern
    const hasKeywords = contractKeywords.some((keyword) => content.includes(keyword));

    return hasKeywords || hasContractAddress;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: { [key: string]: unknown },
    callback?: HandlerCallback
  ): Promise<Content> => {
    logger.info('[interactSmartContractAction] Handler called!');

    const alchemyApiKey = runtime.getSetting('ALCHEMY_API_KEY');
    const zkevmRpcUrl = runtime.getSetting('ZKEVM_RPC_URL');
    const privateKey = runtime.getSetting('PRIVATE_KEY');

    if (!privateKey) {
      const errorMessage = 'PRIVATE_KEY is required for contract interaction.';
      logger.error(`[interactSmartContractAction] Configuration error: ${errorMessage}`);
      const errorContent: Content = {
        text: errorMessage,
        actions: ['POLYGON_INTERACT_SMART_CONTRACT_ZKEVM'],
        data: { error: errorMessage },
      };

      if (callback) {
        await callback(errorContent);
      }
      throw new Error(errorMessage);
    }

    if (!alchemyApiKey && !zkevmRpcUrl) {
      const errorMessage = 'ALCHEMY_API_KEY or ZKEVM_RPC_URL is required in configuration.';
      logger.error(`[interactSmartContractAction] Configuration error: ${errorMessage}`);
      const errorContent: Content = {
        text: errorMessage,
        actions: ['POLYGON_INTERACT_SMART_CONTRACT_ZKEVM'],
        data: { error: errorMessage },
      };

      if (callback) {
        await callback(errorContent);
      }
      throw new Error(errorMessage);
    }

    let interactionParams: any | null = null;
    let transactionHash: string | null = null;
    let methodUsed: 'alchemy' | 'rpc' | null = null;
    let errorMessages: string[] = [];

    // Extract interaction parameters using LLM
    try {
      interactionParams = await callLLMWithTimeout<{
        contractAddress: string;
        abi: any[];
        methodName: string;
        args?: any[];
        gasLimit?: string | number;
        gasPrice?: string;
        maxFeePerGas?: string;
        maxPriorityFeePerGas?: string;
        value?: string;
        error?: string;
      }>(runtime, state, interactSmartContractTemplate, 'interactSmartContractAction');

      // Check if the model returned an error field
      if (interactionParams?.error) {
        logger.error(
          '[interactSmartContractAction] LLM returned an error:',
          interactionParams?.error
        );
        throw new Error(interactionParams?.error);
      }

      // Validate required parameters
      if (
        !interactionParams?.contractAddress ||
        typeof interactionParams.contractAddress !== 'string' ||
        !interactionParams.contractAddress.startsWith('0x')
      ) {
        throw new Error('Invalid contract address received from LLM. Address must start with 0x.');
      }

      if (!interactionParams?.abi || !Array.isArray(interactionParams.abi)) {
        throw new Error('Invalid ABI received from LLM. ABI must be a JSON array.');
      }

      if (!interactionParams?.methodName || typeof interactionParams.methodName !== 'string') {
        throw new Error('Invalid method name received from LLM. Method name must be a string.');
      }

      // Set default args if not provided
      if (!interactionParams.args) {
        interactionParams.args = [];
      }
    } catch (error) {
      logger.debug(
        '[interactSmartContractAction] LLM extraction failed',
        error instanceof Error ? error : undefined
      );
      throw new Error(
        `[interactSmartContractAction] Failed to extract interaction parameters: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    // Determine RPC URL
    const rpcUrl = alchemyApiKey
      ? `${runtime.getSetting('ZKEVM_ALCHEMY_URL') || 'https://polygonzkevm-mainnet.g.alchemy.com/v2'}/${alchemyApiKey}`
      : zkevmRpcUrl;

    if (!rpcUrl) {
      const errorMessage = 'Unable to determine RPC URL for contract interaction.';
      logger.error(`[interactSmartContractAction] ${errorMessage}`);
      const errorContent: Content = {
        text: errorMessage,
        actions: ['POLYGON_INTERACT_SMART_CONTRACT_ZKEVM'],
        data: { error: errorMessage },
      };

      if (callback) {
        await callback(errorContent);
      }
      throw new Error(errorMessage);
    }

    // 1. Attempt contract interaction using Alchemy/RPC with ethers.js
    try {
      logger.info(
        `[interactSmartContractAction] Attempting contract interaction at ${interactionParams.contractAddress}`
      );

      const provider = new JsonRpcProvider(rpcUrl);
      const wallet = new Wallet(privateKey, provider);

      // Create contract instance
      const contract = new Contract(
        interactionParams.contractAddress,
        interactionParams.abi,
        wallet
      );

      // Verify the method exists in the contract
      if (!contract[interactionParams.methodName]) {
        throw new Error(`Method '${interactionParams.methodName}' not found in contract ABI`);
      }

      // Check if this is a view/pure function (read-only)
      const methodAbi = interactionParams.abi.find(
        (item: any) => item.type === 'function' && item.name === interactionParams.methodName
      );
      const isReadOnly =
        methodAbi && (methodAbi.stateMutability === 'view' || methodAbi.stateMutability === 'pure');

      if (isReadOnly) {
        // For view/pure functions, call directly and return the result
        logger.info(
          `[interactSmartContractAction] Calling view/pure method '${interactionParams.methodName}' with args: ${JSON.stringify(interactionParams.args)}`
        );

        const result = await contract[interactionParams.methodName](...interactionParams.args);
        methodUsed = alchemyApiKey ? 'alchemy' : 'rpc';

        logger.info(
          `[interactSmartContractAction] View function call successful. Result: ${result?.toString()}`
        );

        const responseContent: Content = {
          text: `✅ Smart contract view function called successfully on Polygon zkEVM!

**Contract Address:** \`${interactionParams.contractAddress}\`
**Method Called:** \`${interactionParams.methodName}\`
**Arguments:** \`${JSON.stringify(interactionParams.args)}\`
**Result:** \`${result?.toString()}\`
**Method Used:** ${methodUsed}
**Network:** Polygon zkEVM

This was a read-only function call that doesn't modify blockchain state.`,
          actions: ['POLYGON_INTERACT_SMART_CONTRACT_ZKEVM'],
          data: {
            contractAddress: interactionParams.contractAddress,
            methodName: interactionParams.methodName,
            args: interactionParams.args,
            result: result?.toString(),
            network: 'polygon-zkevm',
            timestamp: Date.now(),
            method: methodUsed,
            isReadOnly: true,
          },
        };

        if (callback) {
          await callback(responseContent);
        }

        return responseContent;
      }

      // For state-changing functions, prepare transaction options
      const transactionOptions: any = {};

      // Add value if provided
      if (interactionParams.value) {
        transactionOptions.value = parseEther(interactionParams.value);
      }

      // Add gas parameters
      if (interactionParams.gasLimit) {
        transactionOptions.gasLimit = interactionParams.gasLimit;
      } else {
        // Estimate gas if not provided
        try {
          const estimatedGas = await contract[interactionParams.methodName].estimateGas(
            ...interactionParams.args,
            transactionOptions
          );
          transactionOptions.gasLimit = Math.floor(Number(estimatedGas) * 1.2); // Add 20% buffer
          logger.info(`[interactSmartContractAction] Estimated gas: ${estimatedGas.toString()}`);
        } catch (gasError) {
          logger.warn(
            `[interactSmartContractAction] Gas estimation failed, using default: ${gasError}`
          );
          transactionOptions.gasLimit = '500000'; // Default gas limit for contract interaction
        }
      }

      // Handle gas pricing (EIP-1559 vs legacy)
      if (interactionParams.maxFeePerGas || interactionParams.maxPriorityFeePerGas) {
        // EIP-1559 transaction
        if (interactionParams.maxFeePerGas) {
          transactionOptions.maxFeePerGas = parseUnits(interactionParams.maxFeePerGas, 'gwei');
        }
        if (interactionParams.maxPriorityFeePerGas) {
          transactionOptions.maxPriorityFeePerGas = parseUnits(
            interactionParams.maxPriorityFeePerGas,
            'gwei'
          );
        }
        transactionOptions.type = 2; // EIP-1559
      } else if (interactionParams.gasPrice) {
        // Legacy transaction
        transactionOptions.gasPrice = parseUnits(interactionParams.gasPrice, 'gwei');
        transactionOptions.type = 0; // Legacy
      } else {
        // Use current gas price
        try {
          const feeData = await provider.getFeeData();
          if (feeData.maxFeePerGas && feeData.maxPriorityFeePerGas) {
            transactionOptions.maxFeePerGas = feeData.maxFeePerGas;
            transactionOptions.maxPriorityFeePerGas = feeData.maxPriorityFeePerGas;
            transactionOptions.type = 2;
          } else if (feeData.gasPrice) {
            transactionOptions.gasPrice = feeData.gasPrice;
            transactionOptions.type = 0;
          }
        } catch (feeError) {
          logger.warn(`[interactSmartContractAction] Fee data fetch failed: ${feeError}`);
        }
      }

      // Call the contract method (state-changing)
      logger.info(
        `[interactSmartContractAction] Calling state-changing method '${interactionParams.methodName}' with args: ${JSON.stringify(interactionParams.args)}`
      );

      const transaction = await contract[interactionParams.methodName](
        ...interactionParams.args,
        transactionOptions
      );
      transactionHash = transaction.hash;

      logger.info(
        `[interactSmartContractAction] Contract interaction transaction sent: ${transactionHash}`
      );

      // Wait for the transaction to be mined
      const receipt = await transaction.wait();

      if (receipt && receipt.status === 1) {
        methodUsed = alchemyApiKey ? 'alchemy' : 'rpc';

        logger.info(
          `[interactSmartContractAction] Contract interaction successful. Gas used: ${receipt.gasUsed.toString()}`
        );
      } else {
        throw new Error('Contract interaction failed - transaction was reverted');
      }
    } catch (error) {
      logger.error(`[interactSmartContractAction] Contract interaction failed:`, error);
      errorMessages.push(
        `Contract interaction failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    // Handle result and errors
    if (transactionHash) {
      const responseContent: Content = {
        text: `✅ Smart contract interaction successful on Polygon zkEVM!

**Contract Address:** \`${interactionParams.contractAddress}\`
**Method Called:** \`${interactionParams.methodName}\`
**Arguments:** \`${JSON.stringify(interactionParams.args)}\`
**Transaction Hash:** \`${transactionHash}\`
**Method Used:** ${methodUsed}
**Network:** Polygon zkEVM

This was a state-changing transaction that has been sent to the network.`,
        actions: ['POLYGON_INTERACT_SMART_CONTRACT_ZKEVM'],
        data: {
          contractAddress: interactionParams.contractAddress,
          methodName: interactionParams.methodName,
          args: interactionParams.args,
          transactionHash,
          network: 'polygon-zkevm',
          timestamp: Date.now(),
          method: methodUsed,
          interactionParams: {
            gasLimit: interactionParams.gasLimit,
            value: interactionParams.value,
          },
        },
      };

      if (callback) {
        await callback(responseContent);
      }

      return responseContent;
    } else {
      // Contract interaction failed
      const errorMessage = `Failed to interact with smart contract on Polygon zkEVM. Errors: ${errorMessages.join('; ')}. Please check your contract address, ABI, method name, and arguments.`;
      logger.error(errorMessage);

      const errorContent: Content = {
        text: errorMessage,
        actions: ['POLYGON_INTERACT_SMART_CONTRACT_ZKEVM'],
        data: { error: errorMessage, errors: errorMessages, interactionParams },
      };

      if (callback) {
        await callback(errorContent);
      }

      throw new Error(errorMessage);
    }
  },

  examples: [
    [
      {
        name: '{{user1}}',
        content: {
          text: 'Call the "mint" function on contract 0x123... with arguments ["0xabc...", 100] on Polygon zkEVM',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: '✅ Smart contract interaction successful on Polygon zkEVM! Transaction sent: 0x456... Please wait for confirmation.',
          action: 'POLYGON_INTERACT_SMART_CONTRACT_ZKEVM',
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: {
          text: 'Interact with contract 0xdef... on Polygon zkEVM to call "approve" with args ["0x123...", 50]',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: '✅ Smart contract interaction successful on Polygon zkEVM! Transaction sent: 0x789... Please wait for confirmation.',
          action: 'POLYGON_INTERACT_SMART_CONTRACT_ZKEVM',
        },
      },
    ],
  ],
};
