/** Verifies browser launch connection handling through the package's configured test harness. */
// @vitest-environment jsdom

/**
 * Covers `applyLaunchConnectionFromUrl`: a launch URL's connection params are
 * parsed into a persisted active server + agent profile and pushed into the API
 * client (base URL + token). The API client, boot-config, and persistence
 * layers are mocked so the URL→connection wiring is under test in isolation.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyLaunchConnection,
  applyLaunchConnectionFromUrl,
} from "./browser-launch";

const mocks = vi.hoisted(() => ({
  createPersistedActiveServer: vi.fn((input) => ({
    id: "test-server",
    label: "Test Server",
    ...input,
  })),
  getBootConfig: vi.fn(() => ({ cloudApiBase: "https://api.elizacloud.ai" })),
  savePersistedActiveServer: vi.fn(),
  upsertAndActivateAgentProfile: vi.fn(),
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

vi.mock("../state/agent-profiles", () => ({
  upsertAndActivateAgentProfile: mocks.upsertAndActivateAgentProfile,
}));

describe("browser launch connection handling", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
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

  it("allows trusted private apiBase parameters and syncs the profile registry", async () => {
    window.history.replaceState(
      null,
      "",
      "http://localhost/?apiBase=http%3A%2F%2F100.96.0.1%3A31337%2Fv1%2F",
    );

    await expect(applyLaunchConnectionFromUrl()).resolves.toBe(true);

    expect(mocks.setBaseUrl).toHaveBeenCalledWith("http://100.96.0.1:31337/v1");
    expect(mocks.setToken).toHaveBeenCalledWith(null);
    expect(mocks.savePersistedActiveServer).toHaveBeenCalledWith(
      expect.objectContaining({
        apiBase: "http://100.96.0.1:31337/v1",
        kind: "remote",
      }),
    );
    // The agent-profile registry is kept in sync so the connection shows up in
    // "My Runtimes" (guards the cross-surface state-drift bug).
    expect(mocks.upsertAndActivateAgentProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "remote",
        apiBase: "http://100.96.0.1:31337/v1",
      }),
    );
    expect(window.location.href).toBe("http://localhost/");
  });

  it("rejects public cloud apiBase parameters outside the managed launch-session flow", async () => {
    window.history.replaceState(
      null,
      "",
      "http://localhost/?apiBase=https%3A%2F%2Fagent-1.elizacloud.ai%2F",
    );

    await expect(applyLaunchConnectionFromUrl()).rejects.toThrow(
      "Rejected invalid launch apiBase",
    );

    expect(mocks.setBaseUrl).not.toHaveBeenCalled();
    expect(mocks.savePersistedActiveServer).not.toHaveBeenCalled();
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

  it("rejects Settings-style remote connect calls to arbitrary public HTTPS", () => {
    expect(() =>
      applyLaunchConnection({
        kind: "remote",
        apiBase: "https://agent.attacker.example/",
        token: "secret-token",
      }),
    ).toThrow("Rejected invalid launch apiBase");

    expect(mocks.setBaseUrl).not.toHaveBeenCalled();
    expect(mocks.setToken).not.toHaveBeenCalled();
    expect(mocks.savePersistedActiveServer).not.toHaveBeenCalled();
  });

  it("allows Settings-style remote connect calls to trusted private URLs", () => {
    expect(
      applyLaunchConnection({
        kind: "remote",
        apiBase: "https://my-box.local:31337/",
        token: " secret-token ",
      }),
    ).toEqual({
      apiBase: "https://my-box.local:31337",
      token: "secret-token",
    });

    expect(mocks.setBaseUrl).toHaveBeenCalledWith("https://my-box.local:31337");
    expect(mocks.setToken).toHaveBeenCalledWith("secret-token");
    expect(mocks.savePersistedActiveServer).toHaveBeenCalledWith(
      expect.objectContaining({
        accessToken: "secret-token",
        apiBase: "https://my-box.local:31337",
        kind: "remote",
      }),
    );
    expect(mocks.upsertAndActivateAgentProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        accessToken: "secret-token",
        apiBase: "https://my-box.local:31337",
        kind: "remote",
      }),
    );
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

  it("rejects managed cloud launch sessions that return a non-cloud public runtime URL", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        success: true,
        data: {
          connection: {
            apiBase: "https://agent.attacker.example",
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

    await expect(applyLaunchConnectionFromUrl()).rejects.toThrow(
      "Rejected invalid launch apiBase",
    );

    expect(mocks.setBaseUrl).not.toHaveBeenCalled();
    expect(mocks.savePersistedActiveServer).not.toHaveBeenCalled();
  });
});
