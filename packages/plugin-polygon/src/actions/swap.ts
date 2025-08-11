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
  TemplateType,
} from '@elizaos/core';
import {
  createConfig,
  executeRoute,
  type ExtendedChain,
  getRoutes,
  type Route,
  type LiFiStep,
  type ChainKey,
  SDKBaseConfig,
  ExecutionOptions,
} from '@lifi/sdk';
import { parseUnits, formatUnits, type Address, type Hex, parseAbi, type Chain } from 'viem';
import { WalletProvider, initWalletProvider } from '../providers/PolygonWalletProvider.ts';

interface SwapParams {
  chain: string; // e.g., "polygon"
  fromToken: Address; // Address of the token to sell
  toToken: Address; // Address of the token to buy
  amount: string; // Amount of fromToken to sell (in human-readable format, e.g., "1.5")
  slippage?: number; // Optional slippage percentage (e.g., 0.5 for 0.5%)
}

interface Transaction {
  hash: `0x${string}`;
  from: Address;
  to: Address; // Typically the LiFi router or approval address
  value: bigint; // Usually 0 for token swaps, unless fromToken is native
  chainId: number;
  data?: Hex;
  logs?: any[];
  toAmountMin?: string; // From LiFi estimate
  toAmount?: string; // From LiFi estimate
}

const swapTemplate = {
  name: 'Swap Tokens on Polygon',
  description:
    'Generates parameters to swap tokens on Polygon using LiFi. // Respond with a valid JSON object containing the extracted parameters.',
  parameters: {
    type: 'object',
    properties: {
      chain: {
        type: 'string',
        description: 'Blockchain name (e.g., polygon). Default: polygon.',
        default: 'polygon',
      },
      fromToken: { type: 'string', description: 'Address of the token to sell.' },
      toToken: { type: 'string', description: 'Address of the token to buy.' },
      amount: { type: 'string', description: 'Amount of the token to sell (e.g., \"10.5\").' },
      slippage: {
        type: 'number',
        description: 'Optional: Max slippage percentage (e.g., 0.5). Default: 0.5.',
        default: 0.5,
      },
    },
    required: ['fromToken', 'toToken', 'amount'],
  },
};

const tokenDecimalsAbi = parseAbi(['function decimals() view returns (uint8)']);

class PolygonSwapActionRunner {
  private lifiConfig: SDKBaseConfig;
  private walletProvider: WalletProvider;

  constructor(walletProvider: WalletProvider) {
    this.walletProvider = walletProvider;
    const extendedChains = Object.values(this.walletProvider.chains).map(
      (chainConfig: Chain) =>
        ({
          ...chainConfig,
          key: chainConfig.name.toLowerCase().replace(/\s+/g, '-') as ChainKey,
          chainType: 'EVM',
          coin: chainConfig.nativeCurrency.symbol,
          mainnet: !chainConfig.testnet,
          logoURI: '',
          nativeToken: {
            address: '0x0000000000000000000000000000000000000000',
            chainId: chainConfig.id,
            symbol: chainConfig.nativeCurrency.symbol,
            decimals: chainConfig.nativeCurrency.decimals,
            name: chainConfig.nativeCurrency.name,
            priceUSD: '0',
            logoURI: '',
            coinKey: chainConfig.nativeCurrency.symbol,
          },
          diamondAddress: '0x0000000000000000000000000000000000000000',
          metamask: {
            chainId: `0x${chainConfig.id.toString(16)}`,
            blockExplorerUrls: [chainConfig.blockExplorers?.default?.url || ''],
            chainName: chainConfig.name,
            nativeCurrency: chainConfig.nativeCurrency,
            rpcUrls: [...(chainConfig.rpcUrls.custom?.http || chainConfig.rpcUrls.default.http)],
          },
        }) as ExtendedChain
    );
    this.lifiConfig = createConfig({ integrator: 'ElizaOS-PolygonSwap', chains: extendedChains });
  }

