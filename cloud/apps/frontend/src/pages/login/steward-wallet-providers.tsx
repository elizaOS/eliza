import { darkTheme, getDefaultConfig, RainbowKitProvider } from "@rainbow-me/rainbowkit";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { PhantomWalletAdapter, SolflareWalletAdapter } from "@solana/wallet-adapter-wallets";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useMemo } from "react";
import { http, WagmiProvider } from "wagmi";
import { base, mainnet } from "wagmi/chains";

const DEFAULT_SOLANA_RPC_URL = "https://api.mainnet-beta.solana.com";
const FALLBACK_WALLETCONNECT_PROJECT_ID = "YOUR_WC_PROJECT_ID";

export function StewardWalletProviders({ children }: { children: React.ReactNode }) {
  const appUrl =
    process.env.NEXT_PUBLIC_APP_URL ??
    (typeof window !== "undefined" ? window.location.origin : "http://localhost:3000");
  const walletConnectProjectId =
    process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID?.trim() || FALLBACK_WALLETCONNECT_PROJECT_ID;
  const alchemyKey = process.env.NEXT_PUBLIC_ALCHEMY_API_KEY?.trim();
  const heliusKey = process.env.NEXT_PUBLIC_HELIUS_API_KEY?.trim();
  const solanaEndpoint =
    process.env.NEXT_PUBLIC_SOLANA_RPC_URL ||
    (heliusKey ? `https://mainnet.helius-rpc.com/?api-key=${heliusKey}` : DEFAULT_SOLANA_RPC_URL);

  const evmConfig = useMemo(
    () =>
      getDefaultConfig({
        appName: "Eliza Cloud",
        appDescription: "Eliza Cloud wallet sign-in",
        appUrl,
        projectId: walletConnectProjectId,
        chains: [mainnet, base],
        transports: {
          [mainnet.id]: alchemyKey
            ? http(`https://eth-mainnet.g.alchemy.com/v2/${alchemyKey}`)
            : http(),
          [base.id]: alchemyKey
            ? http(`https://base-mainnet.g.alchemy.com/v2/${alchemyKey}`)
            : http(),
        },
        ssr: false,
      }),
    [alchemyKey, appUrl, walletConnectProjectId],
  );

  const queryClient = useMemo(() => new QueryClient(), []);
  const rainbowTheme = useMemo(
    () =>
      darkTheme({
        accentColor: "#FF5800",
        accentColorForeground: "#FFFFFF",
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
    <WagmiProvider config={evmConfig} reconnectOnMount={false}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider theme={rainbowTheme} modalSize="compact">
          <ConnectionProvider endpoint={solanaEndpoint}>
            <WalletProvider wallets={solanaWallets} autoConnect>
              <WalletModalProvider>{children}</WalletModalProvider>
            </WalletProvider>
          </ConnectionProvider>
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
