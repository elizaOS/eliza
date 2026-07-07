// @vitest-environment jsdom

/**
 * Device RAM-gate coverage (#14390) through its REAL seams: the synchronous
 * `globalThis.ElizaNative.getDeviceTotalRamMb()` Android bridge, the async
 * native resource snapshot fallback, the fail-loud finish assertion, and the
 * boot-time enforcement that reverts a stale persisted "local" mode on a
 * RAM-blocked device. Only the platform constant and the native snapshot call
 * (device boundaries) are substituted; classification, caching, and the
 * persisted-state cleanup run for real against jsdom localStorage.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  isAndroid: true,
  isIOS: false,
  resourceSnapshot: null as { totalRamMb: number | null } | null,
}));

vi.mock("../platform/init", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../platform/init")>();
  return {
    ...actual,
    get isAndroid() {
      return mocks.isAndroid;
    },
    get isIOS() {
      return mocks.isIOS;
    },
  };
});

vi.mock(
  "../services/local-inference/resource-snapshot-bridge",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../services/local-inference/resource-snapshot-bridge")
      >();
    return {
      ...actual,
      getDeviceResourceSnapshot: async () => mocks.resourceSnapshot,
    };
  },
);

import {
  loadPersistedActiveServer,
  savePersistedActiveServer,
} from "../state/persistence";
import {
  assertDeviceRamTierAllowsLocalRuntime,
  enforceDeviceRamPolicyOnPersistedRuntimeModeAtBoot,
  peekDeviceRamTierAssessment,
  resetDeviceRamGateForTests,
  resolveDeviceRamTierAssessment,
} from "./device-ram-gate";
import {
  ANDROID_LOCAL_AGENT_IPC_BASE,
  ANDROID_LOCAL_AGENT_LABEL,
  ANDROID_LOCAL_AGENT_SERVER_ID,
  persistMobileRuntimeMode,
  readPersistedMobileRuntimeMode,
} from "./mobile-runtime-mode";

// This jsdom env exposes `window.localStorage` as an object without methods;
// install a real in-memory Storage (mirrors `first-run.test.ts`).
function ensureLocalStorage(): Storage {
  if (typeof window.localStorage?.clear === "function") {
    return window.localStorage;
  }
  const values = new Map<string, string>();
  const storage = {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key: string) => values.get(key) ?? null,
    key: (index: number) => Array.from(values.keys())[index] ?? null,
    removeItem: (key: string) => {
      values.delete(key);
    },
    setItem: (key: string, value: string) => {
      values.set(key, String(value));
    },
  } satisfies Storage;
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: storage,
  });
  return storage;
}

type GlobalWithBridge = typeof globalThis & {
  ElizaNative?: { getDeviceTotalRamMb?: () => number };
};

function installSyncBridge(totalRamMb: number): void {
  (globalThis as GlobalWithBridge).ElizaNative = {
    getDeviceTotalRamMb: () => totalRamMb,
  };
}

beforeEach(() => {
  ensureLocalStorage().clear();
  resetDeviceRamGateForTests();
  mocks.isAndroid = true;
  mocks.isIOS = false;
  mocks.resourceSnapshot = null;
  delete (globalThis as GlobalWithBridge).ElizaNative;
});

afterEach(() => {
  ensureLocalStorage().clear();
  delete (globalThis as GlobalWithBridge).ElizaNative;
});

describe("peekDeviceRamTierAssessment", () => {
  it("classifies synchronously from the Android native bridge", () => {
    // The #14390 Moto G Play: totalMem ~3660 MB → marketed 4 GB → cloud-only.
    installSyncBridge(3660);
    const a = peekDeviceRamTierAssessment();
    expect(a?.tier).toBe("cloud-only");
    expect(a?.marketedRamGb).toBe(4);
    expect(a?.allowsLocalAgent).toBe(false);
  });

  it("treats the bridge's -1 unreadable sentinel as not-yet-known", () => {
    installSyncBridge(-1);
    expect(peekDeviceRamTierAssessment()).toBeNull();
  });

  it("returns null on mobile before any probe answered", () => {
    expect(peekDeviceRamTierAssessment()).toBeNull();
  });

  it("classifies non-mobile platforms as the ungated unknown tier", () => {
    mocks.isAndroid = false;
    mocks.isIOS = false;
    const a = peekDeviceRamTierAssessment();
    expect(a?.tier).toBe("unknown");
    expect(a?.allowsLocalAgent).toBe(true);
  });
});

describe("resolveDeviceRamTierAssessment", () => {
  it("falls back to the async resource snapshot when no sync bridge exists (iOS path)", async () => {
    mocks.isAndroid = false;
    mocks.isIOS = true;
    mocks.resourceSnapshot = { totalRamMb: 7.5 * 1024 };
    const a = await resolveDeviceRamTierAssessment();
    expect(a.tier).toBe("no-local-models");
    expect(a.marketedRamGb).toBe(8);
    // The resolved assessment is cached for synchronous peeks.
    expect(peekDeviceRamTierAssessment()?.tier).toBe("no-local-models");
  });

  it("classifies an unreachable probe as the explicit unknown tier", async () => {
    mocks.resourceSnapshot = null;
    const a = await resolveDeviceRamTierAssessment();
    expect(a.tier).toBe("unknown");
    expect(a.allowsLocalAgent).toBe(true);
  });
});

describe("assertDeviceRamTierAllowsLocalRuntime", () => {
  it("throws for ANY local runtime on a sub-8 GB device", async () => {
    installSyncBridge(3660);
    await expect(
      assertDeviceRamTierAllowsLocalRuntime("all-local"),
    ).rejects.toThrow(/on-device agent/);
    await expect(
      assertDeviceRamTierAllowsLocalRuntime("cloud-inference"),
    ).rejects.toThrow(/on-device agent/);
  });

  it("allows the hybrid runtime but rejects on-device models on 8-11 GB", async () => {
    installSyncBridge(7500);
    await expect(
      assertDeviceRamTierAllowsLocalRuntime("cloud-inference"),
    ).resolves.toBeUndefined();
    await expect(
      assertDeviceRamTierAllowsLocalRuntime("configure-later"),
    ).resolves.toBeUndefined();
    await expect(
      assertDeviceRamTierAllowsLocalRuntime("all-local"),
    ).rejects.toThrow(/on-device models/);
  });

  it("passes everything on a 16 GB+ device", async () => {
    installSyncBridge(15.5 * 1024);
    await expect(
      assertDeviceRamTierAllowsLocalRuntime("all-local"),
    ).resolves.toBeUndefined();
  });

  it("never blocks when the device total is unreadable (unknown tier)", async () => {
    mocks.resourceSnapshot = { totalRamMb: null };
    await expect(
      assertDeviceRamTierAllowsLocalRuntime("all-local"),
    ).resolves.toBeUndefined();
  });
});

describe("enforceDeviceRamPolicyOnPersistedRuntimeModeAtBoot", () => {
  function seedLocalCommitment(): void {
    persistMobileRuntimeMode("local");
    savePersistedActiveServer({
      id: ANDROID_LOCAL_AGENT_SERVER_ID,
      kind: "remote",
      label: ANDROID_LOCAL_AGENT_LABEL,
      apiBase: ANDROID_LOCAL_AGENT_IPC_BASE,
    });
  }

  it("reverts a stale persisted local mode on a RAM-blocked device", () => {
    installSyncBridge(3660);
    seedLocalCommitment();

    expect(enforceDeviceRamPolicyOnPersistedRuntimeModeAtBoot()).toBe(true);
    expect(readPersistedMobileRuntimeMode()).toBeNull();
    expect(loadPersistedActiveServer()).toBeNull();
  });

  it("keeps a persisted local mode on a capable device", () => {
    installSyncBridge(15.5 * 1024);
    seedLocalCommitment();

    expect(enforceDeviceRamPolicyOnPersistedRuntimeModeAtBoot()).toBe(false);
    expect(readPersistedMobileRuntimeMode()).toBe("local");
    expect(loadPersistedActiveServer()?.id).toBe(ANDROID_LOCAL_AGENT_SERVER_ID);
  });

  it("never touches cloud/remote modes even on a blocked device", () => {
    installSyncBridge(3660);
    persistMobileRuntimeMode("cloud");

    expect(enforceDeviceRamPolicyOnPersistedRuntimeModeAtBoot()).toBe(false);
    expect(readPersistedMobileRuntimeMode()).toBe("cloud");
  });

  it("does nothing when the RAM tier is not synchronously known", () => {
    // No sync bridge: the boot path must not block on the async probe; the
    // native shouldAutoStart gate independently refuses a blocked start.
    seedLocalCommitment();

    expect(enforceDeviceRamPolicyOnPersistedRuntimeModeAtBoot()).toBe(false);
    expect(readPersistedMobileRuntimeMode()).toBe("local");
  });

  it("is a no-op off mobile", () => {
    mocks.isAndroid = false;
    installSyncBridge(3660);
    persistMobileRuntimeMode("local");

    expect(enforceDeviceRamPolicyOnPersistedRuntimeModeAtBoot()).toBe(false);
    expect(readPersistedMobileRuntimeMode()).toBe("local");
  });
});
