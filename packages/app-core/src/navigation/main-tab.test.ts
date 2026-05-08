import { describe, expect, it, vi } from "vitest";
import type { RegistryAppInfo } from "@elizaos/shared";
import { getMainTabApp } from "./main-tab";

function buildApp(overrides: Partial<RegistryAppInfo>): RegistryAppInfo {
  return {
    name: "@elizaos/app-test",
    displayName: "Test",
    description: "",
    category: "tool",
    launchType: "url",
    launchUrl: null,
    icon: null,
    heroImage: null,
    capabilities: [],
    stars: 0,
    repository: "",
    latestVersion: null,
    supports: { v0: false, v1: false, v2: true },
    npm: {
      package: "@elizaos/app-test",
      v0Version: null,
      v1Version: null,
      v2Version: null,
    },
    ...overrides,
  };
}

describe("getMainTabApp", () => {
  it("returns null when no app declares mainTab", () => {
    const apps = [
      buildApp({ name: "@elizaos/app-a" }),
      buildApp({ name: "@elizaos/app-b", mainTab: false }),
    ];
    expect(getMainTabApp(apps)).toBeNull();
  });

  it("returns null for an empty catalog", () => {
    expect(getMainTabApp([])).toBeNull();
  });

  it("returns the unique declarer", () => {
    const apps = [
      buildApp({ name: "@elizaos/app-a" }),
      buildApp({ name: "@elizaos/app-chat", mainTab: true }),
    ];
    const result = getMainTabApp(apps);
    expect(result).toEqual({ tabId: "chat", appName: "@elizaos/app-chat" });
  });

  it("picks the alphabetically-first declarer when multiple claim mainTab", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const apps = [
        buildApp({ name: "@elizaos/app-zeta", mainTab: true }),
        buildApp({ name: "@elizaos/app-alpha", mainTab: true }),
        buildApp({ name: "@elizaos/app-beta", mainTab: true }),
      ];
      const result = getMainTabApp(apps);
      expect(result).toEqual({
        tabId: "alpha",
        appName: "@elizaos/app-alpha",
      });
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0]?.[0]).toMatch(/multiple apps declare/i);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("ignores non-true values for mainTab", () => {
    const apps = [
      buildApp({
        name: "@elizaos/app-a",
        mainTab: undefined as unknown as boolean,
      }),
    ];
    expect(getMainTabApp(apps)).toBeNull();
  });
});
