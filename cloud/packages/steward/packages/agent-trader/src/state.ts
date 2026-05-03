/**
 * Agent state resolver.
 *
 * Gathers the current on-chain + off-chain state needed by strategies:
 *   - Native balance (ETH/BNB)     ← viem publicClient
 *   - Token balance (ERC-20)       ← viem publicClient
 *   - Token price                  ← price oracle or DEX reserve ratio
 *   - Last trade age + daily vol   ← Steward history
 *
 * Token price resolution order:
 *   1. priceOracleUrl env var (simple JSON API returning { price: "1234" })
 *   2. DEX reserve ratio (reads getReserves on a Uniswap V2-style pair)
 *   3. Fallback: 0n (strategies should handle this gracefully)
 */

import type { StewardClient } from "@stwd/sdk";
import type { PublicClient } from "viem";
import { createPublicClient, http } from "viem";
import { base } from "viem/chains";
import type { AgentTraderConfig } from "./config.js";
import { logWarn } from "./logger.js";
import type { AgentState } from "./strategies/types.js";

// ─── Minimal ABIs ─────────────────────────────────────────────────────────────

const ERC20_BALANCE_ABI = [
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

const UNISWAP_V2_PAIR_ABI = [
  {
    name: "getReserves",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "reserve0", type: "uint112" },
      { name: "reserve1", type: "uint112" },
      { name: "blockTimestampLast", type: "uint32" },
    ],
  },
  {
    name: "token0",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
] as const;

// ─── Client cache ────────────────────────────────────────────────────────────

const clientCache = new Map<number, PublicClient>();

function getPublicClient(chainId: number): PublicClient {
  const cachedClient = clientCache.get(chainId);
  if (cachedClient) return cachedClient;

  const rpcUrl =
    process.env[`RPC_URL_${chainId}`] ??
    process.env.RPC_URL ??
    (chainId === 8453 ? "https://mainnet.base.org" : undefined);

  const client = createPublicClient({
    chain: chainId === 8453 ? base : ({ id: chainId } as unknown as typeof base),
    transport: http(rpcUrl),
  }) as unknown as PublicClient;

  clientCache.set(chainId, client);
  return client;
}

// ─── Balances ────────────────────────────────────────────────────────────────

async function getNativeBalance(walletAddress: string, chainId: number): Promise<bigint> {
  const client = getPublicClient(chainId);
  return client.getBalance({ address: walletAddress as `0x${string}` });
}

async function getTokenBalance(
  walletAddress: string,
  tokenAddress: string,
  chainId: number,
): Promise<bigint> {
  const client = getPublicClient(chainId);
  return client.readContract({
    address: tokenAddress as `0x${string}`,
    abi: ERC20_BALANCE_ABI,
    functionName: "balanceOf",
    args: [walletAddress as `0x${string}`],
  });
}

// ─── Token price ──────────────────────────────────────────────────────────────

async function getTokenPrice(tokenAddress: string, chainId: number): Promise<bigint> {
  // 1. External price oracle (env: PRICE_ORACLE_URL or per-token override)
  const oracleUrl =
    process.env[`PRICE_ORACLE_${tokenAddress.toLowerCase()}`] ?? process.env.PRICE_ORACLE_URL;

  if (oracleUrl) {
    try {
      const url = oracleUrl.replace("{token}", tokenAddress);
      const resp = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (resp.ok) {
        const json = (await resp.json()) as { price?: string };
        if (json.price) return BigInt(json.price);
      }
    } catch {
      logWarn("Price oracle request failed, falling back to DEX reserves", {
        tokenAddress,
      });
    }
  }

  // 2. DEX pair reserve ratio
  const pairAddress =
    process.env[`DEX_PAIR_${tokenAddress.toLowerCase()}`] ?? process.env.DEX_PAIR_ADDRESS;

  if (pairAddress) {
    try {
      const client = getPublicClient(chainId);
      const [token0, reserves] = await Promise.all([
        client.readContract({
          address: pairAddress as `0x${string}`,
          abi: UNISWAP_V2_PAIR_ABI,
          functionName: "token0",
        }),
        client.readContract({
          address: pairAddress as `0x${string}`,
          abi: UNISWAP_V2_PAIR_ABI,
          functionName: "getReserves",
        }),
      ]);

      const [reserve0, reserve1] = reserves;
      const isToken0 = token0.toLowerCase() === tokenAddress.toLowerCase();

      // price = nativeReserve / tokenReserve  (scaled to 1e18)
      const tokenReserve = isToken0 ? reserve0 : reserve1;
      const nativeReserve = isToken0 ? reserve1 : reserve0;

      if (tokenReserve > 0n) {
        return (BigInt(nativeReserve) * BigInt(1e18)) / BigInt(tokenReserve);
      }
    } catch (err) {
      logWarn("DEX reserve price lookup failed", {
        tokenAddress,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // 3. Fallback — strategies must handle tokenPrice === 0n
  logWarn("Could not determine token price — returning 0", { tokenAddress });
  return 0n;
}

// ─── Steward history helpers ──────────────────────────────────────────────────

function secondsSinceLastTrade(history: Array<{ timestamp: number; value: string }>): number {
  if (history.length === 0) return Infinity;
  const latestTs = Math.max(...history.map((h) => h.timestamp));
  return Math.floor(Date.now() / 1000) - latestTs;
}

function dailyVolume(history: Array<{ timestamp: number; value: string }>): bigint {
  const cutoff = Math.floor(Date.now() / 1000) - 86400;
  return history.filter((h) => h.timestamp >= cutoff).reduce((acc, h) => acc + BigInt(h.value), 0n);
}

// ─── Main export ──────────────────────────────────────────────────────────────

export async function fetchAgentState(
  agentConfig: AgentTraderConfig,
  walletAddress: string,
  steward: StewardClient,
): Promise<AgentState> {
  const chainId = agentConfig.chainId ?? 8453;

  const [nativeBalance, tokenBalance, tokenPrice, history] = await Promise.all([
    getNativeBalance(walletAddress, chainId).catch((err) => {
      logWarn("Failed to fetch native balance", {
        agentId: agentConfig.agentId,
        error: String(err),
      });
      return 0n;
    }),
    getTokenBalance(walletAddress, agentConfig.tokenAddress, chainId).catch((err) => {
      logWarn("Failed to fetch token balance", {
        agentId: agentConfig.agentId,
        error: String(err),
      });
      return 0n;
    }),
    getTokenPrice(agentConfig.tokenAddress, chainId).catch((err) => {
      logWarn("Failed to fetch token price", {
        agentId: agentConfig.agentId,
        error: String(err),
      });
      return 0n;
    }),
    steward.getHistory(agentConfig.agentId).catch((err) => {
      logWarn("Failed to fetch Steward history", {
        agentId: agentConfig.agentId,
        error: String(err),
      });
      return [];
    }),
  ]);

  const tokenValueInNative = tokenPrice > 0n ? (tokenBalance * tokenPrice) / BigInt(1e18) : 0n;
  const treasuryValue = nativeBalance + tokenValueInNative;

  return {
    nativeBalance,
    tokenBalance,
    tokenPrice,
    lastTradeAge: secondsSinceLastTrade(history),
    dailyVolume: dailyVolume(history),
    treasuryValue,
  };
}
