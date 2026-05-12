/**
 * @module swap/SwapModule
 * SwapModule — multi-chain Uniswap V3 token swap aggregator with 0.875% protocol fee.
 *
 * Supports Base, Arbitrum, Optimism, and Polygon. Automatically selects the best
 * Uniswap V3 fee tier (0.01%, 0.05%, 0.3%, 1%) by quoting all tiers and choosing
 * the highest output. Applies slippage protection and an optional protocol fee.
 *
 * Usage: construct with `chain` param or use `attachSwap(wallet, { chain: 'arbitrum' })`.
 */
// SwapModule — Uniswap V3 token swap aggregator with 0.875% protocol fee
import {
  type Address,
  encodeFunctionData,
  type Hash,
  type PublicClient,
  type WalletClient,
} from "viem";
import { ERC20Abi, UniswapV3QuoterV2Abi, UniswapV3RouterAbi } from "./abi.js";
import {
  DEFAULT_SLIPPAGE_BPS,
  PROTOCOL_FEE_BPS,
  PROTOCOL_FEE_COLLECTOR,
  type SwapChain,
  type SwapModuleConfig,
  type SwapOptions,
  type SwapQuote,
  type SwapResult,
  UNISWAP_V3_ADDRESSES,
  type UniswapFeeTier,
} from "./types.js";

const FEE_TIERS: UniswapFeeTier[] = [100, 500, 3000, 10000];

/** Calculate protocol fee: floor(amount * feeBps / 100_000) */
export function calcProtocolFee(amount: bigint, feeBps: number): bigint {
  return (amount * BigInt(feeBps)) / 100000n;
}

/** Apply slippage: floor(amount * (10_000 - slippageBps) / 10_000) */
export function applySlippage(amount: bigint, slippageBps: number): bigint {
  return (amount * BigInt(10000 - slippageBps)) / 10000n;
}

/** Encode deadline: block.timestamp + deadlineSecs */
export function calcDeadline(deadlineSecs: number): bigint {
  return BigInt(Math.floor(Date.now() / 1000) + deadlineSecs);
}

export class SwapModule {
  private readonly publicClient: PublicClient;
  private readonly walletClient: WalletClient;
  private readonly accountAddress: Address;
  private readonly config: SwapModuleConfig;

  constructor(
    publicClient: PublicClient,
    walletClient: WalletClient,
    accountAddress: Address,
    config?: Partial<SwapModuleConfig> & { chain?: SwapChain },
  ) {
    this.publicClient = publicClient;
    this.walletClient = walletClient;
    this.accountAddress = accountAddress;
    const chain: SwapChain = config?.chain ?? "base";
    const chainAddresses = UNISWAP_V3_ADDRESSES[chain];
    this.config = {
      routerAddress: chainAddresses.ROUTER,
      quoterAddress: chainAddresses.QUOTER_V2,
      feeBps: PROTOCOL_FEE_BPS,
      feeWallet: PROTOCOL_FEE_COLLECTOR,
      chain,
      ...config,
      // Re-apply chain-derived addresses if chain was specified but addresses were not
      ...(config?.routerAddress
        ? {}
        : { routerAddress: chainAddresses.ROUTER }),
      ...(config?.quoterAddress
        ? {}
        : { quoterAddress: chainAddresses.QUOTER_V2 }),
    };
  }

  async getQuote(
    tokenIn: Address,
    tokenOut: Address,
    amountIn: bigint,
    options: Pick<SwapOptions, "slippageBps" | "feeTiers"> = {},
  ): Promise<SwapQuote> {
    const slippageBps = options.slippageBps ?? DEFAULT_SLIPPAGE_BPS;
    const tiersToTry = options.feeTiers ?? FEE_TIERS;
    const feeAmount = calcProtocolFee(amountIn, this.config.feeBps);
    const amountInNet = amountIn - feeAmount;
    if (amountInNet <= 0n) {
      throw new Error(
        `SwapModule: amountIn (${amountIn}) is too small — fee (${feeAmount}) exceeds input`,
      );
    }

    let bestQuote: {
      amountOut: bigint;
      gasEstimate: bigint;
      feeTier: UniswapFeeTier;
    } | null = null;
    for (const fee of tiersToTry) {
      try {
        const result = await this.publicClient.readContract({
          address: this.config.quoterAddress,
          abi: UniswapV3QuoterV2Abi,
          functionName: "quoteExactInputSingle",
          args: [
            {
              tokenIn,
              tokenOut,
              amount: amountInNet,
              fee,
              sqrtPriceLimitX96: 0n,
            },
          ],
        });
        const [amountOut, , , gasEstimate] = result as [
          bigint,
          bigint,
          number,
          bigint,
        ];
        if (!bestQuote || amountOut > bestQuote.amountOut) {
          bestQuote = {
            amountOut,
            gasEstimate,
            feeTier: fee as UniswapFeeTier,
          };
        }
      } catch {
        // Pool doesn't exist for this fee tier
      }
    }

    if (!bestQuote) {
      throw new Error(
        `SwapModule: No Uniswap V3 pool found for ${tokenIn} → ${tokenOut} on ${this.config.chain}.`,
      );
    }

    const amountOutMinimum = applySlippage(bestQuote.amountOut, slippageBps);
    const effectiveRate =
      amountInNet > 0n ? Number(bestQuote.amountOut) / Number(amountInNet) : 0;

    return {
      tokenIn,
      tokenOut,
      amountInRaw: amountIn,
      amountInNet,
      feeAmount,
      amountOut: bestQuote.amountOut,
      amountOutMinimum,
      poolFeeTier: bestQuote.feeTier,
      effectiveRate,
      gasEstimate: bestQuote.gasEstimate,
    };
  }

