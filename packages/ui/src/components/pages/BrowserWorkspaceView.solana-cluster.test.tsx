/**
 * Verifies the desktop browser-workspace Solana bridge fails closed on an
 * unrecognized dApp network value. The real component renders in jsdom with
 * a stubbed <electrobun-webview> custom element, and the dApp request enters
 * through the same "host-message" event the Electrobun preload injects.
 * A dApp asking for "localnet" (or an unrecognizable chain) must receive an
 * error reply and the wallet API must never be called — before this contract
 * the request was forwarded without a cluster, which the wallet API reads as
 * its mainnet default. A recognized cluster still reaches the consent dialog
 * and forwards its resolved cluster; no network value at all still forwards
 * no cluster field.
 */
// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const desktopRuntime = vi.hoisted(() => ({ active: true }));

const authorityState = vi.hoisted(() => ({
  value: "profile-a\u0000https://same-agent.test",
}));

const apiBaseHarness = vi.hoisted(() => ({
  base: "https://remote-agent.example/api-root",
}));

const walletStateHarness = vi.hoisted(() => ({
  pendingApprovals: 0,
  plugins: [] as Array<{ name: string }>,
  walletAddresses: {
    evmAddress: null,
    solanaAddress: "TestSolanaBridgeAddress",
  },
  walletConfig: {
    selectedRpcProviders: {},
    legacyCustomChains: [],
    alchemyKeySet: false,
    infuraKeySet: false,
    ankrKeySet: false,
    heliusKeySet: false,
    birdeyeKeySet: false,
    evmChains: [],
    solanaSigningAvailable: true,
  },
}));

const sendBrowserSolanaTransaction = vi.hoisted(() => vi.fn());

const dappWorkspaceHarness = vi.hoisted(() => ({
  workspace: {
    mode: "desktop" as const,
    tabs: [
      {
        id: "tab-dapp",
        title: "Dapp",
        url: "https://www.dapp.example/",
        partition: "persist:test",
        visible: true,
        createdAt: "2026-10-02T00:00:00.000Z",
        updatedAt: "2026-10-02T00:00:00.000Z",
        lastFocusedAt: null,
      },
    ],
  },
}));

vi.mock("../../bridge/electrobun-runtime", () => ({
  isElectrobunRuntime: () => desktopRuntime.active,
}));

// This standalone page fixture has no connected runtime view installation.
// Catalog binding and reporting are exercised by the shell/catalog integration tests.
vi.mock("../../hooks/useAvailableViews", () => ({
  useAvailableViews: () => ({ views: [] }),
}));

vi.mock("../../hooks/useActiveAgentAuthority", () => ({
  useActiveAgentAuthority: () => authorityState.value,
  getActiveAgentAuthority: () => authorityState.value,
}));

vi.mock("../../utils/asset-url.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../utils/asset-url.js")>()),
  resolveApiUrl: (path: string) => `${apiBaseHarness.base}${path}`,
}));

vi.mock("../../utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../utils")>()),
  openExternalUrl: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../state", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../state")>();
  const state = {
    getStewardPending: async () =>
      Array.from(
        { length: walletStateHarness.pendingApprovals },
        (_, index) => ({ queueId: `pending-${index}` }),
      ),
    getStewardStatus: async () => null,
    setActionNotice: vi.fn(),
    t: (
      _key: string,
      options?: { defaultValue?: string } | Record<string, unknown>,
    ) =>
      typeof options === "object" &&
      options !== null &&
      "defaultValue" in options &&
      typeof options.defaultValue === "string"
        ? options.defaultValue
        : _key,
    plugins: walletStateHarness.plugins,
    uiTheme: "dark",
    walletAddresses: walletStateHarness.walletAddresses,
    walletConfig: walletStateHarness.walletConfig,
  };
  return {
    ...actual,
    useAppSelector: (selector: (s: typeof state) => unknown) => selector(state),
    useAppSelectorShallow: (selector: (s: typeof state) => unknown) =>
      selector(state),
  };
});

vi.mock("../../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api")>();
  return {
    ...actual,
    client: {
      ...actual.client,
      fetch: vi.fn().mockRejectedValue(new Error("no api in test")),
      getWalletConfig: vi.fn().mockRejectedValue(new Error("no api in test")),
      getBrowserWorkspace: vi
        .fn()
        .mockResolvedValue(dappWorkspaceHarness.workspace),
      openBrowserWorkspaceTab: vi
        .fn()
        .mockRejectedValue(new Error("no api in test")),
      navigateBrowserWorkspaceTab: vi
        .fn()
        .mockRejectedValue(new Error("no api in test")),
      closeBrowserWorkspaceTab: vi
        .fn()
        .mockRejectedValue(new Error("no api in test")),
      snapshotBrowserWorkspaceTab: vi
        .fn()
        .mockRejectedValue(new Error("no api in test")),
      sendBrowserSolanaTransaction,
    },
  };
});

import { client } from "../../api";
import { BrowserWorkspaceView } from "./BrowserWorkspaceView";

const TX_BASE64 = Buffer.from("test-tx-bytes").toString("base64");

// Minimal stand-in for Electrobun's <electrobun-webview> tag. Defined before
// the render so React creates real instances and the view registers its
// host-message handler through addEventListener, exactly as in production.
class FakeWebviewTag extends HTMLElement {
  executed: string[] = [];
  loadURL(): void {}
  reload(): void {}
  executeJavascript(js: string): void {
    this.executed.push(js);
  }
  on(event: string, handler: EventListener): void {
    this.addEventListener(event, handler);
  }
  off(event: string, handler: EventListener): void {
    this.removeEventListener(event, handler);
  }
  syncDimensions(): void {}
  toggleHidden(): void {}
  togglePassthrough(): void {}
}
if (!customElements.get("electrobun-webview")) {
  customElements.define("electrobun-webview", FakeWebviewTag);
}

