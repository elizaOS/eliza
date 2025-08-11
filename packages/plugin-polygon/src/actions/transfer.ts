import {
  type Action,
  type Content,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  type State,
  logger,
  composePromptFromState,
  ModelType,
  type ActionExample,
  type TemplateType,
} from '@elizaos/core';
// import { type Chain, polygon as polygonChain, mainnet as ethereumChain } from 'viem/chains'; // Managed by Provider
import {
  // createWalletClient, http, type WalletClient, // Provided by WalletProvider instance
  parseEther,
  type Address,
  type Hex,
  // PublicClient, createPublicClient, fallback, // Provided by WalletProvider instance
  formatEther,
  type Transport, // Not directly used
  type Account, // Not directly used
  type Chain, // For type annotation
} from 'viem';
// import { privateKeyToAccount } from 'viem/accounts'; // Handled by Provider

import { WalletProvider, initWalletProvider } from '../providers/PolygonWalletProvider';

// Minimal ABI for ERC20 transfer (optional, if not using raw data)
const erc20TransferAbi = [
  {
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
    ],
    name: 'transfer',
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'nonpayable',
    type: 'function',
  },
] as const;

// REMOVE INLINE WalletProvider, ChainConfig, and initWalletProvider

interface TransferParams {
  fromChain: string; // Name of the chain, e.g., "polygon"
  toAddress: Address;
  amount: string; // Amount as string, e.g., "1.5" for native currency
  data?: Hex; // Optional data for contract interaction (e.g., ERC20 transfer)
  tokenAddress?: Address; // Optional, for ERC20 transfers, toAddress would be this, data is encoded transfer
}

interface Transaction {
  hash: `0x${string}`;
  from: Address;
  to: Address;
  value: bigint;
  chainId: number;
  data?: Hex;
  logs: any[];
}

const transferTemplateObj = {
  name: 'Transfer MATIC or Tokens',
  description:
    'Generates parameters to transfer MATIC (native currency) or execute a token transaction. // Respond with a valid JSON object containing the extracted parameters.',
  parameters: {
    type: 'object',
    properties: {
      fromChain: {
        type: 'string',
        description: 'Blockchain name (e.g., polygon). Default: polygon.',
        default: 'polygon',
      },
      toAddress: { type: 'string', description: 'Recipient address.' },
      amount: {
        type: 'string',
        description:
          'Amount of MATIC (native) to transfer. For ERC20, use "0" if value is in data.',
      },
      data: {
        type: 'string',
        description: 'Optional: Hex data for transaction (e.g., ERC20 transfer calldata).',
      },
      tokenAddress: { type: 'string', description: 'Optional: ERC20 token contract address.' },
    },
    required: ['toAddress', 'amount'],
  },
} as const; // Use as const for better type inference if TemplateType is structural

class PolygonTransferActionRunner {
  constructor(private walletProvider: WalletProvider) {} // Use imported WalletProvider

  async transfer(params: TransferParams): Promise<Transaction> {
    const effectiveChain = (params.fromChain || 'polygon').toLowerCase();
    const walletClient = this.walletProvider.getWalletClient(effectiveChain);
    const publicClient = this.walletProvider.getPublicClient(effectiveChain);
    const chainConfig = this.walletProvider.getChainConfigs(effectiveChain); // viem.Chain from provider
    const [fromAddress] = await walletClient.getAddresses();

    let txTo: Address = params.toAddress;
    let txData: Hex | undefined = params.data === '0x' ? undefined : params.data;
    let txValue = parseEther(params.amount); // Amount is native value unless it's an ERC20 call w/ data

    if (params.tokenAddress) {
      // ERC20 Transfer, data should be prepared by LLM or helper
      txTo = params.tokenAddress; // Target is token contract
      // If txData is not provided, and it's an ERC20, we might need to encode it.
      // Assuming LLM provides it or params.data is already the encoded call.
      if (!txData) {
        logger.warn(
          `ERC20 tokenAddress ${params.tokenAddress} provided, but no txData. This action will likely fail or do something unintended unless the LLM provides specific calldata for this token interaction.`
        );
      } else {
        // If data is provided for an ERC20 token, amount (txValue) should typically be 0 for the main call,
        // as the value transfer is encoded within the data.
        // However, the original logic used params.amount as value. For consistency, we keep it unless it causes issues.
        // txValue = BigInt(0); // Typically for ERC20 calls where value is in data.
        logger.info(
          `ERC20 interaction with token ${txTo}, data: ${txData}. Value field ${params.amount} ETH will be sent with this call.`
        );
      }
    } else if (txData) {
      logger.info(
        `Raw transaction with data ${txData} to ${params.toAddress}. Value: ${params.amount} ETH.`
      );
      // For raw tx, toAddress is params.toAddress, value is params.amount, data is params.data
    } else {
      // Native currency transfer
      logger.info(
        `Native transfer: ${params.amount} ETH to ${params.toAddress} on ${effectiveChain}.`
      );
    }

    try {
      const kzg = {
        blobToKzgCommitment: (_blob: any) => {
          throw new Error('KZG not impl.');
        },
        computeBlobKzgProof: (_blob: any, _commit: any) => {
          throw new Error('KZG not impl.');
        },
      };
      const hash = await walletClient.sendTransaction({
        account: fromAddress,
        to: txTo,
        value: txValue,
        data: txData,
        chain: chainConfig,
        kzg,
      });

      logger.info(`Transaction sent: ${hash}. Waiting for receipt...`);
      const receipt = await publicClient.waitForTransactionReceipt({ hash });

      return {
        hash,
        from: fromAddress,
        to: txTo,
        value: txValue,
        data: txData,
        chainId: chainConfig.id,
        logs: receipt.logs as any[],
      };
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      logger.error(`Transfer failed: ${errMsg}`, error);
      throw new Error(`Transfer failed: ${errMsg}`);
    }
  }
}