  async ensureApproval(
    token: Address,
    spender: Address,
    amount: bigint,
  ): Promise<Hash | undefined> {
    const currentAllowance = (await this.publicClient.readContract({
      address: token,
      abi: ERC20Abi,
      functionName: "allowance",
      args: [this.accountAddress, spender],
    })) as bigint;

    if (currentAllowance >= amount) return undefined;

    const MAX_UINT256 =
      115792089237316195423570985008687907853269984665640564039457584007913129639935n;
    const account = this.walletClient.account;
    if (!account) throw new Error("SwapModule: walletClient has no account");

    const approveData = encodeFunctionData({
      abi: ERC20Abi,
      functionName: "approve",
      args: [spender, MAX_UINT256],
    });

    return this.walletClient.sendTransaction({
      account,
      to: token,
      data: approveData,
      chain: this.walletClient.chain ?? null,
    });
  }

  private async transferFee(
    token: Address,
    feeAmount: bigint,
    feeWallet: Address,
  ): Promise<Hash> {
    const account = this.walletClient.account;
    if (!account) throw new Error("SwapModule: walletClient has no account");

    const transferData = encodeFunctionData({
      abi: ERC20Abi,
      functionName: "transfer",
      args: [feeWallet, feeAmount],
    });

    return this.walletClient.sendTransaction({
      account,
      to: token,
      data: transferData,
      chain: this.walletClient.chain ?? null,
    });
  }

  async swap(
    tokenIn: Address,
    tokenOut: Address,
    amountIn: bigint,
    options: SwapOptions = {},
  ): Promise<SwapResult> {
    const slippageBps = options.slippageBps ?? DEFAULT_SLIPPAGE_BPS;
    const deadlineSecs = options.deadlineSecs ?? 300;
    const feeWallet = options.feeWallet ?? this.config.feeWallet;

    const quote = await this.getQuote(tokenIn, tokenOut, amountIn, {
      slippageBps,
      feeTiers: options.feeTiers,
    });

    if (quote.gasEstimate > 2000000n) {
      console.warn(
        `SwapModule: High gas estimate (${quote.gasEstimate}). Pool may be illiquid.`,
      );
    }

    const approvalTxHash = await this.ensureApproval(
      tokenIn,
      this.config.routerAddress,
      amountIn,
    );
    const approvalRequired = approvalTxHash !== undefined;

    let feeTxHash: Hash | undefined;
    if (quote.feeAmount > 0n && feeWallet !== this.accountAddress) {
      feeTxHash = await this.transferFee(tokenIn, quote.feeAmount, feeWallet);
    }

    const account = this.walletClient.account;
    if (!account) throw new Error("SwapModule: walletClient has no account");

    const _deadline = calcDeadline(deadlineSecs); // reserved for future router versions
    const swapData = encodeFunctionData({
      abi: UniswapV3RouterAbi,
      functionName: "exactInputSingle",
      args: [
        {
          tokenIn,
          tokenOut,
          fee: quote.poolFeeTier,
          recipient: this.accountAddress,
          amountIn: quote.amountInNet,
          amountOutMinimum: quote.amountOutMinimum,
          sqrtPriceLimitX96: 0n,
        },
      ],
    });

    const txHash = await this.walletClient.sendTransaction({
      account,
      to: this.config.routerAddress,
      data: swapData,
      chain: this.walletClient.chain ?? null,
    });

    return { txHash, feeTxHash, quote, approvalRequired, approvalTxHash };
  }

  getConfig(): SwapModuleConfig {
    return { ...this.config };
  }

  setFeeWallet(address: Address): void {
    this.config.feeWallet = address;
  }
}

export function attachSwap(
  wallet: {
    address: Address;
    publicClient: PublicClient;
    walletClient: WalletClient;
  },
  config?: Partial<SwapModuleConfig> & { chain?: SwapChain },
) {
  const swapModule = new SwapModule(
    wallet.publicClient,
    wallet.walletClient,
    wallet.address,
    config,
  );
  return {
    ...wallet,
    swapModule,
    swap: swapModule.swap.bind(swapModule),
    getQuote: swapModule.getQuote.bind(swapModule),
  };
}
