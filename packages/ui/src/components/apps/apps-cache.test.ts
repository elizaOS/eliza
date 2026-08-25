/**
 * Unit tests for apps cache: validates catalog caching and validation.
 */

import type { RegistryAppInfo } from "@elizaos/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearAppsCache, readAppsCache, writeAppsCache } from "./apps-cache.ts";

describe("apps-cache", () => {
  const storage = new Map<string, string>();
  const globalScope = globalThis as unknown as { window?: unknown };

  beforeEach(() => {
    storage.clear();
    globalScope.window = {
      localStorage: {
        getItem: (k: string) => storage.get(k) ?? null,
        setItem: (k: string, v: string) => storage.set(k, v),
        removeItem: (k: string) => storage.delete(k),
        clear: () => storage.clear(),
      },
    };
  });

  afterEach(() => {
    delete globalScope.window;
  });

  it("returns null when cache is empty", () => {
    expect(readAppsCache()).toBeNull();
  });

  it("writes and reads valid registry apps list", () => {
    const mockApps = [
      { name: "demo-app", displayName: "Demo App" },
    ] as unknown as RegistryAppInfo[];
    writeAppsCache(mockApps);
    const read = readAppsCache();
    expect(read).toEqual(mockApps);
  });

  it("clears cache correctly", () => {
    const mockApps = [{ name: "demo-app" }] as unknown as RegistryAppInfo[];
    writeAppsCache(mockApps);
    clearAppsCache();
    expect(readAppsCache()).toBeNull();
  });
});
