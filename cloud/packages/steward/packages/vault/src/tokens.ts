/**
 * Common ERC-20 token addresses per chain, plus helpers for querying token balances.
 */

import { type Chain, createPublicClient, formatUnits, http } from "viem";
import { arbitrum, base, baseSepolia, bsc, mainnet, polygon } from "viem/chains";

// ─── ERC-20 ABI (minimal for balance queries) ────────────────────────────────

export const ERC20_ABI = [
  {
    inputs: [{ name: "account", type: "address" }],
    name: "balanceOf",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "decimals",
    outputs: [{ name: "", type: "uint8" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "symbol",
    outputs: [{ name: "", type: "string" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

// ─── Token definition ─────────────────────────────────────────────────────────

export interface TokenDef {
  address: string;
  symbol: string;
  decimals: number;
}

export interface TokenBalance {
  token: string; // contract address
  symbol: string;
  balance: string; // raw wei/unit string
  formatted: string; // human-readable
  decimals: number;
}

// ─── Common tokens per chain ──────────────────────────────────────────────────

export const COMMON_TOKENS: Record<number, TokenDef[]> = {
  // Ethereum mainnet
  1: [
    {
      address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      symbol: "USDC",
      decimals: 6,
    },
    {
      address: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
      symbol: "USDT",
      decimals: 6,
    },
    {
      address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
      symbol: "WETH",
      decimals: 18,
    },
    {
      address: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
      symbol: "DAI",
      decimals: 18,
    },
  ],
  // BSC
  56: [
    {
      address: "0x55d398326f99059fF775485246999027B3197955",
      symbol: "USDT",
      decimals: 18,
    },
    {
      address: "0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56",
      symbol: "BUSD",
      decimals: 18,
    },
    {
      address: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
      symbol: "WBNB",
      decimals: 18,
    },
  ],
  // Base
  8453: [
    {
      address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      symbol: "USDC",
      decimals: 6,
    },
    {
      address: "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA",
      symbol: "USDbC",
      decimals: 6,
    },
    {
      address: "0x4200000000000000000000000000000000000006",
      symbol: "WETH",
      decimals: 18,
    },
  ],
  // Polygon
  137: [
    {
      address: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
      symbol: "USDC",
      decimals: 6,
    },
    {
      address: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
      symbol: "USDT",
      decimals: 6,
    },
    {
      address: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619",
      symbol: "WETH",
      decimals: 18,
    },
  ],
  // Arbitrum
  42161: [
    {
      address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
      symbol: "USDC",
      decimals: 6,
    },
    {
      address: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9",
      symbol: "USDT",
      decimals: 6,
    },
    {
      address: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
      symbol: "WETH",
      decimals: 18,
    },
  ],
};

// ─── Chain registry (mirrored from vault.ts for independence) ─────────────────

const CHAINS: Record<number, Chain> = {
  1: mainnet,
  56: bsc,
  137: polygon,
  8453: base,
  42161: arbitrum,
  84532: baseSepolia,
};

const CHAIN_RPCS: Record<number, string> = {
  1: "https://eth.llamarpc.com",
  56: "https://bsc-dataseed.binance.org",
  137: "https://polygon-rpc.com",
  8453: "https://mainnet.base.org",
  42161: "https://arb1.arbitrum.io/rpc",
  84532: "https://sepolia.base.org",
};

// ─── Token balance query ──────────────────────────────────────────────────────

/**
 * Fetch ERC-20 token balances for a wallet address on a given chain.
 *
 * @param address  - The wallet address (0x...)
 * @param chainId  - Numeric EVM chain ID
 * @param tokens   - Optional array of token contract addresses. If omitted,
 *                   uses COMMON_TOKENS for the chain (if available).
 * @param rpcUrl   - Optional RPC URL override.
 * @returns Array of token balances.
 */
export async function getTokenBalances(
  address: string,
  chainId: number,
  tokens?: string[],
  rpcUrl?: string,
): Promise<TokenBalance[]> {
  const chain = CHAINS[chainId];
  if (!chain) {
    throw new Error(`Unsupported EVM chain for token queries: ${chainId}`);
  }

  const resolvedRpc = rpcUrl || CHAIN_RPCS[chainId];
  if (!resolvedRpc) {
    throw new Error(`No RPC URL for chain ${chainId}`);
  }

  const publicClient = createPublicClient({
    chain,
    transport: http(resolvedRpc),
  });

  // Resolve token list: custom addresses or common tokens
  let tokenDefs: TokenDef[];

  if (tokens && tokens.length > 0) {
    // For custom token addresses, we need to query symbol + decimals on-chain
    tokenDefs = await Promise.all(
      tokens.map(async (tokenAddress) => {
        try {
          const [symbol, decimals] = await Promise.all([
            publicClient.readContract({
              address: tokenAddress as `0x${string}`,
              abi: ERC20_ABI,
              functionName: "symbol",
            }),
            publicClient.readContract({
              address: tokenAddress as `0x${string}`,
              abi: ERC20_ABI,
              functionName: "decimals",
            }),
          ]);
          return {
            address: tokenAddress,
            symbol: symbol as string,
            decimals: Number(decimals),
          };
        } catch {
          // If we can't read metadata, return with unknown
          return { address: tokenAddress, symbol: "UNKNOWN", decimals: 18 };
        }
      }),
    );
  } else {
    tokenDefs = COMMON_TOKENS[chainId] ?? [];
  }

  if (tokenDefs.length === 0) {
    return [];
  }

  // Batch all balanceOf calls
  const results = await Promise.allSettled(
    tokenDefs.map(async (token) => {
      const balance = await publicClient.readContract({
        address: token.address as `0x${string}`,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [address as `0x${string}`],
      });
      return {
        token: token.address,
        symbol: token.symbol,
        balance: (balance as bigint).toString(),
        formatted: formatUnits(balance as bigint, token.decimals),
        decimals: token.decimals,
      };
    }),
  );

  return results
    .filter((r): r is PromiseFulfilledResult<TokenBalance> => r.status === "fulfilled")
    .map((r) => r.value);
}