function dappRequest(detail: {
  requestId: number;
  method: string;
  params: Record<string, unknown>;
}): CustomEvent {
  return new CustomEvent("host-message", {
    detail: {
      type: "__elizaWalletRequest",
      protocol: "solana",
      hostname: "www.dapp.example",
      ...detail,
    },
  });
}

async function renderWithDappTab(): Promise<FakeWebviewTag> {
  render(<BrowserWorkspaceView />);
  const tag = await waitFor(() => {
    const element = document.querySelector(
      "electrobun-webview",
    ) as FakeWebviewTag | null;
    expect(element).not.toBeNull();
    return element as FakeWebviewTag;
  });
  expect(screen.getByText("Dapp")).not.toBeNull();
  return tag;
}

async function dispatchWalletRequest(
  tag: FakeWebviewTag,
  event: CustomEvent,
): Promise<void> {
  await act(async () => {
    tag.dispatchEvent(event);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  desktopRuntime.active = true;
  authorityState.value = "profile-a\u0000https://same-agent.test";
  walletStateHarness.pendingApprovals = 0;
  sendBrowserSolanaTransaction.mockReset();
  sendBrowserSolanaTransaction.mockResolvedValue({
    address: "TestSolanaBridgeAddress",
    mode: "local-key",
    signedTransactionBase64: TX_BASE64,
    cluster: "mainnet",
  });
  vi.mocked(client.getBrowserWorkspace)
    .mockReset()
    .mockResolvedValue(dappWorkspaceHarness.workspace);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Browser workspace Solana dApp bridge cluster handling", () => {
  it("replies with an error for an unrecognized dApp cluster and never calls the wallet API", async () => {
    const tag = await renderWithDappTab();
    const callsBefore = tag.executed.length;

    await dispatchWalletRequest(
      tag,
      dappRequest({
        requestId: 1,
        method: "signAndSendTransaction",
        params: { transactionBase64: TX_BASE64, cluster: "localnet" },
      }),
    );

    expect(tag.executed.length).toBeGreaterThan(callsBefore);
    const reply = tag.executed.at(-1) as string;
    expect(reply).toContain("__elizaWalletReply(1,");
    expect(reply).toContain("Unsupported Solana cluster");
    expect(reply).toContain("localnet");
    expect(sendBrowserSolanaTransaction).not.toHaveBeenCalled();
    // The consent dialog must not ask the user to approve a request that
    // cannot be routed honestly.
    expect(screen.queryByText(/wants to send a Solana transaction/)).toBeNull();
  });

  it("replies with an error for an unrecognized dApp chain fallback", async () => {
    const tag = await renderWithDappTab();

    await dispatchWalletRequest(
      tag,
      dappRequest({
        requestId: 2,
        method: "signTransaction",
        params: { transactionBase64: TX_BASE64, chain: "mainent" },
      }),
    );

    const reply = tag.executed.at(-1) as string;
    expect(reply).toContain("__elizaWalletReply(2,");
    expect(reply).toContain("Unsupported Solana cluster");
    expect(sendBrowserSolanaTransaction).not.toHaveBeenCalled();
  });

  it("still sends a recognized dApp cluster through the consent dialog", async () => {
    const tag = await renderWithDappTab();

    await dispatchWalletRequest(
      tag,
      dappRequest({
        requestId: 3,
        method: "signAndSendTransaction",
        params: { transactionBase64: TX_BASE64, cluster: "DEVNET" },
      }),
    );

    const dialog = await screen.findByText(
      /wants to send a Solana transaction/,
    );
    expect(dialog).not.toBeNull();
    const dialogRoot = dialog.closest("[role='dialog']");
    expect(dialogRoot?.textContent ?? "").toContain("Cluster: devnet");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() =>
      expect(sendBrowserSolanaTransaction).toHaveBeenCalledTimes(1),
    );
    expect(sendBrowserSolanaTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        transactionBase64: TX_BASE64,
        broadcast: true,
        cluster: "devnet",
      }),
    );
    const reply = tag.executed.at(-1) as string;
    expect(reply).toContain("__elizaWalletReply(3,");
    expect(reply).toContain("result");
  });

  it("omits the cluster field only when the dApp sent no network value", async () => {
    const tag = await renderWithDappTab();

    await dispatchWalletRequest(
      tag,
      dappRequest({
        requestId: 4,
        method: "signAndSendTransaction",
        params: { transactionBase64: TX_BASE64 },
      }),
    );

    const dialog = await screen.findByText(
      /wants to send a Solana transaction/,
    );
    expect(dialog).not.toBeNull();
    // No Cluster line: the dApp expressed no network preference, and the
    // forwarded request omits the field for the server's documented default.
    const dialogRoot = dialog.closest("[role='dialog']");
    expect(dialogRoot?.textContent ?? "").not.toContain("Cluster:");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() =>
      expect(sendBrowserSolanaTransaction).toHaveBeenCalledTimes(1),
    );
    const forwarded = sendBrowserSolanaTransaction.mock.calls[0][0] as Record<
      string,
      unknown
    >;
    expect(forwarded.transactionBase64).toBe(TX_BASE64);
    expect("cluster" in forwarded).toBe(false);
  });
});
