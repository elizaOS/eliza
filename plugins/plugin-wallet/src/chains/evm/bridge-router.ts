import { logger } from "@elizaos/core";
import {
  createConfig,
  EVM,
  type ExecutionOptions,
  type ExtendedChain,
  executeRoute,
  getRoutes,
  getStatus,
  getToken,
  type RouteExtended,
  resumeRoute,
} from "@lifi/sdk";
import { type Address, type Chain, parseAbi, parseUnits } from "viem";
import * as viemChains from "viem/chains";
import {
  BRIDGE_POLL_INTERVAL_MS,
  DEFAULT_SLIPPAGE_PERCENT,
  MAX_BRIDGE_POLL_ATTEMPTS,
  MAX_PRICE_IMPACT,
  NATIVE_TOKEN_ADDRESS,
} from "./constants";
import { initWalletProvider, type WalletProvider } from "./providers/wallet";
import {
  type BridgeParams,
  EVMError,
  EVMErrorCode,
  type SupportedChain,
} from "./types";
import type {
  WalletRouterContext,
  WalletRouterExecution,
  WalletRouterParams,
} from "../../types/wallet-router.js";

type LiFiGetWalletClient = NonNullable<
  Parameters<typeof EVM>[0]
>["getWalletClient"];
type LiFiSwitchChain = NonNullable<Parameters<typeof EVM>[0]>["switchChain"];

function createLiFiGetWalletClientAdapter(
  walletProvider: WalletProvider,
  getFirstChain: () => string,
): LiFiGetWalletClient {
  return (async () => {
    const firstChain = getFirstChain();
    return walletProvider.getWalletClient(firstChain as SupportedChain);
  }) as LiFiGetWalletClient;
}

function createLiFiSwitchChainAdapter(
  walletProvider: WalletProvider,
  getChainNameById: (chainId: number) => string,
): LiFiSwitchChain {
  return (async (chainId: number) => {
    const chainName = getChainNameById(chainId);
    return walletProvider.getWalletClient(chainName as SupportedChain);
  }) as LiFiSwitchChain;
}

function createExecutionSwitchChainHookAdapter(
  walletProvider: WalletProvider,
  getChainNameById: (chainId: number) => string,
): ExecutionOptions["switchChainHook"] {
  return (async (chainId: number) => {
    const chainName = getChainNameById(chainId);
    return walletProvider.getWalletClient(chainName as SupportedChain);
  }) as ExecutionOptions["switchChainHook"];
}

interface BridgeExecutionStatus {
  readonly route: RouteExtended;
  readonly isComplete: boolean;
  readonly error?: string;
  readonly transactionHashes: readonly string[];
  readonly currentStep: number;
  readonly totalSteps: number;
}

export class BridgeAction {
  private readonly activeRoutes: Map<string, BridgeExecutionStatus> = new Map();

  constructor(private readonly walletProvider: WalletProvider) {
    const evmProvider = EVM({
      getWalletClient: createLiFiGetWalletClientAdapter(
        this.walletProvider,
        () => Object.keys(this.walletProvider.chains)[0],
      ),
      switchChain: createLiFiSwitchChainAdapter(
        this.walletProvider,
        (chainId: number) => this.getChainNameById(chainId),
      ),
    });

    createConfig({
      integrator: "eliza-agent",
      providers: [evmProvider],
      chains: Object.values(this.walletProvider.chains).map((config) => ({
        id: config.id,
        name: config.name,
        key: config.name.toLowerCase(),
        chainType: "EVM",
        nativeToken: {
          ...config.nativeCurrency,
          chainId: config.id,
          address: NATIVE_TOKEN_ADDRESS,
          coinKey: config.nativeCurrency.symbol,
        },
        metamask: {
          chainId: `0x${config.id.toString(16)}`,
          chainName: config.name,
          nativeCurrency: config.nativeCurrency,
          rpcUrls: [config.rpcUrls.default.http[0]],
          blockExplorerUrls: config.blockExplorers?.default?.url
            ? [config.blockExplorers.default.url]
            : [],
        },
        diamondAddress: NATIVE_TOKEN_ADDRESS,
        coin: config.nativeCurrency.symbol,
        mainnet: true,
      })) as ExtendedChain[],
      routeOptions: {
        maxPriceImpact: MAX_PRICE_IMPACT,
        slippage: DEFAULT_SLIPPAGE_PERCENT,
      },
    });
  }

