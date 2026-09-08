/** Exercises real first-run join and client/profile publication against delayed native secure-store acknowledgements. */
// @vitest-environment jsdom

import { writeStoredStewardToken } from "@elizaos/shared/steward-session-client";
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
  removeStorageValue,
  setStorageValue,
} from "../bridge/storage-bridge";
import { setBootConfig } from "../config/boot-config";
import { getActiveProfile } from "../state/agent-profiles";
import { loadPersistedActiveServer } from "../state/persistence";
import { listOrAutoProvisionCloudAgent } from "./first-run-finish";

const native = vi.hoisted(() => ({
  values: new Map<string, string>(),
  heldKey: "",
  heldValue: "joined-agent",
  hold: null as Promise<void> | null,
  enter: () => {},
}));
vi.mock("@capacitor/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@capacitor/core")>();
  return {
    ...actual,
    Capacitor: {
      ...actual.Capacitor,
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
        key === native.heldKey &&
        value.includes(native.heldValue) &&
        native.hold
      ) {
        native.enter();
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

const oldBase = "https://11111111-1111-4111-8111-111111111111.cloud.eliza.app";
const nextBase = "https://22222222-2222-4222-8222-222222222222.cloud.eliza.app";
const originalServer = {
  id: "cloud:old-agent",
  kind: "cloud" as const,
  label: "Original agent",
  apiBase: oldBase,
  accessToken: "original-client-token",
};

function start(signal?: AbortSignal) {
  const complete = vi.fn();
  const result = listOrAutoProvisionCloudAgent(
    {
      agentName: "Eliza",
      runtime: "cloud",
      localInference: "cloud-inference",
      remoteApiBase: "",
      remoteToken: "",
    },
    {
      uiLanguage: "en",
      elizaCloudConnected: true,
      handleInteractiveCloudLogin: async () => {
        throw new Error("Unexpected interactive login");
      },
      setRuntimeState: vi.fn(),
      setTab: vi.fn(),
      completeFirstRun: complete,
      signal,
    },
  );
  return { complete, result };
}

describe("first-run protected native continuation", () => {
  beforeAll(async () => {
    await initializeStorageBridge();
  });
  beforeEach(async () => {
    native.hold = null;
    native.heldKey = "";
    native.heldValue = "joined-agent";
    vi.stubGlobal("Capacitor", { isNativePlatform: () => true });
    setBootConfig({
      branding: {},
      cloudApiBase: "https://api.eliza.app",
      apiBase: oldBase,
    });
    await setStorageValue(
      "elizaos:active-server",
      JSON.stringify(originalServer),
    );
    await setStorageValue(
      "elizaos:agent-profiles",
      JSON.stringify({
        version: 1,
        activeProfileId: "original-profile",
        profiles: [
          {
            id: "original-profile",
            kind: "cloud",
            label: "Original agent",
            cloudAgentId: "old-agent",
            apiBase: oldBase,
            accessToken: "original-client-token",
            createdAt: "2026-09-08T00:00:00.000Z",
          },
        ],
      }),
    );
    await writeStoredStewardToken("account-fixture-token");
    client.setBaseUrl(oldBase);
    client.setToken("original-client-token");
    // Only the account selection transport is doubled; finish, join, live
    // client notifications and native persistence all run unchanged.
    vi.spyOn(client, "ensurePersonalDedicatedEliza").mockResolvedValue({
      personalElizaId: "personal:joined-agent",
      agentId: "personal:joined-agent",
      activeAgentId: "22222222-2222-4222-8222-222222222222",
      agentName: "Joined agent",
      apiBase: nextBase,
      runtime: "dedicated",
    });
  });
  afterEach(() => {
    native.hold = null;
    client.setToken(null);
    client.setBaseUrl(null);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    setBootConfig({ branding: {} });
  });

  it("persists both native records and completes the same authenticated account", async () => {
    const { result, complete } = start();
    expect(await result).toEqual({ kind: "done" });
    expect(complete).toHaveBeenCalledWith("chat");
    expect(client.getBaseUrl()).toBe(nextBase);
    expect(client.getRestAuthToken()).toBe("account-fixture-token");
    expect(getActiveProfile()?.accessToken).toBe("account-fixture-token");
    expect(native.values.get("runtime.agent_profiles")).toContain(
      "personal:joined-agent",
    );
    expect(native.values.get("runtime.active_server")).toContain(
      "personal:joined-agent",
    );
  });

  it.each(["authority", "base"])(
    "preserves a replacement selected synchronously by a %s listener",
    async (notification) => {
      let replaced = false;
      const replace = () => {
        if (replaced || client.getBaseUrl() !== nextBase) return;
        replaced = true;
        client.setBaseUrl(oldBase);
        client.setToken("replacement-client-token");
      };
      const unsubscribe =
        notification === "authority"
          ? client.onAuthorityChange(replace)
          : client.onBaseUrlChange(replace);
      try {
        const { result, complete } = start();
        const outcome = await result.catch((error: unknown) => error);
        expect(replaced).toBe(true);
        expect(outcome).toBeInstanceOf(Error);
        expect(complete).not.toHaveBeenCalled();
        expect(client.getBaseUrl()).toBe(oldBase);
        expect(client.getRestAuthToken()).toBe("replacement-client-token");
        expect(getActiveProfile()?.id).toBe("original-profile");
      } finally {
        unsubscribe();
      }
    },
  );

  it("does not retain a late native profile migration after cancellation without a registry", async () => {
    await removeStorageValue("elizaos:agent-profiles");
    let release!: () => void;
    native.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      native.enter = resolve;
    });
    native.heldKey = "runtime.agent_profiles";
    const controller = new AbortController();
    const { result, complete } = start(controller.signal);
    const outcome = result.catch((error: unknown) => error);
    try {
      await entered;
      controller.abort();
      release();
      expect(await outcome).toBeInstanceOf(Error);
      // Legacy writes first enter the queue on a later browser task.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      await getStorageValue("elizaos:agent-profiles");
      expect(native.values.get("runtime.agent_profiles") ?? "").not.toContain(
        "personal:joined-agent",
      );
      expect(complete).not.toHaveBeenCalled();
    } finally {
      release();
      await outcome;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      await getStorageValue("elizaos:agent-profiles");
    }
  });

  it.each([true, false])(
    "finishes without a registry (legacy server: %s)",
    async (legacyServer) => {
      await removeStorageValue("elizaos:agent-profiles");
      if (!legacyServer) await removeStorageValue("elizaos:active-server");
      const { result, complete } = start();
      expect(await result).toEqual({ kind: "done" });
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      const stored = await getStorageValue("elizaos:agent-profiles");
      expect(stored).not.toBeNull();
      const registry = JSON.parse(stored as string);
      expect(
        registry.profiles.filter(
          (profile: { cloudAgentId: string }) =>
            profile.cloudAgentId === "personal:joined-agent",
        ),
      ).toHaveLength(1);
      expect(getActiveProfile()?.cloudAgentId).toBe("personal:joined-agent");
      expect(complete).toHaveBeenCalledWith("chat");
    },
  );

  it("cancels a delayed legacy-registry preparation before selecting an agent", async () => {
    await removeStorageValue("elizaos:agent-profiles");
    native.heldKey = "runtime.agent_profiles";
    native.heldValue = "old-agent";
    let release!: () => void;
    native.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      native.enter = resolve;
    });
    const controller = new AbortController();
    const { result, complete } = start(controller.signal);
    const outcome = result.catch((error: unknown) => error);
    try {
      await entered;
      controller.abort();
      release();
      expect(await outcome).toBeInstanceOf(Error);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(await getStorageValue("elizaos:agent-profiles")).toBeNull();
      expect(client.ensurePersonalDedicatedEliza).not.toHaveBeenCalled();
      expect(loadPersistedActiveServer()).toEqual(originalServer);
      expect(complete).not.toHaveBeenCalled();
    } finally {
      release();
      await outcome;
    }
  });

  it.each(
    ["server", "profile"].flatMap((stage) =>
      ["abort", "session", "client"].map((change) => ({ stage, change })),
    ),
  )(
    "refuses late $stage publication after $change",
    async ({ stage, change }) => {
      let release!: () => void;
      native.hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      const entered = new Promise<void>((resolve) => {
        native.enter = resolve;
      });
      native.heldKey =
        stage === "server" ? "runtime.active_server" : "runtime.agent_profiles";
      const controller = new AbortController();
      const { result, complete } = start(controller.signal);
      const outcome = result.catch((error: unknown) => error);
      try {
        await entered;
        if (change === "abort") controller.abort();
        else if (change === "session")
          await writeStoredStewardToken("replacement-account-token");
        else client.setToken("replacement-client-token");
        release();
        expect(await outcome).toBeInstanceOf(Error);
        expect(complete).not.toHaveBeenCalled();
        expect(getActiveProfile()?.id).toBe("original-profile");
        expect(native.values.get("runtime.agent_profiles")).not.toContain(
          "personal:joined-agent",
        );
        if (stage === "server")
          expect(loadPersistedActiveServer()).toEqual(originalServer);
        if (change === "client")
          expect(client.getRestAuthToken()).toBe("replacement-client-token");
      } finally {
        release();
        await outcome;
      }
    },
  );
});
