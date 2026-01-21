import type { ActionResult, HandlerCallback, IAgentRuntime, Memory, State } from "@elizaos/core";
import { composePromptFromState, logger, ModelType, parseKeyValueXml } from "@elizaos/core";
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
import { type Address, parseAbi, parseUnits } from "viem";
import {
  BRIDGE_POLL_INTERVAL_MS,
  DEFAULT_SLIPPAGE_PERCENT,
  MAX_BRIDGE_POLL_ATTEMPTS,
  MAX_PRICE_IMPACT,
  NATIVE_TOKEN_ADDRESS,
} from "../constants";
import { requireActionSpec } from "../generated/specs/spec-helpers";
import { initWalletProvider, type WalletProvider } from "../providers/wallet";
import { bridgeTemplate } from "../templates";
import {
  type BridgeParams,
  EVMError,
  EVMErrorCode,
  parseBridgeParams,
  type SupportedChain,
  type Transaction,
} from "../types";

export { bridgeTemplate };

type LiFiGetWalletClient = Parameters<typeof EVM>[0]["getWalletClient"];
type LiFiSwitchChain = Parameters<typeof EVM>[0]["switchChain"];

function createLiFiGetWalletClientAdapter(
  walletProvider: WalletProvider,
  getFirstChain: () => string
): LiFiGetWalletClient {
  return (async () => {
    const firstChain = getFirstChain();
    return walletProvider.getWalletClient(firstChain as SupportedChain);
  }) as LiFiGetWalletClient;
}

function createLiFiSwitchChainAdapter(
  walletProvider: WalletProvider,
  getChainNameById: (chainId: number) => string
): LiFiSwitchChain {
  return (async (chainId: number) => {
    logger.debug(`LiFi requesting chain switch to ${chainId}...`);
    const chainName = getChainNameById(chainId);
    return walletProvider.getWalletClient(chainName as SupportedChain);
  }) as LiFiSwitchChain;
}

