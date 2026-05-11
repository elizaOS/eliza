import { describe, expect, it, vi } from "vitest";
import type { BrowserWorkspaceTab } from "../../api";
import {
  type BrowserWorkspaceWalletRequest,
  type BrowserWorkspaceWalletState,
  EMPTY_BROWSER_WORKSPACE_WALLET_STATE,
  getUnsupportedBrowserWorkspaceEvmChainError,
  parseBrowserWorkspaceEvmChainId,
  resolveBrowserWorkspaceSignMessage,
} from "./browser-workspace-wallet";
import {
  dispatchBrowserWorkspaceWalletRequest,
  redactBrowserWorkspaceIframeWalletState,
} from "./useBrowserWorkspaceWalletBridge";

vi.mock("../../api", () => ({
  client: {
    sendBrowserSolanaTransaction: vi.fn(),
    sendBrowserWalletTransaction: vi.fn(),
    signBrowserSolanaMessage: vi.fn(),
    signBrowserWalletMessage: vi.fn(),
  },
}));

const EVM_ADDRESS = "0x1111111111111111111111111111111111111111";

function walletState(
  overrides: Partial<BrowserWorkspaceWalletState> = {},
): BrowserWorkspaceWalletState {
  return {
    ...EMPTY_BROWSER_WORKSPACE_WALLET_STATE,
    address: EVM_ADDRESS,
    connected: true,
    evmAddress: EVM_ADDRESS,
    evmConnected: true,
    mode: "local",
    messageSigningAvailable: true,
    transactionSigningAvailable: true,
    chainSwitchingAvailable: true,
    signingAvailable: true,
    ...overrides,
  };
}

function request(
  method: BrowserWorkspaceWalletRequest["method"],
  params?: unknown,
): BrowserWorkspaceWalletRequest {
  return {
    type: "ELIZA_BROWSER_WALLET_REQUEST",
    requestId: `${method}-1`,
    method,
    params,
  };
}

function tab(): BrowserWorkspaceTab {
  return {
    id: "tab-1",
    title: "Example",
    url: "https://example.com",
    visible: true,
  } as BrowserWorkspaceTab;
}

describe("browser workspace wallet helpers", () => {
  it("resolves personal_sign message from both common parameter orders", () => {
    expect(
      resolveBrowserWorkspaceSignMessage([EVM_ADDRESS, "hello"], EVM_ADDRESS),
    ).toBe("hello");
    expect(
      resolveBrowserWorkspaceSignMessage(["hello", EVM_ADDRESS], EVM_ADDRESS),
    ).toBe("hello");
    expect(
      resolveBrowserWorkspaceSignMessage(
        [EVM_ADDRESS.toUpperCase(), "hello"],
        EVM_ADDRESS,
      ),
    ).toBe("hello");
  });

  it("parses decimal and hexadecimal EVM chain IDs", () => {
    expect(parseBrowserWorkspaceEvmChainId("0x1")).toBe(1);
    expect(parseBrowserWorkspaceEvmChainId("8453")).toBe(8453);
    expect(parseBrowserWorkspaceEvmChainId(42161)).toBe(42161);
    expect(parseBrowserWorkspaceEvmChainId("0x")).toBeNull();
    expect(parseBrowserWorkspaceEvmChainId(-1)).toBeNull();
  });
});

