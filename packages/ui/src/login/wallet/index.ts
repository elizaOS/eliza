/** Exports the first-party login presentation surface. */
import {
  registerEvmWalletPanel,
  registerSolanaWalletPanel,
} from "../internal/walletPanelRegistry.js";

// Register lazy panels once for login forms imported from either UI barrel.
registerEvmWalletPanel({
  load: () =>
    import("../components/WalletLogin.EVM.js") as Promise<{
      default: import("react").ComponentType<unknown>;
    }>,
});
registerSolanaWalletPanel({
  load: () =>
    import("../components/WalletLogin.Solana.js") as Promise<{
      default: import("react").ComponentType<unknown>;
    }>,
});

export type { LoginConnectOrCreateWalletProps } from "../components/LoginConnectOrCreateWallet.js";
export { LoginConnectOrCreateWallet } from "../components/LoginConnectOrCreateWallet.js";
export type {
  LoginFormWithWalletsEvmConfig,
  LoginFormWithWalletsProps,
  LoginFormWithWalletsSolanaConfig,
} from "../components/LoginFormWithWallets.js";
export type {
  WalletChains,
  WalletLoginClassOverrides,
  WalletLoginProps,
} from "../components/WalletLogin.js";
export { WalletLogin } from "../components/WalletLogin.js";
export type {
  CreateDefaultWagmiConfigOptions,
  DefaultWagmiChains,
  EVMWalletProviderProps,
  SolanaWalletProviderProps,
} from "../providers/WalletProviders.js";
export {
  createDefaultWagmiConfig,
  EVMWalletProvider,
  LoginFormWithWallets,
  SolanaWalletProvider,
} from "./lazy-providers.js";
