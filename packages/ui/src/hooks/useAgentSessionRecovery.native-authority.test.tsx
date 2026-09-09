/** Exercises real in-process pairing and credential persistence against a held native secure-store transport. */
// @vitest-environment jsdom

import {
  clearStoredStewardToken,
  writeStoredStewardToken,
} from "@elizaos/shared/steward-session-client";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { client } from "../api";
import {
  getStorageValue,
  initializeStorageBridge,
  setStorageValue,
} from "../bridge/storage-bridge";
import { setBootConfig } from "../config/boot-config";
import { getActiveProfile } from "../state/agent-profiles";
import {
  loadPersistedActiveServer,
  savePersistedActiveServer,
} from "../state/persistence";
import { useAgentSessionRecovery } from "./useAgentSessionRecovery";

const native = vi.hoisted(() => ({
  values: new Map<string, string>(),
  hold: null as Promise<void> | null,
  entered: false,
  denyRollback: false,
}));
vi.mock("@capacitor/core", async (importOriginal) => {
  const original = await importOriginal<typeof import("@capacitor/core")>();
  return {
    ...original,
    Capacitor: {
      ...original.Capacitor,
      getPlatform: () => "android",
      isNativePlatform: () => true,
    },
  };
});
vi.mock("@capacitor/preferences", () => ({
  Preferences: {
    get: async () => ({ value: null }),
    set: async () => {},
    remove: async () => {},
  },
}));
vi.mock("@elizaos/capacitor-secure-store", () => ({
  ElizaSecureStore: {
    get: async ({ key }: { key: string }) =>
      native.values.has(key)
        ? { ok: true, value: native.values.get(key) }
        : { ok: false, error: "not_found" },
    set: async ({ key, value }: { key: string; value: string }) => {
      if (
        native.denyRollback &&
        key === "runtime.active_server" &&
        value.includes("old-agent-bearer")
      )
        return { ok: false };
      if (
        key === "runtime.active_server" &&
        value.includes("fresh-paired-bearer") &&
        native.hold
      ) {
        native.entered = true;
        await native.hold;
      }
      native.values.set(key, value);
      return { ok: true };
    },
    remove: async ({ key }: { key: string }) => ({
      ok: true,
      deleted: native.values.delete(key),
    }),
  },
}));
vi.mock("./useAuthStatus", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./useAuthStatus")>()),
  useIsAuthenticated: () => false,
}));

const agentId = "11111111-1111-4111-8111-111111111111";
const base = `https://${agentId}.elizacloud.ai`;
const initialServer = {
  id: `cloud:${agentId}`,
  kind: "cloud" as const,
  label: "Test Agent",
  apiBase: base,
  accessToken: "old-agent-bearer",
};

