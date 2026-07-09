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

  it("repairs a stale shared-adapter cloud active server back to the dedicated runtime on restore", async () => {
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
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new DOMException("quota exceeded", "QuotaExceededError");
      });

    try {
      // A failed persist must not throw (callers treat it as best-effort) but
      // must surface a diagnostic — previously this was swallowed silently, so
      // a lost freshly-recovered apiBase re-triggered backfill on every boot.
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

  // #15740 config-drift family (same as #15731): persistence.ts hand-copied the
  // control-plane host set and it drifted — the copy was missing the staging
  // hosts, so on staging.elizacloud.ai / api-staging the bare id-less origin was
  // classified as a concrete per-agent base and PERSISTED, then restored on
  // reload so every /api/* call 404'd ("Backend Unreachable").
  describe("control-plane host set anti-drift (#15740)", () => {
    // The canonical set is the single source of truth. Assert it still contains
    // the staging hosts so a future edit to cloud-agent-base can't silently
    // reintroduce the drift that this fix imports away.
    it("canonical control-plane host set includes the staging hosts", () => {
      expect(ELIZA_CLOUD_CONTROL_PLANE_HOSTS.has("staging.elizacloud.ai")).toBe(
        true,
      );
      expect(
        ELIZA_CLOUD_CONTROL_PLANE_HOSTS.has("api-staging.elizacloud.ai"),
      ).toBe(true);
    });

    // The behavioral anti-drift assertion: because persistence.ts now imports
    // the canonical set, EVERY control-plane host it recognizes is dropped as a
    // runtime apiBase. Drive it through createPersistedActiveServer for every
    // host in the canonical set — the bare origin must never be persisted. This
    // fails if the local hand-copy is ever reintroduced and drifts again.
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

    // The regression proper: a staging bare origin (the exact host missing from
    // the drifted copy) must be dropped. Pre-fix this was persisted as a
    // concrete base and wedged the staging PWA.
    it("drops the staging bare control-plane origin (the drifted-away host)", () => {
      const server = createPersistedActiveServer({
        kind: "cloud",
        apiBase: "https://staging.elizacloud.ai/",
        accessToken: "cloud-token",
      });
      expect(server.apiBase).toBeUndefined();
      expect(server.accessToken).toBe("cloud-token");
    });
  });

  // Self-heal: a user who already hit #15740 has the bare staging origin sitting
  // in localStorage. Loading must repair it AND write the repaired record back
  // so the wedge is permanently cleared without the user clearing storage — the
  // difference between "fixed for new sessions" and "fixed for Shadow's phone".
  describe("self-heal of already-persisted bad control-plane origin (#15740)", () => {
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

      // The write-back happened: the raw stored value no longer carries the bare
      // origin, so a second load (or any other reader) is already clean.
      const rawAfter = JSON.parse(
        localStorage.getItem("elizaos:active-server") ?? "null",
      );
      expect(rawAfter).not.toBeNull();
      expect(rawAfter.apiBase).toBeUndefined();
      expect(rawAfter.accessToken).toBe("cloud-token");

      // Idempotent: loading again yields the same repaired record.
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
        // No write-back for a healthy record.
        expect(setItemSpy).not.toHaveBeenCalled();
      } finally {
        setItemSpy.mockRestore();
      }
    });
  });
});
