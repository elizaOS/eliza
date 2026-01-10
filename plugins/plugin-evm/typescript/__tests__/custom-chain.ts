import { defineChain } from "viem";
import {
  arbitrumSepolia,
  baseSepolia,
  optimismSepolia,
  sepolia,
} from "viem/chains";

// Export the actual testnets we'll use
export { sepolia, baseSepolia, optimismSepolia, arbitrumSepolia };

// Custom testnet configurations if needed
export const customTestChain = defineChain({
  id: 421614, // Arbitrum Sepolia
  name: "Arbitrum Sepolia",
  nativeCurrency: {
    name: "Sepolia Ether",
    symbol: "ETH",
    decimals: 18,
  },
  rpcUrls: {
    default: { http: ["https://sepolia-rollup.arbitrum.io/rpc"] },
    public: { http: ["https://sepolia-rollup.arbitrum.io/rpc"] },
  },
  blockExplorers: {
    default: { name: "Arbiscan Sepolia", url: "https://sepolia.arbiscan.io" },
  },
  testnet: true,
});

// Helper to get test chains configuration
export const getTestChains = () => ({
  sepolia: sepolia,
  baseSepolia: baseSepolia,
  optimismSepolia: optimismSepolia,
  arbitrumSepolia: arbitrumSepolia,
});
