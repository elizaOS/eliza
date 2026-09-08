/** Exercises actual credential, profile, storage and runtime-selection modules with a deterministic mobile native-store adapter and an inert API sink. No installed device or live account is involved. */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BootstrapExchangeResult } from "../api/client-agent";
import type { AgentProfileRegistry } from "./agent-profile-types";

const native = vi.hoisted(() => ({
  values: new Map<string, string>(),
  profileWrites: 0,
  failProfileWrites: 0,
  failServerWrites: 0,
  profileGate: null as Promise<void> | null,
  selectedToken: null as string | null,
}));
vi.mock("@capacitor/core", () => ({
  Capacitor: { getPlatform: () => "ios", isNativePlatform: () => true },
}));
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
      if (key === "runtime.active_server" && native.failServerWrites > 0) {
        native.failServerWrites--;
        return { ok: false, error: "unavailable" };
      }
      if (key === "runtime.agent_profiles") {
        native.profileWrites++;
        await native.profileGate;
        if (native.failProfileWrites > 0) {
          native.failProfileWrites--;
          return { ok: false, error: "unavailable" };
        }
      }
      native.values.set(key, value);
      return { ok: true };
    },
    remove: async ({ key }: { key: string }) => {
      native.values.delete(key);
      return { ok: true };
    },
  },
}));
vi.mock("../api", () => ({
  client: {
    repointBaseUrl: (_url: string, token: string | null) => {
      native.selectedToken = token;
    },
    setToken: (token: string | null) => {
      native.selectedToken = token;
    },
  },
}));
vi.mock("./ChatComposerContext.hooks", () => ({
  clearAllChatDrafts: () => {},
}));

const rawPrototype = Object.getOwnPropertyDescriptors(Storage.prototype);
const rawInstance = Object.getOwnPropertyDescriptors(window.localStorage);
const agentId = "55555555-5555-4555-8555-555555555555";
const server = {
  id: `cloud:${agentId}`,
  kind: "cloud",
  label: "Saved agent",
  apiBase: `https://${agentId}.elizacloud.ai`,
  accessToken: "fixture-old",
};
const profile = {
  ...server,
  id: "saved-profile",
  cloudAgentId: agentId,
  createdAt: "2026-09-08T00:00:00Z",
};
const otherProfile = {
  id: "other-profile",
  kind: "local",
  label: "Other saved agent",
  createdAt: "2026-09-07T00:00:00Z",
};
let bridge: typeof import("../bridge/storage-bridge");
let credentials: typeof import("./active-server-credential");
let profiles: typeof import("./agent-profiles");
let cleanupRendered: (() => void) | undefined;

function readNativeRegistry(): AgentProfileRegistry {
  const raw = native.values.get("runtime.agent_profiles");
  if (!raw) throw new Error("Expected a persisted native profile registry");
  return JSON.parse(raw) as AgentProfileRegistry;
}

beforeEach(async () => {
  vi.resetModules();
  native.values.clear();
  native.profileWrites = 0;
  native.failProfileWrites = 0;
  native.failServerWrites = 0;
  native.profileGate = null;
  native.selectedToken = null;
  localStorage.clear();
  sessionStorage.clear();
  vi.stubGlobal("fetch", () => {
    throw new Error("Network forbidden in storage integration fixture");
  });
  native.values.set("runtime.active_server", JSON.stringify(server));
  native.values.set(
    "runtime.agent_profiles",
    JSON.stringify({
      version: 1,
      activeProfileId: profile.id,
      profiles: [profile, otherProfile],
    }),
  );
  bridge = await import("../bridge/storage-bridge");
  credentials = await import("./active-server-credential");
  profiles = await import("./agent-profiles");
  await bridge.initializeStorageBridge();
  expect(profiles.getActiveProfile()?.accessToken).toBe("fixture-old");
});

