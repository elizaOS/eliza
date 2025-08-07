import { IAgentRuntime } from "@elizaos/core";
import { CalldataWithDescription } from "src/types/tx";
import { getToken, TokenEntry } from "../db";
import { encodeFunctionData, formatUnits } from "viem";
import { isHex } from "viem";
import { oasisTestnet } from "viem/chains";

interface WETHParams {
  chainId: number;
  tokenIn?: `0x${string}`;
  tokenOut?: `0x${string}`;
}

const abi = [
  {
    constant: false,
    inputs: [{ name: "wad", type: "uint256" }],
    name: "withdraw",
    outputs: [],
    payable: false,
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    constant: false,
    inputs: [],
    name: "deposit",
    outputs: [],
    payable: true,
    stateMutability: "payable",
    type: "function",
  },
] as const;

type IsNative = "in" | "out" | undefined;

interface WethHelper {
  side: IsNative;
  address: `0x${string}`;
  getCall: (amount: bigint) => CalldataWithDescription;
}

export function wrapEth(
  amount: bigint,
  weth?: Pick<TokenEntry, "address" | "decimals">
): CalldataWithDescription {
  if (!weth) {
    throw new Error("WETH token not found");
  }

  return {
    to: weth.address as `0x${string}`,
    data: encodeFunctionData({
      abi,
      functionName: "deposit",
      args: [],
    }),
    value: amount.toString(),
    title: `Wrap ${formatUnits(amount, weth.decimals)} ETH`,
    description: `Wrap ${formatUnits(amount, weth.decimals)} ETH to WETH`,
  };
}

export function unwrapEth(
  amount: bigint,
  weth?: Pick<TokenEntry, "address" | "decimals">
): CalldataWithDescription {
  if (!weth) {
    throw new Error("WETH token not found");
  }

  return {
    to: weth.address as `0x${string}`,
    data: encodeFunctionData({
      abi,
      functionName: "withdraw",
      args: [amount],
    }),
    title: `Unwrap ${formatUnits(amount, weth.decimals)} WETH`,
    description: `Unwrap ${formatUnits(amount, weth.decimals)} WETH to ETH`,
  };
}

export async function wethHelper(
  runtime: IAgentRuntime,
  params: WETHParams
): Promise<WethHelper | undefined> {
  const { chainId, tokenIn, tokenOut } = params;

  let isNative: IsNative = undefined;

  if (!tokenIn) {
    isNative = "in";
  }

  if (!tokenOut) {
    if (isNative) {
      throw new Error("Both tokens cannot be native");
    }

    isNative = "out";
  }

  if (!isNative) {
    return undefined;
  }

  const [token] = await getToken(runtime, { chainId, symbol: "WETH" });

  if (!isHex(token?.address)) {
    throw new Error(`WETH token on chain ${chainId} not found`);
  }

  if (isNative === "in") {
    // wrap eth
    const getCall = (amount: bigint) => wrapEth(amount, token);
    return { side: isNative, getCall, address: token.address };
  } else {
    // unwrap weth
    const getCall = (amount: bigint): CalldataWithDescription => ({
      ...unwrapEth(amount, token),
      optional: true,
    });

    return { side: isNative, getCall, address: token.address };
  }
}