  private getChainNameById(chainId: number): string {
    const chain = Object.entries(this.walletProvider.chains).find(
      ([_, config]) => config.id === chainId,
    );
    if (!chain) {
      throw new EVMError(
        EVMErrorCode.CHAIN_NOT_CONFIGURED,
        `Chain with ID ${chainId} not found`,
      );
    }
    return chain[0];
  }

  private async resolveTokenAddress(
    tokenSymbolOrAddress: string,
    chainId: number,
  ): Promise<string> {
    if (
      tokenSymbolOrAddress.startsWith("0x") &&
      tokenSymbolOrAddress.length === 42
    ) {
      return tokenSymbolOrAddress;
    }

    if (tokenSymbolOrAddress === NATIVE_TOKEN_ADDRESS) {
      return tokenSymbolOrAddress;
    }

    const token = await getToken(chainId, tokenSymbolOrAddress);
    return token.address;
  }

  private async getTokenDecimals(
    tokenAddress: string,
    chainName: string,
  ): Promise<number> {
    const chainConfig = this.walletProvider.getChainConfigs(
      chainName as SupportedChain,
    );

    if (
      tokenAddress === NATIVE_TOKEN_ADDRESS ||
      tokenAddress.toUpperCase() ===
        chainConfig.nativeCurrency.symbol.toUpperCase()
    ) {
      return chainConfig.nativeCurrency.decimals;
    }

    const decimalsAbi = parseAbi(["function decimals() view returns (uint8)"]);

    const publicClient = this.walletProvider.getPublicClient(
      chainName as SupportedChain,
    );
    const decimals = await publicClient.readContract({
      address: tokenAddress as Address,
      abi: decimalsAbi,
      functionName: "decimals",
      authorizationList: undefined,
    });
    return Number(decimals);
  }

  private createExecutionOptions(routeId: string): ExecutionOptions {
    return {
      updateTransactionRequestHook: async (txRequest) => {
        if (txRequest.gas) {
          txRequest.gas = (BigInt(txRequest.gas) * BigInt(110)) / BigInt(100);
        }
        if (txRequest.gasPrice) {
          txRequest.gasPrice =
            (BigInt(txRequest.gasPrice) * BigInt(105)) / BigInt(100);
        }
        return txRequest;
      },

      acceptExchangeRateUpdateHook: async (params: {
        toToken: { decimals: number; symbol: string };
        oldToAmount: string;
        newToAmount: string;
      }) => {
        const priceChange =
          ((Number(params.newToAmount) - Number(params.oldToAmount)) /
            Number(params.oldToAmount)) *
          100;
        return Math.abs(priceChange) < 5;
      },

      updateRouteHook: (updatedRoute: RouteExtended) => {
        this.updateRouteStatus(routeId, updatedRoute);
      },

      switchChainHook: createExecutionSwitchChainHookAdapter(
        this.walletProvider,
        (chainId: number) => this.getChainNameById(chainId),
      ),

      executeInBackground: false,
      disableMessageSigning: false,
    };
  }

