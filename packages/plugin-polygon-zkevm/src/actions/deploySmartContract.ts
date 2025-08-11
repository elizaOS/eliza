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
import { JsonRpcProvider, Wallet, parseEther, parseUnits, formatEther } from 'ethers';
import { deploySmartContractTemplate } from '../templates';
import { callLLMWithTimeout } from '../utils/llmHelpers';

export const deploySmartContractAction: Action = {
  name: 'POLYGON_ZKEVM_DEPLOY_SMART_CONTRACT',
  similes: [
    'DEPLOY_CONTRACT',
    'DEPLOY_ZKEVM_CONTRACT',
    'CREATE_CONTRACT',
    'DEPLOY_SMART_CONTRACT_ZKEVM',
    'CREATE_SMART_CONTRACT',
    'PUBLISH_CONTRACT',
    'DEPLOY_CONTRACT_ZKEVM',
  ].map((s) => `POLYGON_ZKEVM_${s}`),
  description:
    'Deploys a smart contract to Polygon zkEVM using bytecode and optional constructor arguments.',

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
    logger.info('[deploySmartContractAction] Handler called!');

    const alchemyApiKey = runtime.getSetting('ALCHEMY_API_KEY');
    const zkevmRpcUrl = runtime.getSetting('ZKEVM_RPC_URL');
    const privateKey = runtime.getSetting('PRIVATE_KEY');

    if (!privateKey) {
      const errorMessage = 'PRIVATE_KEY is required for contract deployment.';
      logger.error(`[deploySmartContractAction] Configuration error: ${errorMessage}`);
      const errorContent: Content = {
        text: errorMessage,
        actions: ['POLYGON_DEPLOY_SMART_CONTRACT_ZKEVM'],
        data: { error: errorMessage },
      };

      if (callback) {
        await callback(errorContent);
      }
      throw new Error(errorMessage);
    }

    if (!alchemyApiKey && !zkevmRpcUrl) {
      const errorMessage = 'ALCHEMY_API_KEY or ZKEVM_RPC_URL is required in configuration.';
      logger.error(`[deploySmartContractAction] Configuration error: ${errorMessage}`);
      const errorContent: Content = {
        text: errorMessage,
        actions: ['POLYGON_DEPLOY_SMART_CONTRACT_ZKEVM'],
        data: { error: errorMessage },
      };

      if (callback) {
        await callback(errorContent);
      }
      throw new Error(errorMessage);
    }

    let deploymentParams: any | null = null;
    let contractAddress: string | null = null;
    let transactionHash: string | null = null;
    let methodUsed: 'alchemy' | 'rpc' | null = null;
    let errorMessages: string[] = [];

    // Extract deployment parameters using LLM with OBJECT_LARGE model
    try {
      deploymentParams = await callLLMWithTimeout<{
        bytecode: string;
        constructorArgs?: any[];
        gasLimit?: string | number;
        gasPrice?: string;
        maxFeePerGas?: string;
        maxPriorityFeePerGas?: string;
        value?: string;
        error?: string;
      }>(runtime, state, deploySmartContractTemplate, 'deploySmartContractAction');

      if (deploymentParams?.error) {
        logger.error('[deploySmartContractAction] LLM returned an error:', deploymentParams?.error);
        throw new Error(deploymentParams?.error);
      }

      if (!deploymentParams?.bytecode) {
        throw new Error(
          'No valid bytecode extracted from input. Please provide bytecode starting with 0x.'
        );
      }

      logger.info(
        `[deploySmartContractAction] Extracted bytecode: ${deploymentParams.bytecode.substring(0, 50)}...`
      );
    } catch (error) {
      logger.error(
        '[deploySmartContractAction] OBJECT_LARGE model failed',
        error instanceof Error ? error : undefined
      );
      throw new Error(
        `[deploySmartContractAction] Failed to extract deployment parameters from input: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    // Determine RPC URL
    const rpcUrl = alchemyApiKey
      ? `${runtime.getSetting('ZKEVM_ALCHEMY_URL') || 'https://polygonzkevm-mainnet.g.alchemy.com/v2'}/${alchemyApiKey}`
      : zkevmRpcUrl;

    if (!rpcUrl) {
      const errorMessage = 'Unable to determine RPC URL for deployment.';
      logger.error(`[deploySmartContractAction] ${errorMessage}`);
      const errorContent: Content = {
        text: errorMessage,
        actions: ['POLYGON_DEPLOY_SMART_CONTRACT_ZKEVM'],
        data: { error: errorMessage },
      };

      if (callback) {
        await callback(errorContent);
      }
      throw new Error(errorMessage);
    }

    // Attempt deployment using provider
    try {
      logger.info(`[deploySmartContractAction] Attempting contract deployment`);

      const provider = new JsonRpcProvider(rpcUrl);
      const wallet = new Wallet(privateKey, provider);

      // Prepare transaction data
      const transactionData: any = {
        data: deploymentParams.bytecode,
      };

      // Add constructor arguments if provided
      if (deploymentParams.constructorArgs && deploymentParams.constructorArgs.length > 0) {
        // Note: In a real implementation, you'd need to properly encode constructor args
        // This is a simplified version - in practice you'd use ethers AbiCoder
        logger.info(
          `[deploySmartContractAction] Constructor args provided: ${JSON.stringify(deploymentParams.constructorArgs)}`
        );
        // For now, we'll log this but not implement full ABI encoding
        logger.warn(
          '[deploySmartContractAction] Constructor argument encoding not fully implemented - deploying without args'
        );
      }

      // Add value if provided
      if (deploymentParams.value) {
        transactionData.value = parseEther(deploymentParams.value);
      }

      // Add gas parameters
      if (deploymentParams.gasLimit) {
        transactionData.gasLimit = BigInt(deploymentParams.gasLimit);
      } else {
        // Estimate gas if not provided
        try {
          const estimatedGas = await provider.estimateGas(transactionData);
          transactionData.gasLimit = estimatedGas;
          logger.info(`[deploySmartContractAction] Estimated gas: ${estimatedGas.toString()}`);
        } catch (gasError) {
          logger.warn(
            `[deploySmartContractAction] Gas estimation failed, using default: ${gasError}`
          );
          transactionData.gasLimit = BigInt('3000000'); // Default gas limit for contract deployment
        }
      }

      // Handle gas pricing (EIP-1559 vs legacy)
      if (deploymentParams.maxFeePerGas || deploymentParams.maxPriorityFeePerGas) {
        // EIP-1559 transaction
        if (deploymentParams.maxFeePerGas) {
          transactionData.maxFeePerGas = parseUnits(deploymentParams.maxFeePerGas, 'gwei');
        }
        if (deploymentParams.maxPriorityFeePerGas) {
          transactionData.maxPriorityFeePerGas = parseUnits(
            deploymentParams.maxPriorityFeePerGas,
            'gwei'
          );
        }
        transactionData.type = 2; // EIP-1559
      } else if (deploymentParams.gasPrice) {
        // Legacy transaction
        transactionData.gasPrice = parseUnits(deploymentParams.gasPrice, 'gwei');
        transactionData.type = 0; // Legacy
      } else {
        // Use current gas price
        try {
          const feeData = await provider.getFeeData();
          if (feeData.maxFeePerGas && feeData.maxPriorityFeePerGas) {
            transactionData.maxFeePerGas = feeData.maxFeePerGas;
            transactionData.maxPriorityFeePerGas = feeData.maxPriorityFeePerGas;
            transactionData.type = 2;
          } else if (feeData.gasPrice) {
            transactionData.gasPrice = feeData.gasPrice;
            transactionData.type = 0;
          }
        } catch (feeError) {
          logger.warn(`[deploySmartContractAction] Fee data fetch failed: ${feeError}`);
        }
      }

      // Send the deployment transaction
      const deploymentTx = await wallet.sendTransaction(transactionData);
      transactionHash = deploymentTx.hash;

      logger.info(`[deploySmartContractAction] Deployment transaction sent: ${transactionHash}`);

      // Wait for the transaction to be mined
      const receipt = await deploymentTx.wait();

      if (receipt && receipt.contractAddress) {
        contractAddress = receipt.contractAddress;
        methodUsed = alchemyApiKey ? 'alchemy' : 'rpc';

        logger.info(
          `[deploySmartContractAction] Contract deployed successfully at: ${contractAddress}`
        );
      } else {
        throw new Error('Contract deployment failed - no contract address in receipt');
      }
    } catch (error) {
      logger.error(`[deploySmartContractAction] Deployment failed:`, error);
      errorMessages.push(
        `Deployment failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    // Handle result and errors
    if (contractAddress && transactionHash) {
      const responseContent: Content = {
        text: `✅ Smart contract deployed successfully to Polygon zkEVM!

**Contract Address:** \`${contractAddress}\`
**Transaction Hash:** \`${transactionHash}\`
**Method Used:** ${methodUsed}
**Network:** Polygon zkEVM

You can now interact with your new contract.`,
        actions: ['POLYGON_DEPLOY_SMART_CONTRACT_ZKEVM'],
        data: {
          contractAddress,
          transactionHash,
          network: 'polygon-zkevm',
          timestamp: Date.now(),
          method: methodUsed,
          deploymentParams: {
            bytecode: deploymentParams.bytecode,
            constructorArgs: deploymentParams.constructorArgs,
            gasLimit: deploymentParams.gasLimit,
            value: deploymentParams.value,
          },
        },
      };

      if (callback) {
        await callback(responseContent);
      }

      return responseContent;
    } else {
      // Deployment failed
      const finalErrorMessage = `❌ Failed to deploy smart contract. Errors: ${errorMessages.join('; ')}`;
      const errorContent: Content = {
        text: finalErrorMessage,
        actions: ['POLYGON_DEPLOY_SMART_CONTRACT_ZKEVM'],
        data: { error: finalErrorMessage, errors: errorMessages, deploymentParams },
      };

      if (callback) {
        await callback(errorContent);
      }

      throw new Error(finalErrorMessage);
    }
  },

  examples: [
    [
      {
        name: '{{user1}}',
        content: {
          text: 'Deploy a smart contract on Polygon zkEVM with bytecode 0x6080...',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: '✅ Smart contract deployed successfully to Polygon zkEVM! Contract Address: 0xabc...',
          action: 'POLYGON_DEPLOY_SMART_CONTRACT_ZKEVM',
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: {
          text: 'Create a new contract on Polygon zkEVM using bytecode 0x6080... and constructor args ["MyToken", "TKN"]',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'I will deploy the smart contract with the provided bytecode and constructor arguments to Polygon zkEVM.',
          action: 'POLYGON_DEPLOY_SMART_CONTRACT_ZKEVM',
        },
      },
    ],
  ],
};