function createExecutionSwitchChainHookAdapter(
  walletProvider: WalletProvider,
  getChainNameById: (chainId: number) => string
): ExecutionOptions["switchChainHook"] {
  return (async (chainId: number) => {
    logger.debug(`Switching to chain ${chainId}...`);
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
        () => Object.keys(this.walletProvider.chains)[0]
      ),
      switchChain: createLiFiSwitchChainAdapter(this.walletProvider, (chainId: number) =>
        this.getChainNameById(chainId)
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
      ([_, config]) => config.id === chainId
    );
    if (!chain) {
      throw new EVMError(EVMErrorCode.CHAIN_NOT_CONFIGURED, `Chain with ID ${chainId} not found`);
    }
    return chain[0];
  }

  private async resolveTokenAddress(
    tokenSymbolOrAddress: string,
    chainId: number
  ): Promise<string> {
    if (tokenSymbolOrAddress.startsWith("0x") && tokenSymbolOrAddress.length === 42) {
      return tokenSymbolOrAddress;
    }

    if (tokenSymbolOrAddress === NATIVE_TOKEN_ADDRESS) {
      return tokenSymbolOrAddress;
    }

    const token = await getToken(chainId, tokenSymbolOrAddress);
    return token.address;
  }

  private async getTokenDecimals(tokenAddress: string, chainName: string): Promise<number> {
    const chainConfig = this.walletProvider.getChainConfigs(chainName as SupportedChain);

    if (
      tokenAddress === NATIVE_TOKEN_ADDRESS ||
      tokenAddress.toUpperCase() === chainConfig.nativeCurrency.symbol.toUpperCase()
    ) {
      return chainConfig.nativeCurrency.decimals;
    }

    const decimalsAbi = parseAbi(["function decimals() view returns (uint8)"]);

    const publicClient = this.walletProvider.getPublicClient(chainName as SupportedChain);
    // @ts-expect-error - viem type narrowing issue with readContract parameters
    const decimals = (await publicClient.readContract({
      address: tokenAddress as Address,
      abi: decimalsAbi,
      functionName: "decimals",
    })) as number;
    return Number(decimals);
  }

  private createExecutionOptions(routeId: string): ExecutionOptions {
    return {
      updateTransactionRequestHook: async (txRequest) => {
        if (txRequest.gas) {
          txRequest.gas = (BigInt(txRequest.gas) * BigInt(110)) / BigInt(100);
        }
        if (txRequest.gasPrice) {
          txRequest.gasPrice = (BigInt(txRequest.gasPrice) * BigInt(105)) / BigInt(100);
        }
        return txRequest;
      },

      acceptExchangeRateUpdateHook: async (params: {
        toToken: { decimals: number; symbol: string };
        oldToAmount: string;
        newToAmount: string;
      }) => {
        const priceChange =
          ((Number(params.newToAmount) - Number(params.oldToAmount)) / Number(params.oldToAmount)) *
          100;

        logger.debug(`Exchange rate change: ${priceChange.toFixed(2)}%`);
        return Math.abs(priceChange) < 5;
      },

      updateRouteHook: (updatedRoute: RouteExtended) => {
        this.updateRouteStatus(routeId, updatedRoute);
      },

      switchChainHook: createExecutionSwitchChainHookAdapter(
        this.walletProvider,
        (chainId: number) => this.getChainNameById(chainId)
      ),

      executeInBackground: false,
      disableMessageSigning: false,
    };
  }

  private updateRouteStatus(routeId: string, route: RouteExtended): BridgeExecutionStatus {
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
            error = `Step ${stepIndex + 1} failed: ${process.error ?? "Unknown error"}`;
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
    routeId: string
  ): Promise<BridgeExecutionStatus> {
    for (let attempt = 1; attempt <= MAX_BRIDGE_POLL_ATTEMPTS; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, BRIDGE_POLL_INTERVAL_MS));

      try {
        const status = await getStatus({
          txHash,
          fromChain: fromChainId,
          toChain: toChainId,
          bridge: tool,
        });

        logger.debug(`Poll attempt ${attempt}/${MAX_BRIDGE_POLL_ATTEMPTS}: ${status.status}`);

        const routeStatus = this.activeRoutes.get(routeId);
        if (!routeStatus) {
          throw new EVMError(EVMErrorCode.INVALID_PARAMS, `Route ${routeId} not found`);
        }

        let isComplete = false;
        let error: string | undefined;

        if (status.status === "DONE") {
          isComplete = true;
          logger.debug("Bridge completed successfully!");
        } else if (status.status === "FAILED") {
          error = `Bridge failed: ${status.substatus ?? "Unknown error"}`;
        }

        const updatedStatus: BridgeExecutionStatus = {
          ...routeStatus,
          isComplete,
          error,
          currentStep: isComplete ? routeStatus.totalSteps : routeStatus.currentStep,
        };

        this.activeRoutes.set(routeId, updatedStatus);

        if (isComplete || error) {
          return updatedStatus;
        }
      } catch (statusError) {
        logger.warn(`Status check attempt ${attempt} failed:`, statusError);
      }
    }

    const routeStatus = this.activeRoutes.get(routeId);
    if (routeStatus) {
      const timeoutStatus: BridgeExecutionStatus = {
        ...routeStatus,
        error: `Bridge status polling timed out after ${(MAX_BRIDGE_POLL_ATTEMPTS * BRIDGE_POLL_INTERVAL_MS) / 1000}s`,
      };
      this.activeRoutes.set(routeId, timeoutStatus);
      return timeoutStatus;
    }

    throw new EVMError(EVMErrorCode.NETWORK_ERROR, "Route status polling failed");
  }

  async bridge(params: BridgeParams): Promise<Transaction> {
    // Validate inputs early to fail fast
    const amount = parseFloat(params.amount);
    if (Number.isNaN(amount) || amount <= 0) {
      throw new EVMError(EVMErrorCode.INVALID_PARAMS, "Amount must be a positive number");
    }

    if (params.fromChain === params.toChain) {
      throw new EVMError(
        EVMErrorCode.INVALID_PARAMS,
        "Source and destination chains must be different for bridging"
      );
    }

    if (
      params.toAddress &&
      (!params.toAddress.startsWith("0x") || params.toAddress.length !== 42)
    ) {
      throw new EVMError(
        EVMErrorCode.INVALID_PARAMS,
        `Invalid recipient address: ${params.toAddress}`
      );
    }

    const walletClient = this.walletProvider.getWalletClient(params.fromChain);
    const [fromAddress] = await walletClient.getAddresses();

    logger.debug(`Bridge: ${params.fromChain} → ${params.toChain}`);
    logger.debug(`Amount: ${params.amount}`);

    const fromChainConfig = this.walletProvider.getChainConfigs(params.fromChain);
    const toChainConfig = this.walletProvider.getChainConfigs(params.toChain);

    const resolvedFromToken = await this.resolveTokenAddress(params.fromToken, fromChainConfig.id);
    const resolvedToToken = await this.resolveTokenAddress(params.toToken, toChainConfig.id);

    const fromTokenDecimals = await this.getTokenDecimals(resolvedFromToken, params.fromChain);

    const fromAmountParsed = parseUnits(params.amount, fromTokenDecimals);

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

    if (!routesResult.routes.length) {
      throw new EVMError(
        EVMErrorCode.INVALID_PARAMS,
        `No bridge routes found for ${params.fromToken} on ${params.fromChain} to ${params.toToken} on ${params.toChain}`
      );
    }

    const selectedRoute = routesResult.routes[0];
    const routeId = `bridge_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    logger.debug(`Selected route ${routeId}`);
    logger.debug(`Steps: ${selectedRoute.steps.length}`);

    try {
      const executionOptions = this.createExecutionOptions(routeId);
      const executedRoute = await executeRoute(selectedRoute, executionOptions);

      const sourceSteps = executedRoute.steps.filter((step) =>
        step.execution?.process?.some((p) => p.txHash)
      );

      if (!sourceSteps.length) {
        throw new EVMError(EVMErrorCode.NETWORK_ERROR, "No transaction hashes found");
      }

      const mainTxHash = sourceSteps[0]?.execution?.process?.find((p) => p.txHash)?.txHash;

      if (!mainTxHash) {
        throw new EVMError(EVMErrorCode.NETWORK_ERROR, "No transaction hash found");
      }

      logger.debug(`Source transaction: ${mainTxHash}`);

      const bridgeTool = selectedRoute.steps[0].tool;
      const finalStatus = await this.pollBridgeStatus(
        mainTxHash,
        fromChainConfig.id,
        toChainConfig.id,
        bridgeTool,
        routeId
      );

      if (finalStatus.error) {
        throw new EVMError(EVMErrorCode.CONTRACT_REVERT, finalStatus.error);
      }

      logger.debug("Bridge initiated successfully!");

      return {
        hash: mainTxHash as `0x${string}`,
        from: fromAddress,
        to: (params.toAddress ?? fromAddress) as `0x${string}`,
        value: fromAmountParsed,
        chainId: toChainConfig.id,
      };
    } finally {
      this.activeRoutes.delete(routeId);
    }
  }

  async getTransactionStatus(txHash: string, fromChainId: number, toChainId: number, tool: string) {
    return await getStatus({
      txHash,
      fromChain: fromChainId,
      toChain: toChainId,
      bridge: tool,
    });
  }

  async resumeBridge(route: RouteExtended) {
    const routeId = `resume_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const executionOptions = this.createExecutionOptions(routeId);

    logger.debug("Resuming bridge operation...");

    try {
      return await resumeRoute(route, executionOptions);
    } finally {
      this.activeRoutes.delete(routeId);
    }
  }
}

