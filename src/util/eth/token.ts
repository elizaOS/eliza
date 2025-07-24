import { erc20Abi, getAddress, isHex } from "viem";
import type { TokenData, TokenInfo } from "../../types/token";
import { getChain, getClient } from "./client";
import { ETH_NULL_ADDR } from "src/constants/eth";

export const getBalanceOf = async (
  chainId: number,
  address: `0x${string}`,
  token?: `0x${string}`
) => {
  const chain = getChain(chainId);
  const client = getClient(chain);

  if (token && token !== ETH_NULL_ADDR) {
    return client.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [address],
    });
  }

  return client.getBalance({
    address,
  });
};

export const getTokenData = async (
  chainId?: number,
  address?: `0x${string}`
): Promise<TokenData> => {
  const chain = getChain(chainId);

  if (!address || address === ETH_NULL_ADDR) {
    const { name, symbol, decimals } = chain.nativeCurrency;
    return { name, symbol, decimals };
  }

  const client = getClient(chain);

  const [name, symbol, decimals] = await Promise.all([
    client.readContract({
      address,
      abi: erc20Abi,
      functionName: "name",
    }),
    client.readContract({
      address,
      abi: erc20Abi,
      functionName: "symbol",
    }),
    client.readContract({
      address,
      abi: erc20Abi,
      functionName: "decimals",
    }),
  ]);

  return { address: getAddress(address), name, symbol, decimals };
};

export const extractTokenData = (
  obj?: Record<string, unknown>
): TokenData | undefined => {
  const { address, decimals, symbol, name } = obj ?? {};

  if (address && !isHex(address)) {
    return;
  }

  if (typeof symbol !== "string") {
    return;
  }

  if (typeof name !== "string") {
    return;
  }

  if (typeof decimals !== "number") {
    return;
  }

  return {
    address: address as `0x${string}`,
    decimals,
    symbol,
    name,
  };
};

export const parseTokenInfo = (info?: unknown): TokenInfo => {
  const tokenInfo: TokenInfo = {};

  if (!info || typeof info !== "object") {
    return tokenInfo;
  }

  // fixme validate with zod
  if ("swap" in info) {
    const swap: TokenInfo["swap"] = info.swap as any;
    tokenInfo.swap = swap;
  }

  if ("allowanceSlot" in info && isHex(info.allowanceSlot)) {
    tokenInfo.allowanceSlot = info.allowanceSlot;
  }

  return tokenInfo;
};
