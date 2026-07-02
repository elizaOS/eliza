/**
 * The wallet provider tree (wagmi + RainbowKit + Solana wallet adapters).
 *
 * Loaded only behind {@link ConditionalWalletProviders}'s lazy boundary so the
 * heavy wallet vendor chunks never enter the entry bundle.
 *
 * NOTE: RainbowKit's stylesheet (`@rainbow-me/rainbowkit/styles.css`) is NOT
 * imported here — the app shell owns CSS and this module is `index.ts`-free by
 * design; the host/cloud-ui CSS entry must `@import` the RainbowKit styles for
 * the modal to render styled.
 */

import { BRAND_COLORS } from "@elizaos/shared/brand";
import {
  darkTheme,
  getDefaultConfig,
  RainbowKitProvider,
} from "@rainbow-me/rainbowkit";
import {
  ConnectionProvider,
  WalletProvider,
} from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import {
  PhantomWalletAdapter,
  SolflareWalletAdapter,
} from "@solana/wallet-adapter-wallets";
import type { ReactNode } from "react";
import { useMemo } from "react";
import { type Config, http, WagmiProvider } from "wagmi";
import { base, bsc } from "wagmi/chains";

const DEFAULT_SOLANA_RPC_URL = "https://api.mainnet-beta.solana.com";
const FALLBACK_WALLETCONNECT_PROJECT_ID = "YOUR_WC_PROJECT_ID";

export function StewardWalletProviders({ children }: { children: ReactNode }) {
  const appUrl =
    process.env.NEXT_PUBLIC_APP_URL ??
    (typeof window !== "undefined"
      ? window.location.origin
      : "http://localhost:3000");
  const walletConnectProjectId =
    process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID?.trim() ||
    FALLBACK_WALLETCONNECT_PROJECT_ID;
  const alchemyKey = process.env.NEXT_PUBLIC_ALCHEMY_API_KEY?.trim();
  const heliusKey = process.env.NEXT_PUBLIC_HELIUS_API_KEY?.trim();
  const solanaEndpoint =
    process.env.NEXT_PUBLIC_SOLANA_RPC_URL ||
    (heliusKey
      ? `https://mainnet.helius-rpc.com/?api-key=${heliusKey}`
      : DEFAULT_SOLANA_RPC_URL);

  // RainbowKit's `getDefaultConfig` is designed to feed `WagmiProvider`, but the
  // monorepo resolves two wagmi copies (RainbowKit pins wagmi 2.x; other packages
  // pull wagmi 3.x), so their `Config` types are structurally identical yet
  // nominally distinct. Bridge them at this single boundary.
  const evmConfig = useMemo<Config>(
    () =>
      getDefaultConfig({
        appName: "Eliza Cloud",
        appDescription:
          "Sign in to chat with your Eliza Cloud agent and manage your account",
        appUrl,
        projectId: walletConnectProjectId,
        chains: [base, bsc],
        transports: {
          [base.id]: alchemyKey
            ? http(`https://base-mainnet.g.alchemy.com/v2/${alchemyKey}`)
            : http("https://base-rpc.publicnode.com"),
          [bsc.id]: http("https://bsc-dataseed.binance.org"),
        },
        ssr: false,
      }) as unknown as Config,
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