async function buildBridgeDetails(
  state: State,
  runtime: IAgentRuntime,
  wp: WalletProvider
): Promise<BridgeParams> {
  const chains = wp.getSupportedChains();
  const balances = await wp.getWalletBalances();

  state.supportedChains = chains.join(" | ");
  state.chainBalances = Object.entries(balances)
    .map(([chain, balance]) => {
      const chainConfig = wp.getChainConfigs(chain as SupportedChain);
      return `${chain}: ${balance} ${chainConfig.nativeCurrency.symbol}`;
    })
    .join(", ");

  const bridgeContext = composePromptFromState({
    state,
    template: bridgeTemplate,
  });

  const xmlResponse = await runtime.useModel(ModelType.TEXT_LARGE, {
    prompt: bridgeContext,
  });

  const content = parseKeyValueXml(xmlResponse);

  if (!content) {
    throw new EVMError(EVMErrorCode.INVALID_PARAMS, "Failed to parse bridge details from LLM");
  }

  const rawParams = {
    fromChain: String(content.fromChain ?? "").toLowerCase(),
    toChain: String(content.toChain ?? "").toLowerCase(),
    fromToken: String(content.token ?? ""),
    toToken: String(content.token ?? ""),
    amount: String(content.amount ?? ""),
    toAddress: content.toAddress ? String(content.toAddress) : undefined,
  };

  const bridgeOptions = parseBridgeParams(rawParams);

  if (!wp.chains[bridgeOptions.fromChain]) {
    throw new EVMError(
      EVMErrorCode.CHAIN_NOT_CONFIGURED,
      `Source chain ${bridgeOptions.fromChain} not configured. Available: ${chains.join(", ")}`
    );
  }

  if (!wp.chains[bridgeOptions.toChain]) {
    throw new EVMError(
      EVMErrorCode.CHAIN_NOT_CONFIGURED,
      `Destination chain ${bridgeOptions.toChain} not configured. Available: ${chains.join(", ")}`
    );
  }

  return bridgeOptions;
}

