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
  formatEther,
  parseUnits,
  getBytes,
} from 'ethers';
import { bridgeMessagesTemplate } from '../templates';
import { callLLMWithTimeout } from '../utils/llmHelpers';

// Polygon zkEVM Bridge Contract ABI for message passing
const BRIDGE_ABI = [
  // Bridge message function - uses the same bridgeAsset function with metadata
  'function bridgeAsset(uint32 destinationNetwork, address destinationAddress, uint256 amount, address token, bool forceUpdateGlobalExitRoot, bytes permitData) external payable',
  // Claim message function
  'function claimAsset(bytes32[32] smtProof, uint32 index, bytes32 mainnetExitRoot, bytes32 rollupExitRoot, uint32 originNetwork, address originTokenAddress, uint32 destinationNetwork, address destinationAddress, uint256 amount, bytes metadata) external',
  // Events
  'event BridgeEvent(uint8 leafType, uint32 originNetwork, address originAddress, uint32 destinationNetwork, address destinationAddress, uint256 amount, bytes metadata, uint32 depositCount)',
  'event ClaimEvent(uint32 index, uint32 originNetwork, address originAddress, address destinationAddress, uint256 amount)',
];

// Bridge contract addresses
const BRIDGE_ADDRESSES = {
  mainnet: '0x2a3DD3EB832aF982ec71669E178424b10Dca2EDe', // Ethereum mainnet bridge
  zkevm: '0x2a3DD3EB832aF982ec71669E178424b10Dca2EDe', // zkEVM bridge (same address)
};

// Network IDs for Polygon zkEVM bridge
const NETWORK_IDS = {
  ethereum: 0,
  zkevm: 1,
};

