/**
 * Verifies wallet-ready delivery ordering against a real iframe WindowProxy:
 * broadcasts wait for a matching committed origin across initial load and navigation.
 */
// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import type { RefObject } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserWorkspaceTab } from "../../api";
import {
  BROWSER_WALLET_READY_TYPE,
  BROWSER_WALLET_REQUEST_TYPE,
  BROWSER_WALLET_RESPONSE_TYPE,
  type BrowserWorkspaceWalletState,
  EMPTY_BROWSER_WORKSPACE_WALLET_STATE,
} from "./browser-workspace-wallet";
import { useBrowserWorkspaceWalletBridge } from "./useBrowserWorkspaceWalletBridge";

const TAB_ID = "tab-wallet";

function tab(url: string): BrowserWorkspaceTab {
  return {
    id: TAB_ID,
    title: new URL(url).hostname,
    url,
    visible: true,
  } as BrowserWorkspaceTab;
}

function walletState(pendingApprovals: number): BrowserWorkspaceWalletState {
  return {
    ...EMPTY_BROWSER_WORKSPACE_WALLET_STATE,
    pendingApprovals,
  };
}

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("useBrowserWorkspaceWalletBridge committed-origin ordering", () => {
  it("deduplicates ready broadcasts by redacted payload value across fresh poll objects", async () => {
    const iframe = document.createElement("iframe");
    document.body.append(iframe);
    const postMessage = vi
      .spyOn(iframe.contentWindow as Window, "postMessage")
      .mockImplementation(() => undefined);
    const readyCalls = () =>
      postMessage.mock.calls.filter(
        ([message]) =>
          (message as { type?: unknown }).type === BROWSER_WALLET_READY_TYPE,
      );
    const iframeRefs: RefObject<Map<string, HTMLIFrameElement | null>> = {
      current: new Map([[TAB_ID, iframe]]),
    };
    const activeTab = tab("https://wallet.example/app");
    let activeWalletState = walletState(4);
    const { rerender } = renderHook(() =>
      useBrowserWorkspaceWalletBridge({
        iframeRefs,
        workspaceTabs: [activeTab],
        walletState: activeWalletState,
        loadWalletState: async () => activeWalletState,
      }),
    );

    await act(async () => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: {
            type: BROWSER_WALLET_REQUEST_TYPE,
            requestId: "prove-origin",
            method: "getState",
          },
          origin: "https://wallet.example",
          source: iframe.contentWindow,
        }),
      );
      await Promise.resolve();
    });
    expect(readyCalls()).toHaveLength(1);

    const previousState = activeWalletState;
    activeWalletState = walletState(4);
    expect(activeWalletState).not.toBe(previousState);
    rerender();
    expect(readyCalls()).toHaveLength(1);

    activeWalletState = walletState(5);
    rerender();
    expect(readyCalls()).toHaveLength(2);
    expect(readyCalls().at(-1)).toEqual([
      {
        type: BROWSER_WALLET_READY_TYPE,
        state: expect.objectContaining({ pendingApprovals: 5 }),
      },
      "https://wallet.example",
    ]);

    const changedState = activeWalletState;
    activeWalletState = walletState(5);
    expect(activeWalletState).not.toBe(changedState);
    rerender();
    expect(readyCalls()).toHaveLength(2);
  });

  it("suppresses unproven and cross-origin transition broadcasts, then sends the latest state to the exact proven origin", async () => {
    const iframe = document.createElement("iframe");
    document.body.append(iframe);
    const postMessage = vi
      .spyOn(iframe.contentWindow as Window, "postMessage")
      .mockImplementation(() => undefined);
    const readyCalls = () =>
      postMessage.mock.calls.filter(
        ([message]) =>
          (message as { type?: unknown }).type === BROWSER_WALLET_READY_TYPE,
      );
    const iframeRefs: RefObject<Map<string, HTMLIFrameElement | null>> = {
      current: new Map([[TAB_ID, iframe]]),
    };
    const request = async (
      origin: string,
      requestId: string,
      method = "getState",
    ) => {
      await act(async () => {
        window.dispatchEvent(
          new MessageEvent("message", {
            data: {
              type: BROWSER_WALLET_REQUEST_TYPE,
              requestId,
              method,
            },
            origin,
            source: iframe.contentWindow,
          }),
        );
        await Promise.resolve();
      });
    };
    let activeTab = tab("https://a.example/page");
    let activeWalletState = walletState(1);

    const { result, rerender } = renderHook(() =>
      useBrowserWorkspaceWalletBridge({
        iframeRefs,
        workspaceTabs: [activeTab],
        walletState: activeWalletState,
        loadWalletState: async () => activeWalletState,
      }),
    );

    // The iframe still contains its inherited about:blank document here.
    // Posting to the requested HTTPS origin would be dropped and would emit a
    // browser warning, so readiness waits for a matching protocol message.
    expect(postMessage).not.toHaveBeenCalled();

    await request("null", "about-blank");
    expect(postMessage).not.toHaveBeenCalled();

    await request("https://a.example", "unknown-a", "future_method");
    expect(readyCalls()).toHaveLength(0);
    await vi.waitFor(() => {
      expect(postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: BROWSER_WALLET_RESPONSE_TYPE,
          requestId: "unknown-a",
          ok: false,
        }),
        "https://a.example",
      );
    });

    await request("https://a.example", "ready-a");
    expect(readyCalls()).toHaveLength(1);
    expect(readyCalls().at(-1)).toEqual([
      {
        type: BROWSER_WALLET_READY_TYPE,
        state: expect.objectContaining({ pendingApprovals: 1 }),
      },
      "https://a.example",
    ]);
    await vi.waitFor(() => {
      expect(postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: BROWSER_WALLET_RESPONSE_TYPE,
          requestId: "ready-a",
          ok: true,
        }),
        "https://a.example",
      );
    });
    await request("https://a.example", "duplicate-a");
    expect(readyCalls()).toHaveLength(1);

    activeWalletState = walletState(2);
    rerender();
    expect(readyCalls()).toHaveLength(2);
    expect(readyCalls().at(-1)).toEqual([
      {
        type: BROWSER_WALLET_READY_TYPE,
        state: expect.objectContaining({ pendingApprovals: 2 }),
      },
      "https://a.example",
    ]);

    act(() =>
      result.current.beginBrowserWalletFrameNavigation(
        TAB_ID,
        "https://b.example/next",
      ),
    );
    await request("https://a.example", "stale-a");
    expect(readyCalls()).toHaveLength(2);

    await request("https://b.example", "ready-b");
    expect(readyCalls()).toHaveLength(3);
    expect(readyCalls().at(-1)).toEqual([
      {
        type: BROWSER_WALLET_READY_TYPE,
        state: expect.objectContaining({ pendingApprovals: 2 }),
      },
      "https://b.example",
    ]);

    activeWalletState = walletState(3);
    rerender();
    expect(readyCalls()).toHaveLength(4);
    expect(readyCalls().at(-1)).toEqual([
      {
        type: BROWSER_WALLET_READY_TYPE,
        state: expect.objectContaining({ pendingApprovals: 3 }),
      },
      "https://b.example",
    ]);

    activeTab = tab("https://b.example/next");
    rerender();
    expect(readyCalls()).toHaveLength(4);

    await request("https://b.example", "duplicate-b");
    expect(readyCalls()).toHaveLength(4);

    act(() => result.current.revokeBrowserWalletFrame(TAB_ID));
    const callCountBeforeClosedRequest = postMessage.mock.calls.length;
    await request("https://b.example", "closed-b");
    expect(postMessage).toHaveBeenCalledTimes(callCountBeforeClosedRequest);
    expect(postMessage.mock.calls.map(([, origin]) => origin)).not.toContain(
      "*",
    );
  });
});
