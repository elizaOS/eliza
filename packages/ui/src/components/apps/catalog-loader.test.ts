import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ELIZAOS_AOSP_UA =
  "Mozilla/5.0 (Linux; Android 15; sdk_gphone64_x86_64) AppleWebKit/537.36 ElizaOS/dev-2026-01";
const STOCK_ANDROID_UA =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36";

const { listCatalogAppsMock, listAppsMock, capacitorState, navigatorMock } =
  vi.hoisted(() => ({
    listCatalogAppsMock: vi.fn(),
    listAppsMock: vi.fn(),
    capacitorState: { platform: "android" as string },
    navigatorMock: {
      userAgent:
        "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36",
    },
  }));

vi.mock("../../api", () => ({
  client: {
    listCatalogApps: listCatalogAppsMock,
    listApps: listAppsMock,
  },
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    getPlatform: () => capacitorState.platform,
  },
}));

vi.stubGlobal("Capacitor", {
  getPlatform: () => capacitorState.platform,
});
vi.stubGlobal("navigator", navigatorMock);

import { loadMergedCatalogApps } from "./catalog-loader";
import { registerOverlayApp } from "./overlay-app-registry";

const OVERLAY_REGISTRY_KEY = "__elizaosOverlayAppRegistry__";

interface ServerAppRow {
  name: string;
  displayName: string;
  description: string;
  category: string;
  launchType: string;
  launchUrl: string | null;
  icon: string | null;
  heroImage: string | null;
  capabilities: string[];
  stars: number;
  repository: string;
  latestVersion: string | null;
  supports: { v0: boolean; v1: boolean; v2: boolean };
  npm: {
    package: string;
    v0Version: string | null;
    v1Version: string | null;
    v2Version: string | null;
  };
}

function makeServerApp(name: string): ServerAppRow {
  return {
    name,
    displayName: name,
    description: name,
    category: "system",
    launchType: "overlay",
    launchUrl: null,
    icon: null,
    heroImage: null,
    capabilities: [],
    stars: 0,
    repository: "",
    latestVersion: null,
    supports: { v0: false, v1: false, v2: true },
    npm: {
      package: name,
      v0Version: null,
      v1Version: null,
      v2Version: null,
    },
  };
}

describe("loadMergedCatalogApps AOSP filter", () => {
  beforeEach(() => {
    (
      globalThis as {
        [OVERLAY_REGISTRY_KEY]?: Map<string, unknown>;
      }
    )[OVERLAY_REGISTRY_KEY] = new Map();
    registerOverlayApp({
      name: "@elizaos/app-phone",
      displayName: "Phone",
      description: "phone",
      category: "system",
      icon: null,
      androidOnly: true,
      Component: () => null as never,
    });
    registerOverlayApp({
      name: "@elizaos/app-contacts",
      displayName: "Contacts",
      description: "contacts",
      category: "system",
      icon: null,
      androidOnly: true,
      Component: () => null as never,
    });
    registerOverlayApp({
      name: "@elizaos/app-wifi",
      displayName: "WiFi",
      description: "wifi",
      category: "system",
      icon: null,
      androidOnly: true,
      Component: () => null as never,
    });

    listCatalogAppsMock.mockReset();
    listAppsMock.mockReset();
    listCatalogAppsMock.mockResolvedValue([]);
    listAppsMock.mockResolvedValue([
      makeServerApp("@elizaos/app-phone"),
      makeServerApp("@elizaos/app-contacts"),
      makeServerApp("@elizaos/app-wifi"),
      makeServerApp("@elizaos/app-companion"),
    ]);
    capacitorState.platform = "android";
    navigatorMock.userAgent = STOCK_ANDROID_UA;
  });

  afterEach(() => {
    (
      globalThis as {
        [OVERLAY_REGISTRY_KEY]?: Map<string, unknown>;
      }
    )[OVERLAY_REGISTRY_KEY] = new Map();
  });

  const ANDROID_ONLY_APP_NAMES = [
    "@elizaos/app-contacts",
    "@elizaos/app-phone",
    "@elizaos/app-wifi",
  ];

  function pickAndroidOnly(names: string[]): string[] {
    return names.filter((name) => ANDROID_ONLY_APP_NAMES.includes(name)).sort();
  }

  it("hides androidOnly apps on stock Android even when the agent reports them as installed", async () => {
    const apps = await loadMergedCatalogApps({ includeHiddenApps: true });
    const names = apps.map((a) => a.name);
    expect(pickAndroidOnly(names)).toEqual([]);
    expect(names).toContain("@elizaos/app-companion");
  });

  it("shows androidOnly apps once on AOSP Eliza-derived Android, deduped across overlay+installed", async () => {
    capacitorState.platform = "android";
    navigatorMock.userAgent = ELIZAOS_AOSP_UA;
    const apps = await loadMergedCatalogApps({ includeHiddenApps: true });
    const names = apps.map((a) => a.name);
    expect(pickAndroidOnly(names)).toEqual(ANDROID_ONLY_APP_NAMES);
    expect(new Set(names).size).toBe(names.length);
  });

  it("hides androidOnly apps on desktop Linux even with installed-app rows", async () => {
    capacitorState.platform = "web";
    navigatorMock.userAgent =
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Electrobun/1.0";
    const apps = await loadMergedCatalogApps({ includeHiddenApps: true });
    const names = apps.map((a) => a.name);
    expect(pickAndroidOnly(names)).toEqual([]);
    expect(names).toContain("@elizaos/app-companion");
  });
});