  async getTokenDecimals(chainName: string, tokenAddress: Address): Promise<number> {
    if (
      tokenAddress.toLowerCase() === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' ||
      tokenAddress.toLowerCase() === '0x0000000000000000000000000000000000000000'
    ) {
      return this.walletProvider.getChainConfigs(chainName).nativeCurrency.decimals;
    }
    const publicClient = this.walletProvider.getPublicClient(chainName);
    try {
      return await publicClient.readContract({
        address: tokenAddress,
        abi: tokenDecimalsAbi,
        functionName: 'decimals',
      });
    } catch (err: any) {
      logger.warn(
        `Could not fetch decimals for ${tokenAddress} on ${chainName}, defaulting to 18. Error: ${err.message}`
      );
      return 18;
    }
  }

  async swap(params: SwapParams): Promise<Transaction> {
    const walletClient = this.walletProvider.getWalletClient(params.chain);
    const publicClient = this.walletProvider.getPublicClient(params.chain);
    const [fromAddress] = await walletClient.getAddresses();
    const chainConfig = this.walletProvider.getChainConfigs(params.chain);

    const fromTokenDecimals = await this.getTokenDecimals(params.chain, params.fromToken);
    const fromAmountWei = parseUnits(params.amount, fromTokenDecimals).toString();

    const routesRequest = {
      fromChainId: chainConfig.id,
      toChainId: chainConfig.id, // Same chain swap
      fromTokenAddress: params.fromToken,
      toTokenAddress: params.toToken,
      fromAmount: fromAmountWei,
      fromAddress,
      toAddress: fromAddress,
      options: { slippage: (params.slippage || 0.5) / 100, order: 'RECOMMENDED' as const },
    };
    logger.debug('Requesting LiFi swap routes with:', routesRequest);
    const routesResult = await getRoutes(routesRequest);

    if (!routesResult.routes || routesResult.routes.length === 0) {
      logger.error('No LiFi routes found for swapping these tokens.');
      throw new Error('No routes found for this swap.');
    }
    const bestRoute: Route = routesResult.routes[0];
    logger.debug('Executing LiFi swap route:', JSON.stringify(bestRoute, null, 2));

    const execution = await executeRoute(bestRoute, this.lifiConfig as ExecutionOptions);

    const process = execution.steps[0]?.execution?.process[0];

    if (!process?.txHash || process.status === 'FAILED') {
      logger.error(
        'Swap transaction hash not found or tx failed in LiFi execution result.',
        process
      );
      throw new Error('Swap transaction failed or hash not found.');
    }
    const txHash = process.txHash as `0x${string}`;

    logger.info(`Waiting for swap transaction receipt: ${txHash}`);
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });

    const toLifiAddress =
      (bestRoute.steps[0]?.toolDetails as any)?.routerAddress || bestRoute.toToken.address;
    return {
      hash: txHash,
      from: fromAddress,
      to: toLifiAddress as Address,
      value:
        bestRoute.fromToken.address.toLowerCase() ===
          '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' ||
        bestRoute.fromToken.address.toLowerCase() === '0x0000000000000000000000000000000000000000'
          ? parseUnits(params.amount, fromTokenDecimals)
          : BigInt(0),
      chainId: chainConfig.id,
      logs: receipt.logs as any[],
      data: bestRoute.steps[0]?.transactionRequest?.data as Hex | undefined,
      toAmountMin: bestRoute.toAmountMin,
      toAmount: bestRoute.toAmount,
    };
  }
}

