/** Exercises startup migration racing a real canonical session write, with only native transports simulated. */
// @vitest-environment jsdom

import {
  clearStoredStewardToken,
  readStoredStewardToken,
  STEWARD_TOKEN_KEY,
  writeStoredStewardToken,
} from "@elizaos/shared/steward-session-client";
import { expect, it, vi } from "vitest";

const device = vi.hoisted(() => ({
  tokens: new Map<string, string>(),
  migrationStarted: false,
  migrationWait: null as Promise<void> | null,
}));
vi.mock("@capacitor/core", () => ({
  Capacitor: { getPlatform: () => "android", isNativePlatform: () => true },
}));
vi.mock("@capacitor/preferences", () => ({
  Preferences: {
    get: async ({ key }: { key: string }) => {
      if (key !== STEWARD_TOKEN_KEY) return { value: null };
      device.migrationStarted = true;
      await device.migrationWait;
      return { value: "legacy-owner" };
    },
    remove: async () => {},
  },
}));
vi.mock("@elizaos/capacitor-secure-store", () => ({
  ElizaSecureStore: {
    get: async ({ key }: { key: string }) =>
      device.tokens.has(key)
        ? { ok: true, value: device.tokens.get(key) }
        : { ok: false, error: "not_found" },
    set: async ({ key, value }: { key: string; value: string }) => {
      device.tokens.set(key, value);
      return { ok: true };
    },
    remove: async ({ key }: { key: string }) => ({
      ok: true,
      deleted: device.tokens.delete(key),
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

it("finishes in-flight legacy migration before committing a newer login", async () => {
  localStorage.clear();
  sessionStorage.clear();
  let release!: () => void;
  device.migrationWait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const bridge = await import("./storage-bridge");
  const hydration = bridge.initializeStorageBridge();
  await vi.waitFor(() => expect(device.migrationStarted).toBe(true));
  const login = writeStoredStewardToken("new-verified-owner");
  try {
    const state = await Promise.race([
      login.then(() => "committed"),
      new Promise<string>((resolve) =>
        setTimeout(() => resolve("pending"), 30),
      ),
    ]);
    expect(state).toBe("pending");
    expect(readStoredStewardToken()).toBeNull();
  } finally {
    release();
    await hydration;
    await login;
  }
  expect(readStoredStewardToken()).toBe("new-verified-owner");
  expect(await bridge.getStorageValue(STEWARD_TOKEN_KEY)).toBe(
    "new-verified-owner",
  );
  expect(device.tokens.get("session.steward_token")).toBe("new-verified-owner");
  await clearStoredStewardToken();
});
