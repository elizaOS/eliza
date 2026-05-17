// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the bridge module before importing the hook so the hook closes over
// the mocked `subscribeDesktopBridgeEvent`. We re-use a shared spy so each
// test can assert on subscribe/unsubscribe calls.
const subscribeSpy =
  vi.fn<
    (options: {
      rpcMessage: string;
      ipcChannel: string;
      listener: (payload: unknown) => void;
    }) => () => void
  >();
const unsubscribeSpy = vi.fn<() => void>();

vi.mock("../bridge/electrobun-rpc", () => ({
  subscribeDesktopBridgeEvent: (options: {
    rpcMessage: string;
    ipcChannel: string;
    listener: (payload: unknown) => void;
  }) => subscribeSpy(options),
}));

import { useDesktopBridgeEvent } from "./useDesktopBridgeEvent";

describe("useDesktopBridgeEvent", () => {
  beforeEach(() => {
    subscribeSpy.mockReset();
    unsubscribeSpy.mockReset();
    subscribeSpy.mockImplementation(() => unsubscribeSpy);
  });

  it("subscribes on mount and unsubscribes on unmount", () => {
    const handler = vi.fn();
    const { unmount } = renderHook(() =>
      useDesktopBridgeEvent({ rpcMessage: "msg", ipcChannel: "chan" }, handler),
    );

    expect(subscribeSpy).toHaveBeenCalledTimes(1);
    expect(subscribeSpy.mock.calls[0]?.[0]).toMatchObject({
      rpcMessage: "msg",
      ipcChannel: "chan",
    });

    unmount();
    expect(unsubscribeSpy).toHaveBeenCalledTimes(1);
  });

  it("invokes the latest handler when the bridge emits a payload", () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = renderHook(
      ({ handler }: { handler: (payload: unknown) => void }) =>
        useDesktopBridgeEvent({ rpcMessage: "m", ipcChannel: "c" }, handler),
      { initialProps: { handler: first } },
    );

    // The bridge captured the wrapper listener; calling it should forward
    // to the *current* handler ref, not the one passed at mount time.
    const listener = subscribeSpy.mock.calls[0]?.[0].listener;
    expect(typeof listener).toBe("function");

    rerender({ handler: second });
    listener?.({ value: 42 });

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith({ value: 42 });

    // Critically: re-rendering with a new handler does NOT cause a new
    // subscribe call, because the handler is captured via ref.
    expect(subscribeSpy).toHaveBeenCalledTimes(1);
  });

  it("re-subscribes when rpcMessage or ipcChannel changes", () => {
    const handler = vi.fn();
    const { rerender } = renderHook(
      ({ msg, chan }: { msg: string; chan: string }) =>
        useDesktopBridgeEvent({ rpcMessage: msg, ipcChannel: chan }, handler),
      { initialProps: { msg: "a", chan: "x" } },
    );

    expect(subscribeSpy).toHaveBeenCalledTimes(1);

    rerender({ msg: "b", chan: "x" });
    expect(unsubscribeSpy).toHaveBeenCalledTimes(1);
    expect(subscribeSpy).toHaveBeenCalledTimes(2);

    rerender({ msg: "b", chan: "y" });
    expect(unsubscribeSpy).toHaveBeenCalledTimes(2);
    expect(subscribeSpy).toHaveBeenCalledTimes(3);
  });
});
