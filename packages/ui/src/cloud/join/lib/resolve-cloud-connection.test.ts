/**
 * Deterministic unit tests for resolve-cloud-connection: validates boot-config
 * cloud API base fallback resolution, auth token extraction, and whitespace trimming.
 */
// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_BOOT_CONFIG,
  setBootConfig,
} from "../../../config/boot-config";
import {
  resolveJoinAuthToken,
  resolveJoinCloudApiBase,
} from "./resolve-cloud-connection";

function makeStorage(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, String(value));
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    clear: () => {
      store.clear();
    },
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    get length() {
      return store.size;
    },
  };
}

describe("resolve-cloud-connection", () => {
  let originalWindow: typeof globalThis.window | undefined;

  beforeEach(() => {
    if (typeof window === "undefined") {
      originalWindow = (globalThis as { window?: typeof globalThis.window })
        .window;
      (globalThis as { window?: unknown }).window = {
        localStorage: makeStorage(),
      };
    } else {
      window.localStorage.clear();
    }
    setBootConfig(DEFAULT_BOOT_CONFIG);
    vi.restoreAllMocks();
  });

  afterEach(() => {
    if (typeof window !== "undefined" && window.localStorage) {
      window.localStorage.clear();
    }
    if (originalWindow !== undefined) {
      (globalThis as { window?: unknown }).window = originalWindow;
    }
    setBootConfig(DEFAULT_BOOT_CONFIG);
    vi.restoreAllMocks();
  });

  describe("resolveJoinCloudApiBase", () => {
    it("resolves default boot-config cloud API base URL", () => {
      setBootConfig(DEFAULT_BOOT_CONFIG);
      expect(resolveJoinCloudApiBase()).toBe("https://eliza.app");
    });

    it("falls back to DEFAULT_CLOUD_API_BASE when cloudApiBase is missing or empty", () => {
      setBootConfig({ ...DEFAULT_BOOT_CONFIG, cloudApiBase: undefined });
      expect(resolveJoinCloudApiBase()).toBe("https://api.eliza.app");

      setBootConfig({ ...DEFAULT_BOOT_CONFIG, cloudApiBase: "" });
      expect(resolveJoinCloudApiBase()).toBe("https://api.eliza.app");

      setBootConfig({ ...DEFAULT_BOOT_CONFIG, cloudApiBase: "   " });
      expect(resolveJoinCloudApiBase()).toBe("https://api.eliza.app");
    });

    it("resolves and trims custom cloud API base URL", () => {
      setBootConfig({
        ...DEFAULT_BOOT_CONFIG,
        cloudApiBase: "  https://custom.eliza.app  ",
      });
      expect(resolveJoinCloudApiBase()).toBe("https://custom.eliza.app");
    });
  });

  describe("resolveJoinAuthToken", () => {
    it("resolves null when user is signed out (empty localStorage)", () => {
      expect(resolveJoinAuthToken()).toBeNull();
    });

    it("resolves and trims session token from localStorage", () => {
      window.localStorage.setItem("steward_session_token", "  tok  ");
      expect(resolveJoinAuthToken()).toBe("tok");
    });

    it("resolves null when session token in localStorage is whitespace-only", () => {
      window.localStorage.setItem("steward_session_token", "   ");
      expect(resolveJoinAuthToken()).toBeNull();
    });
  });
});