export const bridgeMessagesAction: Action = {
  name: 'POLYGON_ZKEVM_BRIDGE_MESSAGES',
  similes: [
    'SEND_MESSAGE',
    'CROSS_CHAIN_MESSAGE',
    'BRIDGE_CALLDATA',
    'SEND_CROSS_CHAIN_MESSAGE',
    'MESSAGE_BRIDGE',
  ].map((s) => `POLYGON_ZKEVM_${s}`),
  description:
    'Sends arbitrary calldata messages between Ethereum and Polygon zkEVM using the bridge contract.',

  validate: async (runtime: IAgentRuntime, message: Memory, state?: State): Promise<boolean> => {
    const alchemyApiKey = runtime.getSetting('ALCHEMY_API_KEY');
    const zkevmRpcUrl = runtime.getSetting('ZKEVM_RPC_URL');

    if (!alchemyApiKey && !zkevmRpcUrl) {
      return false;
    }

    const content = message.content?.text?.toLowerCase() || '';

    // Keywords that indicate bridge message operations
    const bridgeMessageKeywords = [
      'bridge message',
      'send message',
      'cross chain message',
      'l1 message',
      'l2 message',
      'message bridge',
      'relay message',
      'message relay',
      'cross layer',
      'claim message',
      'verify message',
      'bridge data',
      'message proof',
    ];

    // Must contain bridge message-related keywords
    return bridgeMessageKeywords.some((keyword) => content.includes(keyword));
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: { [key: string]: unknown },
    callback?: HandlerCallback
  ): Promise<Content> => {
    logger.info('[bridgeMessagesAction] Handler called!');

    const privateKey = runtime.getSetting('PRIVATE_KEY');
    const alchemyApiKey = runtime.getSetting('ALCHEMY_API_KEY');
    const zkevmRpcUrl = runtime.getSetting('ZKEVM_RPC_URL');

    if (!privateKey) {
      const errorMessage = 'PRIVATE_KEY is required for bridging messages.';
      logger.error(`[bridgeMessagesAction] Configuration error: ${errorMessage}`);
      const errorContent: Content = {
        text: errorMessage,
        actions: ['POLYGON_BRIDGE_MESSAGES_ZKEVM'],
        data: { error: errorMessage },
      };

      if (callback) {
        await callback(errorContent);
      }
      throw new Error(errorMessage);
    }

    if (!alchemyApiKey && !zkevmRpcUrl) {
      const errorMessage = 'ALCHEMY_API_KEY or ZKEVM_RPC_URL is required in configuration.';
      logger.error(`[bridgeMessagesAction] Configuration error: ${errorMessage}`);
      const errorContent: Content = {
        text: errorMessage,
        actions: ['POLYGON_BRIDGE_MESSAGES_ZKEVM'],
        data: { error: errorMessage },
      };

      if (callback) {
        await callback(errorContent);
      }
      throw new Error(errorMessage);
    }

    let messageParams: any | null = null;
    let errorMessages: string[] = [];

    // Extract message parameters using LLM
    try {
      messageParams = await callLLMWithTimeout<{
        destinationChain: 'ethereum' | 'zkevm';
        messageData: string;
        gasLimit?: string | number;
        gasPrice?: string;
        maxFeePerGas?: string;
        maxPriorityFeePerGas?: string;
        value?: string;
      }>(runtime, state, bridgeMessagesTemplate, 'bridgeMessagesAction');

      // Check if the model returned an error field
      if (messageParams?.error) {
        logger.error('[bridgeMessagesAction] LLM returned an error:', messageParams?.error);
        throw new Error(messageParams?.error);
      }

      // Validate required parameters
      if (!messageParams?.destinationChain || !messageParams?.messageData) {
        throw new Error(
          'Missing required message parameters: destinationChain and messageData are required.'
        );
      }

      if (!['ethereum', 'zkevm'].includes(messageParams.destinationChain)) {
        throw new Error('Invalid destination chain. Must be "ethereum" or "zkevm".');
      }

      // Validate message data format
      if (!messageParams.messageData.startsWith('0x')) {
        throw new Error('Message data must be valid hex string starting with 0x.');
      }
    } catch (error) {
      logger.debug(
        '[bridgeMessagesAction] LLM parameter extraction failed',
        error instanceof Error ? error : undefined
      );
      throw new Error(
        `[bridgeMessagesAction] Failed to extract message parameters from input: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    try {
      // Setup providers and wallet based on destination
      let sourceProvider: JsonRpcProvider;
      let destinationProvider: JsonRpcProvider;
      let sourceNetwork: string;
      let destinationNetwork: number;
      let bridgeAddress: string;

      if (messageParams.destinationChain === 'ethereum') {
        // Message from zkEVM to Ethereum
        sourceNetwork = 'zkEVM';
        destinationNetwork = NETWORK_IDS.ethereum;
        bridgeAddress = BRIDGE_ADDRESSES.zkevm;

        if (alchemyApiKey) {
          const zkevmAlchemyUrl =
            runtime.getSetting('ZKEVM_ALCHEMY_URL') ||
            'https://polygonzkevm-mainnet.g.alchemy.com/v2';
          sourceProvider = new JsonRpcProvider(`${zkevmAlchemyUrl}/${alchemyApiKey}`);
        } else if (zkevmRpcUrl) {
          sourceProvider = new JsonRpcProvider(zkevmRpcUrl);
        } else {
          sourceProvider = new JsonRpcProvider('https://zkevm-rpc.com'); // Fallback
        }

        if (alchemyApiKey) {
          destinationProvider = new JsonRpcProvider(
            `https://eth-mainnet.g.alchemy.com/v2/${alchemyApiKey}`
          );
        } else {
          destinationProvider = new JsonRpcProvider('https://ethereum.publicnode.com'); // Fallback
        }
      } else {
        // Message from Ethereum to zkEVM
        sourceNetwork = 'Ethereum';
        destinationNetwork = NETWORK_IDS.zkevm;
        bridgeAddress = BRIDGE_ADDRESSES.mainnet;

        if (alchemyApiKey) {
          sourceProvider = new JsonRpcProvider(
            `https://eth-mainnet.g.alchemy.com/v2/${alchemyApiKey}`
          );
        } else {
          sourceProvider = new JsonRpcProvider('https://ethereum.publicnode.com'); // Fallback
        }

        if (alchemyApiKey) {
          const zkevmAlchemyUrl =
            runtime.getSetting('ZKEVM_ALCHEMY_URL') ||
            'https://polygonzkevm-mainnet.g.alchemy.com/v2';
          destinationProvider = new JsonRpcProvider(`${zkevmAlchemyUrl}/${alchemyApiKey}`);
        } else if (zkevmRpcUrl) {
          destinationProvider = new JsonRpcProvider(zkevmRpcUrl);
        } else {
          destinationProvider = new JsonRpcProvider('https://zkevm-rpc.com'); // Fallback
        }
      }

      const wallet = new Wallet(privateKey, sourceProvider);
      const bridgeContract = new Contract(bridgeAddress, BRIDGE_ABI, wallet);

      // Get wallet address as destination address for the message
      const walletAddress = await wallet.getAddress();

      // Prepare transaction parameters
      const txParams: any = {
        destinationNetwork: destinationNetwork,
        destinationAddress: walletAddress, // Message will be sent to the same wallet on destination chain
        amount: 0, // No ETH transfer, just message
        token: '0x0000000000000000000000000000000000000000', // ETH address (null token)
        forceUpdateGlobalExitRoot: true,
        permitData: messageParams.messageData, // The arbitrary calldata goes here
      };

      // Handle ETH value if specified
      const ethValue = messageParams.value ? parseEther(messageParams.value) : 0;

      // Validate and prepare permitData
      let permitDataBytes: string;
      try {
        // Ensure the calldata is valid hex
        if (!messageParams.messageData.startsWith('0x')) {
          throw new Error('Message data must start with 0x');
        }

        // Get hex data without 0x prefix
        let hexData = messageParams.messageData.slice(2);

        // Validate hex format and minimum length
        const hexPattern = /^[0-9a-fA-F]+$/;
        if (!hexPattern.test(hexData)) {
          throw new Error('Message data contains invalid hex characters');
        }

        // Check if hex data has odd length and auto-fix by padding with 0
        if (hexData.length % 2 !== 0) {
          logger.warn(
            `[bridgeMessagesAction] Calldata has odd length (${hexData.length}), padding with trailing zero`
          );
          hexData = hexData + '0'; // Pad with trailing zero
        }

        // Minimum 4 bytes for valid calldata (function selector)
        if (hexData.length < 8) {
          throw new Error(
            'Message data must be at least 4 bytes (8 hex characters) for a valid function call'
          );
        }

        // Reconstruct the padded calldata
        permitDataBytes = '0x' + hexData;

        logger.info(
          `[bridgeMessagesAction] Valid calldata: ${permitDataBytes} (${hexData.length / 2} bytes)`
        );

        // Additional validation for common function calls
        if (hexData.length >= 8) {
          const functionSelector = hexData.slice(0, 8);
          if (functionSelector === 'a9059cbb') {
            logger.info(`[bridgeMessagesAction] Detected ERC-20 transfer function call`);
          } else if (functionSelector === '095ea7b3') {
            logger.info(`[bridgeMessagesAction] Detected ERC-20 approve function call`);
          } else {
            logger.info(`[bridgeMessagesAction] Function selector: 0x${functionSelector}`);
          }
        }
      } catch (error) {
        throw new Error(
          `Invalid calldata format: ${error instanceof Error ? error.message : String(error)}`
        );
      }

      // Update txParams with validated permitData
      txParams.permitData = permitDataBytes;

      // Estimate gas
      let gasLimit: bigint;
      try {
        gasLimit = await bridgeContract.bridgeAsset.estimateGas(
          txParams.destinationNetwork,
          txParams.destinationAddress,
          txParams.amount,
          txParams.token,
          txParams.forceUpdateGlobalExitRoot,
          txParams.permitData,
          { value: ethValue }
        );
        // Add 20% buffer
        gasLimit = (gasLimit * BigInt(120)) / BigInt(100);
      } catch (error) {
        logger.warn('[bridgeMessagesAction] Gas estimation failed, using default:', error);
        gasLimit = BigInt(500000); // Default gas limit for message bridging
      }

      // Override gas limit if provided
      if (messageParams.gasLimit) {
        gasLimit = BigInt(messageParams.gasLimit);
      }

      // Prepare transaction options
      const txOptions: any = {
        gasLimit: gasLimit,
        value: ethValue,
      };

      // Handle gas pricing
      if (messageParams.maxFeePerGas && messageParams.maxPriorityFeePerGas) {
        // EIP-1559 transaction
        txOptions.maxFeePerGas = parseUnits(messageParams.maxFeePerGas, 'gwei');
        txOptions.maxPriorityFeePerGas = parseUnits(messageParams.maxPriorityFeePerGas, 'gwei');
      } else if (messageParams.gasPrice) {
        // Legacy transaction
        txOptions.gasPrice = parseUnits(messageParams.gasPrice, 'gwei');
      }

      logger.info('[bridgeMessagesAction] Sending message transaction...');

      // Debug log all parameters before calling contract
      logger.info(`[bridgeMessagesAction] Contract call parameters:`, {
        destinationNetwork: txParams.destinationNetwork,
        destinationAddress: txParams.destinationAddress,
        amount: txParams.amount,
        token: txParams.token,
        forceUpdateGlobalExitRoot: txParams.forceUpdateGlobalExitRoot,
        permitData: txParams.permitData,
        txOptions: txOptions,
      });

      // Send the bridge message transaction
      const tx = await bridgeContract.bridgeAsset(
        txParams.destinationNetwork,
        txParams.destinationAddress,
        txParams.amount,
        txParams.token,
        txParams.forceUpdateGlobalExitRoot,
        txParams.permitData,
        txOptions
      );

      logger.info(`[bridgeMessagesAction] Transaction sent: ${tx.hash}`);

      // Wait for transaction confirmation
      const receipt = await tx.wait();
      logger.info(`[bridgeMessagesAction] Transaction confirmed in block: ${receipt.blockNumber}`);

      // Extract message ID from events
      let messageId: string | null = null;
      let depositCount: number | null = null;

      for (const log of receipt.logs) {
        try {
          const parsedLog = bridgeContract.interface.parseLog({
            topics: log.topics,
            data: log.data,
          });

          if (parsedLog && parsedLog.name === 'BridgeEvent') {
            depositCount = Number(parsedLog.args.depositCount);
            messageId = `${sourceNetwork}-${destinationNetwork}-${depositCount}`;
            logger.info(`[bridgeMessagesAction] Message ID: ${messageId}`);
            break;
          }
        } catch (error) {
          // Skip logs that can't be parsed
          continue;
        }
      }

      const successMessage = `✅ Message bridged successfully!

**Transaction Details:**
- Transaction Hash: \`${tx.hash}\`
- From: ${sourceNetwork}
- To: ${messageParams.destinationChain}
- Block Number: ${receipt.blockNumber}
- Gas Used: ${receipt.gasUsed.toString()}
${messageId ? `- Message ID: \`${messageId}\`` : ''}
${depositCount !== null ? `- Deposit Count: ${depositCount}` : ''}

