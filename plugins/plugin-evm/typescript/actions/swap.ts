/**
 * @elizaos/plugin-evm Swap Action
 *
 * Handles token swaps on EVM chains using multiple aggregators (LiFi, Bebop).
 */

import type { ActionResult, HandlerCallback, IAgentRuntime, Memory, State } from "@elizaos/core";
import { composePromptFromState, logger, ModelType, parseKeyValueXml } from "@elizaos/core";
import {
  createConfig,
  type ExtendedChain,
  getRoutes,
  getStepTransaction,
  getToken,
  type Route,
} from "@lifi/sdk";

import { type Address, encodeFunctionData, type Hex, parseAbi, parseUnits } from "viem";
import {
  BEBOP_CHAIN_MAP,
  DEFAULT_SLIPPAGE_PERCENT,
  GAS_BUFFER_MULTIPLIER,
  GAS_PRICE_MULTIPLIER,
  NATIVE_TOKEN_ADDRESS,
  TX_CONFIRMATION_TIMEOUT_MS,
} from "../constants";
import { initWalletProvider, type WalletProvider } from "../providers/wallet";
import { swapTemplate } from "../templates";
import {
  type BebopRoute,
  BebopRouteSchema,
  EVMError,
  EVMErrorCode,
  parseSwapParams,
  type SupportedChain,
  type SwapParams,
  type SwapQuote,
  type Transaction,
} from "../types";

export { swapTemplate };

/**
 * Swap action executor
 */
export class SwapAction {
  constructor(private readonly walletProvider: WalletProvider) {
    const lifiChains: ExtendedChain[] = [];

    for (const config of Object.values(this.walletProvider.chains)) {
      const blockExplorerUrls = config.blockExplorers?.default?.url
        ? [config.blockExplorers.default.url]
        : [];

      // Cast to ExtendedChain - the type assertions are needed for LiFi SDK compatibility
      const lifiChain = {
        id: config.id,
        name: config.name,
        key: config.name.toLowerCase(),
        chainType: "EVM",
        nativeToken: {
          ...config.nativeCurrency,
          chainId: config.id,
          address: NATIVE_TOKEN_ADDRESS,
          coinKey: config.nativeCurrency.symbol,
          priceUSD: "0",
          logoURI: "",
          symbol: config.nativeCurrency.symbol,
          decimals: config.nativeCurrency.decimals,
          name: config.nativeCurrency.name,
        },
        rpcUrls: {
          public: { http: [config.rpcUrls.default.http[0]] },
        },
        blockExplorerUrls,
        metamask: {
          chainId: `0x${config.id.toString(16)}`,
          chainName: config.name,
          nativeCurrency: config.nativeCurrency,
          rpcUrls: [config.rpcUrls.default.http[0]],
          blockExplorerUrls,
        },
        coin: config.nativeCurrency.symbol,
        mainnet: true,
        diamondAddress: NATIVE_TOKEN_ADDRESS,
      } as ExtendedChain;

      lifiChains.push(lifiChain);
    }

    // Configure LiFi SDK with chain information
    createConfig({
      integrator: "eliza",
      chains: lifiChains,
    });
  }

  /**
   * Resolve a token symbol or address to a contract address using LiFi SDK
   */
  private async resolveTokenAddress(
    tokenSymbolOrAddress: string,
    chainId: number
  ): Promise<string> {
    // If it's already a valid address, return as is
    if (tokenSymbolOrAddress.startsWith("0x") && tokenSymbolOrAddress.length === 42) {
      return tokenSymbolOrAddress;
    }

    // If it's the native token, return as is
    if (tokenSymbolOrAddress === NATIVE_TOKEN_ADDRESS) {
      return tokenSymbolOrAddress;
    }

    const token = await getToken(chainId, tokenSymbolOrAddress);
    return token.address;
  }

