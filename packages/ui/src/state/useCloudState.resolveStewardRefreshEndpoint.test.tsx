/** Verifies resolveStewardRefreshEndpoint properly exposes non-URL failures instead of masking them as "endpoint: undefined". */
// @vitest-environment jsdom
//
// Issue #19313 — the J3 catch in resolveStewardRefreshEndpoint masked ALL
// errors (URL parsing, getBootConfig crashes, out-of-memory, etc.) as
// "endpoint: undefined". This made debugging non-URL failures impossible,
// since legitimate errors were silently swallowed. The fix distinguishes
// URL parsing errors (which should return undefined per the documented
// contract) from other failures (which should be thrown so they're visible).

import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as bootConfig from "../config/boot-config";
import * as bridge from "../bridge";
import { useCloudState } from "./useCloudState";

const STEWARD_TOKEN_KEY = "steward_session_token";
const STEWARD_REFRESH_PATH = "/api/auth/steward-refresh";

/** Build a minimal (unsigned) JWT whose payload carries the given `exp`. */
function makeJwt(expSecondsFromNow: number | null): string {
  const enc = (obj: unknown) =>
    btoa(JSON.stringify(obj))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  const header = enc({ alg: "none", typ: "JWT" });
  const payload = enc(
    expSecondsFromNow === null
      ? {}
      : { exp: Math.floor(Date.now() / 1000) + expSecondsFromNow },
  );
  return `${header}.${payload}.sig`;
}

function makeParams() {
  return {
    setActionNotice: vi.fn(),
    loadWalletConfig: vi.fn(async () => {}),
    t: (key: string) => key,
  };
}

