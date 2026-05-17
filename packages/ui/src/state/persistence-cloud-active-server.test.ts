// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createPersistedActiveServer,
  loadPersistedActiveServer,
  savePersistedActiveServer,
} from "./persistence";
import {
  applyRestoredConnection,
  canRestoreActiveServer,
  reconcileMobileRestoredActiveServer,
} from "./startup-phase-restore";

describe("Cloud active server persistence", () => {
  const elizaWindow = window as typeof window & {
    __ELIZA_API_BASE__?: string;
    __ELIZAOS_API_BASE__?: string;
  };

  beforeEach(() => {
    localStorage.clear();
    Reflect.deleteProperty(elizaWindow, "__ELIZA_API_BASE__");
    Reflect.deleteProperty(elizaWindow, "__ELIZAOS_API_BASE__");
  });

  it("does not persist the Eliza Cloud control plane as a runtime API base", () => {
    const server = createPersistedActiveServer({
      kind: "cloud",
      apiBase: "https://api.elizacloud.ai/",
      accessToken: "cloud-token",
    });

    expect(server.apiBase).toBeUndefined();
    expect(server.accessToken).toBe("cloud-token");

    savePersistedActiveServer(server);

    expect(loadPersistedActiveServer()).toEqual(
      expect.objectContaining({
        kind: "cloud",
        label: "Eliza Cloud",
        accessToken: "cloud-token",
      }),
    );
    expect(loadPersistedActiveServer()?.apiBase).toBeUndefined();
  });

  it("normalizes legacy saved Cloud control-plane records", () => {
    localStorage.setItem(
      "elizaos:active-server",
      JSON.stringify({
        id: "cloud:https://api.elizacloud.ai",
        kind: "cloud",
        label: "Eliza Cloud",
        apiBase: "https://api.elizacloud.ai",
        accessToken: "cloud-token",
      }),
    );

    const restored = loadPersistedActiveServer();

    expect(restored).toEqual(
      expect.objectContaining({
        kind: "cloud",
        accessToken: "cloud-token",
      }),
    );
    expect(restored?.apiBase).toBeUndefined();
  });

  it("does not restore Cloud sessions without a runtime bridge URL", () => {
    expect(
      canRestoreActiveServer({
        server: {
          id: "cloud:https://api.elizacloud.ai",
          kind: "cloud",
          label: "Eliza Cloud",
          accessToken: "cloud-token",
        },
        clientApiAvailable: true,
        forceLocal: false,
        isDesktop: false,
      }),
    ).toBe(false);
  });

  it("preserves the injected desktop API base when restoring a local session", async () => {
    elizaWindow.__ELIZA_API_BASE__ = "http://127.0.0.1:31337";
    const setBaseUrl = vi.fn();
    const setToken = vi.fn();
    const startLocalRuntime = vi.fn().mockResolvedValue(undefined);

    await applyRestoredConnection({
      restoredActiveServer: {
        id: "local",
        kind: "local",
        label: "Local Agent",
      },
      clientRef: { setBaseUrl, setToken },
      startLocalRuntime,
    });

    expect(setBaseUrl).toHaveBeenCalledWith("http://127.0.0.1:31337");
    expect(setToken).not.toHaveBeenCalled();
    expect(startLocalRuntime).toHaveBeenCalledTimes(1);
  });

  it("rewrites persisted iOS loopback local agents to the IPC identity", () => {
    expect(
      reconcileMobileRestoredActiveServer({
        platform: "ios",
        mobileRuntimeMode: "local",
        server: {
          id: "remote:http://127.0.0.1:31337",
          kind: "remote",
          label: "127.0.0.1:31337",
          apiBase: "http://127.0.0.1:31337",
        },
      }),
    ).toEqual({
      id: "local:mobile",
      kind: "remote",
      label: "On-device agent",
      apiBase: "eliza-local-agent://ipc",
    });
  });
});