export const transferPolygonAction: Action = {
  name: 'POLYGON_TRANSFER',
  similes: ['SEND', 'TRANSFER_MATIC_OR_TOKEN'].map((s) => `POLYGON_${s}`),
  description: 'Transfers MATIC (native currency) or executes a token transaction on Polygon.',

  validate: async (runtime: IAgentRuntime, _m: Memory, _s: State | undefined): Promise<boolean> => {
    logger.debug('Validating POLYGON_TRANSFER action...');
    const checks = [
      runtime.getSetting('WALLET_PRIVATE_KEY'),
      runtime.getSetting('POLYGON_PLUGINS_ENABLED'),
    ];
    if (checks.some((check) => !check)) {
      logger.error(
        'Required settings (WALLET_PRIVATE_KEY, POLYGON_PLUGINS_ENABLED) are not configured.'
      );
      return false;
    }
    try {
      await initWalletProvider(runtime);
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      logger.error(`WalletProvider initialization failed during validation: ${errMsg}`);
      return false;
    }
    return true;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State | undefined,
    _options: any,
    callback: HandlerCallback | undefined,
    _responses: Memory[] | undefined
  ) => {
    logger.info('Handling POLYGON_TRANSFER for message:', message.id);
    try {
      const walletProvider = await initWalletProvider(runtime);
      const actionRunner = new PolygonTransferActionRunner(walletProvider);

      const supportedChains = Object.keys(walletProvider.chains)
        .map((c) => `\"${c}\"`)
        .join(' | ');
      const dynamicTransferTemplate = {
        ...transferTemplateObj,
        parameters: {
          ...transferTemplateObj.parameters,
          properties: {
            ...transferTemplateObj.parameters.properties,
            fromChain: {
              type: 'string',
              description: `The blockchain name (e.g., polygon). Supported: ${supportedChains}. Default is polygon.`,
              default: 'polygon',
            },
          },
        },
      } as unknown as TemplateType;

      const prompt = composePromptFromState({
        state,
        template: dynamicTransferTemplate,
      });
      const modelResponse = await runtime.useModel(ModelType.SMALL, { prompt });
      let paramsJson;
      try {
        const jsonString = (modelResponse || '').replace(/^```json(\r?\n)?|(\r?\n)?```$/g, '');
        paramsJson = JSON.parse(jsonString);
      } catch (e) {
        logger.error('Failed to parse LLM response for transfer params:', modelResponse, e);
        throw new Error('Could not understand transfer parameters.');
      }

      if (!paramsJson.toAddress || typeof paramsJson.amount === 'undefined') {
        throw new Error('Incomplete transfer parameters: toAddress and amount are required.');
      }

      const transferParams: TransferParams = {
        fromChain: ((paramsJson.fromChain as string) || 'polygon').toLowerCase(),
        toAddress: paramsJson.toAddress as Address,
        amount: paramsJson.amount as string,
        data: paramsJson.data as Hex | undefined,
        tokenAddress: paramsJson.tokenAddress as Address | undefined,
      };

      logger.debug('Parsed transfer parameters:', transferParams);
      const txResult = await actionRunner.transfer(transferParams);
      const successMsg = `Successfully transferred ${transferParams.amount} ${transferParams.tokenAddress ? `token ${transferParams.tokenAddress}` : 'native currency'} to ${transferParams.toAddress} on ${transferParams.fromChain}. TxHash: ${txResult.hash}`;
      logger.info(successMsg);

      if (callback) {
        await callback({
          text: `Transaction successful: ${txResult.hash}`,
          content: { success: true, ...txResult, valueDisplay: formatEther(txResult.value) },
          actions: ['POLYGON_TRANSFER'],
          source: message.content.source,
        });
      }
      return { success: true, ...txResult, chain: transferParams.fromChain };
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      logger.error(`Error in TRANSFER_POLYGON handler: ${errMsg}`, error);
      if (callback) {
        await callback({
          text: `Error during transfer: ${errMsg}`,
          actions: ['POLYGON_TRANSFER'],
          source: message.content.source,
        });
      }
      return { success: false, error: errMsg };
    }
  },

  examples: [
    [
      {
        name: 'Transfer MATIC',
        content: { text: 'Send 10.5 MATIC to 0xRecipientAddress on Polygon.' },
      },
    ],
    [
      {
        name: 'Transfer USDC',
        content: {
          text: 'Transfer 100 USDC (0xTokenAddress) to 0xRecipient on Polygon. Calldata: 0xData.',
        },
      },
    ],
  ],
};
