/**
 * @module tokens/transfers
 * Multi-token transfer utilities for AgentWallet v6.
 *
 * Provides send/balance functions for any ERC-20 token or native gas token,
 * with flexible amount input (raw bigint or human-readable string).
 *
 * All transfer functions go through viem's wallet client — they do NOT
 * route through the AgentAccountV2 contract (use agentTransferToken for that).
 * These are direct EOA/smart-wallet operations for wallets that hold the key.
 */

import {
  type Address,
  type Chain,
  encodeFunctionData,
  type Hash,
  type PublicClient,
  parseAbi,
  type WalletClient,
  zeroAddress,
} from "viem";
import { formatBalance, parseAmount, toHuman } from "./decimals.js";
import { getGlobalRegistry } from "./registry.js";

// ─── ERC20 ABI (minimal) ─────────────────────────────────────────────────────

const ERC20_ABI = parseAbi([
  "function transfer(address to, uint256 amount) returns (bool)",
  "function balanceOf(address account) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function name() view returns (string)",
]);

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TransferOptions {
  /** Gas price override */
  gasPrice?: bigint;
  /** Max fee per gas (EIP-1559) */
  maxFeePerGas?: bigint;
  /** Max priority fee per gas (EIP-1559) */
  maxPriorityFeePerGas?: bigint;
  /** Gas limit override */
  gas?: bigint;
  /** Chain ID for multi-chain operations */
  chainId?: number;
}

export interface TokenBalanceResult {
  address: Address;
  symbol: string;
  name: string;
  decimals: number;
  rawBalance: bigint;
  humanBalance: string;
  formatted: string;
}

export interface NativeBalanceResult {
  symbol: string;
  decimals: number;
  rawBalance: bigint;
  humanBalance: string;
}

// ─── Transfer context ─────────────────────────────────────────────────────────

export interface TransferContext {
  publicClient: PublicClient;
  walletClient: WalletClient;
  /** Caller's address (used as from address) */
  account: Address;
  /** Chain ID for registry lookups */
  chainId?: number;
}

// ─── Core transfer functions ──────────────────────────────────────────────────

/**
 * Send any ERC-20 token.
 *
 * @param ctx - Public + wallet clients and account
 * @param to - Recipient address
 * @param amount - Amount as raw bigint OR human-readable string (requires tokenAddress decimals lookup)
 * @param tokenAddress - ERC-20 contract address
 * @param options - Optional gas overrides
 */
export async function sendToken(
  ctx: TransferContext,
  to: Address,
  amount: string | bigint,
  tokenAddress: Address,
  options: TransferOptions = {},
): Promise<Hash> {
  let rawAmount: bigint;

  if (typeof amount === "string") {
    // Need decimals to parse string amount
    let decimals: number;

    // Try registry first
    if (ctx.chainId != null) {
      const entry = getGlobalRegistry().getTokenByAddress(
        tokenAddress,
        ctx.chainId,
      );
      decimals =
        entry?.decimals ??
        (await fetchTokenDecimals(ctx.publicClient, tokenAddress));
    } else {
      decimals = await fetchTokenDecimals(ctx.publicClient, tokenAddress);
    }

    rawAmount = parseAmount(amount, decimals);
  } else {
    rawAmount = amount;
  }

  const data = encodeFunctionData({
    abi: ERC20_ABI,
    functionName: "transfer",
    args: [to, rawAmount],
  });

  return ctx.walletClient.sendTransaction({
    account: ctx.account,
    chain: requirePublicClientChain(ctx),
    to: tokenAddress,
    data,
    ...buildGasOptions(options),
  });
}

/**
 * Send native gas token (ETH, MATIC, AVAX, etc.).
 *
 * @param ctx - Transfer context
 * @param to - Recipient address
 * @param amount - Raw bigint OR human-readable string (18 decimals for ETH/MATIC/AVAX)
 * @param options - Optional gas overrides
 */
export async function sendNative(
  ctx: TransferContext,
  to: Address,
  amount: string | bigint,
  options: TransferOptions = {},
): Promise<Hash> {
  const rawAmount = parseAmount(amount, 18);

  return ctx.walletClient.sendTransaction({
    account: ctx.account,
    chain: requirePublicClientChain(ctx),
    to,
    value: rawAmount,
    ...buildGasOptions(options),
  });
}

/**
 * Get the ERC-20 balance of the current account (or a specified address).
 *
 * @param ctx - Transfer context
 * @param tokenAddress - ERC-20 contract address
 * @param holder - Address to check (defaults to ctx.account)
 */
