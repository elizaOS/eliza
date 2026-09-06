/**
 * EVM wallet provider.
 *
 * This file contains ONLY EVM peer-dep imports (wagmi, viem, RainbowKit,
 * TanStack Query). It does not reference any Solana adapter. Apps that
 * only want EVM can import from `@elizaos/ui` and skip the
 * Solana peer install entirely.
 */

import {
  connectorsForWallets,
  darkTheme,
  RainbowKitProvider,
  type Theme,
  type WalletList,
} from "@rainbow-me/rainbowkit";
import {
  coinbaseWallet,
  injectedWallet,
  ledgerWallet,
  metaMaskWallet,
  phantomWallet,
  rabbyWallet,
  rainbowWallet,
  safeWallet,
  trustWallet,
  walletConnectWallet,
} from "@rainbow-me/rainbowkit/wallets";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type ReactNode, useMemo } from "react";
import type { Chain, Transport } from "viem";
import {
  createConfig,
  http,
  type Config as WagmiConfig,
  WagmiProvider,
} from "wagmi";

export type DefaultWagmiChains = readonly [Chain, ...Chain[]];

type DefaultWagmiTransports<TChains extends DefaultWagmiChains> = Record<
  TChains[number]["id"],
  Transport
>;

export interface CreateDefaultWagmiConfigOptions<
  TChains extends DefaultWagmiChains,
> {
  /** WalletConnect Cloud project ID. Get one at https://cloud.walletconnect.com. */
  projectId: string;
  /** wagmi chains to support. Must include at least one chain. */
  chains: TChains;
  /** App name shown in wallet connection prompts. Defaults to "elizaOS". */
  appName?: string;
  /** Extra RainbowKit wallet entries, e.g. a elizaOS global-wallet connector. */
  wallets?: WalletList[number]["wallets"];
  /** Enable wagmi SSR support. Defaults to true. */
  ssr?: boolean;
}

function createDefaultTransports<TChains extends DefaultWagmiChains>(
  chains: TChains,
): DefaultWagmiTransports<TChains> {
  return Object.fromEntries(
    chains.map((chain) => [chain.id, http()]),
  ) as DefaultWagmiTransports<TChains>;
}

/**
 * Creates a wagmi config with elizaOS's curated RainbowKit wallet order.
 * Consumers can keep passing their own config to EVMWalletProvider when they
 * need full control.
 */
export function createDefaultWagmiConfig<TChains extends DefaultWagmiChains>({
  projectId,
  chains,
  appName = "elizaOS",
  wallets = [],
  ssr = true,
}: CreateDefaultWagmiConfigOptions<TChains>): WagmiConfig {
  const connectors = connectorsForWallets(
    [
      {
        groupName: "Recommended",
        wallets: [
          ...wallets,
          metaMaskWallet,
          coinbaseWallet,
          walletConnectWallet,
          rainbowWallet,
          rabbyWallet,
          trustWallet,
          phantomWallet,
          ledgerWallet,
          safeWallet,
          injectedWallet,
        ],
      },
    ],
    { appName, projectId },
  );

  return createConfig({
    chains,
    connectors,
    transports: createDefaultTransports(chains),
    ssr,
  }) as WagmiConfig;
}

export interface EVMWalletProviderProps {
  /** wagmi v2 `Config` created with `createConfig()` or `createDefaultWagmiConfig()`. */
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
