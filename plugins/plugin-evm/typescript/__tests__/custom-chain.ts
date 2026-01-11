import { defineChain } from "viem";
import { arbitrumSepolia, baseSepolia, hardhat, optimismSepolia, sepolia } from "viem/chains";

// Export the actual testnets we'll use
export { sepolia, baseSepolia, optimismSepolia, arbitrumSepolia, hardhat };

// Local Anvil chain configuration
export const anvil = defineChain({
  id: 31337,
  name: "Anvil",
  nativeCurrency: {
    name: "Ether",
    symbol: "ETH",
    decimals: 18,
  },
  rpcUrls: {
    default: { http: ["http://127.0.0.1:8545"] },
    public: { http: ["http://127.0.0.1:8545"] },
  },
  testnet: true,
});

// Anvil test account (first account from mnemonic: test test test test test test test test test test test junk)
export const ANVIL_PRIVATE_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
export const ANVIL_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as const;

// Second anvil account (for transfer recipient)
export const ANVIL_PRIVATE_KEY_2 =
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
export const ANVIL_ADDRESS_2 = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as const;

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

// Helper to get test chains configuration (for remote testnets)
export const getTestChains = () => ({
  sepolia: sepolia,
  baseSepolia: baseSepolia,
  optimismSepolia: optimismSepolia,
  arbitrumSepolia: arbitrumSepolia,
});

// Helper to get local Anvil chain configuration
export const getAnvilChain = () => ({
  anvil: anvil,
});
