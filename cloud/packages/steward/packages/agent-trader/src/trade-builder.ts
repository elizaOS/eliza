/**
 * Transaction builder.
 *
 * Produces a raw transaction object (to / value / data / chainId) that can be
 * handed directly to StewardClient.signTransaction().
 *
 * Two build paths:
 *   1. buildNativeTransfer  — simple ETH/BNB send
 *   2. buildSwapTx          — DEX swap using a Uniswap V2-compatible portal
 *
 * The portal ABI targets a single `swapExactInput` entry point.  Waifu.fun
 * portals are expected to implement the same interface.
 */

import type { SignTransactionInput } from "@stwd/sdk";
import { encodeFunctionData } from "viem";

// ─── Portal ABI ───────────────────────────────────────────────────────────────

/**
 * Simplified portal ABI.  The portal receives ETH (via msg.value) for buys and
 * token allowance for sells, then routes through the underlying DEX.
 *
 * function swapExactInput(
 *   address tokenIn,
 *   address tokenOut,
 *   uint256 amountIn,
 *   uint256 amountOutMin,
 *   address recipient
 * ) external payable returns (uint256 amountOut)
 */
export const PORTAL_ABI = [
  {
    name: "swapExactInput",
    type: "function",
    stateMutability: "payable",
    inputs: [
      { name: "tokenIn", type: "address" },
      { name: "tokenOut", type: "address" },
      { name: "amountIn", type: "uint256" },
      { name: "amountOutMin", type: "uint256" },
      { name: "recipient", type: "address" },
    ],
    outputs: [{ name: "amountOut", type: "uint256" }],
  },
] as const;

// Sentinel used when the input currency is native (ETH/BNB)
export const NATIVE_TOKEN_ADDRESS = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE" as const;

// ─── Built transaction type ────────────────────────────────────────────────────

export interface BuiltTx {
  to: string;
  /** Native value attached (wei) */
  value: string;
  /** Hex-encoded calldata, or "0x" for pure transfers */
  data: string;
  chainId: number;
}

// ─── Builders ─────────────────────────────────────────────────────────────────

export function buildNativeTransfer(to: string, amountWei: string, chainId: number): BuiltTx {
  return {
    to,
    value: amountWei,
    data: "0x",
    chainId,
  };
}

/**
 * Build a swap transaction through a Uniswap V2-compatible portal.
 *
 * @param side          "buy"  → spend native, receive token
 *                      "sell" → spend token, receive native
 * @param tokenAddress  ERC-20 address of the agent token
 * @param amount        For buy: native wei to spend.
 *                      For sell: token-unit amount to sell.
 * @param portalAddress DEX portal / router address
 * @param recipient     Address to receive the output tokens (usually the agent wallet)
 * @param chainId       Chain to submit on
 * @param slippageBps   Acceptable slippage in basis points (default 100 = 1%)
 */
export function buildSwapTx(
  side: "buy" | "sell",
  tokenAddress: string,
  amount: string,
  portalAddress: string,
  recipient: string,
  chainId: number,
  slippageBps = 100,
): BuiltTx {
  const amountBig = BigInt(amount);

  // amountOutMin = 0 means accept any output; real integrations should use an
  // oracle for minOut.  slippageBps is here for future use.
  const amountOutMin = 0n;
  void slippageBps; // future: amountOut * (10000 - slippageBps) / 10000

  let tokenIn: string;
  let tokenOut: string;
  let nativeValue: string;

  if (side === "buy") {
    // Native → token
    tokenIn = NATIVE_TOKEN_ADDRESS;
    tokenOut = tokenAddress;
    nativeValue = amount; // attach ETH as msg.value
  } else {
    // Token → native
    tokenIn = tokenAddress;
    tokenOut = NATIVE_TOKEN_ADDRESS;
    nativeValue = "0"; // no native attached; portal pulls token via transferFrom
  }

  const data = encodeFunctionData({
    abi: PORTAL_ABI,
    functionName: "swapExactInput",
    args: [
      tokenIn as `0x${string}`,
      tokenOut as `0x${string}`,
      amountBig,
      amountOutMin,
      recipient as `0x${string}`,
    ],
  });

  return {
    to: portalAddress,
    value: nativeValue,
    data,
    chainId,
  };
}

/**
 * Convenience: produce a SignTransactionInput from a BuiltTx.
 */
export function toSignInput(tx: BuiltTx): SignTransactionInput {
  return {
    to: tx.to,
    value: tx.value,
    data: tx.data !== "0x" ? tx.data : undefined,
    chainId: tx.chainId,
  };
}