export async function getTokenBalance(
  ctx: TransferContext,
  tokenAddress: Address,
  holder?: Address,
): Promise<TokenBalanceResult> {
  const target = holder ?? ctx.account;

  // Batch read: balanceOf + decimals + symbol + name
  const [rawBalance, decimals, symbol, name] = await Promise.all([
    ctx.publicClient.readContract({
      address: tokenAddress,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [target],
    }) as Promise<bigint>,
    ctx.publicClient.readContract({
      address: tokenAddress,
      abi: ERC20_ABI,
      functionName: "decimals",
    }) as Promise<number>,
    ctx.publicClient.readContract({
      address: tokenAddress,
      abi: ERC20_ABI,
      functionName: "symbol",
    }) as Promise<string>,
    ctx.publicClient.readContract({
      address: tokenAddress,
      abi: ERC20_ABI,
      functionName: "name",
    }) as Promise<string>,
  ]);

  const humanBalance = toHuman(rawBalance, decimals);
  const formatted = formatBalance(rawBalance, { symbol, decimals });

  return {
    address: tokenAddress,
    symbol,
    name,
    decimals,
    rawBalance,
    humanBalance,
    formatted,
  };
}

/**
 * Get the native gas token balance of the current account (or a specified address).
 *
 * @param ctx - Transfer context
 * @param holder - Address to check (defaults to ctx.account)
 */
export async function getNativeBalance(
  ctx: TransferContext,
  holder?: Address,
): Promise<NativeBalanceResult> {
  const target = holder ?? ctx.account;
  const rawBalance = await ctx.publicClient.getBalance({ address: target });

  // Determine native token symbol from registry if chainId is known
  let symbol = "ETH";
  if (ctx.chainId != null) {
    const native = getGlobalRegistry().getTokenByAddress(
      zeroAddress,
      ctx.chainId,
    );
    symbol = native?.symbol ?? "ETH";
  }

  const humanBalance = toHuman(rawBalance, 18);

  return { symbol, decimals: 18, rawBalance, humanBalance };
}

/**
 * Batch query balances for multiple ERC-20 tokens.
 *
 * @param ctx - Transfer context
 * @param tokenAddresses - List of ERC-20 addresses to query (or null/empty for all registry tokens)
 * @param holder - Address to check (defaults to ctx.account)
 */
export async function getBalances(
  ctx: TransferContext,
  tokenAddresses?: Address[],
  holder?: Address,
): Promise<TokenBalanceResult[]> {
  const target = holder ?? ctx.account;

  let addresses = tokenAddresses;

  // If no addresses provided and chainId is known, use all registry tokens
  if (!addresses || addresses.length === 0) {
    if (ctx.chainId != null) {
      const tokens = getGlobalRegistry().listTokens(ctx.chainId);
      addresses = tokens.filter((t) => !t.isNative).map((t) => t.address);
    } else {
      return [];
    }
  }

  // Parallel balance fetches
  const results = await Promise.allSettled(
    addresses.map((addr) => getTokenBalance(ctx, addr, target)),
  );

  return results
    .filter(
      (r): r is PromiseFulfilledResult<TokenBalanceResult> =>
        r.status === "fulfilled",
    )
    .map((r) => r.value);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function fetchTokenDecimals(
  publicClient: PublicClient,
  tokenAddress: Address,
): Promise<number> {
  return publicClient.readContract({
    address: tokenAddress,
    abi: ERC20_ABI,
    functionName: "decimals",
  }) as Promise<number>;
}

function buildGasOptions(options: TransferOptions) {
  const gas: Record<string, bigint> = {};
  if (options.gas != null) gas.gas = options.gas;
  if (options.gasPrice != null) gas.gasPrice = options.gasPrice;
  if (options.maxFeePerGas != null) gas.maxFeePerGas = options.maxFeePerGas;
  if (options.maxPriorityFeePerGas != null)
    gas.maxPriorityFeePerGas = options.maxPriorityFeePerGas;
  return gas;
}

function requirePublicClientChain(ctx: TransferContext): Chain {
  const chain = ctx.publicClient.chain;
  if (!chain) {
    throw new Error(
      "TransferContext.publicClient must be created with chain (required for walletClient.sendTransaction).",
    );
  }
  return chain;
}

/**
 * Encode an ERC-20 transfer call as raw calldata.
 * Useful for building calldata for agentExecute() or multicall.
 */
export function encodeERC20Transfer(
  to: Address,
  amount: bigint,
): `0x${string}` {
  return encodeFunctionData({
    abi: ERC20_ABI,
    functionName: "transfer",
    args: [to, amount],
  });
}
