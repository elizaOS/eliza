import { describe, expect, it } from "vitest";
import type { RegistryAppInfo } from "../api";
import type { ViewRegistryEntry } from "./useAvailableViews";
import {
  collapseViewEntries,
  mergeViewCatalog,
  type ViewEntry,
  type ViewModality,
  viewToEntry,
} from "./view-catalog";

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
    enabledKinds: opts.enabledKinds ?? { developer: false, preview: false },
  });
}

describe("viewToEntry", () => {
  it("uses generated local art for icon-only loaded views", () => {
    const entry = viewToEntry(
      makeView("notes", {
        icon: "StickyNote",
        hasHeroImage: false,
      }),
    );
    expect(entry.hasHero).toBe(false);
    expect(entry.imageUrl).toMatch(/^data:image\/svg\+xml,/);
    expect(entry.fallbackImageUrl).toBe(entry.imageUrl);
    expect(entry.icon).toBe("StickyNote");
  });

  it("does not render backend hero URLs without a declared real hero asset", () => {
    const entry = viewToEntry(
      makeView("notes", {
        icon: "StickyNote",
        heroImageUrl: "/api/views/notes/hero",
        hasHeroImage: false,
      }),
    );
    expect(entry.hasHero).toBe(false);
    expect(entry.heroUrl).toBeUndefined();
    expect(entry.imageUrl).toMatch(/^data:image\/svg\+xml,/);
    expect(entry.imageUrl).not.toBe("/api/views/notes/hero");
    expect(entry.fallbackImageUrl).toBe(entry.imageUrl);
    expect(entry.icon).toBe("StickyNote");
  });

  it("uses concrete registry hero URLs when a loaded view provides one", () => {
    const entry = viewToEntry(
      makeView("notes", {
        heroImageUrl: "/api/views/notes/hero",
        hasHeroImage: true,
      }),
    );
    expect(entry.hasHero).toBe(true);
    expect(entry.heroUrl).toBe("/api/views/notes/hero");
    expect(entry.imageUrl).toBe("/api/views/notes/hero");
  });
});

describe("mergeViewCatalog", () => {
  it("marks loaded views as Open (loaded) and not-loaded catalog apps as Get (available)", () => {
    const entries = merge({
      views: [makeView("chat", { pluginName: "@elizaos/builtin" })],
      catalog: [
        makeApp({
          name: "@elizaos/plugin-arcade",
          displayName: "Arcade",
          category: "game",
          heroImage: "/api/apps/hero/arcade",
        }),
      ],
    });
    const chat = entries.find((e) => e.id === "chat");
    const claw = entries.find((e) => e.appName === "@elizaos/plugin-arcade");
    expect(chat?.state).toBe("loaded");
    expect(chat?.kind).toBe("view");
    expect(claw?.state).toBe("available");
    expect(claw?.kind).toBe("app");
    expect(claw?.label).toBe("Arcade");
    expect(claw?.heroUrl).toBe("/api/apps/hero/arcade");
    expect(claw?.hasHero).toBe(true);
    expect(claw?.imageUrl).toBe("/api/apps/hero/arcade");
    expect(claw?.fallbackImageUrl).toMatch(/^data:image\/svg\+xml,/);
  });

  it("uses an absolute (shell-reachable) app hero as the real tile image", () => {
    const entries = merge({
      catalog: [
        makeApp({
          name: "@elizaos/plugin-arcade",
          displayName: "Arcade",
          heroImage: "https://cdn.example.com/arcade.png",
        }),
      ],
    });
    const claw = entries.find((e) => e.appName === "@elizaos/plugin-arcade");
    // An absolute URL loads in any shell, so it is the real hero + primary image.
    expect(claw?.hasHero).toBe(true);
    expect(claw?.heroUrl).toBe("https://cdn.example.com/arcade.png");
    expect(claw?.imageUrl).toBe("https://cdn.example.com/arcade.png");
    // The fallback is still the branded SVG for an onError recovery.
    expect(claw?.fallbackImageUrl).toMatch(/^data:image\/svg\+xml,/);
  });

  it("generates branded image fallbacks for entries without real hero art", () => {
    const entries = merge({
      views: [makeView("calendar", { label: "Calendar" })],
      catalog: [
        makeApp({ name: "@elizaos/plugin-notes", displayName: "Notes" }),
      ],
    });

    const calendar = entries.find((e) => e.id === "calendar");
    const notes = entries.find((e) => e.id === "@elizaos/plugin-notes");
    expect(calendar?.heroUrl).toBeUndefined();
    expect(calendar?.imageUrl).toMatch(/^data:image\/svg\+xml,/);
    expect(calendar?.fallbackImageUrl).toMatch(/^data:image\/svg\+xml,/);
    expect(notes?.heroUrl).toBeUndefined();
    expect(notes?.imageUrl).toMatch(/^data:image\/svg\+xml,/);
    expect(notes?.fallbackImageUrl).toMatch(/^data:image\/svg\+xml,/);
  });
});

