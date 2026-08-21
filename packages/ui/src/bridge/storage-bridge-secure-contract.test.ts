// @vitest-environment jsdom

/** Exercises native credential migration and fail-closed storage behavior. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const nativeStores = vi.hoisted(() => ({
  preferences: new Map<string, string>(),
  secure: new Map<string, string>(),
  secureAvailable: true,
  secureSetError: null as null | "rejected" | "thrown",
  secureDeleteError: null as null | "denied" | "unavailable" | "native_error",
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    getPlatform: () => "android",
    isNativePlatform: () => true,
  },
}));

vi.mock("@capacitor/preferences", () => ({
  Preferences: {
    get: async ({ key }: { key: string }) => ({
      value: nativeStores.preferences.get(key) ?? null,
    }),
    set: async ({ key, value }: { key: string; value: string }) => {
      nativeStores.preferences.set(key, value);
    },
    remove: async ({ key }: { key: string }) => {
      nativeStores.preferences.delete(key);
    },
  },
}));

vi.mock("@elizaos/logger", () => ({
  logger: { error: () => undefined },
}));

vi.mock("@elizaos/shared/steward-session-client", () => ({
  STEWARD_TOKEN_KEY: "eliza.cloud.steward-token",
}));

vi.mock("../first-run/mobile-runtime-mode", () => ({
  MOBILE_RUNTIME_MODE_STORAGE_KEY: "eliza:mobile-runtime-mode",
}));

vi.mock("@elizaos/capacitor-secure-store", () => ({
  ElizaSecureStore: {
    get: async ({ key }: { key: string }) => {
      if (!nativeStores.secureAvailable) throw new Error("bridge cold");
      return nativeStores.secure.has(key)
        ? { ok: true, value: nativeStores.secure.get(key) }
        : { ok: false, error: "not_found" };
    },
    set: async ({ key, value }: { key: string; value: string }) => {
      if (!nativeStores.secureAvailable) throw new Error("bridge cold");
      if (nativeStores.secureSetError === "thrown")
        throw new Error("bridge failed");
      if (nativeStores.secureSetError === "rejected") {
        return { ok: false, error: "denied" };
      }
      nativeStores.secure.set(key, value);
      return { ok: true };
    },
    remove: async ({ key }: { key: string }) => {
      if (!nativeStores.secureAvailable) throw new Error("bridge cold");
      if (nativeStores.secureDeleteError) {
        return { ok: false, error: nativeStores.secureDeleteError };
      }
      const deleted = nativeStores.secure.delete(key);
      return { ok: true, deleted };
    },
  },
}));

vi.mock("./electrobun-runtime", () => ({
  isElectrobunRuntime: () => false,
}));

vi.mock("./electrobun-rpc", () => ({
  desktopSecureStoreDelete: vi.fn(),
  desktopSecureStoreGet: vi.fn(),
  desktopSecureStoreSet: vi.fn(),
}));

vi.mock("../surface-realm-channel", () => ({
  runAsPrivilegedShell: (operation: () => unknown) => operation(),
}));

const source = readFileSync(
  resolve(process.cwd(), "src/bridge/storage-bridge.ts"),
  "utf8",
);

describe("native protected-storage bridge contract", () => {
  beforeEach(() => {
    nativeStores.preferences.clear();
    nativeStores.secure.clear();
    nativeStores.secureAvailable = true;
    nativeStores.secureSetError = null;
    nativeStores.secureDeleteError = null;
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  it("protects every native session/runtime record that can contain a token", () => {
    for (const key of [
      "eliza.device.auth",
      "elizaos:active-server",
      "elizaos:agent-profiles",
    ]) {
      expect(source).toContain(key);
    }
    expect(source).toContain('[STEWARD_TOKEN_KEY, "session.steward_token"]');
  });

  it("verifies migration before removing legacy plaintext", () => {
    expect(source).toContain(
      "const verified = stored ? await protectedStoreGet(key) : null",
    );
    const verification = source.indexOf("if (verified !== legacyValue)");
    expect(verification).toBeGreaterThan(0);
    expect(verification).toBeLessThan(
      source.indexOf("originalRemoveItem(key);", verification),
    );
  });

  it("never redirects a failed protected write into localStorage", () => {
    const branchStart = source.indexOf(
      "if (isProtectedStorageHost() && PROTECTED_STORAGE_KIND.has(key))",
      source.indexOf("const secureSetItem ="),
    );
    const protectedBranch = source.slice(
      branchStart,
      source.indexOf("// Always set in localStorage first", branchStart),
    );
    expect(protectedBranch).toContain("protectedStoreSet(key, value)");
    expect(protectedBranch).not.toContain("originalSetItem(key, value)");
  });

  it("retries hydration when the protected native bridge is still cold", () => {
    expect(source).toContain(
      "return isNativePlatform() || isElectrobunRuntime();",
    );
    expect(source).not.toContain("isAppleNativePlatform");
    expect(source).toContain(
      'throw new Error("Native protected storage is unavailable")',
    );
    expect(source).toContain("protectedStoreResponded = false");
    expect(source).toContain("if (pluginResponded && protectedStoreResponded)");
    expect(source.indexOf("if (isProtectedStorageHost()) {")).toBeLessThan(
      source.indexOf("for (const key of PROTECTED_STORAGE_KIND.keys())"),
    );
  });

  it("migrates an Android plaintext session only after exact secure read-back", async () => {
    nativeStores.preferences.set("eliza.device.auth", "legacy-device-secret");
    window.localStorage.setItem("eliza.device.auth", "legacy-device-secret");
    const rawStorage = window.localStorage;
    const rawGetItem = Storage.prototype.getItem;

    const bridge = await import("./storage-bridge");
    nativeStores.secureAvailable = false;
    await bridge.initializeStorageBridge();
    expect(bridge.isStorageBridgeInitialized()).toBe(false);
    expect(rawGetItem.call(rawStorage, "eliza.device.auth")).toBe(
      "legacy-device-secret",
    );

    nativeStores.secureAvailable = true;
    await bridge.initializeStorageBridge();

    expect(nativeStores.secure.get("session.device_auth")).toBe(
      "legacy-device-secret",
    );
    expect(nativeStores.preferences.has("eliza.device.auth")).toBe(false);
    expect(await bridge.getStorageValue("eliza.device.auth")).toBe(
      "legacy-device-secret",
    );
    expect(window.localStorage.getItem("eliza.device.auth")).toBe(
      "legacy-device-secret",
    );
    expect(rawGetItem.call(rawStorage, "eliza.device.auth")).toBeNull();
    window.sessionStorage.setItem("storage-bridge-probe", "unchanged");
    expect(window.sessionStorage.getItem("storage-bridge-probe")).toBe(
      "unchanged",
    );
    expect(bridge.isStorageBridgeInitialized()).toBe(true);
  }, 60_000);

  it("retains the live and restart credential when native deletion is denied", async () => {
    const bridge = await import("./storage-bridge");
    await bridge.setStorageValue(
      "eliza.device.auth",
      "still-durable-after-failed-delete",
    );
    nativeStores.secureDeleteError = "denied";

    await expect(
      bridge.removeStorageValue("eliza.device.auth"),
    ).rejects.toThrow("Native protected storage rejected deletion");

    expect(nativeStores.secure.get("session.device_auth")).toBe(
      "still-durable-after-failed-delete",
    );
    expect(await bridge.getStorageValue("eliza.device.auth")).toBe(
      "still-durable-after-failed-delete",
    );
  });

  it.each(["rejected", "thrown"] as const)(
    "rolls the live cache back when an awaited protected write is %s",
    async (failureMode) => {
      const bridge = await import("./storage-bridge");
      await bridge.setStorageValue("eliza.device.auth", "durable-secret");
      nativeStores.secureSetError = failureMode;

      await expect(
        bridge.setStorageValue("eliza.device.auth", "rejected-secret"),
      ).rejects.toThrow();

      expect(window.localStorage.getItem("eliza.device.auth")).toBe(
        "durable-secret",
      );
    },
  );
});