describe("native recovery credential commit lifetime", () => {
  beforeAll(async () => {
    await initializeStorageBridge();
  });
  beforeEach(async () => {
    native.hold = null;
    native.entered = false;
    native.denyRollback = false;
    vi.stubGlobal("Capacitor", { isNativePlatform: () => true });
    setBootConfig({
      branding: {},
      cloudApiBase: "https://api.eliza.app",
      apiBase: base,
    });
    await setStorageValue(
      "elizaos:active-server",
      JSON.stringify(initialServer),
    );
    await setStorageValue(
      "elizaos:agent-profiles",
      JSON.stringify({
        version: 1,
        activeProfileId: "fixture-profile",
        profiles: [
          {
            id: "fixture-profile",
            kind: "cloud",
            cloudAgentId: agentId,
            label: "Test Agent",
            apiBase: base,
            accessToken: "old-agent-bearer",
            createdAt: "2026-09-08T00:00:00.000Z",
          },
        ],
      }),
    );
    await writeStoredStewardToken("account-fixture-token");
    client.setBaseUrl(base);
    client.setToken("old-agent-bearer");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/pairing-token"))
          return Response.json({
            data: { redirectUrl: `${base}/pair?token=fixture-pair-token` },
          });
        if (url.endsWith("/api/auth/pair/native"))
          return Response.json({ apiKey: "fresh-paired-bearer", agentId });
        throw new Error("Unexpected fixture request");
      }),
    );
  });
  afterEach(async () => {
    cleanup();
    native.hold = null;
    await new Promise((resolve) => setTimeout(resolve, 30));
    await getStorageValue("elizaos:active-server");
    client.setToken(null);
    client.setBaseUrl(null);
    vi.unstubAllGlobals();
    setBootConfig({ branding: {} });
  });

  it("finishes an uninterrupted in-process recovery", async () => {
    const onRecovered = vi.fn();
    renderHook(() =>
      useAgentSessionRecovery({
        active: true,
        reason: "remote_auth_required",
        onRecovered,
      }),
    );
    await waitFor(() => expect(onRecovered).toHaveBeenCalledOnce());
    expect(client.getRestAuthToken()).toBe("fresh-paired-bearer");
    expect(loadPersistedActiveServer()?.accessToken).toBe(
      "fresh-paired-bearer",
    );
    expect(getActiveProfile()?.accessToken).toBe("fresh-paired-bearer");
  });

  it.each(["unmount", "pagehide", "target", "client", "session"])(
    "does not install a late native credential after %s",
    async (change) => {
      let release!: () => void;
      native.hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      const onRecovered = vi.fn();
      const mounted = renderHook(() =>
        useAgentSessionRecovery({
          active: true,
          reason: "remote_auth_required",
          onRecovered,
        }),
      );
      try {
        await waitFor(() => expect(native.entered).toBe(true));
        if (change === "unmount") mounted.unmount();
        else if (change === "pagehide")
          act(() => window.dispatchEvent(new Event("pagehide")));
        else if (change === "session")
          await act(async () => {
            await clearStoredStewardToken();
          });
        else if (change === "client")
          client.setBaseUrl("https://other.example.test");
        else {
          savePersistedActiveServer({
            id: "remote:other",
            kind: "remote",
            label: "Other",
            apiBase: "https://other.example.test",
            accessToken: "other-target-bearer",
          });
          client.setBaseUrl("https://other.example.test");
          client.setToken("other-target-bearer");
        }
        release();
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 30));
          await getStorageValue("elizaos:active-server");
        });
        expect(onRecovered).not.toHaveBeenCalled();
        expect(client.getRestAuthToken()).not.toBe("fresh-paired-bearer");
        expect(getActiveProfile()?.accessToken).toBe("old-agent-bearer");
        expect(loadPersistedActiveServer()?.accessToken).toBe(
          change === "target" ? "other-target-bearer" : "old-agent-bearer",
        );
        expect(
          JSON.parse((await getStorageValue("elizaos:active-server")) ?? "null")
            ?.accessToken,
        ).toBe(
          change === "target" ? "other-target-bearer" : "old-agent-bearer",
        );
      } finally {
        release();
        mounted.unmount();
      }
    },
  );

  it.each(["guarded", "fresh"])(
    "does not re-adopt a cancelled native write after denied rollback, with %s recovery",
    async (recovery) => {
      let release!: () => void;
      native.hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      const onRecovered = vi.fn();
      const mounted = renderHook(() =>
        useAgentSessionRecovery({
          active: true,
          reason: "remote_auth_required",
          onRecovered,
        }),
      );
      try {
        await waitFor(() => expect(native.entered).toBe(true));
        native.denyRollback = true;
        act(() => window.dispatchEvent(new Event("pagehide")));
        release();
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 30));
        });
        expect(native.values.get("runtime.active_server")).toContain(
          "fresh-paired-bearer",
        );
        expect(onRecovered).not.toHaveBeenCalled();
        expect(await getStorageValue("elizaos:active-server")).toBeNull();
        expect(loadPersistedActiveServer()).toBeNull();
        mounted.unmount();
        if (recovery === "guarded") {
          native.denyRollback = false;
          await setStorageValue(
            "elizaos:active-server",
            JSON.stringify(initialServer),
            {
              revalidate: () => expect(loadPersistedActiveServer()).toBeNull(),
            },
          );
          expect(loadPersistedActiveServer()).toEqual(initialServer);
          return;
        }
        vi.resetModules();
        const freshBridge = await import("../bridge/storage-bridge");
        expect(
          await freshBridge.getStorageValue("elizaos:active-server"),
        ).toBeNull();
        await freshBridge.initializeStorageBridge();
        expect(
          await freshBridge.getStorageValue("elizaos:active-server"),
        ).toBeNull();
        expect(loadPersistedActiveServer()).toBeNull();
        native.denyRollback = false;
        await freshBridge.setStorageValue(
          "elizaos:active-server",
          JSON.stringify(initialServer),
        );
        expect(loadPersistedActiveServer()).toEqual(initialServer);
      } finally {
        native.denyRollback = false;
        release();
        mounted.unmount();
      }
    },
  );
});