describe("viewToEntry uses bundled icons (native 404 fix)", () => {
  it("uses the bundled preloaded icon, never the /api hero, when no real hero exists", () => {
    const entry = viewToEntry(
      makeView("calendar", {
        label: "Calendar",
        hasHeroImage: false,
        heroImageUrl: "/api/views/calendar/hero",
      }),
    );
    expect(entry.hasHero).toBe(false);
    expect(entry.heroUrl).toBeUndefined();
    expect(entry.imageUrl).toMatch(/^data:image\/svg\+xml,/);
    expect(entry.imageUrl).not.toBe("/api/views/calendar/hero");
  });

  it("uses the registry hero for a view when the agent reports a real asset", () => {
    const entry = viewToEntry(
      makeView("notes", {
        label: "Notes",
        hasHeroImage: true,
        heroImageUrl: "/api/views/notes/hero",
      }),
    );
    expect(entry.hasHero).toBe(true);
    expect(entry.heroUrl).toBe("/api/views/notes/hero");
    expect(entry.imageUrl).toBe("/api/views/notes/hero");
    expect(entry.fallbackImageUrl).toMatch(/^data:image\/svg\+xml,/);
  });

  it("dedupes: a catalog app whose plugin is already a loaded view is not shown twice", () => {
    const entries = merge({
      views: [makeView("arcade", { pluginName: "@elizaos/plugin-arcade" })],
      catalog: [
        makeApp({
          name: "@elizaos/plugin-arcade",
          displayName: "Arcade",
        }),
      ],
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.kind).toBe("view");
    expect(entries[0]?.state).toBe("loaded");
  });

  it("marks an active/installed catalog app as loaded even without a bundled view", () => {
    const entries = merge({
      catalog: [
        makeApp({ name: "@elizaos/plugin-external", displayName: "Ext" }),
      ],
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
    expect(
      merge({ ...base, enabledKinds: { developer: true, preview: false } }),
    ).toHaveLength(2);
  });

  it("hides preview entries unless preview mode is on", () => {
    const base = {
      views: [makeView("alpha", { viewKind: "preview" })],
      catalog: [
        makeApp({ name: "@elizaos/plugin-alpha-app", viewKind: "preview" }),
      ],
    };
    // Off by default, even with developer mode on.
    expect(merge(base)).toHaveLength(0);
    expect(
      merge({ ...base, enabledKinds: { developer: true, preview: false } }),
    ).toHaveLength(0);
    expect(
      merge({ ...base, enabledKinds: { developer: false, preview: true } }),
    ).toHaveLength(2);
  });

  it("always shows system and release views regardless of toggles", () => {
    const entries = merge({
      views: [
        makeView("chat", {
          viewKind: "system",
          pluginName: "@elizaos/builtin",
        }),
        makeView("wallet", { viewKind: "release" }),
      ],
      enabledKinds: { developer: false, preview: false },
    });
    expect(entries.map((e) => e.id).sort()).toEqual(["chat", "wallet"]);
    expect(entries.find((e) => e.id === "chat")?.viewKind).toBe("system");
    expect(entries.find((e) => e.id === "wallet")?.viewKind).toBe("release");
  });

  it("respects visibleInManager:false and visibleInAppStore:false", () => {
    const entries = merge({
      views: [makeView("hidden", { visibleInManager: false })],
      catalog: [
        makeApp({ name: "@elizaos/plugin-hidden", visibleInAppStore: false }),
      ],
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
      catalog: [makeApp({ name: "@elizaos/plugin-arcade" })],
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

function viewEntry(id: string, patch: Partial<ViewEntry> = {}): ViewEntry {
  return {
    key: `view:${id}`,
    id,
    label: id,
    hasHero: false,
    modality: "gui",
    state: "loaded",
    kind: "view",
    ...patch,
  };
}

describe("collapseViewEntries", () => {
  it("collapses same-id gui/xr/tui entries into one with the surface union", () => {
    const collapsed = collapseViewEntries([
      viewEntry("phone", { label: "Phone", modality: "gui" }),
      viewEntry("phone", { label: "Phone XR", modality: "xr" }),
      viewEntry("phone", { label: "Phone TUI", modality: "tui" }),
    ]);
    expect(collapsed).toHaveLength(1);
    expect(collapsed[0].label).toBe("Phone");
    expect(collapsed[0].modalities).toEqual(["gui", "xr", "tui"]);
  });

  it("prefers the gui entry as the base even when it arrives last", () => {
    const collapsed = collapseViewEntries([
      viewEntry("phone", { label: "Phone TUI", modality: "tui" }),
      viewEntry("phone", { label: "Phone", modality: "gui" }),
    ]);
    expect(collapsed).toHaveLength(1);
    expect(collapsed[0].label).toBe("Phone");
    expect(collapsed[0].modalities).toEqual(["gui", "tui"]);
  });

  it("preserves first-seen order and leaves app entries (unique ids) untouched", () => {
    const collapsed = collapseViewEntries([
      viewEntry("wallet", { modality: "gui" }),
      { ...viewEntry("@x/app"), kind: "app", appName: "@x/app" },
      viewEntry("wallet", { modality: "tui" }),
    ]);
    expect(collapsed.map((e) => e.id)).toEqual(["wallet", "@x/app"]);
    expect(collapsed[0].modalities).toEqual(["gui", "tui"]);
    expect(collapsed[1].modalities).toEqual(["gui"]);
  });
});
