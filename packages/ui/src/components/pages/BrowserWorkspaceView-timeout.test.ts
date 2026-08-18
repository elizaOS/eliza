/** Verifies BrowserWorkspaceView bridge hops pass timeoutMs through ElizaClient.fetch. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BROWSER_BRIDGE_CHROME_BUILD_FETCH_TIMEOUT_MS,
  BROWSER_BRIDGE_COMPANIONS_FETCH_TIMEOUT_MS,
  BROWSER_BRIDGE_OPEN_MANAGER_FETCH_TIMEOUT_MS,
  BROWSER_BRIDGE_OPEN_PATH_FETCH_TIMEOUT_MS,
  BROWSER_BRIDGE_PACKAGES_FETCH_TIMEOUT_MS,
  buildBrowserBridgeChromePackage,
  fetchBrowserBridgeCompanions,
  fetchBrowserBridgePackages,
  openBrowserBridgeChromeManager,
  revealBrowserBridgeOpenPath,
} from "./BrowserWorkspaceView";

const { fetchMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
}));

describe("BrowserWorkspaceView native-complete deadlines", () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it("keeps a documented budget per hop", () => {
    expect(BROWSER_BRIDGE_COMPANIONS_FETCH_TIMEOUT_MS).toBe(10_000);
    expect(BROWSER_BRIDGE_PACKAGES_FETCH_TIMEOUT_MS).toBe(10_000);
    expect(BROWSER_BRIDGE_CHROME_BUILD_FETCH_TIMEOUT_MS).toBe(10_000);
    expect(BROWSER_BRIDGE_OPEN_PATH_FETCH_TIMEOUT_MS).toBe(10_000);
    expect(BROWSER_BRIDGE_OPEN_MANAGER_FETCH_TIMEOUT_MS).toBe(10_000);
  });

  it("passes companions timeoutMs through client.fetch", async () => {
    fetchMock.mockResolvedValue({ companions: [] });
    await fetchBrowserBridgeCompanions({ fetch: fetchMock });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/browser-bridge/companions",
      undefined,
      { timeoutMs: BROWSER_BRIDGE_COMPANIONS_FETCH_TIMEOUT_MS },
    );
  });

  it("passes packages timeoutMs through client.fetch", async () => {
    fetchMock.mockResolvedValue({ status: { chromeBuildPath: "/tmp" } });
    await fetchBrowserBridgePackages({ fetch: fetchMock });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/browser-bridge/packages",
      undefined,
      { timeoutMs: BROWSER_BRIDGE_PACKAGES_FETCH_TIMEOUT_MS },
    );
  });

  it("passes chrome-build timeoutMs through client.fetch", async () => {
    fetchMock.mockResolvedValue({ status: { chromeBuildPath: "/tmp" } });
    await buildBrowserBridgeChromePackage({ fetch: fetchMock });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/browser-bridge/packages/chrome/build",
      { method: "POST" },
      { timeoutMs: BROWSER_BRIDGE_CHROME_BUILD_FETCH_TIMEOUT_MS },
    );
  });

  it("passes open-path timeoutMs through client.fetch", async () => {
    fetchMock.mockResolvedValue({
      path: "/tmp/bridge",
      target: "chrome_build",
      revealOnly: true,
    });
    await revealBrowserBridgeOpenPath({ fetch: fetchMock });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/browser-bridge/packages/open-path",
      {
        method: "POST",
        body: JSON.stringify({
          target: "chrome_build",
          revealOnly: true,
        }),
      },
      { timeoutMs: BROWSER_BRIDGE_OPEN_PATH_FETCH_TIMEOUT_MS },
    );
  });

  it("passes open-manager timeoutMs through client.fetch", async () => {
    fetchMock.mockResolvedValue({ ok: true });
    await openBrowserBridgeChromeManager({ fetch: fetchMock });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/browser-bridge/packages/chrome/open-manager",
      { method: "POST" },
      { timeoutMs: BROWSER_BRIDGE_OPEN_MANAGER_FETCH_TIMEOUT_MS },
    );
  });

  it("aborts a stalled open-manager hop as TimeoutError", async () => {
    const timeout = Object.assign(new Error("Request timed out after 10ms"), {
      name: "ApiError",
      kind: "timeout",
    });
    fetchMock.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          setTimeout(() => reject(timeout), 10);
        }),
    );
    await expect(
      openBrowserBridgeChromeManager({ fetch: fetchMock }, 10),
    ).rejects.toMatchObject({ name: "ApiError", kind: "timeout" });
  });

  it("surfaces a provider error from a completed companions GET", async () => {
    fetchMock.mockRejectedValue(
      Object.assign(new Error("Companions request failed (503)"), {
        name: "ApiError",
        kind: "http",
        status: 503,
      }),
    );
    await expect(
      fetchBrowserBridgeCompanions({ fetch: fetchMock }),
    ).rejects.toMatchObject({ status: 503 });
  });
});