  private updateRouteStatus(
    routeId: string,
    route: RouteExtended,
  ): BridgeExecutionStatus {
    const transactionHashes: string[] = [];
    let currentStep = 0;
    let isComplete = false;
    let error: string | undefined;

    route.steps.forEach((step, stepIndex) => {
      const stepExecution = step.execution;
      if (stepExecution?.process) {
        stepExecution.process.forEach((process) => {
          if (process.txHash) {
            transactionHashes.push(process.txHash);
          }
          if (process.status === "DONE") {
            currentStep = Math.max(currentStep, stepIndex + 1);
          }
          if (process.status === "FAILED") {
            error = `Step ${stepIndex + 1} failed: ${
              process.error ?? "Unknown error"
            }`;
          }
        });
      }
    });

    isComplete = currentStep === route.steps.length && !error;

    const status: BridgeExecutionStatus = {
      route,
      isComplete,
      error,
      transactionHashes,
      currentStep,
      totalSteps: route.steps.length,
    };

    this.activeRoutes.set(routeId, status);
    return status;
  }

  private async pollBridgeStatus(
    txHash: string,
    fromChainId: number,
    toChainId: number,
    tool: string,
    routeId: string,
  ): Promise<BridgeExecutionStatus> {
    for (let attempt = 1; attempt <= MAX_BRIDGE_POLL_ATTEMPTS; attempt++) {
      await new Promise((resolve) =>
        setTimeout(resolve, BRIDGE_POLL_INTERVAL_MS),
      );

      const status = await getStatus({
        txHash,
        fromChain: fromChainId,
        toChain: toChainId,
        bridge: tool,
      });

      const routeStatus = this.activeRoutes.get(routeId);
      if (!routeStatus) {
        throw new EVMError(
          EVMErrorCode.INVALID_PARAMS,
          `Route ${routeId} not found`,
        );
      }

      let isComplete = false;
      let error: string | undefined;

      if (status.status === "DONE") {
        isComplete = true;
      } else if (status.status === "FAILED") {
        error = `Bridge failed: ${status.substatus ?? "Unknown error"}`;
      }

      const updatedStatus: BridgeExecutionStatus = {
        ...routeStatus,
        isComplete,
        error,
        currentStep: isComplete
          ? routeStatus.totalSteps
          : routeStatus.currentStep,
      };

      this.activeRoutes.set(routeId, updatedStatus);

      if (isComplete || error) {
        return updatedStatus;
      }
    }

    const routeStatus = this.activeRoutes.get(routeId);
    if (routeStatus) {
      const timeoutStatus: BridgeExecutionStatus = {
        ...routeStatus,
        error: `Bridge status polling timed out after ${
          (MAX_BRIDGE_POLL_ATTEMPTS * BRIDGE_POLL_INTERVAL_MS) / 1000
        }s`,
      };
      this.activeRoutes.set(routeId, timeoutStatus);
      return timeoutStatus;
    }

    throw new EVMError(
      EVMErrorCode.NETWORK_ERROR,
      "Route status polling failed",
    );
  }

  async getQuote(params: BridgeParams) {
    const fromChainConfig = this.walletProvider.getChainConfigs(
      params.fromChain,
    );
    const toChainConfig = this.walletProvider.getChainConfigs(params.toChain);

    const resolvedFromToken = await this.resolveTokenAddress(
      params.fromToken,
      fromChainConfig.id,
    );
    const resolvedToToken = await this.resolveTokenAddress(
      params.toToken,
      toChainConfig.id,
    );

    const fromTokenDecimals = await this.getTokenDecimals(
      resolvedFromToken,
      params.fromChain,
    );
    const fromAmountParsed = parseUnits(params.amount, fromTokenDecimals);

    const walletClient = this.walletProvider.getWalletClient(params.fromChain);
    const [fromAddress] = await walletClient.getAddresses();

    const routesResult = await getRoutes({
      fromChainId: fromChainConfig.id,
      toChainId: toChainConfig.id,
      fromTokenAddress: resolvedFromToken,
      toTokenAddress: resolvedToToken,
      fromAmount: fromAmountParsed.toString(),
      fromAddress,
      toAddress: params.toAddress ?? fromAddress,
      options: {
        order: "RECOMMENDED",
        slippage: DEFAULT_SLIPPAGE_PERCENT,
        maxPriceImpact: MAX_PRICE_IMPACT,
        allowSwitchChain: true,
      },
    });

    return {
      routes: routesResult.routes,
      fromChainId: fromChainConfig.id,
      toChainId: toChainConfig.id,
      resolvedFromToken,
      resolvedToToken,
      fromAmountParsed,
      fromAddress,
    };
  }

