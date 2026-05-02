/**
 * Wallet Login example — two usage patterns.
 *
 * Pattern A: Use the bundled <EVMWalletProvider> / <SolanaWalletProvider>
 *            wrappers. Fastest path for greenfield apps.
 *
 * Pattern B: Bring your own wagmi + Solana provider stack. Preferred for apps
 *            that already have wallet providers mounted elsewhere.
 *
 * This file is documentation, not shipped code. It is not part of the build.
 */

import { StewardProvider } from "@stwd/react";
import { EVMWalletProvider, SolanaWalletProvider, WalletLogin } from "@stwd/react/wallet";
import { StewardClient } from "@stwd/sdk";

import "@stwd/react/styles.css";
import "@rainbow-me/rainbowkit/styles.css";
import "@solana/wallet-adapter-react-ui/styles.css";

import { getDefaultConfig } from "@rainbow-me/rainbowkit";
import { base, mainnet } from "wagmi/chains";

// ─── Pattern A: bundled wrappers ─────────────────────────────────────────────

const wagmiConfig = getDefaultConfig({
  appName: "Steward",
  projectId: "YOUR_WALLETCONNECT_PROJECT_ID",
  chains: [mainnet, base],
  ssr: true,
});

const stewardClient = new StewardClient({
  baseUrl: "https://api.steward.fi",
  apiKey: "…",
});

export function PatternA() {
  return (
    <StewardProvider
      client={stewardClient}
      agentId="agent_abc"
      auth={{ baseUrl: "https://api.steward.fi" }}
    >
      <EVMWalletProvider config={wagmiConfig}>
        <SolanaWalletProvider endpoint="https://api.mainnet-beta.solana.com">
          <WalletLogin
            chains="both"
            onSuccess={(result, kind) => {
              console.log("signed in via", kind, result.token);
            }}
            onError={(err, kind) => {
              console.error(kind, err);
            }}
          />
        </SolanaWalletProvider>
      </EVMWalletProvider>
    </StewardProvider>
  );
}

// ─── Pattern B: bring your own providers ─────────────────────────────────────

import { darkTheme, RainbowKitProvider } from "@rainbow-me/rainbowkit";
import {
  ConnectionProvider,
  WalletProvider as SolanaAdapterProvider,
} from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { PhantomWalletAdapter } from "@solana/wallet-adapter-wallets";
import { WagmiProvider } from "wagmi";

export function PatternB() {
  const solanaWallets = [new PhantomWalletAdapter()];
  return (
    <WagmiProvider config={wagmiConfig}>
      <RainbowKitProvider theme={darkTheme()} modalSize="compact">
        <ConnectionProvider endpoint="https://api.mainnet-beta.solana.com">
          <SolanaAdapterProvider wallets={solanaWallets} autoConnect>
            <WalletModalProvider>
              <StewardProvider
                client={stewardClient}
                agentId="agent_abc"
                auth={{ baseUrl: "https://api.steward.fi" }}
              >
                <WalletLogin chains="both" />
              </StewardProvider>
            </WalletModalProvider>
          </SolanaAdapterProvider>
        </ConnectionProvider>
      </RainbowKitProvider>
    </WagmiProvider>
  );
}

// ─── Single-chain example ────────────────────────────────────────────────────

export function EvmOnly() {
  return (
    <StewardProvider
      client={stewardClient}
      agentId="agent_abc"
      auth={{ baseUrl: "https://api.steward.fi" }}
    >
      <EVMWalletProvider config={wagmiConfig}>
        <WalletLogin chains="evm" />
      </EVMWalletProvider>
    </StewardProvider>
  );
}