**Message Data:** \`${messageParams.messageData}\`

**Note:** The message will be available for claiming on the destination chain once the transaction is finalized (typically 30-60 minutes for zkEVM).`;

      const successContent: Content = {
        text: successMessage,
        actions: ['POLYGON_BRIDGE_MESSAGES_ZKEVM'],
        data: {
          success: true,
          transactionHash: tx.hash,
          messageId: messageId,
          depositCount: depositCount,
          sourceNetwork: sourceNetwork,
          destinationChain: messageParams.destinationChain,
          messageData: messageParams.messageData,
          blockNumber: receipt.blockNumber,
          gasUsed: receipt.gasUsed.toString(),
        },
      };

      if (callback) {
        await callback(successContent);
      }

      return successContent;
    } catch (error) {
      const errorMessage = `Failed to bridge message: ${error instanceof Error ? error.message : String(error)}`;
      logger.error(`[bridgeMessagesAction] ${errorMessage}`, error);

      const errorContent: Content = {
        text: `❌ ${errorMessage}`,
        actions: ['POLYGON_BRIDGE_MESSAGES_ZKEVM'],
        data: {
          error: errorMessage,
          destinationChain: messageParams?.destinationChain,
          messageData: messageParams?.messageData,
        },
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
        name: 'user',
        content: {
          text: 'bridge calldata 0xa9059cbb000000000000000000000000742d35cc6000000000000000000000000000000000000000000000000000000000000000000000000000000000de0b6b3a7640000 to ethereum',
        },
      },
      {
        name: 'assistant',
        content: {
          text: '✅ Message bridged successfully!\n\n**Transaction Details:**\n- Transaction Hash: `0x1234567890abcdef...`\n- From: zkEVM\n- To: ethereum\n- Block Number: 12345\n- Gas Used: 200000\n- Message ID: `zkEVM-0-12345`\n\n**Message Data:** `0xa9059cbb000000000000000000000000742d35cc6000000000000000000000000000000000000000000000000000000000000000000000000000000000de0b6b3a7640000`\n\n**Note:** The message will be available for claiming on the destination chain once the transaction is finalized (typically 30-60 minutes for zkEVM).',
          actions: ['POLYGON_BRIDGE_MESSAGES_ZKEVM'],
        },
      },
    ],
    [
      {
        name: 'user',
        content: {
          text: 'send calldata 0x095ea7b3000000000000000000000000742d35cc60000000000000000000000000000000000000000000000000000000000000000000000000000001bc16d674ec80000 to polygon zkevm',
        },
      },
      {
        name: 'assistant',
        content: {
          text: '✅ Message bridged successfully!\n\n**Transaction Details:**\n- Transaction Hash: `0xabcdef1234567890...`\n- From: Ethereum\n- To: zkevm\n- Block Number: 18500000\n- Gas Used: 150000\n- Message ID: `Ethereum-1-67890`\n\n**Message Data:** `0x095ea7b3000000000000000000000000742d35cc60000000000000000000000000000000000000000000000000000000000000000000000000000001bc16d674ec80000`\n\n**Note:** The message will be available for claiming on the destination chain once the transaction is finalized (typically 30-60 minutes for zkEVM).',
          actions: ['POLYGON_BRIDGE_MESSAGES_ZKEVM'],
        },
      },
    ],
    [
      {
        name: 'user',
        content: {
          text: 'bridge message 0x1234abcd to ethereum',
        },
      },
      {
        name: 'assistant',
        content: {
          text: '✅ Message bridged successfully!\n\n**Transaction Details:**\n- Transaction Hash: `0xfedcba0987654321...`\n- From: zkEVM\n- To: ethereum\n- Block Number: 8500000\n- Gas Used: 180000\n- Message ID: `zkEVM-0-55555`\n\n**Message Data:** `0x1234abcd`\n\n**Note:** The message will be available for claiming on the destination chain once the transaction is finalized (typically 30-60 minutes for zkEVM).',
          actions: ['POLYGON_BRIDGE_MESSAGES_ZKEVM'],
        },
      },
    ],
    [
      {
        name: 'user',
        content: {
          text: 'send cross chain message with data 0xabcdef1234567890 from ethereum to polygon zkevm',
        },
      },
      {
        name: 'assistant',
        content: {
          text: '✅ Message bridged successfully!\n\n**Transaction Details:**\n- Transaction Hash: `0x9876543210fedcba...`\n- From: Ethereum\n- To: zkevm\n- Block Number: 18600000\n- Gas Used: 165000\n- Message ID: `Ethereum-1-77777`\n\n**Message Data:** `0xabcdef1234567890`\n\n**Note:** The message will be available for claiming on the destination chain once the transaction is finalized (typically 30-60 minutes for zkEVM).',
          actions: ['POLYGON_BRIDGE_MESSAGES_ZKEVM'],
        },
      },
    ],
  ],
};
