/**
 * Solana-only wallet entry. Import this when your app only needs SIWS
 * (no EVM). Requires only Solana peer deps:
 *   - @solana/wallet-adapter-react / -react-ui
 *   - @solana/web3.js, bs58
 *   - the curated default adapter subpackages (Phantom, Solflare,
 *     Coinbase, Trust, MathWallet, Coin98)
 *
 * Usage:
 *   import {
 *     SolanaWalletProvider,
 *     WalletLogin,
 *     createDefaultSolanaWallets,
 *   } from "./solana";
 *
 * Note on `<WalletLogin>`: always pass `chains="solana"` to ensure
 * the EVM panel loader is never triggered when you only ship the
 * Solana peer install. See README for bundler tips.
 */

export type { LoginConnectOrCreateWalletProps } from "../components/LoginConnectOrCreateWallet.js";
export { LoginConnectOrCreateWallet } from "../components/LoginConnectOrCreateWallet.js";
export type {
  WalletChains,
  WalletLoginClassOverrides,
  WalletLoginProps,
} from "../components/WalletLogin.js";
export { WalletLogin } from "../components/WalletLogin.js";
export type { SolanaWalletProviderProps } from "../providers/SolanaProvider.js";
export {
  createDefaultSolanaWallets,
  SolanaWalletProvider,
} from "../providers/SolanaProvider.js";
