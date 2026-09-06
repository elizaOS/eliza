/** Shares the EVM and Solana provider implementations with login consumers. */
export type {
  CreateDefaultWagmiConfigOptions,
  DefaultWagmiChains,
  EVMWalletProviderProps,
} from "./EVMProvider.js";
export { createDefaultWagmiConfig, EVMWalletProvider } from "./EVMProvider.js";
export type { SolanaWalletProviderProps } from "./SolanaProvider.js";
export {
  createDefaultSolanaWallets,
  SolanaWalletProvider,
} from "./SolanaProvider.js";
