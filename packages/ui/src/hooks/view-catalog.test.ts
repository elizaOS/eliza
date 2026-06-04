import { describe, expect, it } from "vitest";
import type { RegistryAppInfo } from "../api";
import type { ViewRegistryEntry } from "./useAvailableViews";
import { mergeViewCatalog, type ViewModality } from "./view-catalog";

function makeView(
  id: string,
  patch: Partial<ViewRegistryEntry> = {},
): ViewRegistryEntry {
  return {
    id,
    label: id,
    available: true,
    pluginName: `@elizaos/plugin-${id}`,
    ...patch,
  };
}

// Test fixtures only exercise the fields mergeViewCatalog reads; the cast keeps
// the fixture minimal without enumerating the full RegistryAppInfo contract.
function makeApp(
  patch: Partial<RegistryAppInfo> & { name: string },
): RegistryAppInfo {
  return { displayName: patch.name, ...patch } as RegistryAppInfo;
}

function merge(
  opts: Partial<Parameters<typeof mergeViewCatalog>[0]> & {
    activeModality?: ViewModality;
  } = {},
) {
  return mergeViewCatalog({
    views: opts.views ?? [],
    catalog: opts.catalog ?? [],
    installed: opts.installed ?? [],
    activeModality: opts.activeModality ?? "gui",
    isDeveloperMode: opts.isDeveloperMode ?? false,
  });
}

describe("mergeViewCatalog", () => {
  it("marks loaded views as Open (loaded) and not-loaded catalog apps as Get (available)", () => {
    const entries = merge({
      views: [makeView("chat", { pluginName: "@elizaos/builtin" })],
      catalog: [
        makeApp({
          name: "@elizaos/plugin-clawville",
          displayName: "ClawVille",
          category: "game",
          heroImage: "/api/apps/hero/clawville",
        }),
      ],
    });
    const chat = entries.find((e) => e.id === "chat");
    const claw = entries.find((e) => e.appName === "@elizaos/plugin-clawville");
    expect(chat?.state).toBe("loaded");
    expect(chat?.kind).toBe("view");
    expect(claw?.state).toBe("available");
    expect(claw?.kind).toBe("app");
    expect(claw?.label).toBe("ClawVille");
    expect(claw?.heroUrl).toBe("/api/apps/hero/clawville");
    expect(claw?.hasHero).toBe(true);
  });

  it("dedupes: a catalog app whose plugin is already a loaded view is not shown twice", () => {
    const entries = merge({
      views: [makeView("clawville", { pluginName: "@elizaos/plugin-clawville" })],
      catalog: [
        makeApp({ name: "@elizaos/plugin-clawville", displayName: "ClawVille" }),
      ],
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.kind).toBe("view");
    expect(entries[0]?.state).toBe("loaded");
  });

  it("marks an active/installed catalog app as loaded even without a bundled view", () => {
    const entries = merge({
      catalog: [makeApp({ name: "@elizaos/plugin-external", displayName: "Ext" })],
      installed: [{ name: "@elizaos/plugin-external" }],
    });
    expect(entries[0]?.state).toBe("loaded");
  });

  it("hides developer-only entries unless developer mode is on", () => {
    const base = {
      views: [makeView("trace", { developerOnly: true })],
      catalog: [makeApp({ name: "@elizaos/plugin-dev", developerOnly: true })],
    };
    expect(merge(base)).toHaveLength(0);
    expect(merge({ ...base, isDeveloperMode: true })).toHaveLength(2);
  });

  it("respects visibleInManager:false and visibleInAppStore:false", () => {
    const entries = merge({
      views: [makeView("hidden", { visibleInManager: false })],
      catalog: [makeApp({ name: "@elizaos/plugin-hidden", visibleInAppStore: false })],
    });
    expect(entries).toHaveLength(0);
  });

  it("on a non-GUI surface lists only loaded views of that modality, no catalog", () => {
    const entries = merge({
      activeModality: "xr",
      views: [
        makeView("spatial", { viewType: "xr" }),
        makeView("chat", { viewType: "gui" }),
      ],
      catalog: [makeApp({ name: "@elizaos/plugin-clawville" })],
    });
    expect(entries.map((e) => e.id)).toEqual(["spatial"]);
  });

  it("filters loaded views by the active modality (gui hides tui/xr)", () => {
    const entries = merge({
      views: [
        makeView("a", { viewType: "gui" }),
        makeView("b", { viewType: "tui" }),
        makeView("c", { viewType: "xr" }),
      ],
    });
    expect(entries.map((e) => e.id)).toEqual(["a"]);
  });
});
