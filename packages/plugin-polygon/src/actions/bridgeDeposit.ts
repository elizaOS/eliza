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
  parseJSONObjectFromText,
} from '@elizaos/core';
import {
  createConfig,
  executeRoute,
  type ExtendedChain,
  getRoutes,
  type LiFiStep,
  type Route,
  type ChainKey,
  type RouteExecutionData,
  type RouteExtended,
} from '@lifi/sdk';
import {
  createWalletClient,
  http,
  type WalletClient,
  parseEther,
  type PublicClient,
  createPublicClient,
  fallback,
  type Address,
  type Hex,
  type Transport,
  type Account,
  type Chain,
  parseUnits,
  parseAbi,
} from 'viem';
import { type WalletProvider, initWalletProvider } from '../providers/PolygonWalletProvider';
import { bridgeDepositPolygonTemplate } from '../templates';
import type { SupportedChain } from '../types';
import { EVM } from '@lifi/sdk';
import { privateKeyToAccount } from 'viem/accounts';
import { arbitrum, mainnet, optimism, polygon, scroll } from 'viem/chains';

interface BridgeParams {
  fromChain: string;
  toChain: string;
  fromToken: Address;
  toToken: Address;
  amount: string;
  toAddress?: Address;
}
interface Transaction {
  hash: `0x${string}`;
  from: Address;
  to: Address;
  value: string;
  valueRaw?: bigint;
  chainId: number;
  data?: Hex;
  logs?: Array<unknown>;
  error?: string;
}

const tokenDecimalsAbi = parseAbi(['function decimals() view returns (uint8)']);

class PolygonBridgeActionRunner {
  private config;
  private walletProvider: WalletProvider;

  constructor(walletProvider: WalletProvider) {
    this.walletProvider = walletProvider;
    const extendedChains = Object.values(this.walletProvider.chains).map((chainConfig: Chain) => {
      const rpcUrls = chainConfig.rpcUrls.custom?.http || chainConfig.rpcUrls.default.http;
      const blockExplorerUrl = chainConfig.blockExplorers?.default?.url || '';

      return {
        ...chainConfig,
        key: chainConfig.name.toLowerCase().replace(/\s+/g, '-') as ChainKey,
        chainType: 'EVM',
        coin: chainConfig.nativeCurrency.symbol,
        mainnet: !chainConfig.testnet,
        logoURI: '',
        diamondAddress: undefined,
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
        metamask: {
          chainId: `0x${chainConfig.id.toString(16)}`,
          blockExplorerUrls: blockExplorerUrl ? [blockExplorerUrl] : [],
          chainName: chainConfig.name,
          nativeCurrency: chainConfig.nativeCurrency,
          rpcUrls: rpcUrls.slice(),
        },
      } as ExtendedChain;
    });

    const evmProvider = EVM({
      // Type mismatch with LiFi SDK typings is an issue, using 'as any' as a workaround
      // This is related to a complex intersection type conflict with the Client type
      getWalletClient: async () => this.walletProvider.getActiveWalletClient() as any,

      switchChain: async (chainId) => this.walletProvider.switchChainById(chainId) as any,
    });

    this.config = createConfig({
      integrator: 'ElizaOS-PolygonPlugin',
      chains: extendedChains,
      providers: [evmProvider], // ⬅ crucial line
    });
  }

  async getTokenDecimals(chainName: string, tokenAddress: Address): Promise<number> {
    if (
      tokenAddress.toLowerCase() === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' ||
      tokenAddress.toLowerCase() === '0x0000000000000000000000000000000000000000'
    ) {
      return this.walletProvider.getChainConfigs(chainName as SupportedChain).nativeCurrency
        .decimals;
    }
    const publicClient = this.walletProvider.getPublicClient(chainName as SupportedChain);
    try {
      return await publicClient.readContract({
        address: tokenAddress,
        abi: tokenDecimalsAbi,
        functionName: 'decimals',
      });
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      logger.warn(
        `Could not fetch decimals for ${tokenAddress} on ${chainName}, defaulting to 18. Error: ${errorMessage}`
      );
      return 18;
    }
  }

