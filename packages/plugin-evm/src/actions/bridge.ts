import type { HandlerCallback, IAgentRuntime, Memory, State } from '@elizaos/core';
import { composePrompt, ModelType } from '@elizaos/core';
import { type ExtendedChain, createConfig, executeRoute, getRoutes } from '@lifi/sdk';

import { parseEther } from 'viem';
import { type WalletProvider, initWalletProvider } from '../providers/wallet';
import { bridgeTemplate } from '../templates';
import type { BridgeParams, Transaction } from '../types';

export { bridgeTemplate };

export class BridgeAction {
  private config;

  constructor(private walletProvider: WalletProvider) {
    this.config = createConfig({
      integrator: 'eliza',
      chains: Object.values(this.walletProvider.chains).map((config) => ({
        id: config.id,
        name: config.name,
        key: config.name.toLowerCase(),
        chainType: 'EVM',
        nativeToken: {
          ...config.nativeCurrency,
          chainId: config.id,
          address: '0x0000000000000000000000000000000000000000',
          coinKey: config.nativeCurrency.symbol,
        },
        metamask: {
          chainId: `0x${config.id.toString(16)}`,
          chainName: config.name,
          nativeCurrency: config.nativeCurrency,
          rpcUrls: [config.rpcUrls.default.http[0]],
          blockExplorerUrls: [config.blockExplorers.default.url],
        },
        diamondAddress: '0x0000000000000000000000000000000000000000',
        coin: config.nativeCurrency.symbol,
        mainnet: true,
      })) as ExtendedChain[],
    });
  }

  async bridge(params: BridgeParams): Promise<Transaction> {
    const walletClient = this.walletProvider.getWalletClient(params.fromChain);
    const [fromAddress] = await walletClient.getAddresses();

    const routes = await getRoutes({
      fromChainId: this.walletProvider.getChainConfigs(params.fromChain).id,
      toChainId: this.walletProvider.getChainConfigs(params.toChain).id,
      fromTokenAddress: params.fromToken,
      toTokenAddress: params.toToken,
      fromAmount: parseEther(params.amount).toString(),
      fromAddress: fromAddress,
      toAddress: params.toAddress || fromAddress,
    });

    if (!routes.routes.length) throw new Error('No routes found');

    const execution = await executeRoute(routes.routes[0], this.config);
    const process = execution.steps[0]?.execution?.process[0];

    if (!process?.status || process.status === 'FAILED') {
      throw new Error('Transaction failed');
    }

    return {
      hash: process.txHash as `0x${string}`,
      from: fromAddress,
      to: routes.routes[0].steps[0].estimate.approvalAddress as `0x${string}`,
      value: BigInt(params.amount),
      chainId: this.walletProvider.getChainConfigs(params.fromChain).id,
    };
  }
}

const buildBridgeDetails = async (
  state: State,
  runtime: IAgentRuntime,
  wp: WalletProvider
): Promise<BridgeParams> => {
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

  // Compose bridge context
  const bridgeContext = composePrompt({
    state,
    template: bridgeTemplate,
  });

  const content = await runtime.useModel(ModelType.OBJECT_LARGE, {
    context: bridgeContext,
  });

  // Validate chains exist
  const fromChain = content.fromChain;
  const toChain = content.toChain;

  if (!wp.chains[fromChain]) {
    throw new Error(
      `Source chain ${fromChain} not configured. Available chains: ${chains.join(', ')}`
    );
  }

  if (!wp.chains[toChain]) {
    throw new Error(
      `Destination chain ${toChain} not configured. Available chains: ${chains.join(', ')}`
    );
  }

  const bridgeOptions: BridgeParams = {
    fromChain: content.fromChain,
    toChain: content.toChain,
    fromToken: content.token,
    toToken: content.token,
    toAddress: content.toAddress,
    amount: content.amount,
  };

  return bridgeOptions;
};

export const bridgeAction = {
  name: 'EVM_BRIDGE_TOKENS',
  description: 'Bridge tokens between different chains',
  handler: async (
    runtime: IAgentRuntime,
    _message: Memory,
    state: State,
    _options: Record<string, unknown>,
    callback?: HandlerCallback
  ) => {
    const walletProvider = await initWalletProvider(runtime);
    const action = new BridgeAction(walletProvider);

    try {
      // Get bridge parameters
      const bridgeOptions = await buildBridgeDetails(state, runtime, walletProvider);

      const bridgeResp = await action.bridge(bridgeOptions);
      if (callback) {
        callback({
          text: `Successfully bridged ${bridgeOptions.amount} tokens from ${bridgeOptions.fromChain} to ${bridgeOptions.toChain}\nTransaction Hash: ${bridgeResp.hash}`,
          content: {
            success: true,
            hash: bridgeResp.hash,
            recipient: bridgeResp.to,
            fromChain: bridgeOptions.fromChain,
            toChain: bridgeOptions.toChain,
          },
        });
      }
      return true;
    } catch (error) {
      console.error('Error in bridge handler:', error.message);
      if (callback) {
        callback({
          text: `Error: ${error.message}`,
          content: { error: error.message },
        });
      }
      return false;
    }
  },
  template: bridgeTemplate,
  validate: async (runtime: IAgentRuntime) => {
    const privateKey = runtime.getSetting('EVM_PRIVATE_KEY');
    return typeof privateKey === 'string' && privateKey.startsWith('0x');
  },
  examples: [
    [
      {
        user: 'user',
        content: {
          text: 'Bridge 1 ETH from Ethereum to Base',
          action: 'CROSS_CHAIN_TRANSFER',
        },
      },
    ],
  ],
  similes: ['CROSS_CHAIN_TRANSFER', 'CHAIN_BRIDGE', 'MOVE_CROSS_CHAIN'],
};