  /**
   * Execute a token swap
   */
  async swap(params: SwapParams): Promise<Transaction> {
    const walletClient = this.walletProvider.getWalletClient(params.chain);
    const [fromAddress] = await walletClient.getAddresses();

    // Resolve token symbols to addresses
    const chainConfig = this.walletProvider.getChainConfigs(params.chain);
    const chainId = chainConfig.id;

    const resolvedFromToken = await this.resolveTokenAddress(params.fromToken, chainId);
    const resolvedToToken = await this.resolveTokenAddress(params.toToken, chainId);

    const resolvedParams: SwapParams = {
      ...params,
      fromToken: resolvedFromToken as Address,
      toToken: resolvedToToken as Address,
    };

    // Try swap with progressively higher slippage if needed
    const slippageLevels = [0.01, 0.015, 0.02];
    let lastError: Error | undefined;
    let attemptCount = 0;

    for (const slippage of slippageLevels) {
      logger.info(`Attempting swap with ${(slippage * 100).toFixed(1)}% slippage...`);

      const sortedQuotes = await this.getSortedQuotes(fromAddress, resolvedParams, slippage);

      for (const quote of sortedQuotes) {
        attemptCount++;
        logger.info(`Trying ${quote.aggregator} (attempt ${attemptCount})...`);

        try {
          let result: Transaction | undefined;

          switch (quote.aggregator) {
            case "lifi":
              result = await this.executeLifiQuote(quote);
              break;
            case "bebop":
              result = await this.executeBebopQuote(quote, resolvedParams);
              break;
          }

          if (result) {
            logger.info(`✅ Swap succeeded via ${quote.aggregator}!`);
            return result;
          }
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error));
          logger.warn(`${quote.aggregator} attempt failed: ${lastError.message}`);

          // If it's a recoverable error, continue to next attempt
          if (this.isRecoverableError(lastError)) {
            continue;
          }

          // Non-recoverable error, throw immediately
          throw lastError;
        }
      }