  async bridge(params: BridgeParams) {
    const amount = parseFloat(params.amount);
    if (Number.isNaN(amount) || amount <= 0) {
      throw new EVMError(
        EVMErrorCode.INVALID_PARAMS,
        "Amount must be a positive number",
      );
    }

    if (params.fromChain === params.toChain) {
      throw new EVMError(
        EVMErrorCode.INVALID_PARAMS,
        "Source and destination chains must be different for bridging",
      );
    }

    if (
      params.toAddress &&
      (!params.toAddress.startsWith("0x") || params.toAddress.length !== 42)
    ) {
      throw new EVMError(
        EVMErrorCode.INVALID_PARAMS,
        `Invalid recipient address: ${params.toAddress}`,
      );
    }

    const quote = await this.getQuote(params);

    if (!quote.routes.length) {
      throw new EVMError(
        EVMErrorCode.INVALID_PARAMS,
        `No bridge routes found for ${params.fromToken} on ${params.fromChain} to ${params.toToken} on ${params.toChain}`,
      );
    }

    const selectedRoute = quote.routes[0];
    const routeId = `bridge_${Date.now()}_${Math.random()
      .toString(36)
      .slice(2, 11)}`;

    try {
      const executionOptions = this.createExecutionOptions(routeId);
      const executedRoute = await executeRoute(selectedRoute, executionOptions);

      const sourceSteps = executedRoute.steps.filter((step) =>
        step.execution?.process?.some((p) => p.txHash),
      );

      if (!sourceSteps.length) {
        throw new EVMError(
          EVMErrorCode.NETWORK_ERROR,
          "No transaction hashes found",
        );
      }

      const mainTxHash = sourceSteps[0]?.execution?.process?.find(
        (p) => p.txHash,
      )?.txHash;

      if (!mainTxHash) {
        throw new EVMError(
          EVMErrorCode.NETWORK_ERROR,
          "No transaction hash found",
        );
      }

      const bridgeTool = selectedRoute.steps[0].tool;
      const finalStatus = await this.pollBridgeStatus(
        mainTxHash,
        quote.fromChainId,
        quote.toChainId,
        bridgeTool,
        routeId,
      );

      if (finalStatus.error) {
        throw new EVMError(EVMErrorCode.CONTRACT_REVERT, finalStatus.error);
      }

      return {
        hash: mainTxHash as `0x${string}`,
        from: quote.fromAddress,
        to: (params.toAddress ?? quote.fromAddress) as `0x${string}`,
        value: quote.fromAmountParsed,
        chainId: quote.toChainId,
        route: selectedRoute,
      };
    } finally {
      this.activeRoutes.delete(routeId);
    }
  }

  async resumeBridge(route: RouteExtended) {
    const routeId = `resume_${Date.now()}_${Math.random()
      .toString(36)
      .slice(2, 11)}`;
    const executionOptions = this.createExecutionOptions(routeId);
    try {
      return await resumeRoute(route, executionOptions);
    } finally {
      this.activeRoutes.delete(routeId);
    }
  }
}

export async function checkBridgeStatus(
  txHash: string,
  fromChainId: number,
  toChainId: number,
  tool: string = "stargateV2Bus",
) {
  const status = await getStatus({
    txHash,
    fromChain: fromChainId,
    toChain: toChainId,
    bridge: tool,
  });

  return {
    status: status.status,
    substatus: status.substatus,
    isComplete: status.status === "DONE",
    isFailed: status.status === "FAILED",
    isPending: status.status === "PENDING",
    error: status.status === "FAILED" ? status.substatus : undefined,
  };
}

function viemChainByName(name: string): Chain | null {
  const chain = (viemChains as Record<string, Chain | undefined>)[name];
  return chain?.id ? chain : null;
}

