// @vitest-environment jsdom

/**
 * Unit coverage for the decision matrix in `preSeedAndroidLocalRuntimeIfFresh`
 * (#14390): only a branded ElizaOS device image (the device IS the agent) is
 * pre-seeded, and only while nothing has already chosen a server/runtime.
 * Stock-phone sideload builds are never pre-seeded — their fresh install lands
 * in onboarding, which starts the local agent on demand after the user picks
 * it. UA detection mocked, no real device.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  isAospElizaUserAgent: vi.fn(() => false),
  readPersistedMobileRuntimeMode: vi.fn(() => null as string | null),
  persistMobileRuntimeModeForServerTarget: vi.fn(),
}));

vi.mock("../platform/aosp-user-agent", () => ({
  isAospElizaUserAgent: mocks.isAospElizaUserAgent,
}));

vi.mock("./mobile-runtime-mode", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./mobile-runtime-mode")>();
  return {
    ...actual,
    readPersistedMobileRuntimeMode: mocks.readPersistedMobileRuntimeMode,
    persistMobileRuntimeModeForServerTarget:
      mocks.persistMobileRuntimeModeForServerTarget,
  };
});

import {
  ANDROID_LOCAL_AGENT_IPC_BASE,
  ANDROID_LOCAL_AGENT_LABEL,
  ANDROID_LOCAL_AGENT_SERVER_ID,
} from "./mobile-runtime-mode";
import { preSeedAndroidLocalRuntimeIfFresh } from "./pre-seed-local-runtime";

const ACTIVE_SERVER_STORAGE_KEY = "elizaos:active-server";

// This jsdom env exposes `window.localStorage` as an object without methods;
// install a real in-memory Storage (mirrors `first-run.test.ts`) so the file
// is self-contained instead of relying on another suite's side effect.
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

function setUserAgent(value: string): void {
  Object.defineProperty(navigator, "userAgent", {
    configurable: true,
    value,
  });
}

const STOCK_WEBVIEW_UA =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP1A; wv) AppleWebKit/537.36";
const STOCK_BROWSER_UA =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/124";

function readSeededActiveServer(): unknown {
  const raw = localStorage.getItem(ACTIVE_SERVER_STORAGE_KEY);
  return raw ? JSON.parse(raw) : null;
}

describe("preSeedAndroidLocalRuntimeIfFresh", () => {
  beforeEach(() => {
    ensureLocalStorage().clear();
    mocks.isAospElizaUserAgent.mockReturnValue(false);
    mocks.readPersistedMobileRuntimeMode.mockReturnValue(null);
    mocks.persistMobileRuntimeModeForServerTarget.mockClear();
    setUserAgent(STOCK_BROWSER_UA);
  });

  afterEach(() => {
    ensureLocalStorage().clear();
  });

  it("seeds the local agent on a branded ElizaOS device", () => {
    mocks.isAospElizaUserAgent.mockReturnValue(true);
    setUserAgent(`${STOCK_BROWSER_UA} ElizaOS/2026.1`);

    expect(preSeedAndroidLocalRuntimeIfFresh()).toBe(true);
    expect(mocks.persistMobileRuntimeModeForServerTarget).toHaveBeenCalledWith(
      "local",
    );
    expect(readSeededActiveServer()).toEqual({
      id: ANDROID_LOCAL_AGENT_SERVER_ID,
      kind: "remote",
      label: ANDROID_LOCAL_AGENT_LABEL,
      apiBase: ANDROID_LOCAL_AGENT_IPC_BASE,
    });
  });

  it("does not seed the stock-phone sideload build (onboarding owns the choice, #14390)", () => {
    // Pre-#14390 this build was pre-seeded, which committed "local" before
    // any user choice and auto-booted the bundled agent on phones that cannot
    // sustain it. The sideload now defaults the runtime chooser ON
    // (first-run-runtime-flag.ts) and starts the agent from the finish path
    // only after the user picks "On this device".
    setUserAgent(STOCK_WEBVIEW_UA);

    expect(preSeedAndroidLocalRuntimeIfFresh()).toBe(false);
    expect(
      mocks.persistMobileRuntimeModeForServerTarget,
    ).not.toHaveBeenCalled();
    expect(readSeededActiveServer()).toBeNull();
  });

  it("does not seed a branded device when an active server is already persisted", () => {
    mocks.isAospElizaUserAgent.mockReturnValue(true);
    localStorage.setItem(
      ACTIVE_SERVER_STORAGE_KEY,
      JSON.stringify({
        id: "remote:https://existing.example.com",
        kind: "remote",
        label: "https://existing.example.com",
        apiBase: "https://existing.example.com",
      }),
    );

    expect(preSeedAndroidLocalRuntimeIfFresh()).toBe(false);
    expect(
      mocks.persistMobileRuntimeModeForServerTarget,
    ).not.toHaveBeenCalled();
  });

  it("does not seed a branded device with an explicit non-local runtime mode", () => {
    mocks.isAospElizaUserAgent.mockReturnValue(true);
    mocks.readPersistedMobileRuntimeMode.mockReturnValue("cloud");

    expect(preSeedAndroidLocalRuntimeIfFresh()).toBe(false);
    expect(
      mocks.persistMobileRuntimeModeForServerTarget,
    ).not.toHaveBeenCalled();
    expect(readSeededActiveServer()).toBeNull();
  });

  it("does not seed a stock Android browser (no brand UA)", () => {
    setUserAgent(STOCK_BROWSER_UA);

    expect(preSeedAndroidLocalRuntimeIfFresh()).toBe(false);
    expect(
      mocks.persistMobileRuntimeModeForServerTarget,
    ).not.toHaveBeenCalled();
  });
});
