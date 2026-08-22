/**
 * The wallet provider tree (wagmi + RainbowKit + Solana wallet adapters).
 *
 * Loaded only behind {@link ConditionalWalletProviders}'s lazy boundary so the
 * heavy wallet vendor chunks never enter the entry bundle.
 *
 * NOTE: no stylesheet is imported here — the app shell owns CSS and this
 * module is `index.ts`-free by design. The wallet modal styles (RainbowKit's
 * `styles.css` and `@solana/wallet-adapter-react-ui/styles.css`) are
 * `@import`ed by `cloud-ui/index.css`; without them both modals render
 * unstyled (#15600).
 *
 * NOTE: `@wagmi/connectors` reaches its wallet SDKs (`@metamask/connect-evm`,
 * `@walletconnect/ethereum-provider`, `@coinbase/wallet-sdk`, …) through
 * dynamic imports of *optional* peer deps. Any peer missing from the install
 * is compiled by Vite into a stub that throws
 * `Could not resolve "<pkg>" imported by "@wagmi/connectors"` at click time
 * (#15600 — MetaMask). package.json therefore declares `@metamask/connect-evm`
 * even though no source file imports it (guarded by wallet-connector-deps.test.ts).
 *
 * WalletConnect project id (#18459): when the public project id is missing or
 * still a placeholder, this module never substitutes `YOUR_WC_PROJECT_ID`.
 * Injected-wallet connectors still mount so browser extensions work; QR /
 * deep-link WalletConnect stays unavailable rather than false-green.
 */

import { BRAND_COLORS } from "@elizaos/shared/brand";
import {
  connectorsForWallets,
  darkTheme,
  RainbowKitProvider,
} from "@rainbow-me/rainbowkit";
import {
  injectedWallet,
  walletConnectWallet,
} from "@rainbow-me/rainbowkit/wallets";
import { PhantomWalletAdapter } from "@solana/wallet-adapter-phantom";
import {
  ConnectionProvider,
  WalletProvider,
} from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { SolflareWalletAdapter } from "@solana/wallet-adapter-solflare";
import type { ReactNode } from "react";
import { useMemo } from "react";
import { type Config, createConfig, http, WagmiProvider } from "wagmi";
import { base, bsc } from "wagmi/chains";
import { injected } from "wagmi/connectors";
import { readWalletConnectProjectIdFromEnv } from "./wallet-connect-project-id";

const DEFAULT_SOLANA_RPC_URL = "https://api.mainnet-beta.solana.com";

function buildEvmTransports(alchemyKey: string | undefined) {
  return {
    [base.id]: alchemyKey
      ? http(`https://base-mainnet.g.alchemy.com/v2/${alchemyKey}`)
      : http("https://base-rpc.publicnode.com"),
    [bsc.id]: http("https://bsc-dataseed.binance.org"),
  } as const;
}

/**
 * Build the EVM wagmi config. When a real WalletConnect project id is present,
 * RainbowKit's full connector set (including WalletConnect QR) is used. When
 * it is not, only the injected connector is registered so extension wallets
 * keep working without a false-green WalletConnect configuration.
 */
export function buildStewardEvmConfig(options: {
  appUrl: string;
  walletConnectProjectId: string | null;
  alchemyKey: string | undefined;
}): Config {
  const transports = buildEvmTransports(options.alchemyKey);

  if (options.walletConnectProjectId) {
    const connectors = connectorsForWallets(
      [
        {
          groupName: "Available wallets",
          wallets: [injectedWallet, walletConnectWallet],
        },
      ],
      {
        appName: "Eliza Cloud",
        appDescription:
          "Sign in to chat with your Eliza Cloud agent and manage your account",
        appUrl: options.appUrl,
        projectId: options.walletConnectProjectId,
      },
    );

    return createConfig({
      chains: [base, bsc],
      connectors,
      transports,
      ssr: false,
    });
  }

  return createConfig({
    chains: [base, bsc],
    connectors: [injected({ shimDisconnect: true })],
    transports,
    ssr: false,
    multiInjectedProviderDiscovery: true,
  });
}

export function StewardWalletProviders({ children }: { children: ReactNode }) {
  const appUrl =
    process.env.NEXT_PUBLIC_APP_URL ??
    (typeof window !== "undefined"
      ? window.location.origin
      : "http://localhost:3000");
  const walletConnectProjectId = readWalletConnectProjectIdFromEnv();
  const alchemyKey = process.env.NEXT_PUBLIC_ALCHEMY_API_KEY?.trim();
  const heliusKey = process.env.NEXT_PUBLIC_HELIUS_API_KEY?.trim();
  const solanaEndpoint =
    process.env.NEXT_PUBLIC_SOLANA_RPC_URL ||
    (heliusKey
      ? `https://mainnet.helius-rpc.com/?api-key=${heliusKey}`
      : DEFAULT_SOLANA_RPC_URL);

  const evmConfig = useMemo<Config>(
    () =>
      buildStewardEvmConfig({
        appUrl,
        walletConnectProjectId,
        alchemyKey: alchemyKey || undefined,
      }),
    [alchemyKey, appUrl, walletConnectProjectId],
  );

  const rainbowTheme = useMemo(
    () =>
      darkTheme({
        accentColor: BRAND_COLORS.orange,
        accentColorForeground: BRAND_COLORS.white,
        borderRadius: "medium",
        overlayBlur: "small",
      }),
    [],
  );

  const solanaWallets = useMemo(
    () => [new PhantomWalletAdapter(), new SolflareWalletAdapter()],
    [],
  );

  return (
    <WagmiProvider config={evmConfig}>
      <RainbowKitProvider theme={rainbowTheme} modalSize="compact">
        <ConnectionProvider endpoint={solanaEndpoint}>
          <WalletProvider wallets={solanaWallets} autoConnect>
            <WalletModalProvider>{children}</WalletModalProvider>
          </WalletProvider>
        </ConnectionProvider>
      </RainbowKitProvider>
    </WagmiProvider>
  );
}
