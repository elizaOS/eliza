/** Verifies useCloudState — Electrobun Steward refresh endpoint through the package's configured test harness. */
// @vitest-environment jsdom

/**
 * Steward token-refresh arming under Electrobun (`useCloudState`): the
 * desktop-runtime branch of the stored-token lifecycle refresh. jsdom with the
 * cloud client, desktop bridge, and boot config mocked — no real Steward
 * service.
 */
import { ELIZA_DOMAIN_CONTRACTS } from "@elizaos/shared/elizacloud";
import { STEWARD_TOKEN_KEY } from "@elizaos/shared/steward-session-client";
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setBootConfig } from "../config/boot-config";

const clientCloudMocks = vi.hoisted(() => ({
  refreshCloudStewardSession: vi.fn(),
}));

// Spread the real module: `useCloudState` also imports
// `resolveDirectCloudAuthApiBase` from here, and a total-replacement mock makes
// that import throw inside `resolveStewardRefreshEndpoint`, where the catch
// swallows it and yields `endpoint: undefined` instead of the real endpoint.
vi.mock("../api/client-cloud", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/client-cloud")>()),
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
        // Legacy elizacloud.ai bases resolve onto the canonical Cloud API
        // origin, so derive it rather than pinning a second copy of the domain.
        endpoint: `${ELIZA_DOMAIN_CONTRACTS.production.cloudApiOrigin}/api/auth/steward-refresh`,
      }),
    );
  });
});
