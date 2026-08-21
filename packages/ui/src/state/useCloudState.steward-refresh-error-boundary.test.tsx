/**
 * Exercises the native Steward refresh endpoint boundary through useCloudState.
 *
 * The deterministic jsdom harness replaces the Cloud transport and endpoint
 * resolver collaborators while retaining the production hook lifecycle, so it
 * can distinguish malformed configured input from an unexpected resolver
 * defect without contacting Steward.
 */
// @vitest-environment jsdom

import { logger } from "@elizaos/logger";
import { STEWARD_TOKEN_KEY } from "@elizaos/shared/steward-session-client";
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setBootConfig } from "../config/boot-config";

const clientCloudMocks = vi.hoisted(() => ({
  refreshCloudStewardSession: vi.fn(),
  replaceStoredStewardTokenIfCurrent: vi.fn(),
  resolveDirectCloudAuthApiBase: vi.fn(),
}));

vi.mock("@elizaos/shared/steward-session-client", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@elizaos/shared/steward-session-client")
  >()),
  replaceStoredStewardTokenIfCurrent:
    clientCloudMocks.replaceStoredStewardTokenIfCurrent,
}));

vi.mock("../api/client-cloud", () => ({
  cloudTokenSecsRemaining: () => 0,
  refreshCloudStewardSession: clientCloudMocks.refreshCloudStewardSession,
  resolveDirectCloudAuthApiBase: clientCloudMocks.resolveDirectCloudAuthApiBase,
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

function armStewardRefresh(): void {
  localStorage.setItem(STEWARD_TOKEN_KEY, "near-expiry-steward-jwt");
  renderHook(() => useCloudState(makeParams()));
}

describe("useCloudState — Steward refresh endpoint error boundary", () => {
  beforeEach(() => {
    localStorage.clear();
    setBootConfig({
      branding: {},
      cloudApiBase: "https://api.example.com",
    });
    clientCloudMocks.refreshCloudStewardSession.mockReset();
    clientCloudMocks.refreshCloudStewardSession.mockResolvedValue({
      token: "fresh",
    });
    clientCloudMocks.replaceStoredStewardTokenIfCurrent.mockReset();
    clientCloudMocks.replaceStoredStewardTokenIfCurrent.mockImplementation(
      async (expectedToken: string, replacementToken: string) => {
        if (localStorage.getItem(STEWARD_TOKEN_KEY) !== expectedToken) {
          return false;
        }
        localStorage.setItem(STEWARD_TOKEN_KEY, replacementToken);
        return true;
      },
    );
    clientCloudMocks.resolveDirectCloudAuthApiBase.mockReset();
    clientCloudMocks.resolveDirectCloudAuthApiBase.mockImplementation(
      (base: string) => base,
    );
  });

  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("passes a validated configured API endpoint to the Electrobun refresh", async () => {
    armStewardRefresh();

    await waitFor(() =>
      expect(clientCloudMocks.refreshCloudStewardSession).toHaveBeenCalledWith({
        endpoint: "https://api.example.com/api/auth/steward-refresh",
      }),
    );
  });

  it("uses the documented default endpoint for malformed configured input", async () => {
    setBootConfig({ branding: {}, cloudApiBase: "not a URL" });

    armStewardRefresh();

    await waitFor(() =>
      expect(clientCloudMocks.refreshCloudStewardSession).toHaveBeenCalledWith({
        endpoint: undefined,
      }),
    );
  });

  it("reports an unexpected resolver failure without fabricating an endpoint", async () => {
    const resolverFailure = new Error("resolver unavailable");
    clientCloudMocks.resolveDirectCloudAuthApiBase.mockImplementationOnce(
      () => {
        throw resolverFailure;
      },
    );
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

    armStewardRefresh();

    await waitFor(() =>
      expect(warn).toHaveBeenCalledWith(
        { err: resolverFailure },
        "[useCloudState] steward session refresh failed",
      ),
    );
    expect(clientCloudMocks.refreshCloudStewardSession).not.toHaveBeenCalled();
  });

  it("observes protected persistence denial without publishing the refreshed token", async () => {
    const persistenceFailure = new Error("native secure store denied");
    clientCloudMocks.replaceStoredStewardTokenIfCurrent.mockRejectedValueOnce(
      persistenceFailure,
    );
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

    armStewardRefresh();

    await waitFor(() =>
      expect(warn).toHaveBeenCalledWith(
        { err: persistenceFailure },
        "[useCloudState] steward session refresh failed",
      ),
    );
    expect(localStorage.getItem(STEWARD_TOKEN_KEY)).toBe(
      "near-expiry-steward-jwt",
    );
  });

  it("does not restore a refreshed token after logout wins the race", async () => {
    let releaseRefresh: (value: { token: string }) => void = () => {};
    clientCloudMocks.refreshCloudStewardSession.mockReturnValueOnce(
      new Promise((resolve) => {
        releaseRefresh = resolve;
      }),
    );

    armStewardRefresh();
    await waitFor(() =>
      expect(clientCloudMocks.refreshCloudStewardSession).toHaveBeenCalled(),
    );
    localStorage.removeItem(STEWARD_TOKEN_KEY);
    releaseRefresh({ token: "stale-refreshed-token" });

    await waitFor(() =>
      expect(
        clientCloudMocks.replaceStoredStewardTokenIfCurrent,
      ).toHaveBeenCalledWith(
        "near-expiry-steward-jwt",
        "stale-refreshed-token",
      ),
    );
    expect(localStorage.getItem(STEWARD_TOKEN_KEY)).toBeNull();
  });
});
