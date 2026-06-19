// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyLaunchConnectionFromUrl } from "./browser-launch";

const mocks = vi.hoisted(() => ({
  createPersistedActiveServer: vi.fn((input) => ({
    id: "test-server",
    ...input,
  })),
  getBootConfig: vi.fn(() => ({ cloudApiBase: "https://api.elizacloud.ai" })),
  savePersistedActiveServer: vi.fn(),
  setBaseUrl: vi.fn(),
  setToken: vi.fn(),
}));

vi.mock("../api", () => ({
  client: {
    setBaseUrl: mocks.setBaseUrl,
    setToken: mocks.setToken,
  },
}));

vi.mock("../config/boot-config-store", () => ({
  getBootConfig: mocks.getBootConfig,
}));

vi.mock("../state/persistence", () => ({
  createPersistedActiveServer: mocks.createPersistedActiveServer,
  savePersistedActiveServer: mocks.savePersistedActiveServer,
}));

describe("browser launch connection handling", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    mocks.createPersistedActiveServer.mockImplementation((input) => ({
      id: "test-server",
      ...input,
    }));
    mocks.getBootConfig.mockReturnValue({
      cloudApiBase: "https://api.elizacloud.ai",
    });
    window.history.replaceState(null, "", "http://localhost/");
  });

  it("ignores raw token launch parameters and strips them from the URL", async () => {
    window.history.replaceState(
      null,
      "",
      "http://localhost/?apiBase=http%3A%2F%2F127.0.0.1%3A31337&token=secret",
    );

    await expect(applyLaunchConnectionFromUrl()).resolves.toBe(false);

    expect(window.location.href).toBe("http://localhost/");
    expect(mocks.setBaseUrl).not.toHaveBeenCalled();
    expect(mocks.savePersistedActiveServer).not.toHaveBeenCalled();
  });

  it("allows the configured cloud API host without accepting arbitrary public HTTPS", async () => {
    window.history.replaceState(
      null,
      "",
      "http://localhost/?apiBase=https%3A%2F%2Fapi.elizacloud.ai%2Fv1%2F",
    );

    await expect(applyLaunchConnectionFromUrl()).resolves.toBe(true);

    expect(mocks.setBaseUrl).toHaveBeenCalledWith(
      "https://api.elizacloud.ai/v1",
    );
    expect(mocks.setToken).toHaveBeenCalledWith(null);
    expect(mocks.savePersistedActiveServer).toHaveBeenCalledWith(
      expect.objectContaining({
        apiBase: "https://api.elizacloud.ai/v1",
        kind: "remote",
      }),
    );
    expect(window.location.href).toBe("http://localhost/");
  });

  it("rejects unconfigured public HTTPS apiBase parameters", async () => {
    window.history.replaceState(
      null,
      "",
      "http://localhost/?apiBase=https%3A%2F%2Fevil.example",
    );

    await expect(applyLaunchConnectionFromUrl()).rejects.toThrow(
      "Rejected invalid launch apiBase",
    );

    expect(mocks.setBaseUrl).not.toHaveBeenCalled();
    expect(mocks.savePersistedActiveServer).not.toHaveBeenCalled();
  });

  it("rejects configured cloud API hosts over plaintext HTTP", async () => {
    window.history.replaceState(
      null,
      "",
      "http://localhost/?apiBase=http%3A%2F%2Fapi.elizacloud.ai",
    );

    await expect(applyLaunchConnectionFromUrl()).rejects.toThrow(
      "Rejected invalid launch apiBase",
    );

    expect(mocks.setBaseUrl).not.toHaveBeenCalled();
    expect(mocks.savePersistedActiveServer).not.toHaveBeenCalled();
  });

  it("exchanges managed cloud launch sessions before applying runtime credentials", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        success: true,
        data: {
          connection: {
            apiBase: "https://agent-1.elizacloud.ai",
            token: "runtime-token",
          },
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    window.history.replaceState(
      null,
      "",
      "http://localhost/?cloudLaunchSession=launch-1&cloudLaunchBase=https%3A%2F%2Fapi.elizacloud.ai",
    );

    await expect(applyLaunchConnectionFromUrl()).resolves.toBe(true);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.elizacloud.ai/api/v1/eliza/launch-sessions/launch-1",
      expect.objectContaining({
        headers: { Accept: "application/json" },
        method: "GET",
        redirect: "manual",
      }),
    );
    expect(mocks.setBaseUrl).toHaveBeenCalledWith(
      "https://agent-1.elizacloud.ai",
    );
    expect(mocks.setToken).toHaveBeenCalledWith("runtime-token");
    expect(mocks.savePersistedActiveServer).toHaveBeenCalledWith(
      expect.objectContaining({
        accessToken: "runtime-token",
        apiBase: "https://agent-1.elizacloud.ai",
        kind: "cloud",
      }),
    );
    expect(window.location.href).toBe("http://localhost/");
  });
});
