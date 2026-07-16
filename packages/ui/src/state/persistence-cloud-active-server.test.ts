// @vitest-environment jsdom

/**
 * Active-server persistence for the Cloud path (`persistence` +
 * `startup-phase-restore`): the invariant that the Eliza Cloud control plane is
 * never persisted or restored as a runtime API base, plus token scrub. jsdom +
 * real `localStorage`; no network.
 */
import { logger } from "@elizaos/logger";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_BOOT_CONFIG, setBootConfig } from "../config/boot-config";
import { shellLocalStorage } from "../surface-realm-channel";
import { ELIZA_CLOUD_CONTROL_PLANE_HOSTS } from "../utils/cloud-agent-base";
import {
  createPersistedActiveServer,
  loadPersistedActiveServer,
  savePersistedActiveServer,
  scrubPersistedActiveServerToken,
} from "./persistence";
import {
  applyRestoredConnection,
  canRestoreActiveServer,
  reconcileMobileRestoredActiveServer,
} from "./startup-phase-restore";

describe("Cloud active server persistence", () => {
  const elizaWindow = window as typeof window & {
    __ELIZAOS_API_BASE__?: string;
  };

  beforeEach(() => {
    localStorage.clear();
    setBootConfig(DEFAULT_BOOT_CONFIG);
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

  it("keeps a provisioned cloud agent id separate from its runtime URL", () => {
    const server = createPersistedActiveServer({
      kind: "cloud",
      id: "cloud:agent-123",
      label: "Demo Agent",
      apiBase: "https://agent-runtime.example.test/",
      accessToken: "cloud-token",
    });

    expect(server).toEqual({
      id: "cloud:agent-123",
      kind: "cloud",
      label: "Demo Agent",
      apiBase: "https://agent-runtime.example.test",
      accessToken: "cloud-token",
    });

    savePersistedActiveServer(server);

    expect(loadPersistedActiveServer()).toEqual(server);
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
        isDesktop: false,
      }),
    ).toBe(false);
  });

  it("restores the persisted mobile on-device agent IPC record (issue: iOS local cold launch re-onboarded every boot)", () => {
    // `eliza-local-agent://ipc` is a native Capacitor IPC identity, not a
    // network host. The remote-host trust gate (http/https only) must not
    // drop it — dropping it clears the saved server + first-run flag and
    // bounces every iOS/Android local-mode launch back into onboarding.
    expect(
      canRestoreActiveServer({
        server: {
          id: "local:mobile",
          kind: "remote",
          label: "On-device agent",
          apiBase: "eliza-local-agent://ipc",
        },
        clientApiAvailable: false,
        isDesktop: false,
      }),
    ).toBe(true);
  });

  it("applies the mobile on-device agent IPC record without dropping it as an untrusted remote", async () => {
    const setBaseUrl = vi.fn();
    const setToken = vi.fn();
    savePersistedActiveServer(
      createPersistedActiveServer({
        id: "local:mobile",
        kind: "remote",
        label: "On-device agent",
        apiBase: "eliza-local-agent://ipc",
      }),
    );

    await applyRestoredConnection({
      restoredActiveServer: {
        id: "local:mobile",
        kind: "remote",
        label: "On-device agent",
        apiBase: "eliza-local-agent://ipc",
      },
      clientRef: { setBaseUrl, setToken },
    });

    expect(setBaseUrl).toHaveBeenCalledWith("eliza-local-agent://ipc");
    // The SECURITY backstop for untrusted remotes must NOT clear the record.
    expect(loadPersistedActiveServer()).toEqual(
      expect.objectContaining({ apiBase: "eliza-local-agent://ipc" }),
    );
  });

  it("restores a Cloud session with a recoverable agent id even when the apiBase is missing", () => {
    // backfillCloudApiBase recovers the runtime base from `cloud:<agentId>`, so
    // a returning user is not forced back through onboarding just because the
    // persisted base was absent. Only an id-less / URL-as-id session is dropped.
    expect(
      canRestoreActiveServer({
        server: {
          id: "cloud:agent-123",
          kind: "cloud",
          label: "Demo Agent",
          accessToken: "cloud-token",
        },
        clientApiAvailable: true,
        isDesktop: false,
      }),
    ).toBe(true);
  });

  it("keeps a dedicated Eliza Cloud active server dedicated on restore", async () => {
    const server = createPersistedActiveServer({
      kind: "cloud",
      id: "cloud:agent-dedicated",
      label: "Demo Agent",
      apiBase: "https://agent-dedicated.elizacloud.ai/",
      accessToken: "cloud-token",
    });
    savePersistedActiveServer(server);
    const setBaseUrl = vi.fn();
    const setToken = vi.fn();

    await applyRestoredConnection({
      restoredActiveServer: server,
      clientRef: { setBaseUrl, setToken },
    });

    const expectedApiBase = "https://agent-dedicated.elizacloud.ai";
    expect(setBaseUrl).toHaveBeenCalledWith(expectedApiBase);
    expect(setToken).toHaveBeenCalledWith("cloud-token");
    expect(loadPersistedActiveServer()).toEqual(
      expect.objectContaining({
        id: "cloud:agent-dedicated",
        kind: "cloud",
        apiBase: expectedApiBase,
      }),
    );
  });

  it("preserves a shared adapter until server-authoritative tier selection", async () => {
    const server = createPersistedActiveServer({
      kind: "cloud",
      id: "cloud:agent-dedicated",
      label: "Demo Agent",
      apiBase: "https://api.elizacloud.ai/api/v1/eliza/agents/agent-dedicated",
      accessToken: "cloud-token",
    });
    savePersistedActiveServer(server);
    const setBaseUrl = vi.fn();
    const setToken = vi.fn();

    await applyRestoredConnection({
      restoredActiveServer: server,
      clientRef: { setBaseUrl, setToken },
    });

    const expectedApiBase =
      "https://api.elizacloud.ai/api/v1/eliza/agents/agent-dedicated";
    expect(setBaseUrl).toHaveBeenCalledWith(expectedApiBase);
    expect(setToken).toHaveBeenCalledWith("cloud-token");
    expect(loadPersistedActiveServer()).toEqual(
      expect.objectContaining({
        id: "cloud:agent-dedicated",
        kind: "cloud",
        apiBase: expectedApiBase,
      }),
    );
  });

  it("preserves the injected desktop API base when restoring a local session", async () => {
    setBootConfig({
      ...DEFAULT_BOOT_CONFIG,
      apiBase: "http://127.0.0.1:31337",
    });
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

  it("scrubs the at-rest access token on sign-out but keeps the server selection", () => {
    savePersistedActiveServer(
      createPersistedActiveServer({
        kind: "cloud",
        id: "cloud:agent-1",
        label: "Demo Agent",
        apiBase: "https://agent-runtime.example.test/",
        accessToken: "jwt-to-scrub",
      }),
    );

    scrubPersistedActiveServerToken();

    const after = loadPersistedActiveServer();
    expect(after?.accessToken).toBeUndefined();
    expect(after).toEqual(
      expect.objectContaining({
        id: "cloud:agent-1",
        kind: "cloud",
        label: "Demo Agent",
        apiBase: "https://agent-runtime.example.test",
      }),
    );
  });

  it("scrubbing the token is a safe no-op when nothing is persisted", () => {
    expect(() => scrubPersistedActiveServerToken()).not.toThrow();
    expect(loadPersistedActiveServer()).toBeNull();
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

  it("keeps the on-device agent record under cloud-hybrid (#16065 LP3 re-onboarded every cold launch)", () => {
    // cloud-hybrid = on-device agent chat + cloud inference, so the persisted
    // on-device record is valid. Rejecting it here (returning null) cleared the
    // record + reset first-run on every cold launch, bouncing a returning hybrid
    // user into onboarding while the still-booting agent (~30s on the LP3) was
    // unreachable. `undefined` = keep the record as-is.
    const server = {
      id: "local:android",
      kind: "remote" as const,
      label: "On-device agent",
      apiBase: "eliza-local-agent://ipc",
    };
    expect(
      reconcileMobileRestoredActiveServer({
        platform: "android",
        mobileRuntimeMode: "cloud-hybrid",
        server,
      }),
    ).toBeUndefined();
  });

  it("keeps the on-device agent record under local (the committed on-device sibling of cloud-hybrid)", () => {
    const server = {
      id: "local:mobile",
      kind: "remote" as const,
      label: "On-device agent",
      apiBase: "eliza-local-agent://ipc",
    };
    expect(
      reconcileMobileRestoredActiveServer({
        platform: "ios",
        mobileRuntimeMode: "local",
        server,
      }),
    ).toBeUndefined();
  });

  it("drops the on-device agent record for a non-agent mode (pure cloud never runs a bundled agent)", () => {
    // A persisted on-device record with a mode that runs NO bundled agent
    // (`cloud`, `remote-mac`, `tunnel-to-mobile`) is genuinely stale — return
    // null so restore clears it and lets the user re-onboard to the chosen mode.
    const server = {
      id: "local:android",
      kind: "remote" as const,
      label: "On-device agent",
      apiBase: "eliza-local-agent://ipc",
    };
    expect(
      reconcileMobileRestoredActiveServer({
        platform: "android",
        mobileRuntimeMode: "cloud",
        server,
      }),
    ).toBeNull();
    expect(
      reconcileMobileRestoredActiveServer({
        platform: "android",
        mobileRuntimeMode: "remote-mac",
        server,
      }),
    ).toBeNull();
  });

  it("logs a warning instead of silently swallowing a failed active-server persist", () => {
    const server = createPersistedActiveServer({
      id: "cloud:agent-warn",
      kind: "cloud",
      label: "Demo Agent",
      apiBase: "https://agent-runtime.example.test",
      accessToken: "cloud-token",
    });
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const setItemSpy = vi
      .spyOn(shellLocalStorage, "setItem")
      .mockImplementation(() => {
        throw new DOMException("quota exceeded", "QuotaExceededError");
      });

    try {
      // Callers treat device persistence as best-effort, but its failure must
      // stay observable because losing a recovered apiBase retriggers backfill.
      expect(() => savePersistedActiveServer(server)).not.toThrow();
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0]?.[0]).toMatch(
        /\[persistence\] failed to save active server/,
      );
    } finally {
      setItemSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  describe("control-plane host set anti-drift (#15740)", () => {
    it("canonical control-plane host set includes the staging hosts", () => {
      expect(ELIZA_CLOUD_CONTROL_PLANE_HOSTS.has("staging.elizacloud.ai")).toBe(
        true,
      );
      expect(
        ELIZA_CLOUD_CONTROL_PLANE_HOSTS.has("api-staging.elizacloud.ai"),
      ).toBe(true);
    });

    it("never persists any canonical control-plane host as a runtime apiBase", () => {
      for (const host of ELIZA_CLOUD_CONTROL_PLANE_HOSTS) {
        const server = createPersistedActiveServer({
          kind: "cloud",
          apiBase: `https://${host}/`,
          accessToken: "cloud-token",
        });
        expect(
          server.apiBase,
          `bare control-plane origin for ${host} must not be persisted`,
        ).toBeUndefined();
      }
    });

    it("drops a staging control-plane origin without an agent id", () => {
      const server = createPersistedActiveServer({
        kind: "cloud",
        apiBase: "https://staging.elizacloud.ai/",
        accessToken: "cloud-token",
      });
      expect(server.apiBase).toBeUndefined();
      expect(server.accessToken).toBe("cloud-token");
    });
  });

  describe("repair of persisted control-plane origins (#15740)", () => {
    it("repairs and re-persists a stored bare staging origin on load", () => {
      localStorage.setItem(
        "elizaos:active-server",
        JSON.stringify({
          id: "cloud:https://staging.elizacloud.ai",
          kind: "cloud",
          label: "Eliza Cloud",
          apiBase: "https://staging.elizacloud.ai",
          accessToken: "cloud-token",
        }),
      );

      const restored = loadPersistedActiveServer();
      expect(restored?.apiBase).toBeUndefined();
      expect(restored?.accessToken).toBe("cloud-token");

      const rawAfter = JSON.parse(
        localStorage.getItem("elizaos:active-server") ?? "null",
      );
      expect(rawAfter).not.toBeNull();
      expect(rawAfter.apiBase).toBeUndefined();
      expect(rawAfter.accessToken).toBe("cloud-token");

      expect(loadPersistedActiveServer()?.apiBase).toBeUndefined();
    });

    it("leaves a concrete per-agent cloud base untouched (no spurious repair)", () => {
      const setItemSpy = vi.spyOn(Storage.prototype, "setItem");
      try {
        savePersistedActiveServer(
          createPersistedActiveServer({
            kind: "cloud",
            id: "cloud:agent-xyz",
            label: "Demo Agent",
            apiBase: "https://agent-xyz.example.test/",
            accessToken: "cloud-token",
          }),
        );
        setItemSpy.mockClear();

        const restored = loadPersistedActiveServer();
        expect(restored?.apiBase).toBe("https://agent-xyz.example.test");
        expect(setItemSpy).not.toHaveBeenCalled();
      } finally {
        setItemSpy.mockRestore();
      }
    });
  });
});