export function validateWalletBridgeParams(
  params: WalletRouterParams,
): string | null {
  if (!params.amount) {
    return "amount is required for bridge.";
  }
  if (!params.fromToken) {
    return "fromToken is required for bridge.";
  }
  if (!params.chain) {
    return "chain (source) is required for bridge.";
  }
  if (!params.toChain) {
    return "toChain (destination) is required for bridge.";
  }
  if (params.chain === params.toChain) {
    return "Source and destination chains must be different for bridge.";
  }
  return null;
}

export async function routeEvmBridge(
  params: WalletRouterParams,
  context: WalletRouterContext,
  fromChainKey: string,
  fromChain: Chain,
): Promise<WalletRouterExecution> {
  const validationError = validateWalletBridgeParams(params);
  if (validationError) {
    throw new Error(validationError);
  }

  const toChainKey = params.toChain as string;
  const toChain = viemChainByName(toChainKey);
  if (!toChain) {
    throw new Error(
      `Unsupported destination chain "${toChainKey}" for bridge.`,
    );
  }

  if (params.mode === "prepare" || params.dryRun) {
    let routeMetadata: Record<string, unknown> | undefined;
    try {
      const walletProvider = await initWalletProvider(context.runtime);
      const action = new BridgeAction(walletProvider);
      const quote = await action.getQuote({
        fromChain: fromChainKey as SupportedChain,
        toChain: toChainKey as SupportedChain,
        fromToken: params.fromToken as Address,
        toToken: (params.toToken ?? params.fromToken) as Address,
        amount: params.amount as string,
        toAddress: params.recipient as Address | undefined,
      });

      const topRoute = quote.routes[0];
      routeMetadata = topRoute
        ? {
            tool: topRoute.steps[0]?.tool,
            steps: topRoute.steps.length,
            fromAmount: topRoute.fromAmount,
            toAmount: topRoute.toAmount,
            fromChainId: topRoute.fromChainId,
            toChainId: topRoute.toChainId,
            gasCostUSD: topRoute.gasCostUSD,
          }
        : { routes: 0 };
    } catch (error) {
      routeMetadata = {
        quoteUnavailable:
          error instanceof Error ? error.message : String(error),
      };
    }

    return {
      status: "prepared",
      chain: fromChainKey,
      chainId: String(fromChain.id),
      subaction: "bridge",
      dryRun: params.dryRun,
      mode: params.mode,
      amount: params.amount,
      fromToken: params.fromToken,
      toToken: params.toToken,
      to: params.recipient,
      metadata: {
        fromChain: fromChainKey,
        fromChainId: fromChain.id,
        toChain: toChainKey,
        toChainId: toChain.id,
        recipient: params.recipient,
        lifiQuote: routeMetadata,
        requiresConfirmation: true,
      },
    };
  }

  const walletProvider = await initWalletProvider(context.runtime);
  const action = new BridgeAction(walletProvider);
  const tx = await action.bridge({
    fromChain: fromChainKey as SupportedChain,
    toChain: toChainKey as SupportedChain,
    fromToken: params.fromToken as Address,
    toToken: (params.toToken ?? params.fromToken) as Address,
    amount: params.amount as string,
    toAddress: params.recipient as Address | undefined,
  });

  logger.debug(
    { fromChainKey, toChainKey, hash: tx.hash },
    "[plugin-wallet] Bridge submitted",
  );

  return {
    status: "submitted",
    chain: fromChainKey,
    chainId: String(fromChain.id),
    subaction: "bridge",
    dryRun: false,
    mode: params.mode,
    transactionHash: tx.hash,
    from: tx.from,
    to: tx.to,
    amount: params.amount,
    fromToken: params.fromToken,
    toToken: params.toToken ?? params.fromToken,
    metadata: {
      fromChain: fromChainKey,
      fromChainId: fromChain.id,
      toChain: toChainKey,
      toChainId: toChain.id,
      tool: tx.route.steps[0]?.tool,
    },
  };
}
