import * as React from "react";
import { renderToString } from "react-dom/server";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { createLoginAuthContext } from "../../test/login-auth-context.js";

let mockEvmConnected = true;
let mockSolConnected = true;
const signMessageAsync = vi.fn(async () => "0xdeadbeef" as const);
const solSignMessage = vi.fn(async () => new Uint8Array([1, 2, 3, 4]));

vi.doMock("wagmi", () => ({
  useAccount: () => ({
    address: mockEvmConnected
      ? ("0xabc0000000000000000000000000000000000def" as const)
      : undefined,
    isConnected: mockEvmConnected,
    connector: { name: "MetaMask" },
    chain: { id: 1, name: "Ethereum" },
  }),
  useSignMessage: () => ({ signMessageAsync }),
  useDisconnect: () => ({ disconnect: () => {} }),
}));

vi.doMock("@rainbow-me/rainbowkit", () => ({
  ConnectButton: () =>
    React.createElement(
      "div",
      { "data-testid": "rk-connect" },
      "[ConnectButton]",
    ),
  darkTheme: () => ({}),
  lightTheme: () => ({}),
  RainbowKitProvider: ({ children }: { children?: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
}));

vi.doMock("@solana/wallet-adapter-react", () => ({
  useWallet: () => ({
    publicKey: mockSolConnected
      ? {
          toBase58: () => "SoLPubKeyMock1111111111111111111111111111111",
          toBytes: () => new Uint8Array(),
        }
      : null,
    connected: mockSolConnected,
    connecting: false,
    wallet: mockSolConnected
      ? { adapter: { name: "Phantom", publicKey: null } }
      : null,
    signMessage: solSignMessage,
    disconnect: async () => {},
  }),
  useConnection: () => ({ connection: null }),
  ConnectionProvider: ({ children }: { children?: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
  WalletProvider: ({ children }: { children?: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
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
  PhantomWalletAdapter: class {},
  SolflareWalletAdapter: class {},
  BackpackWalletAdapter: class {},
}));

const { WalletLogin } = await import("./WalletLogin.js");
const WalletLoginEVM = (await import("./WalletLogin.EVM.js")).default;
const WalletLoginSolana = (await import("./WalletLogin.Solana.js")).default;
const { LoginAuthContext } = await import("./provider.js");

function wrap(
  children: React.ReactNode,
  overrides: Parameters<typeof createLoginAuthContext>[0] = {},
) {
  const value = createLoginAuthContext({
    signInWithSolana: async () => {
      throw new Error("Unexpected Solana sign-in during server rendering");
    },
    ...overrides,
  });
  return React.createElement(LoginAuthContext.Provider, { value }, children);
}

describe("<WalletLogin /> shell", () => {
  beforeEach(() => {
    mockEvmConnected = true;
    mockSolConnected = true;
  });

  test("EVM-only mode renders EVM loading placeholder, no Solana", () => {
    const html = renderToString(
      wrap(React.createElement(WalletLogin, { chains: "evm" })),
    );
    expect(html).toContain("stwd-wallet-root-one");
    expect(html).toContain("wallet-loading-evm");
    expect(html).not.toContain("wallet-loading-solana");
  });

  test("Solana-only mode renders Solana loading placeholder, no EVM", () => {
    const html = renderToString(
      wrap(React.createElement(WalletLogin, { chains: "solana" })),
    );
    expect(html).toContain("stwd-wallet-root-one");
    expect(html).toContain("wallet-loading-solana");
    expect(html).not.toContain("wallet-loading-evm");
  });

  test("Both mode renders two-column layout with both placeholders", () => {
    const html = renderToString(wrap(React.createElement(WalletLogin, {})));
    expect(html).toContain("stwd-wallet-root-two");
    expect(html).toContain("wallet-loading-evm");
    expect(html).toContain("wallet-loading-solana");
  });
});

describe("EVM panel (direct render)", () => {
  beforeEach(() => {
    mockEvmConnected = true;
  });

  test("renders connector, address, and sign button when connected", () => {
    const html = renderToString(
      wrap(
        React.createElement(WalletLoginEVM, {
          label: "ethereum",
        }),
      ),
    );
    expect(html).toContain("ethereum");
    expect(html).toContain("[ConnectButton]");
    expect(html).toContain("sign in with MetaMask");
  });

  test("renders hint when not connected", () => {
    mockEvmConnected = false;
    const html = renderToString(
      wrap(React.createElement(WalletLoginEVM, { label: "ethereum" })),
    );
    expect(html).toContain("connect a wallet");
  });
});

describe("Solana panel (direct render)", () => {
  beforeEach(() => {
    mockSolConnected = true;
  });

  test("renders connector, address, and sign button when connected", () => {
    const html = renderToString(
      wrap(
        React.createElement(WalletLoginSolana, {
          label: "solana",
        }),
      ),
    );
    expect(html).toContain("solana");
    expect(html).toContain("[WalletMultiButton]");
    expect(html).toContain("sign in with Phantom");
  });

  test("sign button is disabled when signInWithSolana is not on context", () => {
    const html = renderToString(
      wrap(React.createElement(WalletLoginSolana, { label: "solana" }), {
        signInWithSolana: undefined,
      }),
    );
    expect(html).toContain("disabled");
  });
});
