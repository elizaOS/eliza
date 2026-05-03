// @vitest-environment jsdom

/**
 * Pre-seed contract for the ElizaOS APK boot flow.
 *
 * The AOSP ElizaOS variant bypasses the RuntimeGate "Choose your setup"
 * picker entirely — `apps/app/src/main.tsx` calls
 * `preSeedAndroidLocalRuntimeIfFresh()` before React mounts (gated on
 * `isElizaOS()`), which writes the persisted runtime mode + active
 * server so `StartupShell` (and RuntimeGate's ElizaOS branch) treat the
 * device as already-onboarded for the local on-device agent.
 *
 * The same APK installed on a stock Android phone never enters this
 * branch — it falls through to the picker and a deliberate user choice
 * is required. The tests below exercise the helper in isolation; the
 * `isElizaOS()` gate is covered separately by `is-eliza-os.test.ts`
 * and the `RuntimeGate.test.tsx` mocks.
 *
 * These tests pin the two invariants:
 *   1. On a clean install (no persisted state at all), the helper writes
 *      both keys exactly once and returns `true`.
 *   2. When *any* prior choice exists — either `eliza:mobile-runtime-mode`
 *      or `elizaos:active-server` — the helper does nothing and returns
 *      `false`. A user's deliberate cloud/remote selection from a previous
 *      session must never be clobbered by the pre-seed.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ANDROID_LOCAL_AGENT_API_BASE,
  ANDROID_LOCAL_AGENT_LABEL,
  ANDROID_LOCAL_AGENT_SERVER_ID,
  MOBILE_RUNTIME_MODE_STORAGE_KEY,
  readPersistedMobileRuntimeMode,
} from "../../src/onboarding/mobile-runtime-mode";
import { preSeedAndroidLocalRuntimeIfFresh } from "../../src/onboarding/pre-seed-local-runtime";

const ACTIVE_SERVER_STORAGE_KEY = "elizaos:active-server";

// Node 25's experimental global `localStorage` shadows jsdom's; install an
// in-memory shim so the helpers under test see a real Storage.
function installMemoryLocalStorage(): Storage {
  const store = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return store.size;
    },
    clear() {
      store.clear();
    },
    getItem(key: string) {
      return store.has(key) ? (store.get(key) ?? null) : null;
    },
    key(index: number) {
      return Array.from(store.keys())[index] ?? null;
    },
    removeItem(key: string) {
      store.delete(key);
    },
    setItem(key: string, value: string) {
      store.set(key, String(value));
    },
  };
  Object.defineProperty(globalThis, "localStorage", {
    value: storage,
    configurable: true,
    writable: true,
  });
  if (typeof window !== "undefined") {
    Object.defineProperty(window, "localStorage", {
      value: storage,
      configurable: true,
      writable: true,
    });
  }
  return storage;
}

interface PersistedActiveServer {
  id: string;
  kind: "remote" | "cloud" | "local";
  label: string;
  apiBase?: string;
}

function readActiveServer(storage: Storage): PersistedActiveServer | null {
  const raw = storage.getItem(ACTIVE_SERVER_STORAGE_KEY);
  if (!raw) return null;
  return JSON.parse(raw) as PersistedActiveServer;
}

function writeActiveServer(
  storage: Storage,
  server: PersistedActiveServer,
): void {
  storage.setItem(ACTIVE_SERVER_STORAGE_KEY, JSON.stringify(server));
}

describe("preSeedAndroidLocalRuntimeIfFresh", () => {
  let storage: Storage;

  beforeEach(() => {
    storage = installMemoryLocalStorage();
    storage.clear();
  });

  afterEach(() => {
    storage.clear();
  });

  it("writes the persisted runtime mode + active server on a clean install", () => {
    expect(readPersistedMobileRuntimeMode()).toBeNull();
    expect(readActiveServer(storage)).toBeNull();

    const wrote = preSeedAndroidLocalRuntimeIfFresh();

    expect(wrote).toBe(true);
    expect(storage.getItem(MOBILE_RUNTIME_MODE_STORAGE_KEY)).toBe("local");
    expect(readPersistedMobileRuntimeMode()).toBe("local");

    const server = readActiveServer(storage);
    expect(server).not.toBeNull();
    expect(server).toMatchObject({
      id: ANDROID_LOCAL_AGENT_SERVER_ID,
      kind: "remote",
      label: ANDROID_LOCAL_AGENT_LABEL,
      apiBase: ANDROID_LOCAL_AGENT_API_BASE,
    });
  });

  it("is a no-op when a persisted runtime mode already exists", () => {
    storage.setItem(MOBILE_RUNTIME_MODE_STORAGE_KEY, "cloud");

    const wrote = preSeedAndroidLocalRuntimeIfFresh();

    expect(wrote).toBe(false);
    expect(storage.getItem(MOBILE_RUNTIME_MODE_STORAGE_KEY)).toBe("cloud");
    expect(readActiveServer(storage)).toBeNull();
  });

  it("is a no-op when an active server is already persisted", () => {
    writeActiveServer(storage, {
      id: "remote:https://my-mac.local",
      kind: "remote",
      label: "my-mac",
      apiBase: "https://my-mac.local",
    });

    const wrote = preSeedAndroidLocalRuntimeIfFresh();

    expect(wrote).toBe(false);
    const server = readActiveServer(storage);
    expect(server?.id).toBe("remote:https://my-mac.local");
    expect(server?.apiBase).toBe("https://my-mac.local");
    expect(readPersistedMobileRuntimeMode()).toBeNull();
  });

  it("is a no-op when both a runtime mode and an active server already exist", () => {
    storage.setItem(MOBILE_RUNTIME_MODE_STORAGE_KEY, "cloud");
    writeActiveServer(storage, {
      id: "cloud:foo",
      kind: "cloud",
      label: "Eliza Cloud",
      apiBase: "https://api.eliza.example",
    });

    const wrote = preSeedAndroidLocalRuntimeIfFresh();

    expect(wrote).toBe(false);
    expect(storage.getItem(MOBILE_RUNTIME_MODE_STORAGE_KEY)).toBe("cloud");
    expect(readActiveServer(storage)?.kind).toBe("cloud");
  });

  it("is idempotent — a second call after a successful seed is a no-op", () => {
    expect(preSeedAndroidLocalRuntimeIfFresh()).toBe(true);
    expect(preSeedAndroidLocalRuntimeIfFresh()).toBe(false);

    expect(readPersistedMobileRuntimeMode()).toBe("local");
    expect(readActiveServer(storage)?.id).toBe(ANDROID_LOCAL_AGENT_SERVER_ID);
  });
});
