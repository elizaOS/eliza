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

  it("reacts to NETWORK_STATUS_CHANGE_EVENT", () => {
    const { result } = renderHook(() => useShellState());
    act(() => result.current.send({ type: "BOOT_READY" }));
    expect(result.current.state.isOnline).toBe(true);
    act(() => {
      const detail: NetworkStatusChangeDetail = { isOnline: false };
      window.dispatchEvent(
        new CustomEvent(NETWORK_STATUS_CHANGE_EVENT, { detail }),
      );
    });
    expect(result.current.state.isOnline).toBe(false);
  });
});