  /**
   * Helper function to execute a bridge route and immediately return the tx hash
   * @param route The route to execute
   * @param onTxHash Callback for when the tx hash is available
   * @param onDone Callback for when the bridge is complete
   */
  private async bridgeAndStream(
    route: Route,
    onTxHash: (hash: Hex) => void,
    onDone?: (execution: RouteExtended) => void,
    onError?: (error: Error) => void
  ): Promise<void> {
    let txHashSent = false;

    try {
      await executeRoute(route, {
        // Fires on every status change through updateRouteHook
        updateRouteHook: (updatedRoute: RouteExtended) => {
          // Check all steps' execution processes for a txHash
          for (const step of updatedRoute.steps) {
            if (step.execution?.process) {
              for (const process of step.execution.process) {
                const hash = process.txHash;

                // Return hash as soon as it's available
                if (!txHashSent && hash) {
                  txHashSent = true;
                  logger.info(`Bridge transaction hash available: ${hash}`);
                  onTxHash(hash as Hex);
                }
              }
            }
          }

          // Check if the bridge is complete
          const isComplete = updatedRoute.steps.every(
            (step) => step.execution?.status === 'DONE' || step.execution?.status === 'FAILED'
          );

          if (isComplete && onDone) {
            logger.info(`Bridge operation completed`);
            onDone(updatedRoute);
          }
        },
      });
    } catch (error) {
      // Catch any errors from executeRoute and handle them properly
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error('Bridge execution error:', err);

      // Call the error callback if provided
      if (onError) {
        onError(err);
      }
    }
  }

