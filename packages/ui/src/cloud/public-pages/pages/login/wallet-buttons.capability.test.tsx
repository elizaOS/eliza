/** Verifies wallet-chain capability gating with deterministic vendor hook doubles. */
// @vitest-environment jsdom

import type { StewardAuth } from "@stwd/sdk";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const walletHooks = vi.hoisted(() => ({
  connectAsync: vi.fn(),
  openConnectModal: vi.fn(),
  setSolanaModalVisible: vi.fn(),
  signMessageAsync: vi.fn(),
}));

vi.mock("@rainbow-me/rainbowkit", () => ({
  useConnectModal: () => ({
    openConnectModal: walletHooks.openConnectModal,
  }),
}));

vi.mock("@solana/wallet-adapter-react", () => ({
  useWallet: () => ({
    connected: false,
    publicKey: null,
    signMessage: undefined,
  }),
}));

vi.mock("@solana/wallet-adapter-react-ui", () => ({
  useWalletModal: () => ({
    setVisible: walletHooks.setSolanaModalVisible,
  }),
}));

vi.mock("wagmi", () => ({
  useAccount: () => ({ address: undefined, isConnected: false }),
  useConnect: () => ({
    connectAsync: walletHooks.connectAsync,
    connectors: [],
  }),
  useSignMessage: () => ({
    signMessageAsync: walletHooks.signMessageAsync,
  }),
}));

vi.mock("../../../shell/CloudI18nProvider", () => ({
  useCloudT: () => (_key: string, opts?: { defaultValue?: string }) =>
    opts?.defaultValue ?? _key,
}));

import { WalletButtons } from "./wallet-buttons";

const auth = {} as StewardAuth;

describe("WalletButtons capability gating", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("fails closed when wallet capabilities are omitted", () => {
    render(
      <WalletButtons
        auth={auth}
        autoStart={null}
        disabled={false}
        loadingProvider={null}
        onLoadingChange={vi.fn()}
        onSuccess={vi.fn()}
        onError={vi.fn()}
      />,
    );

    expect(screen.queryByRole("button", { name: /EVM wallet/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /Solana wallet/i })).toBeNull();
  });

  it.each([
    { siwe: true, siws: false },
    { siwe: false, siws: true },
    { siwe: true, siws: true },
  ])(
    "renders only announced chains for siwe=$siwe and siws=$siws",
    ({ siwe, siws }) => {
      render(
        <WalletButtons
          auth={auth}
          autoStart={null}
          disabled={false}
          siwe={siwe}
          siws={siws}
          loadingProvider={null}
          onLoadingChange={vi.fn()}
          onSuccess={vi.fn()}
          onError={vi.fn()}
        />,
      );

      expect(
        screen.queryByRole("button", { name: /EVM wallet/i }) !== null,
      ).toBe(siwe);
      expect(
        screen.queryByRole("button", { name: /Solana wallet/i }) !== null,
      ).toBe(siws);
    },
  );
});
