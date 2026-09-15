/**
 * Solana wallet provider.
 *
 * This file contains ONLY Solana peer-dep imports. It does not reference
 * any EVM peer (wagmi, RainbowKit, viem, TanStack Query). Apps that only
 * want Solana can import from `@elizaos/ui` and skip the
 * EVM peer install entirely.
 *
 * Each Solana adapter is imported from its own subpackage rather than
 * the `@solana/wallet-adapter-wallets` barrel because the barrel
 * re-exports every adapter (including hardware ones that fail Node ESM
 * resolution via `@ledgerhq/errors`). Importing subpackages directly
 * keeps the SSR import path clean.
 */

import { Coin98WalletAdapter } from "@solana/wallet-adapter-coin98";
import { CoinbaseWalletAdapter } from "@solana/wallet-adapter-coinbase";
import { PhantomWalletAdapter } from "@solana/wallet-adapter-phantom";
import {
  ConnectionProvider,
  WalletProvider,
  type WalletProviderProps,
} from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { SolflareWalletAdapter } from "@solana/wallet-adapter-solflare";
import { TrustWalletAdapter } from "@solana/wallet-adapter-trust";
import { type ReactNode, useMemo } from "react";

/**
 * Build fresh Solana adapter instances. Solana wallet adapters keep
 * mutable connection state and event listeners on the instance, so a
 * shared module-level array would leak state between providers. Always
 * call this from a useMemo inside the provider so each provider mount
 * gets its own adapters.
 *
 * Hardware wallets (Ledger, Trezor) are intentionally excluded:
 *   - Their adapter packages do not implement `signMessage`, so they
 *     cannot complete the SIWS sign-in flow.
 *   - `@ledgerhq/errors` ships a non-extension import that
 *     `ERR_MODULE_NOT_FOUND`s under Node ESM/SSR.
 *
 * Apps that want hardware support in non-login contexts can extend
 * the wallet list explicitly via the provider's `wallets` prop.
 */
export function createDefaultSolanaWallets(): WalletProviderProps["wallets"] {
  return [
    new PhantomWalletAdapter(),
    new SolflareWalletAdapter(),
    new CoinbaseWalletAdapter(),
    new TrustWalletAdapter(),
    new Coin98WalletAdapter(),
  ];
}

export interface SolanaWalletProviderProps {
  /** JSON-RPC endpoint (`https://api.mainnet-beta.solana.com`, Helius, etc.). */
  endpoint: string;
  /**
   * Wallet adapters. Defaults to `createDefaultSolanaWallets()`. Pass an
   * explicit array to narrow, replace, or extend the list.
   *
   * Backpack, Brave, and other Solana Wallet Standard wallets are
   * discovered by wallet-adapter at runtime when the browser wallet is
   * present.
   */
  wallets?: WalletProviderProps["wallets"];
  /** Auto-connect previously selected wallet on mount. Defaults to true. */
  autoConnect?: boolean;
  children?: ReactNode;
}

/**
 * Wraps children with Solana wallet-adapter providers. Optional convenience.
 *
 * Remember to import `@solana/wallet-adapter-react-ui/styles.css` once at
 * your app root.
 */
export function SolanaWalletProvider({
  endpoint,
  wallets,
  autoConnect = true,
  children,
}: SolanaWalletProviderProps) {
  // Build a fresh adapter list per provider mount when no wallets prop
  // was passed. Sharing a single module-level array across mounts would
  // leak connection state between providers (the previous behavior was
  // a P2 codex finding).
  const resolvedWallets = useMemo(
    () => wallets ?? createDefaultSolanaWallets(),
    [wallets],
  );

  return (
    <ConnectionProvider endpoint={endpoint}>
      <WalletProvider wallets={resolvedWallets} autoConnect={autoConnect}>
        <WalletModalProvider>{children}</WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