  async bridge(params: BridgeParams): Promise<Transaction> {
    logger.debug('Available chains in WalletProvider:', Object.keys(this.walletProvider.chains));
    logger.debug(`Attempting to get wallet client for chain: ${params.fromChain}`);

    const walletClient = this.walletProvider.getWalletClient(params.fromChain as SupportedChain);
    const [fromAddress] = await walletClient.getAddresses();

    // Get token decimals
    const fromTokenDecimals = await this.getTokenDecimals(params.fromChain, params.fromToken);
    const amountRaw = parseUnits(params.amount, fromTokenDecimals).toString();

    logger.debug(
      `Converted ${params.amount} tokens to ${amountRaw} base units using ${fromTokenDecimals} decimals`
    );

    // Prepare route request
    const fromChainId = this.walletProvider.getChainConfigs(params.fromChain as SupportedChain).id;
    const toChainId = this.walletProvider.getChainConfigs(params.toChain as SupportedChain).id;

    const routeRequest = {
      fromChainId,
      toChainId,
      fromTokenAddress: params.fromToken,
      toTokenAddress: params.toToken,
      fromAmount: amountRaw,
      fromAddress,
      toAddress: params.toAddress || fromAddress,
    };

    logger.debug('Requesting bridge routes with:', routeRequest);

    try {
      const routes = await getRoutes(routeRequest);

      if (!routes.routes || routes.routes.length === 0) {
        logger.error('No routes found for this bridge transaction');
        throw new Error('No routes found for bridging tokens between these chains');
      }

      logger.debug(`Found ${routes.routes.length} routes, using the best route`);
      const bestRoute = routes.routes[0];
      logger.debug('Best route selected:', JSON.stringify(bestRoute, null, 2));

      // Log estimated gas costs if available
      if (bestRoute.steps[0]?.estimate?.gasCosts) {
        logger.debug(
          'Estimated gas costs:',
          JSON.stringify(bestRoute.steps[0].estimate.gasCosts, null, 2)
        );
      }
      if (bestRoute.steps[0]?.estimate?.feeCosts) {
        logger.debug(
          'Estimated fee costs:',
          JSON.stringify(bestRoute.steps[0].estimate.feeCosts, null, 2)
        );
      }

      logger.debug('Executing bridge route');

      // Use Promise to get transaction hash as soon as it's available
      const txHashPromise = new Promise<Hex>((resolve, reject) => {
        // Execute the route but don't wait for completion
        this.bridgeAndStream(
          bestRoute,
          // Called as soon as the hash is available
          (hash: Hex) => {
            resolve(hash);
          },
          // Called when the bridge is complete (optional)
          (execution: RouteExtended) => {
            logger.info(`Bridge operation completed`);

            // You could implement a notification system here to inform
            // the user when the bridge completes
          },
          // Error handler
          (error: Error) => {
            logger.error(`Bridge operation failed:`, error);
            reject(error);
          }
        );
      });

      // Wait for the transaction hash only, not the entire bridge process
      try {
        const txHash = await txHashPromise;
        logger.info(`Returning bridge transaction hash: ${txHash}`);

        // Determine if the token is a native token (ETH, MATIC, etc.)
        const isNativeToken =
          params.fromToken.toLowerCase() === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' ||
          params.fromToken.toLowerCase() === '0x0000000000000000000000000000000000000000';

        // For native tokens, set value to the parsed amount, otherwise zero
        const txValue = isNativeToken ? parseUnits(params.amount, fromTokenDecimals) : BigInt(0);

        const tx = {
          hash: txHash,
          from: fromAddress,
          to: bestRoute.steps[0].estimate.approvalAddress as `0x${string}`,
          value: txValue.toString(),
          valueRaw: txValue,
          chainId: fromChainId,
        };

        const txForLog = { ...tx, valueRaw: tx.valueRaw.toString() };

        logger.debug('Returning transaction:', JSON.stringify(txForLog, null, 2));
        return tx;
      } catch (error) {
        // Catch any errors from the bridgeAndStream process
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error(`Bridge transaction hash retrieval failed: ${errorMessage}`, error);

        // Return a standardized result with the error rather than throwing
        return {
          hash: '0x0', // A placeholder hash indicating failure
          from: fromAddress,
          to: bestRoute.steps[0].estimate.approvalAddress as `0x${string}`,
          value: '0',
          chainId: fromChainId,
          error: errorMessage,
        };
      }
    } catch (error) {
      // Catch any errors from the outer getRoutes or initial setup
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`Bridge transaction failed: ${errorMessage}`, error);

      // Return a standardized result with the error rather than throwing
      return {
        hash: '0x0', // A placeholder hash indicating failure
        from: '0x0' as Address,
        to: '0x0' as Address,
        value: '0',
        chainId: 0,
        error: errorMessage,
      };
    }
  }
}

