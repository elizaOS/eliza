/** Verifies the headless wallet launcher's vendor-modal focus handoff. */
// @vitest-environment jsdom

import type { StewardAuth } from "@stwd/sdk";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const modalState = vi.hoisted(() => ({
  visible: false,
  setVisible: vi.fn(),
}));

const solanaWalletState = vi.hoisted(() => ({
  connected: false,
  publicKey: null,
  signMessage: undefined,
}));

const evmWalletState = vi.hoisted(() => ({
  address: undefined as `0x${string}` | undefined,
  isConnected: false,
  connectors: [] as Array<{
    id: string;
    name: string;
    type: string;
    getProvider: () => Promise<unknown>;
  }>,
  connectAsync: vi.fn(),
  openConnectModal: vi.fn(),
  signMessageAsync: vi.fn(),
}));

vi.mock("@rainbow-me/rainbowkit", () => ({
  useConnectModal: () => ({
    openConnectModal: evmWalletState.openConnectModal,
  }),
}));

vi.mock("@solana/wallet-adapter-react", () => ({
  useWallet: () => solanaWalletState,
}));

vi.mock("@solana/wallet-adapter-react-ui", () => ({
  useWalletModal: () => ({
    visible: modalState.visible,
    setVisible: modalState.setVisible,
  }),
}));

vi.mock("wagmi", () => ({
  useAccount: () => ({
    address: evmWalletState.address,
    isConnected: evmWalletState.isConnected,
  }),
  useConnect: () => ({
    connectAsync: evmWalletState.connectAsync,
    connectors: evmWalletState.connectors,
  }),
  useSignMessage: () => ({
    signMessageAsync: evmWalletState.signMessageAsync,
  }),
}));

vi.mock("../../../shell/CloudI18nProvider", () => ({
  useCloudT: () => (_key: string, opts?: { defaultValue?: string }) =>
    opts?.defaultValue ?? _key,
}));

import { WalletAutoLauncher } from "./wallet-buttons";

const auth = {} as StewardAuth;

function launcher(returnFocusTarget: HTMLElement, autoStart = false) {
  return (
    <WalletAutoLauncher
      kind="solana"
      autoStart={autoStart}
      auth={auth}
      disabled={false}
      loadingProvider={null}
      returnFocusTarget={returnFocusTarget}
      onAutoStartHandled={vi.fn()}
      onLoadingChange={vi.fn()}
      onSuccess={vi.fn()}
      onError={vi.fn()}
    />
  );
}

function ethereumLauncher() {
  return (
    <WalletAutoLauncher
      kind="ethereum"
      autoStart
      auth={auth}
      disabled={false}
      loadingProvider={null}
      onAutoStartHandled={vi.fn()}
      onLoadingChange={vi.fn()}
      onSuccess={vi.fn()}
      onError={vi.fn()}
    />
  );
}

describe("WalletAutoLauncher Solana modal focus", () => {
  beforeEach(() => {
    modalState.visible = false;
    modalState.setVisible.mockReset();
    evmWalletState.address = undefined;
    evmWalletState.isConnected = false;
    evmWalletState.connectors = [];
    evmWalletState.connectAsync.mockReset();
    evmWalletState.openConnectModal.mockReset();
    evmWalletState.signMessageAsync.mockReset();
    Reflect.deleteProperty(window, "ethereum");
    vi.stubGlobal(
      "requestAnimationFrame",
      (callback: FrameRequestCallback): number => {
        callback(0);
        return 1;
      },
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
  });

  afterEach(() => {
    cleanup();
    document.querySelector(".wallet-adapter-modal")?.remove();
    document.querySelector("[data-wallet-return-target]")?.remove();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("focuses a named wallet choice and restores the login trigger on close", async () => {
    const returnTarget = document.createElement("button");
    returnTarget.dataset.walletReturnTarget = "true";
    returnTarget.textContent = "Continue with a wallet";
    document.body.append(returnTarget);
    returnTarget.focus();

    const vendorModal = document.createElement("div");
    vendorModal.className = "wallet-adapter-modal";
    vendorModal.setAttribute("role", "dialog");
    vendorModal.setAttribute("aria-labelledby", "wallet-adapter-modal-title");
    vendorModal.innerHTML = `
      <h1 class="wallet-adapter-modal-title">Connect a wallet on Solana</h1>
      <button class="wallet-adapter-modal-button-close" type="button"></button>
      <ul class="wallet-adapter-modal-list">
        <li><button type="button">Phantom</button></li>
        <li><button type="button">Solflare</button></li>
      </ul>
    `;
    document.body.append(vendorModal);

    const rendered = render(launcher(returnTarget, true));
    expect(modalState.setVisible).toHaveBeenCalledWith(true);
    modalState.visible = true;
    rendered.rerender(launcher(returnTarget, true));

    const phantom = screen.getByRole("button", { name: "Phantom" });
    const close = screen.getByRole("button", { name: "Close" });
    expect(
      screen.getByRole("dialog", { name: "Connect a wallet on Solana" }),
    ).toBe(vendorModal);
    expect(vendorModal.querySelector(".wallet-adapter-modal-title")?.id).toBe(
      "wallet-adapter-modal-title",
    );
    await waitFor(() => expect(document.activeElement).toBe(phantom));
    expect(document.activeElement).not.toBe(close);

    modalState.visible = false;
    rendered.rerender(launcher(returnTarget, true));
    await waitFor(() => expect(document.activeElement).toBe(returnTarget));
  });

  it("opens RainbowKit when wagmi's generic injected connector has no provider", async () => {
    evmWalletState.connectors = [
      {
        id: "injected",
        name: "Injected",
        type: "injected",
        getProvider: vi.fn().mockResolvedValue(undefined),
      },
    ];

    render(ethereumLauncher());

    await waitFor(() =>
      expect(evmWalletState.openConnectModal).toHaveBeenCalledTimes(1),
    );
    expect(evmWalletState.connectAsync).not.toHaveBeenCalled();
  });
});
