import {
  type Action,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  ModelType,
  type State,
  composePrompt,
} from '@elizaos/core';
import { type ByteArray, type Hex, formatEther, parseEther } from 'viem';

import { type WalletProvider, initWalletProvider } from '../providers/wallet';
import { transferTemplate } from '../templates';
import type { Transaction, TransferParams } from '../types';

// Exported for tests
export class TransferAction {
  constructor(private walletProvider: WalletProvider) {}

  async transfer(params: TransferParams): Promise<Transaction> {
    if (!params.data) {
      params.data = '0x';
    }

    const walletClient = this.walletProvider.getWalletClient(params.fromChain);

    try {
      const hash = await walletClient.sendTransaction({
        account: walletClient.account,
        to: params.toAddress,
        value: parseEther(params.amount),
        data: params.data as Hex,
        kzg: {
          blobToKzgCommitment: (_: ByteArray): ByteArray => {
            throw new Error('Function not implemented.');
          },
          computeBlobKzgProof: (_blob: ByteArray, _commitment: ByteArray): ByteArray => {
            throw new Error('Function not implemented.');
          },
        },
        chain: undefined,
      });

      return {
        hash,
        from: walletClient.account.address,
        to: params.toAddress,
        value: parseEther(params.amount),
        data: params.data as Hex,
      };
    } catch (error) {
      throw new Error(`Transfer failed: ${error.message}`);
    }
  }
}

const buildTransferDetails = async (
  state: State,
  runtime: IAgentRuntime,
  wp: WalletProvider
): Promise<TransferParams> => {
  const chains = wp.getSupportedChains();
  state.supportedChains = chains.map((item) => `"${item}"`).join('|');

  // Add balances to state for better context in template
  const balances = await wp.getWalletBalances();
  state.chainBalances = Object.entries(balances)
    .map(([chain, balance]) => {
      const chainConfig = wp.getChainConfigs(chain as any);
      return `${chain}: ${balance} ${chainConfig.nativeCurrency.symbol}`;
    })
    .join(', ');

  const context = composePrompt({
    state,
    template: transferTemplate,
  });

  const transferDetails = await runtime.useModel(ModelType.OBJECT_SMALL, {
    context,
  });

  const existingChain = wp.chains[transferDetails.fromChain];

  if (!existingChain) {
    throw new Error(
      'The chain ' +
        transferDetails.fromChain +
        ' not configured yet. Add the chain or choose one from configured: ' +
        chains.toString()
    );
  }

  return transferDetails;
};

export const transferAction: Action = {
  name: 'EVM_TRANSFER_TOKENS',
  description: 'Transfer tokens between addresses on the same chain',
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State,
    _options: any,
    callback?: HandlerCallback
  ) => {
    if (!state) {
      state = (await runtime.composeState(message)) as State;
    }

    const walletProvider = await initWalletProvider(runtime);
    const action = new TransferAction(walletProvider);

    // Compose transfer context
    const paramOptions = await buildTransferDetails(state, runtime, walletProvider);

    try {
      const transferResp = await action.transfer(paramOptions);
      if (callback) {
        callback({
          text: `Successfully transferred ${paramOptions.amount} tokens to ${paramOptions.toAddress}\nTransaction Hash: ${transferResp.hash}`,
          content: {
            success: true,
            hash: transferResp.hash,
            amount: formatEther(transferResp.value),
            recipient: transferResp.to,
            chain: paramOptions.fromChain,
          },
        });
      }
      return true;
    } catch (error) {
      console.error('Error during token transfer:', error);
      if (callback) {
        callback({
          text: `Error transferring tokens: ${error.message}`,
          content: { error: error.message },
        });
      }
      return false;
    }
  },
  validate: async (runtime: IAgentRuntime) => {
    const privateKey = runtime.getSetting('EVM_PRIVATE_KEY');
    return typeof privateKey === 'string' && privateKey.startsWith('0x');
  },
  examples: [
    [
      {
        name: 'assistant',
        content: {
          text: "I'll help you transfer 1 ETH to 0x742d35Cc6634C0532925a3b844Bc454e4438f44e",
          action: 'SEND_TOKENS',
        },
      },
      {
        name: 'user',
        content: {
          text: 'Transfer 1 ETH to 0x742d35Cc6634C0532925a3b844Bc454e4438f44e',
          action: 'SEND_TOKENS',
        },
      },
    ],
  ],
  similes: ['EVM_TRANSFER', 'EVM_SEND_TOKENS', 'EVM_TOKEN_TRANSFER', 'EVM_MOVE_TOKENS'],
};