describe("dispatchBrowserWorkspaceWalletRequest", () => {
  it("redacts iframe wallet state and account access until consent exists", async () => {
    const state = walletState({
      solanaAddress: "FRxMiVKjLwghX4DySdchACz3Gk2bHpv1pW5ydLzK2LQ",
      solanaConnected: true,
      solanaMessageSigningAvailable: true,
      solanaTransactionSigningAvailable: true,
    });
    expect(redactBrowserWorkspaceIframeWalletState(state)).toMatchObject({
      address: null,
      connected: false,
      evmAddress: null,
      evmConnected: false,
      solanaAddress: null,
      solanaConnected: false,
      signingAvailable: false,
    });

    const ctx = {
      sourceTab: tab(),
      walletState: state,
      tabChainId: 1,
      setTabChainId: vi.fn(),
      loadWalletState: vi.fn(),
      postWalletReady: vi.fn(),
      walletStateRef: {
        current: state,
      },
    };

    await expect(
      dispatchBrowserWorkspaceWalletRequest(request("getState"), ctx),
    ).resolves.toMatchObject({
      ok: true,
      result: {
        evmAddress: null,
        solanaAddress: null,
      },
    });
    await expect(
      dispatchBrowserWorkspaceWalletRequest(request("eth_accounts"), ctx),
    ).resolves.toEqual({ ok: true, result: [] });
    await expect(
      dispatchBrowserWorkspaceWalletRequest(
        request("eth_requestAccounts"),
        ctx,
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("account access is disabled"),
    });
    await expect(
      dispatchBrowserWorkspaceWalletRequest(request("solana_connect"), ctx),
    ).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("account access is disabled"),
    });
  });

  it("rejects iframe signing and transactions until iframe consent exists", async () => {
    const ctx = {
      sourceTab: tab(),
      walletState: walletState(),
      tabChainId: 1,
      setTabChainId: vi.fn(),
      loadWalletState: vi.fn(),
      postWalletReady: vi.fn(),
      walletStateRef: {
        current: walletState(),
      },
    };

    const blockedRequests: Array<{
      method: BrowserWorkspaceWalletRequest["method"];
      params?: unknown;
    }> = [
      { method: "personal_sign", params: ["hello", EVM_ADDRESS] },
      { method: "eth_sign", params: [EVM_ADDRESS, "hello"] },
      {
        method: "eth_sendTransaction",
        params: [{ to: EVM_ADDRESS, value: "0x0" }],
      },
      { method: "sendTransaction", params: { to: EVM_ADDRESS, value: "0x0" } },
      { method: "solana_signMessage", params: { message: "hello" } },
      {
        method: "solana_signTransaction",
        params: { transactionBase64: "AQID" },
      },
      {
        method: "solana_signAndSendTransaction",
        params: { transactionBase64: "AQID" },
      },
    ];

    for (const blocked of blockedRequests) {
      await expect(
        dispatchBrowserWorkspaceWalletRequest(
          request(blocked.method, blocked.params),
          ctx,
        ),
      ).resolves.toMatchObject({
        ok: false,
        error: expect.stringContaining("disabled in embedded iframe tabs"),
      });
    }
    expect(ctx.setTabChainId).not.toHaveBeenCalled();
    expect(ctx.loadWalletState).not.toHaveBeenCalled();
  });

  it("returns explicit unsupported typed-data responses", async () => {
    await expect(
      dispatchBrowserWorkspaceWalletRequest(
        request("eth_signTypedData_v4", []),
        {
          sourceTab: tab(),
          walletState: walletState(),
          tabChainId: 1,
          setTabChainId: vi.fn(),
          loadWalletState: vi.fn(),
          postWalletReady: vi.fn(),
          walletStateRef: {
            current: walletState(),
          },
        },
      ),
    ).resolves.toEqual({
      ok: false,
      error: "Typed-data signing is not supported by the Eliza browser wallet.",
    });
  });

  it("restricts wallet_switchEthereumChain to supported chains", async () => {
    const setTabChainId = vi.fn();
    const postWalletReady = vi.fn();
    const ctx = {
      sourceTab: tab(),
      walletState: walletState(),
      tabChainId: 1,
      setTabChainId,
      loadWalletState: vi.fn(),
      postWalletReady,
      walletStateRef: {
        current: walletState(),
      },
    };

    await expect(
      dispatchBrowserWorkspaceWalletRequest(
        request("wallet_switchEthereumChain", [{ chainId: "0x2105" }]),
        ctx,
      ),
    ).resolves.toEqual({ ok: true, result: null });
    expect(setTabChainId).toHaveBeenCalledWith(8453);
    expect(postWalletReady).toHaveBeenCalledOnce();

    setTabChainId.mockClear();
    postWalletReady.mockClear();
    await expect(
      dispatchBrowserWorkspaceWalletRequest(
        request("wallet_switchEthereumChain", [{ chainId: "0x539" }]),
        ctx,
      ),
    ).resolves.toEqual({
      ok: false,
      error: getUnsupportedBrowserWorkspaceEvmChainError(1337),
    });
    expect(setTabChainId).not.toHaveBeenCalled();
    expect(postWalletReady).not.toHaveBeenCalled();
  });
});