      // Add delay before retrying with higher slippage
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }

    throw new EVMError(
      EVMErrorCode.CONTRACT_REVERT,
      `All swap attempts failed after ${attemptCount} tries. ${lastError?.message ?? "Unknown error"}`
    );
  }

  private isRecoverableError(error: Error): boolean {
    const message = error.message;
    return (
      message.includes("price movement") ||
      message.includes("Return amount is not enough") ||
      message.includes("reverted") ||
      message.includes("MEV frontrunning") ||
      message.includes("TRANSFER_FROM_FAILED")
    );
  }

  private async getSortedQuotes(
    fromAddress: Address,
    params: SwapParams,
    slippage: number = DEFAULT_SLIPPAGE_PERCENT
  ): Promise<SwapQuote[]> {
    const decimalsAbi = parseAbi(["function decimals() view returns (uint8)"]);
    let fromTokenDecimals: number;

    const chainConfig = this.walletProvider.getChainConfigs(params.chain);

    // Check if the fromToken is the native currency
    if (
      params.fromToken.toUpperCase() === chainConfig.nativeCurrency.symbol.toUpperCase() ||
      params.fromToken === NATIVE_TOKEN_ADDRESS
    ) {
      fromTokenDecimals = chainConfig.nativeCurrency.decimals;
    } else {
      const publicClient = this.walletProvider.getPublicClient(params.chain);
      fromTokenDecimals = Number(// @ts-expect-error - viem type narrowing issue
    await publicClient.readContract({
        address: params.fromToken as Address,
        abi: decimalsAbi,
        functionName: "decimals",
      } as unknown as Parameters<typeof publicClient.readContract>[0]));
    }

    const quotesPromises: Promise<SwapQuote | undefined>[] = [
      this.getLifiQuote(fromAddress, params, fromTokenDecimals, slippage),
      this.getBebopQuote(fromAddress, params, fromTokenDecimals),
    ];

    const quotesResults = await Promise.all(quotesPromises);
    const sortedQuotes = quotesResults.filter((quote): quote is SwapQuote => quote !== undefined);

    sortedQuotes.sort((a, b) => (BigInt(a.minOutputAmount) > BigInt(b.minOutputAmount) ? -1 : 1));

    if (sortedQuotes.length === 0) {
      throw new EVMError(EVMErrorCode.INVALID_PARAMS, "No routes found");
    }

    return sortedQuotes;
  }

  private async getLifiQuote(
    fromAddress: Address,
    params: SwapParams,
    fromTokenDecimals: number,
    slippage: number = DEFAULT_SLIPPAGE_PERCENT
  ): Promise<SwapQuote | undefined> {
    try {
      const routes = await getRoutes({
        fromChainId: this.walletProvider.getChainConfigs(params.chain).id,
        toChainId: this.walletProvider.getChainConfigs(params.chain).id,
        fromTokenAddress: params.fromToken,
        toTokenAddress: params.toToken,
        fromAmount: parseUnits(params.amount, fromTokenDecimals).toString(),
        fromAddress,
        options: {
          slippage,
          order: "RECOMMENDED",
        },
      });

      if (!routes.routes.length) {
        throw new Error("No routes found");
      }

      return {
        aggregator: "lifi",
        minOutputAmount: routes.routes[0].steps[0].estimate.toAmountMin,
        swapData: routes.routes[0],
      };
    } catch (error) {
      logger.error("Error in getLifiQuote:", error);
      return undefined;
    }
  }

  private async getBebopQuote(
    fromAddress: Address,
    params: SwapParams,
    fromTokenDecimals: number
  ): Promise<SwapQuote | undefined> {
    try {
      const chainName = BEBOP_CHAIN_MAP[params.chain] ?? params.chain;
      const url = `https://api.bebop.xyz/router/${chainName}/v1/quote`;

      const chainConfig = this.walletProvider.getChainConfigs(params.chain);
      const resolvedFromToken = await this.resolveTokenAddress(params.fromToken, chainConfig.id);
      const resolvedToToken = await this.resolveTokenAddress(params.toToken, chainConfig.id);

      const reqParams = new URLSearchParams({
        sell_tokens: resolvedFromToken,
        buy_tokens: resolvedToToken,
        sell_amounts: parseUnits(params.amount, fromTokenDecimals).toString(),
        taker_address: fromAddress,
        approval_type: "Standard",
        skip_validation: "true",
        gasless: "false",
        source: "eliza",
      });

      const response = await fetch(`${url}?${reqParams.toString()}`, {
        method: "GET",
        headers: { accept: "application/json" },
      });

      if (!response.ok) {
        throw new Error(`Bebop API error: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();

      if (!data.routes?.length) {
        throw new Error("No routes found in Bebop API response");
      }

      const firstRoute = data.routes[0];
      const quoteTx = firstRoute?.quote?.tx;

      if (!quoteTx) {
        throw new Error("Invalid route structure in Bebop API response");
      }

      const route: BebopRoute = {
        data: quoteTx.data,
        sellAmount: parseUnits(params.amount, fromTokenDecimals).toString(),
        approvalTarget: firstRoute.quote.approvalTarget as Address,
        from: quoteTx.from as Address,
        value: quoteTx.value?.toString() ?? "0",
        to: quoteTx.to as Address,
        gas: quoteTx.gas?.toString() ?? "0",
        gasPrice: quoteTx.gasPrice?.toString() ?? "0",
      };

      // Validate the route structure
      BebopRouteSchema.parse(route);

      // Find buy token info
      const buyTokens = firstRoute.quote.buyTokens;
      if (!buyTokens) {
        throw new Error("Missing buyTokens in Bebop response");
      }

      const buyTokenInfo =
        buyTokens[resolvedToToken] ??
        buyTokens[params.toToken] ??
        buyTokens[resolvedToToken.toLowerCase()] ??
        Object.values(buyTokens)[0];

      if (!buyTokenInfo?.minimumAmount) {
        throw new Error("Cannot determine minimum output amount");
      }

      return {
        aggregator: "bebop",
        minOutputAmount: buyTokenInfo.minimumAmount.toString(),
        swapData: route,
      };
    } catch (error) {
      logger.error("Error in getBebopQuote:", error);
      return undefined;
    }
  }

  private async executeLifiQuote(quote: SwapQuote): Promise<Transaction | undefined> {
    const route = quote.swapData as Route;
    const step = route.steps[0];

    if (!step) {
      throw new EVMError(EVMErrorCode.INVALID_PARAMS, "No steps found in route");
    }

    const stepWithTx = await getStepTransaction(step);

    if (!stepWithTx.transactionRequest) {
      throw new EVMError(EVMErrorCode.INVALID_PARAMS, "No transaction request found in step");
    }

    const chainId = route.fromChainId;
    const chainName = Object.keys(this.walletProvider.chains).find(
      (name) => this.walletProvider.getChainConfigs(name as SupportedChain).id === chainId
    );

    if (!chainName) {
      throw new EVMError(EVMErrorCode.CHAIN_NOT_CONFIGURED, `Chain with ID ${chainId} not found`);
    }

    const walletClient = this.walletProvider.getWalletClient(chainName as SupportedChain);
    const publicClient = this.walletProvider.getPublicClient(chainName as SupportedChain);

    if (!walletClient.account) {
      throw new EVMError(EVMErrorCode.WALLET_NOT_INITIALIZED, "Wallet account is not available");
    }

    const txRequest = stepWithTx.transactionRequest;

    // Handle ERC20 approval if needed
    const fromToken = route.fromToken;
    if (fromToken.address !== NATIVE_TOKEN_ADDRESS) {
      await this.handleTokenApproval(
        publicClient,
        walletClient,
        fromToken.address as Address,
        txRequest.to as Address,
        BigInt(route.fromAmount)
      );
    }

    const hash = // @ts-expect-error - viem type narrowing issue
    await walletClient.sendTransaction({
      account: walletClient.account,
      to: txRequest.to as Address,
      value: BigInt(txRequest.value ?? "0"),
      data: txRequest.data as Hex,
      chain: walletClient.chain,
      gas: txRequest.gasLimit
        ? BigInt(Math.floor(Number(txRequest.gasLimit) * GAS_BUFFER_MULTIPLIER))
        : undefined,
      gasPrice: txRequest.gasPrice
        ? BigInt(Math.floor(Number(txRequest.gasPrice) * GAS_PRICE_MULTIPLIER))
        : undefined,
    });

    const receipt = await publicClient.waitForTransactionReceipt({
      hash,
      timeout: TX_CONFIRMATION_TIMEOUT_MS,
    });

    if (receipt.status === "reverted") {
      throw new EVMError(EVMErrorCode.CONTRACT_REVERT, `Transaction reverted. Hash: ${hash}`);
    }

    return {
      hash,
      from: walletClient.account.address,
      to: txRequest.to as Address,
      value: BigInt(txRequest.value ?? "0"),
      data: txRequest.data as Hex,
      chainId: route.fromChainId,
    };
  }

  private async executeBebopQuote(
    quote: SwapQuote,
    params: SwapParams
  ): Promise<Transaction | undefined> {
    const bebopRoute = quote.swapData as BebopRoute;
    const walletClient = this.walletProvider.getWalletClient(params.chain);
    const publicClient = this.walletProvider.getPublicClient(params.chain);

    if (!walletClient.account) {
      throw new EVMError(EVMErrorCode.WALLET_NOT_INITIALIZED, "Wallet account is not available");
    }

    const chainConfig = this.walletProvider.getChainConfigs(params.chain);
    const resolvedFromToken = await this.resolveTokenAddress(params.fromToken, chainConfig.id);

    // Handle ERC20 approval if not native token
    if (resolvedFromToken !== NATIVE_TOKEN_ADDRESS) {
      await this.handleTokenApproval(
        publicClient,
        walletClient,
        resolvedFromToken as Address,
        bebopRoute.approvalTarget,
        BigInt(bebopRoute.sellAmount)
      );
    }

    const hash = await walletClient.sendTransaction({
      account: walletClient.account,
      to: bebopRoute.to,
      value: BigInt(bebopRoute.value),
      data: bebopRoute.data as Hex,
      chain: walletClient.chain,
    } as unknown as Parameters<typeof walletClient.sendTransaction>[0]);

    const receipt = await publicClient.waitForTransactionReceipt({
      hash,
      timeout: TX_CONFIRMATION_TIMEOUT_MS,
    });

    if (receipt.status === "reverted") {
      throw new EVMError(EVMErrorCode.CONTRACT_REVERT, `Bebop swap reverted. Hash: ${hash}`);
    }

    return {
      hash,
      from: walletClient.account.address,
      to: bebopRoute.to,
      value: BigInt(bebopRoute.value),
      data: bebopRoute.data as Hex,
      chainId: chainConfig.id,
    };
  }

  private async handleTokenApproval(
    publicClient: ReturnType<WalletProvider["getPublicClient"]>,
    walletClient: ReturnType<WalletProvider["getWalletClient"]>,
    tokenAddress: Address,
    spenderAddress: Address,
    requiredAmount: bigint
  ): Promise<void> {
    if (!walletClient.account) {
      throw new EVMError(EVMErrorCode.WALLET_NOT_INITIALIZED, "Wallet account not available");
    }

    const allowanceAbi = parseAbi(["function allowance(address,address) view returns (uint256)"]);

    const allowance = (// @ts-expect-error - viem type narrowing issue
    await publicClient.readContract({
      address: tokenAddress,
      abi: allowanceAbi,
      functionName: "allowance",
      args: [walletClient.account.address, spenderAddress],
    })) as bigint;

    if (allowance >= requiredAmount) {
      return;
    }

    logger.info(`Approving token for swap...`);

    const approvalData = encodeFunctionData({
      abi: parseAbi(["function approve(address,uint256)"]),
      functionName: "approve",
      args: [spenderAddress, requiredAmount],
    });

    const approvalTx = // @ts-expect-error - viem type narrowing issue
    await walletClient.sendTransaction({
      account: walletClient.account,
      to: tokenAddress,
      value: 0n,
      data: approvalData,
      chain: walletClient.chain,
    });

    logger.info(`Waiting for approval confirmation...`);

    const approvalReceipt = await publicClient.waitForTransactionReceipt({
      hash: approvalTx,
      timeout: TX_CONFIRMATION_TIMEOUT_MS,
    });

    if (approvalReceipt.status === "reverted") {
      throw new EVMError(
        EVMErrorCode.CONTRACT_REVERT,
        `Token approval failed. Hash: ${approvalTx}`
      );
    }

    logger.info(`Token approval confirmed`);
  }
}

/**
 * Build swap details from LLM response
 */
async function buildSwapDetails(
  state: State,
  message: Memory,
  runtime: IAgentRuntime,
  wp: WalletProvider
): Promise<SwapParams> {
  const chains = wp.getSupportedChains();
  const balances = await wp.getWalletBalances();

  state = await runtime.composeState(message, ["RECENT_MESSAGES"], true);
  state.supportedChains = chains.join(" | ");
  state.chainBalances = Object.entries(balances)
    .map(([chain, balance]) => {
      const chainConfig = wp.getChainConfigs(chain as SupportedChain);
      return `${chain}: ${balance} ${chainConfig.nativeCurrency.symbol}`;
    })
    .join(", ");

  const context = composePromptFromState({
    state,
    template: swapTemplate,
  });

  const xmlResponse = await runtime.useModel(ModelType.TEXT_LARGE, {
    prompt: context,
  });

  const parsedXml = parseKeyValueXml(xmlResponse);

  if (!parsedXml) {
    throw new EVMError(
      EVMErrorCode.INVALID_PARAMS,
      "Failed to parse XML response from LLM for swap details."
    );
  }

  const rawParams = {
    fromToken: String(parsedXml.inputToken ?? ""),
    toToken: String(parsedXml.outputToken ?? ""),
    amount: String(parsedXml.amount ?? ""),
    chain: String(parsedXml.chain ?? "").toLowerCase(),
  };

  const swapDetails = parseSwapParams(rawParams);

  // Validate chain exists
  if (!wp.chains[swapDetails.chain]) {
    throw new EVMError(
      EVMErrorCode.CHAIN_NOT_CONFIGURED,
      `Chain ${swapDetails.chain} not configured. Available: ${chains.join(", ")}`
    );
  }

  // Handle percentage-based amounts
  const messageText = (message.content.text ?? "").toLowerCase();
  if (!swapDetails.amount || swapDetails.amount === "null") {
    const balance = balances[swapDetails.chain];
    if (balance) {
      if (messageText.includes("half") || messageText.includes("50%")) {
        return { ...swapDetails, amount: (parseFloat(balance) / 2).toString() };
      }
      if (
        messageText.includes("all") ||
        messageText.includes("100%") ||
        messageText.includes("everything")
      ) {
        return {
          ...swapDetails,
          amount: (parseFloat(balance) * 0.9).toString(),
        };
      }
      const percentMatch = messageText.match(/(\d+)%/);
      if (percentMatch) {
        const percentage = parseInt(percentMatch[1], 10) / 100;
        return {
          ...swapDetails,
          amount: (parseFloat(balance) * percentage).toString(),
        };
      }
    }
  }

  return swapDetails;
}

/**
 * Swap action definition
 */
export const swapAction = {
  name: "EVM_SWAP_TOKENS",
  description: "Swap tokens on the same chain",

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    _options?: Record<string, unknown>,
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    const walletProvider = await initWalletProvider(runtime);
    const action = new SwapAction(walletProvider);

    if (!state) {
      state = await runtime.composeState(message);
    }

    const swapOptions = await buildSwapDetails(state, message, runtime, walletProvider);

    const swapResp = await action.swap(swapOptions);

    const successText = `✅ Successfully swapped ${swapOptions.amount} ${swapOptions.fromToken} for ${swapOptions.toToken} on ${swapOptions.chain}\nTransaction Hash: ${swapResp.hash}`;

    if (callback) {
      callback({
        text: successText,
        content: {
          success: true,
          hash: swapResp.hash,
          chain: swapOptions.chain,
          fromToken: swapOptions.fromToken,
          toToken: swapOptions.toToken,
          amount: swapOptions.amount,
        },
      });
    }

    return {
      success: true,
      text: successText,
      values: {
        swapSucceeded: true,
        inputToken: swapOptions.fromToken,
        outputToken: swapOptions.toToken,
      },
      data: {
        actionName: "EVM_SWAP_TOKENS",
        transactionHash: swapResp.hash,
        chain: swapOptions.chain,
        fromToken: swapOptions.fromToken,
        toToken: swapOptions.toToken,
        amount: swapOptions.amount,
      },
    };
  },

  template: swapTemplate,

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
          text: "Swap 1 WETH for USDC on Arbitrum",
          action: "TOKEN_SWAP",
        },
      },
    ],
  ],

  similes: ["TOKEN_SWAP", "EXCHANGE_TOKENS", "TRADE_TOKENS"],
};
