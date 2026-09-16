/** Verifies disabled wallet chains never initialize their provider subtree. */
// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const providerSpies = vi.hoisted(() => ({
  connectorsForWallets: vi.fn(() => []),
  createConfig: vi.fn(() => ({ id: "wagmi-config" })),
  darkTheme: vi.fn(() => ({ id: "rainbow-theme" })),
  http: vi.fn((url: string) => ({ url })),
  injected: vi.fn(() => ({ id: "injected" })),
  phantomConstructed: vi.fn(),
  solflareConstructed: vi.fn(),
  walletProviderProps: vi.fn(),
}));

vi.mock("@rainbow-me/rainbowkit", () => ({
  connectorsForWallets: providerSpies.connectorsForWallets,
  darkTheme: providerSpies.darkTheme,
  RainbowKitProvider: ({ children }: { children: ReactNode }) => (
    <div data-testid="rainbow-provider">{children}</div>
  ),
}));

vi.mock("@rainbow-me/rainbowkit/wallets", () => ({
  injectedWallet: { id: "injected-wallet" },
  walletConnectWallet: { id: "wallet-connect-wallet" },
}));

vi.mock("@solana/wallet-adapter-phantom", () => ({
  PhantomWalletAdapter: class PhantomWalletAdapter {
    constructor() {
      providerSpies.phantomConstructed();
    }
  },
}));

vi.mock("@solana/wallet-adapter-solflare", () => ({
  SolflareWalletAdapter: class SolflareWalletAdapter {
    constructor() {
      providerSpies.solflareConstructed();
    }
  },
}));

vi.mock("@solana/wallet-adapter-react", () => ({
  ConnectionProvider: ({ children }: { children: ReactNode }) => (
    <div data-testid="solana-connection-provider">{children}</div>
  ),
  WalletProvider: ({
    children,
    ...props
  }: {
    children: ReactNode;
    wallets: unknown[];
    autoConnect: boolean;
  }) => {
    providerSpies.walletProviderProps(props);
    return <div data-testid="solana-wallet-provider">{children}</div>;
  },
}));

vi.mock("@solana/wallet-adapter-react-ui", () => ({
  WalletModalProvider: ({ children }: { children: ReactNode }) => (
    <div data-testid="solana-modal-provider">{children}</div>
  ),
}));

vi.mock("wagmi", () => ({
  createConfig: providerSpies.createConfig,
  http: providerSpies.http,
  WagmiProvider: ({ children }: { children: ReactNode }) => (
    <div data-testid="wagmi-provider">{children}</div>
  ),
}));

vi.mock("wagmi/chains", () => ({
  base: { id: 8453 },
  bsc: { id: 56 },
}));

vi.mock("wagmi/connectors", () => ({
  injected: providerSpies.injected,
}));

vi.mock("./wallet-connect-project-id", () => ({
  readWalletConnectProjectIdFromEnv: () => null,
}));

import { StewardWalletProviders } from "./steward-wallet-providers";

function renderProviders(
  options: { enableEvm?: boolean; enableSolana?: boolean } = {},
) {
  return render(
    <StewardWalletProviders {...options}>
      <div data-testid="provider-child">Child</div>
    </StewardWalletProviders>,
  );
}

function expectNoEvmInitialization() {
  expect(screen.queryByTestId("wagmi-provider")).toBeNull();
  expect(screen.queryByTestId("rainbow-provider")).toBeNull();
  expect(providerSpies.createConfig).not.toHaveBeenCalled();
  expect(providerSpies.darkTheme).not.toHaveBeenCalled();
  expect(providerSpies.http).not.toHaveBeenCalled();
  expect(providerSpies.injected).not.toHaveBeenCalled();
}

function expectNoSolanaInitialization() {
  expect(screen.queryByTestId("solana-connection-provider")).toBeNull();
  expect(screen.queryByTestId("solana-wallet-provider")).toBeNull();
  expect(screen.queryByTestId("solana-modal-provider")).toBeNull();
  expect(providerSpies.phantomConstructed).not.toHaveBeenCalled();
  expect(providerSpies.solflareConstructed).not.toHaveBeenCalled();
  expect(providerSpies.walletProviderProps).not.toHaveBeenCalled();
}

describe("StewardWalletProviders capability gating", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("fails closed when a caller omits capability flags", () => {
    renderProviders();

    expect(screen.getByTestId("provider-child")).toBeTruthy();
    expectNoEvmInitialization();
    expectNoSolanaInitialization();
  });

  it("preserves the full provider tree for an explicit billing caller", () => {
    renderProviders({ enableEvm: true, enableSolana: true });

    expect(screen.getByTestId("provider-child")).toBeTruthy();
    expect(screen.getByTestId("wagmi-provider")).toBeTruthy();
    expect(screen.getByTestId("rainbow-provider")).toBeTruthy();
    expect(screen.getByTestId("solana-connection-provider")).toBeTruthy();
    expect(screen.getByTestId("solana-wallet-provider")).toBeTruthy();
    expect(screen.getByTestId("solana-modal-provider")).toBeTruthy();
    expect(providerSpies.createConfig).toHaveBeenCalledTimes(1);
    expect(providerSpies.phantomConstructed).toHaveBeenCalledTimes(1);
    expect(providerSpies.solflareConstructed).toHaveBeenCalledTimes(1);
    expect(providerSpies.walletProviderProps).toHaveBeenCalledWith(
      expect.objectContaining({ autoConnect: true }),
    );
  });

  it("does not construct or mount Solana providers for SIWE-only", () => {
    renderProviders({ enableEvm: true, enableSolana: false });

    expect(screen.getByTestId("wagmi-provider")).toBeTruthy();
    expect(screen.getByTestId("rainbow-provider")).toBeTruthy();
    expectNoSolanaInitialization();
  });

  it("does not construct or mount EVM providers for SIWS-only", () => {
    renderProviders({ enableEvm: false, enableSolana: true });

    expect(screen.getByTestId("solana-connection-provider")).toBeTruthy();
    expect(screen.getByTestId("solana-wallet-provider")).toBeTruthy();
    expect(screen.getByTestId("solana-modal-provider")).toBeTruthy();
    expectNoEvmInitialization();
  });

  it("renders children without initializing either provider when disabled", () => {
    renderProviders({ enableEvm: false, enableSolana: false });

    expect(screen.getByTestId("provider-child")).toBeTruthy();
    expectNoEvmInitialization();
    expectNoSolanaInitialization();
  });
});