export const bridgeDepositAction: Action = {
  name: 'POLYGON_BRIDGE_DEPOSIT',
  similes: ['BRIDGE_FUNDS', 'MOVE_ETH_TO_LIFI'].map((s) => `POLYGON_${s}`),
  description: 'Initiates a deposit/bridge using LiFi.',
  validate: async (runtime: IAgentRuntime, _m: Memory, _s: State | undefined): Promise<boolean> => {
    logger.debug('Validating BRIDGE_DEPOSIT_POLYGON...');
    const checks = [
      runtime.getSetting('WALLET_PRIVATE_KEY'),
      runtime.getSetting('POLYGON_PLUGINS_ENABLED'),
    ];
    if (checks.some((check) => !check)) {
      logger.error('Required settings (WALLET_PRIVATE_KEY, POLYGON_PLUGINS_ENABLED) missing.');
      return false;
    }
    try {
      await initWalletProvider(runtime);
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      logger.error(`WalletProvider initialization failed during validation: ${errMsg} `);
      return false;
    }
    return true;
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State | undefined,
    _o: unknown,
    cb: HandlerCallback | undefined,
    _rs: Memory[] | undefined
  ) => {
    logger.info('Handling BRIDGE_DEPOSIT_POLYGON for:', message.id);
    try {
      const walletProvider = await initWalletProvider(runtime);
      const actionRunner = new PolygonBridgeActionRunner(walletProvider);
      const prompt = composePromptFromState({
        state,
        template: bridgeDepositPolygonTemplate as unknown as TemplateType,
      });
      const modelResponse = await runtime.useModel(ModelType.TEXT_SMALL, {
        prompt,
      });
      let paramsJson: BridgeParams | { error: string };
      let bridgeOptions: BridgeParams;
      try {
        paramsJson = parseJSONObjectFromText(modelResponse) as BridgeParams | { error: string };
        logger.debug('Bridge parameters extracted:', paramsJson);

        // Check if the model response contains an error
        if ('error' in paramsJson) {
          logger.warn(`Bridge action: Model responded with error: ${paramsJson.error}`);
          throw new Error(paramsJson.error);
        }

        // At this point, paramsJson must be BridgeParams
        bridgeOptions = paramsJson;
      } catch (e) {
        logger.error('Failed to parse LLM response for bridge params:', modelResponse, e);
        throw new Error('Could not understand bridge parameters.');
      }
      if (
        !bridgeOptions.fromChain ||
        !bridgeOptions.toChain ||
        !bridgeOptions.fromToken ||
        !bridgeOptions.toToken ||
        !bridgeOptions.amount
      ) {
        throw new Error('Incomplete bridge parameters extracted.');
      }

      logger.debug('Parsed bridge options:', bridgeOptions);

      // Bridge the tokens and get the transaction hash immediately
      const bridgeResp = await actionRunner.bridge(bridgeOptions);

      // Check if the bridge operation encountered an error
      if (bridgeResp.error) {
        logger.error('Bridge operation failed:', bridgeResp.error);
        throw new Error(bridgeResp.error);
      }

      // Format source/target chains
      const fromChainFormatted =
        bridgeOptions.fromChain.charAt(0).toUpperCase() + bridgeOptions.fromChain.slice(1);
      const toChainFormatted =
        bridgeOptions.toChain.charAt(0).toUpperCase() + bridgeOptions.toChain.slice(1);

      // Create a user-friendly message
      const successMessage = `
Bridging started! 🚀
Initiating transfer of ${bridgeOptions.amount} tokens from ${fromChainFormatted} to ${toChainFormatted}.
Transaction hash: ${bridgeResp.hash}

The bridge operation is now in progress and will continue in the background. This may take several minutes to complete. You can check the status by tracking the transaction hash.`;

      logger.info(`Bridge transaction initiated: ${bridgeResp.hash}`);

      if (cb) {
        await cb({
          text: successMessage,
          content: {
            success: true,
            hash: bridgeResp.hash,
            status: 'pending',
            fromChain: bridgeOptions.fromChain,
            toChain: bridgeOptions.toChain,
            amount: bridgeOptions.amount,
          },
          actions: ['BRIDGE_DEPOSIT_POLYGON'],
          source: message.content.source,
        });
      }

      return {
        success: true,
        hash: bridgeResp.hash,
        status: 'pending',
        fromChain: bridgeOptions.fromChain,
        toChain: bridgeOptions.toChain,
        amount: bridgeOptions.amount,
      };
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      logger.error('BRIDGE_DEPOSIT_POLYGON handler error:', errMsg, error);
      if (cb) {
        await cb({
          text: `Error bridging: ${errMsg}`,
          actions: ['BRIDGE_DEPOSIT_POLYGON'],
          source: message.content.source,
        });
      }
      return { success: false, error: errMsg };
    }
  },
  examples: [
    [
      {
        name: 'user',
        content: { text: 'Bridge 0.5 WETH from Polygon to Ethereum mainnet.' },
      },
    ],
    [
      {
        name: 'user',
        content: {
          text: 'Move 100 USDC from Arbitrum to Polygon, send it to 0x123...',
        },
      },
    ],
  ],
};
