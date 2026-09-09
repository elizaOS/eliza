/** Exercises fresh native bridge hydration against a durable interrupted-write marker; only the device transport is simulated. */
// @vitest-environment jsdom

import {
  clearStoredStewardToken,
  readStoredStewardToken,
  STEWARD_PENDING_WRITE_KEY,
  STEWARD_TOKEN_KEY,
  writeStoredStewardToken,
} from "@elizaos/shared/steward-session-client";
import { expect, it, vi } from "vitest";

const native = vi.hoisted(() => new Map<string, string>());
vi.mock("@capacitor/core", () => ({
  Capacitor: { getPlatform: () => "android", isNativePlatform: () => true },
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
      native.has(key)
        ? { ok: true, value: native.get(key) }
        : { ok: false, error: "not_found" },
    set: async ({ key, value }: { key: string; value: string }) => {
      native.set(key, value);
      return { ok: true };
    },
    remove: async ({ key }: { key: string }) => ({
      ok: true,
      deleted: native.delete(key),
    }),
  },
}));
vi.mock("./electrobun-runtime", () => ({ isElectrobunRuntime: () => false }));
vi.mock("../first-run/mobile-runtime-mode", () => ({
  MOBILE_RUNTIME_MODE_STORAGE_KEY: "eliza:mobile-runtime-mode",
}));
vi.mock("../surface-realm-channel", () => ({
  runAsPrivilegedShell: (operation: () => unknown) => operation(),
}));

it("does not resurrect an interrupted token before or during fresh bridge hydration, and accepts a new verified write", async () => {
  localStorage.clear();
  sessionStorage.clear();
  native.set("session.steward_token", "unacknowledged-native-candidate");
  localStorage.setItem(STEWARD_PENDING_WRITE_KEY, "interrupted-write-id");
  localStorage.setItem(STEWARD_TOKEN_KEY, "legacy-plaintext-candidate");
  expect(readStoredStewardToken()).toBeNull();

  const bridge = await import("./storage-bridge");
  expect(bridge.isStorageBridgeInitialized()).toBe(false);
  await bridge.initializeStorageBridge();
  expect(bridge.isStorageBridgeInitialized()).toBe(true);
  expect(readStoredStewardToken()).toBeNull();
  expect(localStorage.getItem(STEWARD_TOKEN_KEY)).toBeNull();
  expect(await bridge.getStorageValue(STEWARD_TOKEN_KEY)).toBeNull();
  expect(native.get("session.steward_token")).toBe(
    "unacknowledged-native-candidate",
  );

  await writeStoredStewardToken("new-verified-owner");
  expect(readStoredStewardToken()).toBe("new-verified-owner");
  expect(await bridge.getStorageValue(STEWARD_TOKEN_KEY)).toBe(
    "new-verified-owner",
  );
  expect(localStorage.getItem(STEWARD_PENDING_WRITE_KEY)).toBeNull();
  await clearStoredStewardToken();
  expect(native.has("session.steward_token")).toBe(false);
});
