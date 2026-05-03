import { darkTheme, RainbowKitProvider, type Theme } from "@rainbow-me/rainbowkit";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { PhantomWalletAdapter, SolflareWalletAdapter } from "@solana/wallet-adapter-wallets";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type ReactNode, useMemo } from "react";
// All imports from optional peer dependencies are intentional. These two
// wrappers are opt-in utilities; consumers who ship their own wagmi / Solana
// providers should import them directly instead of using these.
import { type Config as WagmiConfig, WagmiProvider } from "wagmi";

// ─── EVM wrapper ─────────────────────────────────────────────────────────────

export interface EVMWalletProviderProps {
  /** wagmi v2 `Config` created with `createConfig()` or `getDefaultConfig()`. */
  config: WagmiConfig;
  /**
   * TanStack Query client. Pass yours if the host app already has one;
   * otherwise a default client is created and scoped to this subtree.
   */
  queryClient?: QueryClient;
  /** RainbowKit theme. Defaults to dark. Pass `null` to skip theming. */
  theme?: Theme | null;
  /** RainbowKit modal size. Defaults to "compact". */
  modalSize?: "compact" | "wide";
  /** Reconnect on mount. Defaults to true. */
  reconnectOnMount?: boolean;
  children?: ReactNode;
}

/**
 * Wraps children with wagmi + RainbowKit + TanStack Query providers. This is
 * an optional convenience. Most apps already have their own wagmi setup;
 * skip this wrapper if so. `<WalletLogin chains="evm">` only needs the
 * ambient wagmi + RainbowKit + QueryClient context to exist above it.
 *
 * Remember to import `@rainbow-me/rainbowkit/styles.css` once at your app root.
 */
export function EVMWalletProvider({
  config,
  queryClient,
  theme,
  modalSize = "compact",
  reconnectOnMount = true,
  children,
}: EVMWalletProviderProps) {
  const resolvedTheme = theme === null ? null : (theme ?? darkTheme());
  const client = useMemo(() => queryClient ?? new QueryClient(), [queryClient]);
  return (
    <WagmiProvider config={config} reconnectOnMount={reconnectOnMount}>
      <QueryClientProvider client={client}>
        <RainbowKitProvider theme={resolvedTheme} modalSize={modalSize}>
          {children}
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}

// ─── Solana wrapper ──────────────────────────────────────────────────────────

export interface SolanaWalletProviderProps {
  /** JSON-RPC endpoint (`https://api.mainnet-beta.solana.com`, Helius, etc.). */
  endpoint: string;
  /**
   * Wallet adapters. Defaults to Phantom, Solflare, Backpack. Pass an explicit
   * array to narrow or extend the list.
   */
  wallets?: unknown[];
  /** Auto-connect previously selected wallet on mount. Defaults to true. */
  autoConnect?: boolean;
  children?: ReactNode;
}

/**
 * Wraps children with Solana wallet-adapter providers. Optional convenience.
 *
 * Remember to import `@solana/wallet-adapter-react-ui/styles.css` once at your
 * app root.
 */
export function SolanaWalletProvider({
  endpoint,
  wallets,
  autoConnect = true,
  children,
}: SolanaWalletProviderProps) {
  const defaultWallets = useMemo(
    () => wallets ?? [new PhantomWalletAdapter(), new SolflareWalletAdapter()],
    [wallets],
  );

  return (
    <ConnectionProvider endpoint={endpoint}>
      <WalletProvider wallets={defaultWallets} autoConnect={autoConnect}>
        <WalletModalProvider>{children}</WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
