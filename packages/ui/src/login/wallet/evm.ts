/**
 * EVM-only wallet entry. Import this when your app only needs SIWE
 * (no Solana). Requires only EVM peer deps: wagmi, viem, RainbowKit,
 * @tanstack/react-query.
 *
 * Usage:
 *   import {
 *     EVMWalletProvider,
 *     WalletLogin,
 *     createDefaultWagmiConfig,
 *   } from "./evm";
 *
 * Note on `<WalletLogin>`: the component itself dynamic-imports its
 * EVM and Solana panels. When you only ship the EVM peer install,
 * always pass `chains="evm"` so the Solana panel loader is never
 * triggered. Some bundlers (notably webpack) eagerly create chunks
 * for the literal dynamic import path strings; see the README for
 * webpack/Vite optimization tips when building EVM-only.
 */

export type { LoginConnectOrCreateWalletProps } from "../components/LoginConnectOrCreateWallet.js";
export { LoginConnectOrCreateWallet } from "../components/LoginConnectOrCreateWallet.js";
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
} from "../providers/EVMProvider.js";
export {
  createDefaultWagmiConfig,
  EVMWalletProvider,
} from "../providers/EVMProvider.js";
