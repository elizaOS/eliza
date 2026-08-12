/** Verifies that trusted app shells, but not plain web pages, may poll Cloud account state through a dedicated agent binding. */
// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { client } from "../api";

const bridgeState = vi.hoisted(() => ({ electrobun: false }));

vi.mock("../bridge", () => ({
  invokeDesktopBridgeRequestWithTimeout: vi.fn(),
  isElectrobunRuntime: () => bridgeState.electrobun,
}));

import { useCloudState } from "./useCloudState";

const DEDICATED_AGENT_BASE =
  "https://11111111-1111-4111-8111-111111111111.elizacloud.ai";

function makeParams() {
  return {
    setActionNotice: vi.fn(),
    loadWalletConfig: vi.fn(async () => {}),
    t: (key: string) => key,
  };
}

describe("useCloudState — dedicated-agent status polling gate", () => {
  let getCloudStatusSpy: ReturnType<typeof vi.spyOn>;
  let getCloudCreditsSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    localStorage.clear();
    bridgeState.electrobun = false;
    vi.spyOn(client, "getBaseUrl").mockReturnValue(DEDICATED_AGENT_BASE);
    getCloudStatusSpy = vi.spyOn(client, "getCloudStatus").mockResolvedValue({
      enabled: true,
      connected: true,
      hasApiKey: true,
      cloudVoiceProxyAvailable: true,
      userId: "desktop-user",
    });
    getCloudCreditsSpy = vi.spyOn(client, "getCloudCredits").mockResolvedValue({
      connected: true,
      balance: 25,
      low: false,
      critical: false,
    });
  });

  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("polls through the supported direct Cloud transport in Electrobun", async () => {
    bridgeState.electrobun = true;
    const { result, unmount } = renderHook(() => useCloudState(makeParams()));

    let connected = false;
    await act(async () => {
      connected = await result.current.pollCloudCredits();
    });

    expect(connected).toBe(true);
    expect(getCloudStatusSpy).toHaveBeenCalledTimes(1);
    expect(getCloudCreditsSpy).toHaveBeenCalledTimes(1);
    expect(result.current.elizaCloudConnected).toBe(true);
    expect(result.current.elizaCloudCredits).toBe(25);
    unmount();
  });

  it("keeps a plain web page on a dedicated agent outside the full-shell polling boundary", async () => {
    const { result, unmount } = renderHook(() => useCloudState(makeParams()));

    let connected = true;
    await act(async () => {
      connected = await result.current.pollCloudCredits();
    });

    expect(connected).toBe(false);
    expect(getCloudStatusSpy).not.toHaveBeenCalled();
    expect(getCloudCreditsSpy).not.toHaveBeenCalled();
    expect(result.current.elizaCloudConnected).toBe(false);
    unmount();
  });
});