const spec = requireActionSpec("BRIDGE");

export const bridgeAction = {
  name: spec.name,
  description: spec.description,

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    _options?: Record<string, unknown>,
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    const walletProvider = await initWalletProvider(runtime);
    const action = new BridgeAction(walletProvider);

    if (!state) {
      state = await runtime.composeState(message, ["RECENT_MESSAGES"], true);
    }

    const bridgeOptions = await buildBridgeDetails(state, runtime, walletProvider);

    const bridgeResp = await action.bridge(bridgeOptions);

    const successText = `✅ Successfully bridged ${bridgeOptions.amount} tokens from ${bridgeOptions.fromChain} to ${bridgeOptions.toChain}\n\nTransaction Hash: ${bridgeResp.hash}`;

    await runtime.createMemory(
      {
        entityId: message.agentId ?? runtime.agentId,
        roomId: message.roomId,
        agentId: message.agentId ?? runtime.agentId,
        content: {
          text: successText,
          action: ["EVM_BRIDGE_TOKENS"],
        },
      },
      "messages"
    );

    if (callback) {
      callback({
        text: successText,
        content: {
          success: true,
          hash: bridgeResp.hash,
          recipient: bridgeResp.to,
          fromChain: bridgeOptions.fromChain,
          toChain: bridgeOptions.toChain,
          amount: bridgeOptions.amount,
        },
      });
    }

    return {
      success: true,
      text: successText,
      values: {
        bridgeSucceeded: true,
      },
      data: {
        actionName: "EVM_BRIDGE_TOKENS",
        transactionHash: bridgeResp.hash,
        fromChain: bridgeOptions.fromChain,
        toChain: bridgeOptions.toChain,
        token: bridgeOptions.fromToken,
        amount: bridgeOptions.amount,
        recipient: bridgeResp.to,
      },
    };
  },

  template: bridgeTemplate,

  validate: async (runtime: IAgentRuntime): Promise<boolean> => {
    const privateKey = runtime.getSetting("EVM_PRIVATE_KEY");
    return typeof privateKey === "string" && privateKey.startsWith("0x");
  },

  examples: [
    [
      {
        name: "user",
        user: "user",
        content: {
          text: "Bridge 1 ETH from Ethereum to Base",
          action: "CROSS_CHAIN_TRANSFER",
        },
      },
    ],
  ],

  similes: spec.similes ? [...spec.similes] : [],
};

export async function checkBridgeStatus(
  txHash: string,
  fromChainId: number,
  toChainId: number,
  tool: string = "stargateV2Bus"
) {
  const status = await getStatus({
    txHash,
    fromChain: fromChainId,
    toChain: toChainId,
    bridge: tool,
  });

  logger.debug(
    `Bridge Status: ${status.status}${status.substatus ? ` (${status.substatus})` : ""}`
  );

  return {
    status: status.status,
    substatus: status.substatus,
    isComplete: status.status === "DONE",
    isFailed: status.status === "FAILED",
    isPending: status.status === "PENDING",
    error: status.status === "FAILED" ? status.substatus : undefined,
  };
}
