// @vitest-environment jsdom

import { STEWARD_TOKEN_KEY } from "@elizaos/shared/steward-session-client";
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setBootConfig } from "../config/boot-config";

const clientCloudMocks = vi.hoisted(() => ({
  refreshCloudStewardSession: vi.fn(),
}));

vi.mock("../api/client-cloud", () => ({
  cloudTokenSecsRemaining: () => 0,
  refreshCloudStewardSession: clientCloudMocks.refreshCloudStewardSession,
}));

vi.mock("../bridge", () => ({
  invokeDesktopBridgeRequestWithTimeout: vi.fn(),
  isElectrobunRuntime: () => true,
}));

import { useCloudState } from "./useCloudState";

function makeParams() {
  return {
    setActionNotice: vi.fn(),
    loadWalletConfig: vi.fn(async () => {}),
    t: (key: string) => key,
  };
}

describe("useCloudState — Electrobun Steward refresh endpoint", () => {
  beforeEach(() => {
    localStorage.clear();
    setBootConfig({
      branding: {},
      cloudApiBase: "https://www.elizacloud.ai",
    });
    clientCloudMocks.refreshCloudStewardSession.mockReset();
    clientCloudMocks.refreshCloudStewardSession.mockResolvedValue({
      token: "fresh",
    });
  });

  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("uses the Cloud API refresh endpoint on Electrobun instead of the local origin", async () => {
    localStorage.setItem(STEWARD_TOKEN_KEY, "near-expiry-steward-jwt");

    renderHook(() => useCloudState(makeParams()));

    await waitFor(() =>
      expect(clientCloudMocks.refreshCloudStewardSession).toHaveBeenCalledWith({
        endpoint: "https://api.elizacloud.ai/api/auth/steward-refresh",
      }),
    );
  });
});
