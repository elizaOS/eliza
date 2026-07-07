// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://app.elizacloud.ai/" }
//
// `useCloudState.handleCloudLogin` popup→same-tab fallback (#15143). On hosted
// web (direct cloud auth, no agent proxy) a dead popup handle — null from a
// blocked pre-open, on any browser — must navigate THIS tab to the same-origin
// /login page with a returnTo instead of starting a device-code session whose
// popup would never open, and must leave the first-run cloud-resume marker
// intact for the round trip. A live popup handle keeps the device-code popup
// flow. jsdom pinned to a hosted elizacloud origin with the API client mocked.

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { client } from "../api";
import {
  markCloudLoginPending,
  readCloudLoginPending,
} from "../first-run/first-run-cloud-resume";
import { useCloudState } from "./useCloudState";

const DEVICE_CODE_SENTINEL = "device-code-flow-reached";

function makeParams() {
  return {
    setActionNotice: vi.fn(),
    loadWalletConfig: vi.fn(async () => {}),
    t: (key: string) => key,
  };
}

describe("useCloudState — handleCloudLogin same-tab fallback on hosted web", () => {
  let assignSpy: ReturnType<typeof vi.fn>;
  let cloudLoginSpy: ReturnType<typeof vi.spyOn>;
  let cloudLoginDirectSpy: ReturnType<typeof vi.spyOn>;
  const originalLocationDescriptor = Object.getOwnPropertyDescriptor(
    window,
    "location",
  );

  beforeEach(() => {
    localStorage.clear();
    assignSpy = vi.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...window.location, assign: assignSpy },
    });
    cloudLoginSpy = vi.spyOn(client, "cloudLogin").mockResolvedValue({
      ok: false,
      sessionId: "",
      browserUrl: "",
      error: DEVICE_CODE_SENTINEL,
    });
    cloudLoginDirectSpy = vi
      .spyOn(client, "cloudLoginDirect")
      .mockResolvedValue({
        ok: false,
        sessionId: "",
        browserUrl: "",
        error: DEVICE_CODE_SENTINEL,
      });
  });

  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
    if (originalLocationDescriptor) {
      Object.defineProperty(window, "location", originalLocationDescriptor);
    }
  });

  const deviceCodeCalls = () =>
    cloudLoginSpy.mock.calls.length + cloudLoginDirectSpy.mock.calls.length;

  it("a dead popup handle navigates same-tab to /login with returnTo and starts no device-code session", async () => {
    const { result } = renderHook(() => useCloudState(makeParams()));
    await act(async () => {
      await result.current.handleCloudLogin(null);
    });

    expect(assignSpy).toHaveBeenCalledTimes(1);
    expect(assignSpy).toHaveBeenCalledWith("/login?returnTo=%2F");
    expect(deviceCodeCalls()).toBe(0);
    expect(result.current.elizaCloudLoginBusy).toBe(false);
    expect(result.current.elizaCloudLoginError).toBeNull();
  });

  it("leaves the first-run cloud-resume marker intact across the redirect leg", async () => {
    markCloudLoginPending({
      runtime: "cloud",
      localInference: "cloud-inference",
      agentName: "Eliza",
    });

    const { result } = renderHook(() => useCloudState(makeParams()));
    await act(async () => {
      await result.current.handleCloudLogin(null);
    });

    expect(assignSpy).toHaveBeenCalledWith("/login?returnTo=%2F");
    expect(readCloudLoginPending()).toEqual({
      runtime: "cloud",
      localInference: "cloud-inference",
      agentName: "Eliza",
    });
  });

  it("a live popup handle keeps the device-code popup flow (no same-tab navigation)", async () => {
    const popup = {
      closed: false,
      close: vi.fn(),
      location: { href: "" },
      opener: {},
    } as unknown as Window;

    const { result } = renderHook(() => useCloudState(makeParams()));
    await act(async () => {
      await result.current.handleCloudLogin(popup);
    });

    expect(assignSpy).not.toHaveBeenCalled();
    expect(cloudLoginDirectSpy).toHaveBeenCalledTimes(1);
    expect(result.current.elizaCloudLoginError).toBe(DEVICE_CODE_SENTINEL);
  });
});