export const swapAction: Action = {
  name: 'POLYGON_SWAP_TOKENS',
  similes: ['SWAP', 'TRADE_TOKENS'].map((s) => `POLYGON_${s}`),
  description: 'Swaps one token for another using a decentralized exchange on Polygon.',

  validate: async (runtime: IAgentRuntime, _m: Memory, _s: State | undefined): Promise<boolean> => {
    logger.debug('Validating SWAP_TOKENS action...');
    const checks = [
      runtime.getSetting('WALLET_PRIVATE_KEY'),
      runtime.getSetting('POLYGON_PLUGINS_ENABLED'),
    ];
    if (checks.some((c) => !c)) {
      logger.error(
        'Required settings (WALLET_PRIVATE_KEY, POLYGON_PLUGINS_ENABLED) not configured.'
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
    _o: any,
    cb: HandlerCallback | undefined,
    _rs: Memory[] | undefined
  ) => {
    logger.info('Handling POLYGON_SWAP_TOKENS for message:', message.id);
    try {
      const walletProvider = await initWalletProvider(runtime);
      const actionRunner = new PolygonSwapActionRunner(walletProvider as WalletProvider);
      const prompt = composePromptFromState({
        state: state as State,
        template: swapTemplate as unknown as TemplateType,
      });
      const modelResponse = await runtime.useModel(ModelType.LARGE, { prompt });
      let paramsJson;
      try {
        const responseText = modelResponse || '';
        const jsonString = responseText.replace(/^```json(\\r?\\n)?|(\\r?\\n)?```$/g, '');
        paramsJson = JSON.parse(jsonString);
      } catch (e) {
        logger.error('Failed to parse LLM response for swap params:', modelResponse, e);
        throw new Error('Could not understand swap parameters.');
      }

      if (!paramsJson.fromToken || !paramsJson.toToken || !paramsJson.amount) {
        throw new Error('Incomplete swap parameters extracted.');
      }

      const swapParams: SwapParams = {
        chain: ((paramsJson.chain as string) || 'polygon').toLowerCase(),
        fromToken: paramsJson.fromToken as Address,
        toToken: paramsJson.toToken as Address,
        amount: paramsJson.amount as string,
        slippage: paramsJson.slippage as number | undefined,
      };

      logger.debug('Swap parameters:', swapParams);
      const txResult = await actionRunner.swap(swapParams);

      let toAmountDisplay = 'unknown amount';
      if (txResult.toAmountMin) {
        try {
          const toTokenDecimals = await actionRunner.getTokenDecimals(
            swapParams.chain,
            swapParams.toToken
          );
          toAmountDisplay = `${formatUnits(BigInt(txResult.toAmountMin), toTokenDecimals)} (min)`;
          if (txResult.toAmount) {
            toAmountDisplay = `${formatUnits(BigInt(txResult.toAmount), toTokenDecimals)}`;
          }
        } catch (e) {
          logger.warn('Could not format toAmountMin/toAmount from LiFi result', e);
        }
      }

      const successMsg = `Successfully initiated swap of ${swapParams.amount} ${swapParams.fromToken} for (approx) ${toAmountDisplay} ${swapParams.toToken} on ${swapParams.chain}. TxHash: ${txResult.hash}`;
      logger.info(successMsg);

      if (cb) {
        await cb({
          text: successMsg,
          content: { success: true, ...txResult, toAmountDisplay },
          actions: ['POLYGON_SWAP_TOKENS'],
          source: message.content.source,
        });
      }
      return { success: true, ...txResult, toAmountDisplay };
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      logger.error('Error in POLYGON_SWAP_TOKENS handler:', errMsg, error);
      if (cb) {
        await cb({
          text: `Error swapping tokens: ${errMsg}`,
          actions: ['POLYGON_SWAP_TOKENS'],
          source: message.content.source,
        });
      }
      return { success: false, error: errMsg };
    }
  },
  examples: [
    [
      {
        name: '{{user1}}',
        content: {
          text: 'Swap 100 USDC for DAI on Polygon.',
          context:
            'Current token mapping: USDC is 0x2791bca1f2de4661ed88a30c99a7a9449aa84174, DAI is 0x8f3cf7ad23cd3cadbd9735df95802323922a03c1.',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'Swapping 100 USDC for DAI on Polygon.',
          action: 'POLYGON_SWAP_TOKENS',
          params: {
            chain: 'polygon',
            fromToken: '0x2791bca1f2de4661ed88a30c99a7a9449aa84174',
            toToken: '0x8f3cf7ad23cd3cadbd9735df95802323922a03c1',
            amount: '100',
          },
        },
      },
    ],
  ],
};