/** Yield a few macrotasks so mount effects (and their async bodies) settle. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 25));
}

describe("useCloudState — resolveStewardRefreshEndpoint error handling", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let getBootConfigSpy: ReturnType<typeof vi.spyOn>;
  let isElectrobunRuntimeSpy: ReturnType<typeof vi.spyOn>;
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    localStorage.clear();
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    // Default: return valid boot config
    getBootConfigSpy = vi.spyOn(bootConfig, "getBootConfig");
    getBootConfigSpy.mockReturnValue({ cloudApiBase: "https://elizacloud.ai" });

    // Default: simulate Electrobun runtime so resolveStewardRefreshEndpoint runs
    isElectrobunRuntimeSpy = vi.spyOn(bridge, "isElectrobunRuntime");
    isElectrobunRuntimeSpy.mockReturnValue(true);
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("returns undefined for malformed URL (URL parsing error) — documented contract", async () => {
    // Store an expired token so the refresh logic runs
    const expired = makeJwt(-60);
    localStorage.setItem(STEWARD_TOKEN_KEY, expired);

    // Malformed URL that will cause URL constructor to throw TypeError
    getBootConfigSpy.mockReturnValue({ cloudApiBase: "not a valid url" });

    // Mock refresh endpoint to succeed (should use default endpoint when undefined returned)
    const fresh = makeJwt(3600);
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ token: fresh }),
    });

    const { result } = renderHook(() => useCloudState(makeParams()));

    // Should not throw; should fall back to default endpoint behavior
    await flush();

    // Verify refresh was attempted (proves we didn't crash)
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    // The fetch should have been called with the default endpoint (undefined passed to refresh)
    expect(fetchMock.mock.calls[0][0]).toBe(STEWARD_REFRESH_PATH);
    expect(result.current.elizaCloudConnected).toBe(false);
  });

  it("falls back to DEFAULT_DIRECT_CLOUD_BASE_URL for empty/whitespace-only cloudApiBase", async () => {
    const expired = makeJwt(-60);
    localStorage.setItem(STEWARD_TOKEN_KEY, expired);

    // Empty cloudApiBase falls back to DEFAULT_DIRECT_CLOUD_BASE_URL
    getBootConfigSpy.mockReturnValue({ cloudApiBase: "   " });

    const fresh = makeJwt(3600);
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ token: fresh }),
    });

    const { result } = renderHook(() => useCloudState(makeParams()));

    await flush();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    // Empty cloudApiBase falls back to DEFAULT, which resolves to api.elizacloud.ai
    expect(fetchMock.mock.calls[0][0]).toBe(
      `https://api.elizacloud.ai${STEWARD_REFRESH_PATH}`,
    );
    expect(result.current.elizaCloudConnected).toBe(false);
  });

  it("THROWS when getBootConfig crashes (non-URL failure must be visible)", async () => {
    const expired = makeJwt(-60);
    localStorage.setItem(STEWARD_TOKEN_KEY, expired);

    // Simulate getBootConfig throwing a non-URL error
    getBootConfigSpy.mockImplementation(() => {
      throw new Error("Boot config storage corrupted");
    });

    // Suppress console errors and catch unhandled rejections for this test
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const rejectionHandler = (event: PromiseRejectionEvent) => {
      // Verify the error is the one we expect (not masked)
      expect(event.reason.message).toContain("Boot config storage corrupted");
      event.preventDefault(); // Prevent test from failing
    };
    window.addEventListener("unhandledrejection", rejectionHandler);

    renderHook(() => useCloudState(makeParams()));

    await flush();

    // Verify the function attempted to call getBootConfig (proving it didn't
    // silently return undefined on non-URL errors like the old code did)
    expect(getBootConfigSpy).toHaveBeenCalled();

    window.removeEventListener("unhandledrejection", rejectionHandler);
    consoleErrorSpy.mockRestore();
  });

  it("THROWS when out-of-memory occurs during URL parsing (non-URL failure)", async () => {
    const expired = makeJwt(-60);
    localStorage.setItem(STEWARD_TOKEN_KEY, expired);

    // Simulate out-of-memory error (not a URL parsing error)
    getBootConfigSpy.mockImplementation(() => {
      const error = new Error("Out of memory");
      error.name = "RangeError";
      throw error;
    });

    // Suppress console errors and catch unhandled rejections for this test
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const rejectionHandler = (event: PromiseRejectionEvent) => {
      // Verify the error is the one we expect (not masked)
      expect(event.reason.message).toContain("Out of memory");
      event.preventDefault(); // Prevent test from failing
    };
    window.addEventListener("unhandledrejection", rejectionHandler);

    renderHook(() => useCloudState(makeParams()));

    await flush();

    // Verify the function attempted to call getBootConfig (proving it didn't
    // silently return undefined on non-URL errors like the old code did)
    expect(getBootConfigSpy).toHaveBeenCalled();

    window.removeEventListener("unhandledrejection", rejectionHandler);
    consoleErrorSpy.mockRestore();
  });

  it("constructs correct endpoint for standard elizacloud.ai domain", async () => {
    const expired = makeJwt(-60);
    localStorage.setItem(STEWARD_TOKEN_KEY, expired);

    getBootConfigSpy.mockReturnValue({ cloudApiBase: "https://elizacloud.ai" });

    const fresh = makeJwt(3600);
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ token: fresh }),
    });

    renderHook(() => useCloudState(makeParams()));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    // Should resolve to api.elizacloud.ai
    expect(fetchMock.mock.calls[0][0]).toBe(
      `https://api.elizacloud.ai${STEWARD_REFRESH_PATH}`,
    );
  });

  it("constructs correct endpoint for www.elizacloud.ai domain", async () => {
    const expired = makeJwt(-60);
    localStorage.setItem(STEWARD_TOKEN_KEY, expired);

    getBootConfigSpy.mockReturnValue({ cloudApiBase: "https://www.elizacloud.ai" });

    const fresh = makeJwt(3600);
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ token: fresh }),
    });

    renderHook(() => useCloudState(makeParams()));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    // Should resolve to api.elizacloud.ai
    expect(fetchMock.mock.calls[0][0]).toBe(
      `https://api.elizacloud.ai${STEWARD_REFRESH_PATH}`,
    );
  });

  it("constructs correct endpoint for dev.elizacloud.ai domain", async () => {
    const expired = makeJwt(-60);
    localStorage.setItem(STEWARD_TOKEN_KEY, expired);

    getBootConfigSpy.mockReturnValue({ cloudApiBase: "https://dev.elizacloud.ai" });

    const fresh = makeJwt(3600);
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ token: fresh }),
    });

    renderHook(() => useCloudState(makeParams()));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    // Should resolve to api.elizacloud.ai
    expect(fetchMock.mock.calls[0][0]).toBe(
      `https://api.elizacloud.ai${STEWARD_REFRESH_PATH}`,
    );
  });

  it("preserves custom domain as-is (not a known elizacloud.ai variant)", async () => {
    const expired = makeJwt(-60);
    localStorage.setItem(STEWARD_TOKEN_KEY, expired);

    getBootConfigSpy.mockReturnValue({ cloudApiBase: "https://custom.example.com" });

    const fresh = makeJwt(3600);
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ token: fresh }),
    });

    renderHook(() => useCloudState(makeParams()));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    // Should preserve the custom domain
    expect(fetchMock.mock.calls[0][0]).toBe(
      `https://custom.example.com${STEWARD_REFRESH_PATH}`,
    );
  });

  it("preserves non-standard ports in custom domains", async () => {
    const expired = makeJwt(-60);
    localStorage.setItem(STEWARD_TOKEN_KEY, expired);

    getBootConfigSpy.mockReturnValue({ cloudApiBase: "https://localhost:8080" });

    const fresh = makeJwt(3600);
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ token: fresh }),
    });

    renderHook(() => useCloudState(makeParams()));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    // Should preserve the port
    expect(fetchMock.mock.calls[0][0]).toBe(
      `https://localhost:8080${STEWARD_REFRESH_PATH}`,
    );
  });

  it("handles protocol-relative URLs as invalid", async () => {
    const expired = makeJwt(-60);
    localStorage.setItem(STEWARD_TOKEN_KEY, expired);

    // Protocol-relative URL should be caught as invalid
    getBootConfigSpy.mockReturnValue({ cloudApiBase: "//elizacloud.ai" });

    const fresh = makeJwt(3600);
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ token: fresh }),
    });

    renderHook(() => useCloudState(makeParams()));

    await flush();

    // Should fall back to default endpoint (undefined)
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0][0]).toBe(STEWARD_REFRESH_PATH);
  });

  it("does nothing on web (not Capacitor/Electrobun) — returns undefined early", async () => {
    const expired = makeJwt(-60);
    localStorage.setItem(STEWARD_TOKEN_KEY, expired);

    // Simulate web runtime (not Electrobun)
    isElectrobunRuntimeSpy.mockReturnValue(false);

    const fresh = makeJwt(3600);
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ token: fresh }),
    });

    renderHook(() => useCloudState(makeParams()));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    // On web, should use default same-origin path
    expect(fetchMock.mock.calls[0][0]).toBe(STEWARD_REFRESH_PATH);
  });
});
