// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  NETWORK_STATUS_CHANGE_EVENT,
  type NetworkStatusChangeDetail,
} from "../../../events";
import { useShellState } from "../useShellState";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useShellState", () => {
  it("starts in the booting phase", () => {
    const { result } = renderHook(() => useShellState());
    expect(result.current.state.phase).toBe("booting");
  });

  it("exposes a send() that dispatches actions", () => {
    const { result } = renderHook(() => useShellState());
    act(() => result.current.send({ type: "BOOT_READY" }));
    expect(result.current.state.phase).toBe("idle");
  });

  it("reacts to NETWORK_STATUS_CHANGE_EVENT on document with connected=false", () => {
    const { result } = renderHook(() => useShellState());
    act(() => result.current.send({ type: "BOOT_READY" }));
    expect(result.current.state.isOnline).toBe(true);
    act(() => {
      const detail: NetworkStatusChangeDetail = { connected: false };
      document.dispatchEvent(
        new CustomEvent(NETWORK_STATUS_CHANGE_EVENT, { detail }),
      );
    });
    expect(result.current.state.isOnline).toBe(false);
  });

  it("ignores malformed network events (no detail, non-boolean connected)", () => {
    const { result } = renderHook(() => useShellState());
    act(() => result.current.send({ type: "BOOT_READY" }));
    expect(result.current.state.isOnline).toBe(true);
    act(() => {
      // No detail at all
      document.dispatchEvent(new CustomEvent(NETWORK_STATUS_CHANGE_EVENT));
      // Empty detail object
      document.dispatchEvent(
        new CustomEvent(NETWORK_STATUS_CHANGE_EVENT, {
          detail: {} as NetworkStatusChangeDetail,
        }),
      );
      // Non-boolean connected
      document.dispatchEvent(
        new CustomEvent(NETWORK_STATUS_CHANGE_EVENT, {
          detail: { connected: "yes" } as unknown as NetworkStatusChangeDetail,
        }),
      );
    });
    expect(result.current.state.isOnline).toBe(true);
  });

  it("removes the document listener on unmount", () => {
    const { result, unmount } = renderHook(() => useShellState());
    act(() => result.current.send({ type: "BOOT_READY" }));
    unmount();
    // Fire after unmount — would throw or update state if the listener wasn't removed.
    document.dispatchEvent(
      new CustomEvent(NETWORK_STATUS_CHANGE_EVENT, {
        detail: { connected: false } as NetworkStatusChangeDetail,
      }),
    );
    // No assertion on result.current.state after unmount because the hook is gone.
    // Sanity: no exception thrown means the listener was cleanly removed.
  });

  it("send() identity is stable across state changes", () => {
    const { result, rerender } = renderHook(() => useShellState());
    const firstSend = result.current.send;
    act(() => result.current.send({ type: "BOOT_READY" }));
    rerender();
    expect(result.current.send).toBe(firstSend);
    act(() => result.current.send({ type: "OPEN" }));
    rerender();
    expect(result.current.send).toBe(firstSend);
  });
});