afterEach(async () => {
  cleanupRendered?.();
  cleanupRendered = undefined;
  // Let legacy picker writes drain before restoring this test realm's Storage.
  await new Promise((resolve) => setTimeout(resolve, 20));
  Object.defineProperties(Storage.prototype, rawPrototype);
  for (const key of ["getItem", "setItem", "removeItem"]) {
    const original = rawInstance[key];
    if (original) Object.defineProperty(window.localStorage, key, original);
    else Reflect.deleteProperty(window.localStorage, key);
  }
  vi.unstubAllGlobals();
});

describe("companion profile acknowledgement", () => {
  it.each([false, true])(
    "rejects a denied profile write (guarded=%s)",
    async (guarded) => {
      native.failProfileWrites = 1;
      const serverReceipt = vi.fn();
      await expect(
        credentials.persistActiveServerCredential("fixture-new", undefined, {
          ...(guarded ? { revalidate: () => {} } : {}),
          onActiveServerPersisted: serverReceipt,
        }),
      ).rejects.toThrow();
      expect(native.selectedToken).toBeNull();
      expect(serverReceipt).toHaveBeenCalledExactlyOnceWith({
        ...server,
        accessToken: "fixture-new",
      });
      expect(readNativeRegistry().profiles[0].accessToken).toBe("fixture-old");
    },
  );

  it("does not acknowledge a rejected server write or publish its companion", async () => {
    native.failServerWrites = 1;
    const serverReceipt = vi.fn();
    await expect(
      credentials.persistActiveServerCredential("fixture-new", undefined, {
        revalidate: () => {},
        onActiveServerPersisted: serverReceipt,
      }),
    ).rejects.toThrow();
    expect(serverReceipt).not.toHaveBeenCalled();
    expect(native.profileWrites).toBe(0);
    expect(readNativeRegistry().profiles[0].accessToken).toBe("fixture-old");
    expect(native.selectedToken).toBeNull();
  });

  it("waits for the matching profile and preserves every other saved profile", async () => {
    let release!: () => void;
    native.profileGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let completed = false;
    const pending = credentials
      .persistActiveServerCredential("fixture-new", undefined, {
        revalidate: () => {},
      })
      .then(() => {
        completed = true;
      });
    try {
      await vi.waitFor(() => expect(native.profileWrites).toBeGreaterThan(0));
      expect(completed).toBe(false);
      expect(readNativeRegistry().profiles[0].accessToken).toBe("fixture-old");
    } finally {
      release();
    }
    await pending;
    await bridge.getStorageValue("elizaos:agent-profiles");
    expect(profiles.getActiveProfile()?.accessToken).toBe("fixture-new");
    expect(profiles.loadAgentProfileRegistry().profiles[1]).toEqual(
      otherProfile,
    );
    const { switchRuntimeNonDestructive } = await import("./switch-runtime");
    expect(switchRuntimeNonDestructive(profile.id).ok).toBe(true);
    expect(native.selectedToken).toBe("fixture-new");
  });

  it("rechecks recovery lifetime while the companion write is pending", async () => {
    let release!: () => void;
    native.profileGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let current = true;
    const pending = credentials.persistActiveServerCredential(
      "fixture-new",
      undefined,
      {
        revalidate: () => {
          if (!current) throw new Error("Recovery ended");
        },
      },
    );
    const rejected = expect(pending).rejects.toThrow("Recovery ended");
    try {
      await vi.waitFor(() => expect(native.profileWrites).toBeGreaterThan(0));
      current = false;
    } finally {
      release();
    }
    await rejected;
    expect(readNativeRegistry().profiles[0].accessToken).toBe("fixture-old");
    expect(native.selectedToken).toBeNull();
  });

  it("preserves a concurrent registry edit instead of replacing it with the recovery snapshot", async () => {
    let release!: () => void;
    native.profileGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending = credentials.persistActiveServerCredential(
      "fixture-new",
      undefined,
      { revalidate: () => {} },
    );
    const rejected = expect(pending).rejects.toThrow();
    try {
      await vi.waitFor(() => expect(native.profileWrites).toBeGreaterThan(0));
      profiles.updateAgentProfile(otherProfile.id, {
        label: "User's newer label",
      });
    } finally {
      release();
    }
    await rejected;
    await bridge.getStorageValue("elizaos:agent-profiles");
    expect(
      profiles
        .loadAgentProfileRegistry()
        .profiles.find((saved) => saved.id === otherProfile.id)?.label,
    ).toBe("User's newer label");
    expect(native.selectedToken).toBeNull();
  });

  it.each([false, true])(
    "keeps the acknowledged credential after legacy registry migration (guarded=%s)",
    async (guarded) => {
      // Leave only the single-server record, as on a legacy installation.
      await bridge.removeStorageValue("elizaos:agent-profiles");
      expect(native.values.has("runtime.agent_profiles")).toBe(false);
      const migrated = profiles.getActiveProfile();
      expect(migrated?.accessToken).toBe("fixture-old");
      // Migration is synchronous for its caller but defers native storage.
      expect(native.profileWrites).toBe(0);
      await credentials.persistActiveServerCredential(
        "fixture-new",
        undefined,
        guarded ? { revalidate: () => {} } : undefined,
      );
      await vi.waitFor(() => expect(native.profileWrites).toBe(2));
      await bridge.getStorageValue("elizaos:agent-profiles");
      expect(profiles.getActiveProfile()).toMatchObject({
        id: migrated?.id,
        accessToken: "fixture-new",
      });
      expect(readNativeRegistry().profiles).toHaveLength(1);
      expect(readNativeRegistry().profiles[0].accessToken).toBe("fixture-new");
    },
  );

  it("durably creates an explicitly paired remote profile without replacing unrelated profiles", async () => {
    await credentials.persistActiveServerCredential(
      "fixture-paired",
      "http://127.0.0.1:42199",
    );
    await bridge.getStorageValue("elizaos:agent-profiles");
    expect(profiles.getActiveProfile()).toMatchObject({
      kind: "remote",
      accessToken: "fixture-paired",
      apiBase: "http://127.0.0.1:42199",
    });
    expect(profiles.loadAgentProfileRegistry().profiles).toEqual(
      expect.arrayContaining([profile, otherProfile]),
    );
  });

  it.each([false, true])(
    "bootstrap waits for profile storage and surfaces rejection (reject=%s)",
    async (reject) => {
      const { createElement } = await import("react");
      const { render, fireEvent, cleanup, waitFor } = await import(
        "@testing-library/react/pure"
      );
      cleanupRendered = cleanup;
      const { BootstrapStep } = await import(
        "../components/setup/BootstrapStep"
      );
      const advance = vi.fn();
      let release!: () => void;
      native.profileGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      native.failProfileWrites = reject ? 1 : 0;
      const view = render(
        createElement(BootstrapStep, {
          onAdvance: advance,
          exchangeFn: async (): Promise<BootstrapExchangeResult> => ({
            ok: true,
            sessionId: "fixture-new",
            expiresAt: Date.now() + 60_000,
            identityId: "fixture-identity",
          }),
        }),
      );
      fireEvent.change(view.getByLabelText("Bootstrap token"), {
        target: { value: "fixture-bootstrap" },
      });
      fireEvent.submit(
        view.getByRole("form", { name: "Bootstrap token entry" }),
      );
      try {
        await waitFor(() => expect(native.profileWrites).toBeGreaterThan(0));
        expect(advance).not.toHaveBeenCalled();
        expect(native.selectedToken).toBeNull();
        expect(sessionStorage.getItem("eliza_session")).toBeNull();
      } finally {
        release();
      }
      if (reject) {
        const message = await view.findByText(/session could not be saved/i);
        expect(message.getAttribute("aria-live")).toBe("assertive");
        expect(
          view.getByLabelText("Bootstrap token").getAttribute("aria-invalid"),
        ).toBe("true");
        expect(advance).not.toHaveBeenCalled();
        expect(native.selectedToken).toBeNull();
        expect(sessionStorage.getItem("eliza_session")).toBeNull();
      } else {
        await waitFor(() => expect(advance).toHaveBeenCalledTimes(1));
        expect(native.selectedToken).toBe("fixture-new");
        expect(sessionStorage.getItem("eliza_session")).toBe("fixture-new");
      }
    },
  );
});
