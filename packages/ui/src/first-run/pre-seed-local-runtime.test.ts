// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Decision matrix for `preSeedAndroidLocalRuntimeIfFresh`: it should seed the
// on-device local agent only when the device IS the local agent and nothing
// has already chosen a server/runtime.

const mocks = vi.hoisted(() => ({
  capacitorPlatform: "web" as string,
  isAndroidCloudBuild: vi.fn(() => false),
  isAospElizaUserAgent: vi.fn(() => false),
  readPersistedMobileRuntimeMode: vi.fn(() => null as string | null),
  persistMobileRuntimeModeForServerTarget: vi.fn(),
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    getPlatform: () => mocks.capacitorPlatform,
  },
}));

vi.mock("../platform/android-runtime", () => ({
  isAndroidCloudBuild: mocks.isAndroidCloudBuild,
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
    mocks.capacitorPlatform = "web";
    mocks.isAndroidCloudBuild.mockReturnValue(false);
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

  it("does NOT auto-seed a stock-phone sideload — the first-run chooser offers local instead", () => {
    // A stock sideload used to auto-seed local, which skipped the 3-way
    // chooser, auto-started the slow on-device agent (POST_NOTIFICATIONS
    // prompt + "connecting to backend" hang). The chooser now offers a
    // "Local models" card, so the fresh install should render the chooser.
    mocks.capacitorPlatform = "android";
    mocks.isAndroidCloudBuild.mockReturnValue(false);
    setUserAgent(STOCK_WEBVIEW_UA);

    expect(preSeedAndroidLocalRuntimeIfFresh()).toBe(false);
    expect(
      mocks.persistMobileRuntimeModeForServerTarget,
    ).not.toHaveBeenCalled();
    expect(readSeededActiveServer()).toBeNull();
  });

  it("does not seed the cloud-locked Android build", () => {
    mocks.capacitorPlatform = "android";
    mocks.isAndroidCloudBuild.mockReturnValue(true);
    setUserAgent(STOCK_WEBVIEW_UA);

    expect(preSeedAndroidLocalRuntimeIfFresh()).toBe(false);
    expect(
      mocks.persistMobileRuntimeModeForServerTarget,
    ).not.toHaveBeenCalled();
    expect(readSeededActiveServer()).toBeNull();
  });

  it("does not seed when an active server is already persisted", () => {
    mocks.capacitorPlatform = "android";
    setUserAgent(STOCK_WEBVIEW_UA);
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

  it("does not seed when an explicit non-local runtime mode is persisted", () => {
    mocks.capacitorPlatform = "android";
    mocks.readPersistedMobileRuntimeMode.mockReturnValue("cloud");
    setUserAgent(STOCK_WEBVIEW_UA);

    expect(preSeedAndroidLocalRuntimeIfFresh()).toBe(false);
    expect(
      mocks.persistMobileRuntimeModeForServerTarget,
    ).not.toHaveBeenCalled();
    expect(readSeededActiveServer()).toBeNull();
  });

  it("does not seed a stock Android browser (no WebView marker, no brand UA)", () => {
    mocks.capacitorPlatform = "web";
    setUserAgent(STOCK_BROWSER_UA);

    expect(preSeedAndroidLocalRuntimeIfFresh()).toBe(false);
    expect(
      mocks.persistMobileRuntimeModeForServerTarget,
    ).not.toHaveBeenCalled();
  });
});
