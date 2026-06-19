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
import { useMemo } from "react";
import { http, WagmiProvider } from "wagmi";
import { base, bsc } from "wagmi/chains";

const DEFAULT_SOLANA_RPC_URL = "https://api.mainnet-beta.solana.com";
const FALLBACK_WALLETCONNECT_PROJECT_ID = "YOUR_WC_PROJECT_ID";

export function StewardWalletProviders({
  children,
}: {
  children: React.ReactNode;
}) {
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

  const evmConfig = useMemo(
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
