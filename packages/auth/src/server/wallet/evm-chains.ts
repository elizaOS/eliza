import type { Chain } from "viem";
import {
  arbitrum,
  base,
  baseSepolia,
  bsc,
  bscTestnet,
  gnosis,
  mainnet,
  polygon,
} from "viem/chains";

export const EVM_CHAINS: Record<number, Chain> = {
  1: mainnet, // Ethereum
  56: bsc, // BSC
  97: bscTestnet, // BSC Testnet
  100: gnosis, // Gnosis
  137: polygon, // Polygon
  8453: base, // Base
  42161: arbitrum, // Arbitrum
  84532: baseSepolia, // Base Sepolia
};

// Default public RPC URLs per EVM chain (override with env / VaultConfig.rpcUrl for the active chain)
export const EVM_CHAIN_RPCS: Record<number, string> = {
  1: "https://eth.llamarpc.com",
  56: "https://bsc-dataseed.binance.org",
  97: "https://data-seed-prebsc-1-s1.bnbchain.org:8545",
  100: "https://rpc.gnosischain.com",
  137: "https://polygon-rpc.com",
  8453: "https://mainnet.base.org",
  42161: "https://arb1.arbitrum.io/rpc",
  84532: "https://sepolia.base.org",
};
