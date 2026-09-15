import { PhantomWalletAdapter as RealPhantomWalletAdapter } from "@solana/wallet-adapter-phantom";
import * as React from "react";
import { renderToString } from "react-dom/server";
/**
 * Exercises provider configuration at wallet-library boundaries with stubbed UI
 * wrappers; separate mounts must never share mutable adapter event state.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";

let capturedSolanaWallets: unknown[] | undefined;
let capturedWalletGroups:
  | Array<{ groupName: string; wallets: unknown[] }>
  | undefined;
const mockConnectors = [{ id: "connector" }];
const mockHttpTransport = { key: "http" };
const mockConnectorsForWallets = vi.fn(
  (walletGroups: Array<{ groupName: string; wallets: unknown[] }>) => {
    capturedWalletGroups = walletGroups;
    return mockConnectors;
  },
);
const mockCreateConfig = vi.fn((config: unknown) => ({
  kind: "wagmi-config",
  config,
}));
const mockHttp = vi.fn(() => mockHttpTransport);

class PhantomWalletAdapter {
  name = "Phantom";
}
class SolflareWalletAdapter {
  name = "Solflare";
}
class CoinbaseWalletAdapter {
  name = "Coinbase Wallet";
}
class TrustWalletAdapter {
  name = "Trust Wallet";
}
class LedgerWalletAdapter {
  name = "Ledger";
}
class TrezorWalletAdapter {
  name = "Trezor";
}
class MathWalletAdapter {
  name = "MathWallet";
}
class Coin98WalletAdapter {
  name = "Coin98";
}
class BackpackWalletAdapter {
  name = "Backpack";
}

vi.doMock("@rainbow-me/rainbowkit", () => ({
  ConnectButton: () =>
    React.createElement(
      "div",
      { "data-testid": "rk-connect" },
      "[ConnectButton]",
    ),
  connectorsForWallets: mockConnectorsForWallets,
  darkTheme: () => ({}),
  lightTheme: () => ({}),
  RainbowKitProvider: ({ children }: { children?: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
}));

vi.doMock("@rainbow-me/rainbowkit/wallets", () => ({
  metaMaskWallet: () => ({ id: "metaMask" }),
  coinbaseWallet: () => ({ id: "coinbase" }),
  walletConnectWallet: () => ({ id: "walletConnect" }),
  rainbowWallet: () => ({ id: "rainbow" }),
  rabbyWallet: () => ({ id: "rabby" }),
  trustWallet: () => ({ id: "trust" }),
  phantomWallet: () => ({ id: "phantom" }),
  ledgerWallet: () => ({ id: "ledger" }),
  safeWallet: () => ({ id: "safe" }),
  injectedWallet: () => ({ id: "injected" }),
}));

vi.doMock("@solana/wallet-adapter-react", () => ({
  useWallet: () => ({
    publicKey: {
      toBase58: () => "SoLPubKeyMock1111111111111111111111111111111",
      toBytes: () => new Uint8Array(),
    },
    connected: true,
    connecting: false,
    wallet: { adapter: { name: "Phantom", publicKey: null } },
    signMessage: async () => new Uint8Array([1, 2, 3, 4]),
    disconnect: async () => {},
  }),
  useConnection: () => ({ connection: null }),
  ConnectionProvider: ({ children }: { children?: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
  WalletProvider: ({
    wallets,
    children,
  }: {
    wallets?: unknown[];
    children?: React.ReactNode;
  }) => {
    capturedSolanaWallets = wallets;
    return React.createElement(React.Fragment, null, children);
  },
}));

vi.doMock("@solana/wallet-adapter-react-ui", () => ({
  WalletMultiButton: () =>
    React.createElement(
      "div",
      { "data-testid": "sol-connect" },
      "[WalletMultiButton]",
    ),
  WalletModalProvider: ({ children }: { children?: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
}));

vi.doMock("@solana/wallet-adapter-wallets", () => ({
  BackpackWalletAdapter,
  PhantomWalletAdapter,
  SolflareWalletAdapter,
  CoinbaseWalletAdapter,
  TrustWalletAdapter,
  LedgerWalletAdapter,
  TrezorWalletAdapter,
  MathWalletAdapter,
  Coin98WalletAdapter,
}));

vi.doMock("@tanstack/react-query", () => ({
  QueryClient: class QueryClient {},
  QueryClientProvider: ({ children }: { children?: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
}));

vi.doMock("wagmi", () => ({
  createConfig: mockCreateConfig,
  http: mockHttp,
  useAccount: () => ({
    address: "0xabc0000000000000000000000000000000000def",
    isConnected: true,
    connector: { name: "MetaMask" },
    chain: { id: 1, name: "Ethereum" },
  }),
  useDisconnect: () => ({ disconnect: () => {} }),
  useSignMessage: () => ({ signMessageAsync: async () => "0xdeadbeef" }),
  WagmiProvider: ({ children }: { children?: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
}));

const { createDefaultWagmiConfig, SolanaWalletProvider } = await import(
  "../providers/WalletProviders.js"
);

describe("Wallet provider helpers", () => {
  beforeEach(() => {
    capturedSolanaWallets = undefined;
    capturedWalletGroups = undefined;
    mockConnectorsForWallets.mockClear();
    mockCreateConfig.mockClear();
    mockHttp.mockClear();
  });

  test("SolanaWalletProvider builds fresh adapters per mount (no shared state)", () => {
    renderToString(
      React.createElement(SolanaWalletProvider, {
        endpoint: "https://api.mainnet-beta.solana.com",
      }),
    );
    const firstMount = capturedSolanaWallets;

    renderToString(
      React.createElement(SolanaWalletProvider, {
        endpoint: "https://api.mainnet-beta.solana.com",
      }),
    );
    const secondMount = capturedSolanaWallets;

    // Different array instances. Adapter instances should also differ
    // (each adapter is `new`d per call).
    expect(firstMount).not.toBe(secondMount);
    expect(firstMount?.[0]).not.toBe(secondMount?.[0]);
  });

  test("SolanaWalletProvider wallets prop overrides defaults", () => {
    const customAdapter = new RealPhantomWalletAdapter();

    renderToString(
      React.createElement(SolanaWalletProvider, {
        endpoint: "https://api.mainnet-beta.solana.com",
        wallets: [customAdapter],
      }),
    );

    expect(capturedSolanaWallets).toEqual([customAdapter]);
  });

  test("createDefaultWagmiConfig returns a wagmi config using curated connectors", () => {
    const chains = [
      {
        id: 1,
        name: "Ethereum",
        nativeCurrency: { decimals: 18, name: "Ether", symbol: "ETH" },
        rpcUrls: { default: { http: ["https://example.invalid"] } },
      },
    ] as const;

    const config = createDefaultWagmiConfig({
      projectId: "test-project-id",
      appName: "elizaOS Test",
      chains,
    });

    expect(config).toEqual({
      kind: "wagmi-config",
      config: {
        chains,
        connectors: mockConnectors,
        transports: { 1: mockHttpTransport },
        ssr: true,
      },
    });
    expect(mockConnectorsForWallets).toHaveBeenCalledTimes(1);
    expect(mockCreateConfig).toHaveBeenCalledTimes(1);
    expect(mockHttp).toHaveBeenCalledTimes(1);
  });

  test("createDefaultWagmiConfig prepends extra global wallet entries", () => {
    const chains = [
      {
        id: 1,
        name: "Ethereum",
        nativeCurrency: { decimals: 18, name: "Ether", symbol: "ETH" },
        rpcUrls: { default: { http: ["https://example.invalid"] } },
      },
    ] as const;
    const stewardWallet = () => {
      throw new Error(
        "Connector construction is outside this provider composition test",
      );
    };

    createDefaultWagmiConfig({
      projectId: "test-project-id",
      chains,
      wallets: [stewardWallet],
    });

    expect(capturedWalletGroups?.[0]?.groupName).toBe("Recommended");
    expect(capturedWalletGroups?.[0]?.wallets[0]).toBe(stewardWallet);
    expect(capturedWalletGroups?.[0]?.wallets.length).toBeGreaterThan(1);
  });
});
