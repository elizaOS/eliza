// @vitest-environment jsdom
/**
 * The mobile shell entry: one product registration drives theme, view ids,
 * launcher keys and the one favorites migration; Home, All apps and lazy
 * views render from it without the package barrel.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  InstalledApp,
  LauncherBridge,
} from "@elizaos/capacitor-system/launcher";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ELIZA_DEFAULT_THEME } from "../../config/theme";
import { BUILTIN_ROUTE_DESCRIPTORS } from "../../navigation/builtin-route-descriptors";
import {
  applyMobileShellTheme,
  compareMobileFeatureManifests,
  createMobileShellLauncher,
  createMobileViewRegistry,
  defineMobileProductRegistration,
  ELIZA_MOBILE_PRODUCT,
  MOBILE_SHELL_HOME,
  MOBILE_SHELL_LAUNCHER_CAPABILITIES,
  MOBILE_SHELL_VIEW_IDS,
  MobileAllAppsDrawer,
  MobileHomeScreen,
  type MobileProductRegistration,
  MobileViewHost,
  migrateLauncherViewIds,
  mobileFeatureDifferenceKey,
  mobileFeatureManifest,
  mobileShellThemeVariables,
  mobileShellViewPath,
  mobileShellViewPaths,
  navigateMobileShell,
  resolveMobileShellAppearance,
  resolveMobileShellSwipe,
  validateMobileProductRegistration,
} from "../index";

afterEach(cleanup);

const chrome = {
  scrim: "rgba(0,0,0,.2)",
  shadow: "rgba(0,0,0,.1)",
  frame: "#ddd",
};
const product = (): MobileProductRegistration => ({
  schema: "elizaos.mobile-product",
  schemaVersion: 1,
  revision: 3,
  identity: {
    appName: "Example Phone",
    appId: "com.example.phone",
    characterName: "Ex",
  },
  theme: {
    id: "example",
    name: "Example",
    defaultAppearance: "system",
    fonts: { body: "Sans, sans-serif", display: "Serif, serif" },
    light: {
      bg: "#ffffff",
      surface: "#f3f3f3",
      bgHover: "#e6e6e6",
      text: "#000000",
      muted: "#6b6b6b",
      border: "#e3e3e3",
      accent: "#0000ff",
      accentForeground: "#ffffff",
    },
    dark: {
      bg: "#000000",
      surface: "#151515",
      bgHover: "#262626",
      text: "#ffffff",
      muted: "#8f8f8f",
      border: "#262626",
      accent: "#0000ff",
      accentForeground: "#ffffff",
    },
    chrome: { light: chrome, dark: { ...chrome, frame: "#161616" } },
    aliases: {
      "--s2": "surface",
      "--serif": "fontDisplay",
      "--frame": "frame",
    },
  },
  icons: {
    baseUrl: "/icons/",
    views: { notes: "sticky-note", automations: "workflow" },
    allApps: "layout-grid",
  },
  backgrounds: { home: { dark: "#050505" } },
  views: {
    order: ["notes", "calendar", "automations", "settings"],
    labels: {
      notes: "Notes",
      calendar: "Calendar",
      automations: "Workflows",
      settings: "Settings",
    },
    rendererKeys: { automations: "workflows" },
    legacyIds: { home: "chat", workflows: "automations", wallet: "inventory" },
    serves: { calendar: ["reminders"] },
  },
  storage: {
    launcherFavorites: "example.launcher.favorites.v1",
    launcherBuiltinPrefix: "example:",
    launcherDefaultPolicy: "example-apps",
    retained: { appearance: "example.appearance.v1" },
  },
});

const registryFor = (available = (_id: string) => true) =>
  createMobileViewRegistry(defineMobileProductRegistration(product()), {
    views: [{ id: "settings", hidden: true }],
    available: (view) => available(view.id),
  });

describe("product registration", () => {
  it("accepts a complete record and reuses the shared theme definition", () => {
    expect(validateMobileProductRegistration(product())).toEqual([]);
    const eliza = {
      ...product(),
      theme: {
        ...ELIZA_DEFAULT_THEME,
        defaultAppearance: "dark",
        chrome: { light: chrome, dark: chrome },
      },
    };
    expect(validateMobileProductRegistration(eliza)).toEqual([]);
    const frozen = defineMobileProductRegistration(product());
    expect(Object.isFrozen(frozen.theme.light)).toBe(true);
  });

  it("names every problem instead of failing on the first", () => {
    const broken = product() as unknown as Record<string, any>;
    delete broken.theme.dark.accent;
    broken.theme.aliases["--bg"] = "bg";
    broken.views.legacyIds.notes = "calendar";
    broken.views.rendererKeys = { notes: "memo" };
    delete broken.views.labels.calendar;
    broken.views.serves = { calendar: ["notes"] };
    broken.storage.retained.again = "example.launcher.favorites.v1";
    broken.storage.launcherDefaultPolicy = "Example apps";
    broken.identity.appId = "not an id";
    const issues = validateMobileProductRegistration(broken);
    expect(issues).toEqual(
      expect.arrayContaining([
        "identity.appId: must be a reverse-domain application id",
        "theme.dark.accent: is required",
        "theme.aliases.--bg: must be a product property name",
        "views.legacyIds.notes: must be a non-canonical id",
        "views.labels.calendar: is required",
        "views.rendererKeys.notes: must be an older id of this ordered view",
        "views.serves.calendar: cannot serve notes",
        "storage: example.launcher.favorites.v1 is named twice",
        "storage.launcherDefaultPolicy: must be a lowercase name",
      ]),
    );
    expect(() =>
      defineMobileProductRegistration(broken as MobileProductRegistration),
    ).toThrow(/Invalid mobile product registration/);
  });

  it("resolves canonical, chrome, background and alias properties per appearance", () => {
    const registration = product();
    const light = mobileShellThemeVariables(registration, "light");
    expect(light).toMatchObject({
      "--bg": "#ffffff",
      "--surface": "#f3f3f3",
      "--text": "#000000",
      "--primary": "#0000ff",
      "--font-display": "Serif, serif",
      "--mobile-shell-scrim": chrome.scrim,
      "--mobile-shell-home-background": "#ffffff",
      "--s2": "#f3f3f3",
      "--serif": "Serif, serif",
      "--frame": "#ddd",
    });
    const dark = mobileShellThemeVariables(registration, "dark");
    expect(dark["--mobile-shell-home-background"]).toBe("#050505");
    expect(dark["--frame"]).toBe("#161616");
    const element = document.createElement("div");
    const remove = applyMobileShellTheme(element, registration, "dark");
    expect(element.style.getPropertyValue("--s2")).toBe("#151515");
    remove();
    expect(element.style.getPropertyValue("--s2")).toBe("");
    expect(resolveMobileShellAppearance(registration, null, true)).toBe("dark");
    expect(resolveMobileShellAppearance(registration, "light", true)).toBe(
      "light",
    );
  });
});

async function waitForNotice(container: HTMLElement): Promise<HTMLElement> {
  for (let i = 0; i < 50; i++) {
    const notice = container.querySelector<HTMLElement>(
      "[data-mobile-shell-view-error]",
    );
    if (notice) return notice;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("No failure notice");
}

describe("product palette", () => {
  it("emits fixed colours under product properties, per appearance where given", () => {
    const registration = product();
    (registration.theme as { palette?: unknown }).palette = {
      "--call-bg": "#000000",
      "--on-media": { light: "#ffffff", dark: "#eeeeee" },
    };
    expect(validateMobileProductRegistration(registration)).toEqual([]);
    expect(mobileShellThemeVariables(registration, "light")).toMatchObject({
      "--call-bg": "#000000",
      "--on-media": "#ffffff",
      "--s2": "#f3f3f3",
    });
    expect(mobileShellThemeVariables(registration, "dark")["--on-media"]).toBe(
      "#eeeeee",
    );
    const element = document.createElement("div");
    const remove = applyMobileShellTheme(element, registration, "dark");
    expect(element.style.getPropertyValue("--call-bg")).toBe("#000000");
    remove();
    expect(element.style.getPropertyValue("--call-bg")).toBe("");
  });

  it("refuses canonical names, alias clashes and incomplete appearances", () => {
    const registration = product();
    (registration.theme as { palette?: unknown }).palette = {
      "--bg": "#000",
      "--s2": "#111",
      "--mobile-shell-x": "#222",
      "--half": { light: "#333" },
      "--empty": "",
      "--extra": { light: "#1", dark: "#2", dim: "#3" },
      "--escape": "#000; background: url(x)",
    };
    expect(validateMobileProductRegistration(registration)).toEqual(
      expect.arrayContaining([
        "theme.palette.--bg: must be a product property name",
        "theme.palette.--s2: is also an alias",
        "theme.palette.--mobile-shell-x: must be a product property name",
        "theme.palette.--half: must be a colour or one colour per appearance",
        "theme.palette.--empty: must be a colour or one colour per appearance",
        "theme.palette.--extra: must be a colour or one colour per appearance",
        "theme.palette.--escape: must be a colour or one colour per appearance",
      ]),
    );
  });
});

describe("gesture zones", () => {
  const home = {
    screen: "home",
    shade: false,
    view: null,
    chat: "input",
    launcher: true,
  };
  const at = (x: number, y: number, onShadeControl = false) => ({
    x,
    y,
    onShadeControl,
  });

  it("ignores short swipes and unlocks the lock screen upward only", () => {
    expect(resolveMobileShellSwipe(home, at(200, 400), 20, -40)).toBeNull();
    const lock = { ...home, screen: "lock" };
    expect(resolveMobileShellSwipe(lock, at(200, 600), 0, -120)).toBe("unlock");
    expect(resolveMobileShellSwipe(lock, at(200, 300), 0, 120)).toBeNull();
    expect(
      resolveMobileShellSwipe(
        { ...home, screen: "off" },
        at(200, 300),
        0,
        -120,
      ),
    ).toBeNull();
  });

  it("closes a stand-in shade upward and answers edge Back over it", () => {
    const shade = { ...home, shade: true };
    expect(resolveMobileShellSwipe(shade, at(200, 400), 0, -100)).toBe(
      "close-shade",
    );
    expect(resolveMobileShellSwipe(shade, at(10, 400), 100, 0)).toBe("back");
    expect(resolveMobileShellSwipe(shade, at(200, 400), 100, 0)).toBeNull();
  });

  it("opens the system shade from the launcher control or the product's pull", () => {
    expect(resolveMobileShellSwipe(home, at(200, 120, true), 0, 80)).toBe(
      "open-system-shade",
    );
    const standalone = { ...home, launcher: false };
    expect(
      resolveMobileShellSwipe(standalone, at(200, 120, true), 0, 80),
    ).toBeNull();
    const asked: number[][] = [];
    const pullOpensShade = (dx: number, dy: number, threshold: number) => {
      asked.push([dx, dy, threshold]);
      return dy > 100;
    };
    expect(
      resolveMobileShellSwipe(home, at(200, 300), 0, 120, { pullOpensShade }),
    ).toBe("open-system-shade");
    expect(
      resolveMobileShellSwipe(home, at(200, 300), 0, 80, { pullOpensShade }),
    ).toBeNull();
    expect(asked).toEqual([
      [0, 120, 46],
      [0, 80, 46],
    ]);
  });

  it("goes HOME from the bottom bar, moves the assistant and answers edge Back", () => {
    const view = { ...home, view: "notes" };
    expect(resolveMobileShellSwipe(view, at(200, 890), 0, -80)).toBe("home");
    expect(
      resolveMobileShellSwipe(
        { ...view, launcher: false },
        at(200, 890),
        0,
        -80,
      ),
    ).toBeNull();
    expect(resolveMobileShellSwipe(home, at(200, 500), 0, -80)).toBe(
      "raise-assistant",
    );
    expect(resolveMobileShellSwipe(view, at(200, 500), 0, -80)).toBeNull();
    expect(
      resolveMobileShellSwipe({ ...view, chat: "sheet" }, at(200, 500), 0, 80),
    ).toBe("lower-assistant");
    expect(resolveMobileShellSwipe(view, at(400, 500), -80, 10)).toBe("back");
    expect(resolveMobileShellSwipe(view, at(200, 500), -80, 10)).toBeNull();
    expect(
      resolveMobileShellSwipe(view, at(500, 500), -80, 0, { canvasWidth: 520 }),
    ).toBe("back");
  });
});

describe("view registry", () => {
  it("resolves host keys, older ids and served ids to one canonical view", () => {
    const registry = registryFor();
    expect(registry.canonicalId("workflows")).toBe("automations");
    expect(registry.canonicalId("home")).toBe("chat");
    expect(registry.target("chat")).toEqual({ kind: "home" });
    expect(registry.target("reminders")).toMatchObject({
      kind: "view",
      view: { id: "calendar" },
    });
    expect(registry.target("unknown")).toBeUndefined();
    const automations = registry.find("workflows");
    expect(automations && registry.hostKey(automations)).toBe("workflows");
    expect(automations && registry.launcherKey(automations)).toBe(
      "example:automations",
    );
    expect(registry.fromLauncherKey("example:automations")).toBe(automations);
    expect(registry.fromLauncherKey("example:workflows")).toBeUndefined();
    expect(mobileShellViewPaths("chat")).toEqual(["/chat", "/apps/chat", "/"]);
  });

  it("names builtin views by the builtin route registry's ids and paths", () => {
    const builtins: Record<string, { path: string }> =
      BUILTIN_ROUTE_DESCRIPTORS;
    const shared = MOBILE_SHELL_VIEW_IDS.filter((id) =>
      Object.hasOwn(builtins, id),
    );
    expect(shared).toEqual(
      expect.arrayContaining([
        "chat",
        "phone",
        "files",
        "inventory",
        "settings",
      ]),
    );
    for (const id of shared)
      expect(mobileShellViewPath(id), id).toBe(builtins[id]?.path);
  });

  it("offers available views in product order and refuses navigation to the rest", () => {
    let calendar = true;
    const registry = registryFor((id) => id !== "calendar" || calendar);
    expect(registry.available().map((view) => view.id)).toEqual([
      "notes",
      "calendar",
      "automations",
    ]);
    calendar = false;
    expect(registry.available().map((view) => view.id)).toEqual([
      "notes",
      "automations",
    ]);
    expect(registry.target("reminders")).toBeUndefined();
    expect(registry.target("settings")).toMatchObject({ kind: "view" });
    expect(() =>
      createMobileViewRegistry(product(), { views: [{ id: "maps" }] }),
    ).toThrow(/needs a label/);
    const withMaps = createMobileViewRegistry(product(), {
      views: [{ id: "maps", label: "Maps" }],
    });
    expect(withMaps.available().at(-1)).toMatchObject({
      id: "maps",
      label: "Maps",
    });
  });
});

describe("navigation", () => {
  it("pushes, limits, pops and returns Home like device Back", () => {
    let state = navigateMobileShell(MOBILE_SHELL_HOME, {
      type: "drawer",
      open: true,
    });
    state = navigateMobileShell(state, { type: "drawer-query", query: "no" });
    expect(state).toMatchObject({ drawer: true, drawerQuery: "no" });
    expect(navigateMobileShell(state, { type: "back" })).toMatchObject({
      drawer: false,
      drawerQuery: "",
    });
    state = navigateMobileShell(state, { type: "open", view: "a" });
    expect(state).toEqual({
      view: "a",
      stack: [],
      drawer: false,
      drawerQuery: "",
      assistant: "pill",
    });
    for (const view of ["b", "c", "d", "e", "f", "g", "h"])
      state = navigateMobileShell(state, {
        type: "open",
        view,
        history: "push",
      });
    expect(state.stack).toEqual(["b", "c", "d", "e", "f", "g"]);
    expect(
      navigateMobileShell(state, { type: "open", view: "h", history: "push" })
        .stack,
    ).toEqual([]);
    expect(
      navigateMobileShell(state, { type: "open", view: "x", history: "keep" })
        .stack,
    ).toEqual(state.stack);
    state = navigateMobileShell(state, { type: "back" });
    expect(state).toMatchObject({
      view: "g",
      stack: ["b", "c", "d", "e", "f"],
    });
    expect(navigateMobileShell({ ...state, stack: [] }, { type: "back" })).toBe(
      MOBILE_SHELL_HOME,
    );
  });

  it("moves the assistant with navigation: Back lowers it before leaving a view", () => {
    // The browser rests with its composer open; other views rest as a pill.
    const options = {
      assistantRest: (view: string) =>
        view === "browser" ? ("input" as const) : ("pill" as const),
    };
    const go = (
      state: typeof MOBILE_SHELL_HOME,
      action: Parameters<typeof navigateMobileShell>[1],
    ) => navigateMobileShell(state, action, options);
    expect(MOBILE_SHELL_HOME.assistant).toBe("input");
    let state = go(MOBILE_SHELL_HOME, { type: "open", view: "notes" });
    expect(state.assistant).toBe("pill");
    state = go(state, { type: "open", view: "browser", history: "push" });
    expect(state).toMatchObject({ view: "browser", assistant: "input" });
    state = go(state, { type: "assistant", detent: "full" });
    // Full lowers to the half sheet, the sheet to the view's rest; only then Back leaves.
    state = go(state, { type: "back" });
    expect(state).toMatchObject({ view: "browser", assistant: "sheet" });
    state = go(state, { type: "back" });
    expect(state).toMatchObject({ view: "browser", assistant: "input" });
    state = go(state, { type: "back" });
    expect(state).toMatchObject({
      view: "notes",
      stack: [],
      assistant: "pill",
    });
    // An explicit detent opens a view over its rest; rest returns to it.
    state = go(state, {
      type: "open",
      view: "browser",
      history: "keep",
      assistant: "sheet",
    });
    expect(state.assistant).toBe("sheet");
    expect(go(state, { type: "assistant", detent: "rest" }).assistant).toBe(
      "input",
    );
    // On Home the sheet lowers to the composer; the drawer closes before it.
    const home = go(MOBILE_SHELL_HOME, { type: "home", assistant: "sheet" });
    expect(home).toMatchObject({ view: null, assistant: "sheet" });
    expect(go(home, { type: "back" })).toEqual(MOBILE_SHELL_HOME);
    const drawer = go(home, { type: "drawer", open: true });
    expect(go(drawer, { type: "back" })).toMatchObject({
      drawer: false,
      assistant: "sheet",
    });
    // Without a rest policy every view rests as a pill.
    expect(
      navigateMobileShell(MOBILE_SHELL_HOME, { type: "open", view: "browser" })
        .assistant,
    ).toBe("pill");
  });
});

describe("launcher favorites migration", () => {
  const memory = (value: string | null) => {
    const store = new Map<string, string>();
    if (value !== null) store.set("example.launcher.favorites.v1", value);
    return {
      store,
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, next: string) => void store.set(key, next),
    };
  };

  it("renames older product ids once, keeping order, installed apps and other fields", () => {
    const storage = memory(
      JSON.stringify({
        version: 2,
        keys: [
          "example:notes",
          "com.android.settings",
          "example:workflows",
          "example:automations",
        ],
        defaultPolicy: "example-apps",
        previousDefaults: ["example:wallet"],
      }),
    );
    expect(migrateLauncherViewIds(storage, product())).toEqual({
      status: "migrated",
      renamed: 2,
    });
    expect(
      JSON.parse(storage.getItem("example.launcher.favorites.v1") ?? ""),
    ).toEqual({
      version: 2,
      keys: ["example:notes", "com.android.settings", "example:automations"],
      defaultPolicy: "example-apps",
      previousDefaults: ["example:inventory"],
    });
    expect(migrateLauncherViewIds(storage, product())).toEqual({
      status: "unchanged",
    });
  });

  it("leaves absent and unreadable records alone and reports a refused write", () => {
    expect(migrateLauncherViewIds(memory(null), product())).toEqual({
      status: "absent",
    });
    for (const value of [
      "{",
      '{"version":9,"keys":[]}',
      '{"version":2,"keys":[1]}',
    ]) {
      const storage = memory(value);
      expect(migrateLauncherViewIds(storage, product())).toEqual({
        status: "unreadable",
      });
      expect(storage.getItem("example.launcher.favorites.v1")).toBe(value);
    }
    const refusing = memory(
      JSON.stringify({ version: 1, keys: ["example:workflows"] }),
    );
    refusing.setItem = () => {
      throw new Error("quota");
    };
    expect(migrateLauncherViewIds(refusing, product())).toMatchObject({
      status: "failed",
    });
  });
});

const installed: InstalledApp[] = [
  {
    packageName: "com.android.settings",
    activityName: "com.android.settings.Settings",
    label: "Settings",
  },
];
function shellLauncher(saved: string[] | null = null) {
  const registry = registryFor();
  const launches: unknown[] = [];
  const opened: string[] = [];
  const bridge: LauncherBridge = {
    list: vi.fn(async () => ({ apps: installed })),
    launch: async (target) => void launches.push(target),
  };
  let favorites = saved;
  const shell = createMobileShellLauncher({
    bridge,
    registry,
    open: (view) => opened.push(view.id),
    changed: () => {},
    favorites: {
      read: () => favorites,
      write: (keys) => void (favorites = [...keys]),
    },
  });
  shell.syncViews();
  return { registry, shell, bridge, launches, opened };
}

describe("launcher join", () => {
  it("opens product views in the shell and installed apps by exact component", async () => {
    const { shell, launches, opened } = shellLauncher();
    expect(shell.homeEntries().map((entry) => entry.key)).toEqual([
      "example:notes",
      "example:calendar",
      "example:automations",
    ]);
    await shell.launcher.load();
    const [notes] = shell.launcher.favoriteApps();
    await shell.launcher.launch(notes);
    expect(opened).toEqual(["notes"]);
    expect(launches).toEqual([]);
    const settings = shell.launcher
      .snapshot()
      .apps.find((app) => app.packageName === "com.android.settings");
    if (!settings) throw new Error("installed app missing");
    shell.launcher.toggleFavorite(settings);
    expect(shell.homeEntries().at(-1)).toMatchObject({
      kind: "app",
      app: { label: "Settings" },
    });
    await shell.launcher.launch(settings);
    expect(launches).toEqual([
      {
        packageName: "com.android.settings",
        activityName: "com.android.settings.Settings",
      },
    ]);
  });

  it("reads a native plugin proxy whose methods exist only when read", async () => {
    const calls: string[] = [];
    const plugin = new Proxy({} as LauncherBridge, {
      get: (_target, name) => async () => {
        calls.push(String(name));
        if (name === "list") return { apps: installed };
        if (name === "resolveDefault")
          return {
            available: true,
            label: "Dialer",
            packageName: "com.example.dialer",
          };
        return undefined;
      },
    });
    const shell = createMobileShellLauncher({
      bridge: plugin,
      registry: registryFor(),
      open: () => {},
      changed: () => {},
    });
    shell.syncViews();
    await shell.launcher.load();
    expect(shell.launcher.snapshot()).toMatchObject({
      status: "ready",
      dial: { label: "Dialer" },
    });
    expect(shell.launcher.snapshot().apps.map((app) => app.label)).toContain(
      "Settings",
    );
    expect(calls).toEqual(["list", "resolveDefault"]);
  });

  it("migrates the product's installed favorites once, before the launcher reads them", async () => {
    const store = new Map<string, string>([
      [
        "example.launcher.favorites.v1",
        JSON.stringify({
          version: 2,
          keys: ["example:workflows", "example:notes"],
          defaultPolicy: "example-apps",
        }),
      ],
    ]);
    const storage = () => ({
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
    });
    const join = () =>
      createMobileShellLauncher({
        bridge: {
          list: async () => ({ apps: installed }),
          launch: async () => {},
        },
        registry: registryFor(),
        open: () => {},
        changed: () => {},
        storage,
      });
    const first = join();
    first.syncViews();
    expect(first.migration).toEqual({ status: "migrated", renamed: 1 });
    expect(first.homeEntries().map((entry) => entry.key)).toEqual([
      "example:automations",
      "example:notes",
    ]);
    await first.launcher.load();
    const settings = first.launcher
      .snapshot()
      .apps.find((app) => app.packageName === "com.android.settings");
    if (!settings) throw new Error("installed app missing");
    first.launcher.toggleFavorite(settings);
    expect(
      JSON.parse(store.get("example.launcher.favorites.v1") ?? ""),
    ).toMatchObject({
      version: 2,
      keys: [
        "example:automations",
        "example:notes",
        "com.android.settings/com.android.settings.Settings",
      ],
      defaultPolicy: "example-apps",
    });
    expect(join().migration).toEqual({ status: "unchanged" });
    // A host-supplied store is its own record: nothing is migrated for it.
    expect(shellLauncher().shell.migration).toBeUndefined();
  });

  it("reports unavailable storage and offers the product's default Home", () => {
    const shell = createMobileShellLauncher({
      bridge: { list: async () => ({ apps: [] }), launch: async () => {} },
      registry: registryFor(),
      open: () => {},
      changed: () => {},
      storage: () => {
        throw new Error("SecurityError");
      },
    });
    const registry = registryFor();
    shell.syncViews();
    expect(shell.migration).toMatchObject({ status: "failed" });
    const home = shell.homeEntries();
    expect(home.map((entry) => entry.key)).toEqual(
      registry.available().map((view) => registry.launcherKey(view)),
    );
    expect(home.length).toBeGreaterThan(0);
    // Nothing can be saved, and the launcher says so instead of dropping the choice.
    const first = shell.launcher.favoriteApps()[0];
    shell.launcher.toggleFavorite(first);
    expect(shell.launcher.snapshot().launchError).toBe(
      "Favorites could not be saved. Nothing changed.",
    );
    expect(shell.homeEntries().map((entry) => entry.key)).toEqual(
      home.map((entry) => entry.key),
    );
  });

  it("reads the inventory for Home only when an installed app is a favorite", () => {
    const productOnly = shellLauncher(["example:notes"]);
    productOnly.shell.prepareHome();
    expect(productOnly.bridge.list).not.toHaveBeenCalled();
    const withApp = shellLauncher([
      "example:notes",
      "com.android.settings/com.android.settings.Settings",
    ]);
    withApp.shell.prepareHome();
    expect(withApp.bridge.list).toHaveBeenCalledTimes(1);
  });
});

describe("Home, All apps and view host", () => {
  it("renders host notices, cards and tiles, and leaves the tree when covered", () => {
    const opened: string[] = [];
    const tiles = [
      {
        key: "notes",
        label: "Notes",
        glyphUrl: "/icons/sticky-note.svg",
        iconId: "sticky-note",
        onOpen: () => opened.push("notes"),
      },
      {
        key: "app",
        label: "Clock",
        image: "data:image/png;base64,AA==",
        badge: true,
        onOpen: () => opened.push("app"),
      },
    ];
    const allApps = vi.fn();
    const { rerender } = render(
      <MobileHomeScreen
        tiles={tiles}
        header={<p>Notice</p>}
        cards={<button type="button">Next event</button>}
        onOpenAllApps={allApps}
        allAppsIconId="layout-grid"
        data-host-layer="home"
        gridProps={{ "data-host-apps": "" }}
      />,
    );
    const home = screen.getByRole("region", { name: "Home" });
    expect(home.getAttribute("data-host-layer")).toBe("home");
    expect(
      home
        .querySelector("[data-host-apps]")
        ?.hasAttribute("data-mobile-shell-apps"),
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Notes" }));
    fireEvent.click(screen.getByRole("button", { name: "All apps" }));
    expect(opened).toEqual(["notes"]);
    expect(allApps).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Next event" })).toBeTruthy();
    expect(home.querySelector("[data-mobile-shell-tile-badge]")).toBeTruthy();
    const notes = screen.getByRole("button", { name: "Notes" });
    expect(notes.getAttribute("data-mobile-shell-tile-icon")).toBe(
      "sticky-note",
    );
    expect(
      screen
        .getByRole("button", { name: "All apps" })
        .getAttribute("data-mobile-shell-tile-icon"),
    ).toBe("layout-grid");
    expect(
      screen
        .getByRole("button", { name: "Clock" })
        .hasAttribute("data-mobile-shell-tile-icon"),
    ).toBe(false);
    rerender(<MobileHomeScreen tiles={tiles} covered />);
    expect(home.hasAttribute("inert")).toBe(true);
    expect(screen.queryByRole("region", { name: "Home" })).toBeNull();
  });

  it("lists product views with installed apps and opens them in the shell", async () => {
    const { registry, shell, opened } = shellLauncher();
    await shell.launcher.load();
    const onQuery = vi.fn();
    render(
      <MobileAllAppsDrawer
        shellLauncher={shell}
        registry={registry}
        query=""
        onQuery={onQuery}
        onClose={() => {}}
      />,
    );
    const dialog = screen.getByRole("dialog", { name: "All apps" });
    expect(
      dialog.querySelector('[data-launcher-favorite="example:notes"]'),
    ).toBeTruthy();
    expect(
      dialog.querySelector(
        '[data-launcher-app="com.android.settings/com.android.settings.Settings"]',
      ),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open Workflows" }));
    await vi.waitFor(() => expect(opened).toEqual(["automations"]));
    fireEvent.change(screen.getByRole("searchbox", { name: "Search apps" }), {
      target: { value: "set" },
    });
    expect(onQuery).toHaveBeenCalledWith("set");
  });

  it("loads a registered view lazily and keeps a failed load visible with a retry", async () => {
    let fail = true;
    const loader = vi.fn(async () => {
      if (fail) throw new Error("chunk");
      return {
        default: ({ viewId }: { viewId: string }) => <p>Loaded {viewId}</p>,
      };
    });
    const registry = createMobileViewRegistry(product(), {
      views: [{ id: "notes", loader }],
    });
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    const onError = vi.fn();
    render(
      <MobileViewHost
        registry={registry}
        view="notes"
        onClose={() => {}}
        onError={onError}
      />,
    );
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Notes could not be opened.",
    );
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "chunk" }),
      expect.objectContaining({ viewId: "notes" }),
    );
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect((await screen.findByText(/Loaded/)).textContent).toBe(
      "Loaded notes",
    );
    expect(loader).toHaveBeenCalledTimes(2);
    quiet.mockRestore();
    cleanup();
    const { container } = render(
      <MobileViewHost registry={registry} view="calendar" onClose={() => {}} />,
    );
    expect(container.innerHTML).toBe("");
  });

  it("keeps an inactive view mounted and draws failures in the host's chrome", async () => {
    let fail = false;
    const seen: unknown[] = [];
    const loader = vi.fn(async () => {
      if (fail) throw new Error("chunk");
      return {
        default: ({ active }: { active?: boolean }) => {
          seen.push(active);
          return <p>Notes {active === false ? "behind" : "in front"}</p>;
        },
      };
    });
    const registry = createMobileViewRegistry(product(), {
      views: [{ id: "notes", loader }],
    });
    const view = render(
      <MobileViewHost registry={registry} view="notes" onClose={() => {}} />,
    );
    expect((await screen.findByText(/Notes/)).textContent).toBe(
      "Notes in front",
    );
    view.rerender(
      <MobileViewHost
        registry={registry}
        view="notes"
        active={false}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText(/Notes/).textContent).toBe("Notes behind");
    expect(loader).toHaveBeenCalledTimes(1);
    cleanup();

    fail = true;
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    const failed = vi.fn(async () => {
      throw new Error("chunk");
    });
    const failing = createMobileViewRegistry(product(), {
      views: [{ id: "calendar", loader: failed }],
    });
    const plain = render(
      <MobileViewHost
        registry={failing}
        view="calendar"
        active={false}
        onClose={() => {}}
      />,
    );
    const notice = await waitForNotice(plain.container);
    expect(notice.hidden).toBe(true);
    expect(notice.hasAttribute("inert")).toBe(true);
    cleanup();

    const onClose = vi.fn();
    render(
      <MobileViewHost
        registry={failing}
        view="calendar"
        onClose={onClose}
        renderError={({ label, retry, close, active }) => (
          <section aria-label={`${label} failed`} data-active={active}>
            <button type="button" onClick={close}>
              Back
            </button>
            <button type="button" onClick={retry}>
              Retry {label}
            </button>
          </section>
        )}
      />,
    );
    const chrome = await screen.findByRole("region", {
      name: "Calendar failed",
    });
    expect(chrome.dataset.active).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Retry Calendar" }));
    await screen.findByRole("region", { name: "Calendar failed" });
    expect(failed).toHaveBeenCalledTimes(2);
    quiet.mockRestore();
  });

  it("counts retries per view, so retrying one view never reloads another", async () => {
    let failNotes = true;
    const notes = vi.fn(async () => {
      if (failNotes) throw new Error("chunk");
      return { default: () => <p>Notes view</p> };
    });
    const calendar = vi.fn(async () => ({
      default: () => <p>Calendar view</p>,
    }));
    const registry = createMobileViewRegistry(product(), {
      views: [
        { id: "notes", loader: notes },
        { id: "calendar", loader: calendar },
      ],
    });
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    const host = (view: string) => (
      <MobileViewHost registry={registry} view={view} onClose={() => {}} />
    );
    const { rerender } = render(host("calendar"));
    await screen.findByText("Calendar view");
    rerender(host("notes"));
    await screen.findByRole("alert");
    failNotes = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByText("Notes view");
    rerender(host("calendar"));
    expect(screen.getByText("Calendar view")).toBeTruthy();
    expect(calendar).toHaveBeenCalledTimes(1);
    quiet.mockRestore();
  });
});

describe("feature manifest", () => {
  it("emits identity and theme as branding and the rest as sorted functional features", () => {
    const manifest = mobileFeatureManifest(
      defineMobileProductRegistration({
        ...product(),
        features: {
          capabilities: ["notes.local-record.v1", "launcher.installed-apps"],
          actions: ["create_note"],
        },
      }),
    );
    expect(manifest.schema).toBe("elizaos.mobile-feature-manifest");
    expect(manifest.branding).toMatchObject({
      appName: "Example Phone",
      appId: "com.example.phone",
      themeId: "example",
      order: ["notes", "calendar", "automations", "settings"],
      labels: { automations: "Workflows" },
      storage: { launcherFavorites: "example.launcher.favorites.v1" },
    });
    expect(manifest.functional).toEqual({
      views: [
        { id: "automations", serves: [] },
        { id: "calendar", serves: ["reminders"] },
        { id: "notes", serves: [] },
        { id: "settings", serves: [] },
      ],
      capabilities: ["launcher.installed-apps", "notes.local-record.v1"],
      actions: ["create_note"],
    });
    expect(JSON.stringify(mobileFeatureManifest(product()))).toBe(
      JSON.stringify(mobileFeatureManifest(product())),
    );
  });

  it("two brands that differ only by identity and theme are functionally equal", () => {
    const rebranded: MobileProductRegistration = {
      ...product(),
      identity: {
        appName: "Other Phone",
        appId: "org.other.phone",
        characterName: "Oz",
      },
      theme: { ...product().theme, id: "other", name: "Other" },
      views: {
        ...product().views,
        order: ["settings", "automations", "calendar", "notes"],
        labels: { ...product().views.labels, automations: "Automations" },
      },
      storage: {
        ...product().storage,
        launcherFavorites: "other.launcher.favorites.v1",
        launcherBuiltinPrefix: "other:",
      },
    };
    expect(
      compareMobileFeatureManifests(
        mobileFeatureManifest(product()),
        mobileFeatureManifest(rebranded),
      ),
    ).toEqual([]);
  });

  it("names every functional difference on the side that has it", () => {
    const a = mobileFeatureManifest({
      ...product(),
      features: { capabilities: ["clock.handoff.v1"], actions: ["open_view"] },
    });
    const b = mobileFeatureManifest({
      ...product(),
      views: {
        ...product().views,
        order: ["notes", "calendar", "maps"],
        labels: { ...product().views.labels, maps: "Maps" },
        rendererKeys: {},
        serves: {},
      },
      features: { actions: ["open_view", "create_note"] },
    });
    expect(compareMobileFeatureManifests(a, b).map(mobileFeatureDifferenceKey))
      .toEqual([
        "view:automations:only-a",
        "view:maps:only-b",
        "view:settings:only-a",
        "serves:calendar:reminders:only-a",
        "capability:clock.handoff.v1:only-a",
        "action:create_note:only-b",
      ]);
  });

  it("refuses malformed or repeated feature names", () => {
    expect(
      validateMobileProductRegistration({
        ...product(),
        features: { capabilities: ["ok.v1", "ok.v1", "bad name"], actions: 3 },
      }),
    ).toEqual([
      "features.capabilities: ok.v1 is listed twice",
      "features.capabilities: bad name is not a feature name",
      "features.actions: must be a list of names",
    ]);
  });

  it("Eliza's reference record keeps its installed launcher names and provides the shell launcher", () => {
    expect(validateMobileProductRegistration(ELIZA_MOBILE_PRODUCT)).toEqual(
      [],
    );
    expect(ELIZA_MOBILE_PRODUCT.storage).toMatchObject({
      launcherFavorites: "eliza.launcher.favorites.v1",
      launcherBuiltinPrefix: "eliza:",
      launcherDefaultPolicy: "eliza-apps",
    });
    const manifest = mobileFeatureManifest(ELIZA_MOBILE_PRODUCT);
    expect(manifest.functional.capabilities).toEqual(
      [...MOBILE_SHELL_LAUNCHER_CAPABILITIES].sort(),
    );
    const registry = createMobileViewRegistry(ELIZA_MOBILE_PRODUCT);
    expect(registry.find("wallet")?.id).toBe("inventory");
    expect(registry.target("reminders")).toMatchObject({
      kind: "view",
      view: { id: "calendar" },
    });
  });
});

describe("entries", () => {
  const src = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../..",
  );
  /** Every module an entry loads, and each package it imports at runtime. */
  const closure = (entry: string) => {
    const seen = new Set<string>();
    const runtime = new Set<string>();
    const visit = (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      const source = fs.readFileSync(file, "utf8");
      for (const [statement, from, bare] of source.matchAll(
        /^(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["'];|^import\s*["']([^"']+)["'];/gm,
      )) {
        const specifier = from ?? bare;
        const typeOnly = /^(?:import|export)\s+type\b/.test(statement);
        if (typeOnly) continue;
        if (!specifier.startsWith(".")) {
          if (!typeOnly) runtime.add(specifier);
          continue;
        }
        const base = path.resolve(path.dirname(file), specifier);
        const extensionless = base.replace(/\.js$/, "");
        const resolved = [`${extensionless}.ts`, `${extensionless}.tsx`, base].find(
          (candidate) =>
            fs.existsSync(candidate) && fs.statSync(candidate).isFile(),
        );
        if (!resolved) throw new Error(`${file}: cannot resolve ${specifier}`);
        visit(resolved);
      }
    };
    visit(path.join(src, entry));
    return {
      files: [...seen].map((file) => path.relative(src, file)).sort(),
      packages: [...runtime].sort(),
    };
  };
  const core = [
    "config/theme.ts",
    "mobile-shell/core.ts",
    "mobile-shell/eliza-product.ts",
    "mobile-shell/feature-manifest.ts",
    "mobile-shell/gestures.ts",
    "mobile-shell/navigation.ts",
    "mobile-shell/product-registration.ts",
    "mobile-shell/view-id-migration.ts",
    "mobile-shell/view-ids.ts",
    "mobile-shell/view-policy.ts",
    "mobile-shell/view-registry.ts",
  ];

  it("the shell entry imports only its own leaves, never the package barrel", () => {
    expect(closure("mobile-shell/index.ts")).toEqual({
      files: [
        "components/pages/InstalledAppsLauncher.tsx",
        "app-shell-pages.ts",
        "registry-host.ts",
        ...core,
        "mobile-shell/MobileAllAppsDrawer.tsx",
        "mobile-shell/MobileApplication.tsx",
        "mobile-shell/MobileHomeScreen.tsx",
        "mobile-shell/MobileViewHost.tsx",
        "mobile-shell/index.ts",
        "mobile-shell/mobile-launcher.ts",
        "mobile-shell/application-catalog.ts",
      ].sort(),
      packages: [
        "@elizaos/capacitor-system/launcher",
        "@elizaos/contracts",
        "react",
      ],
    });
  });

  it("the core entry loads no React and no component", () => {
    expect(closure("mobile-shell/core.ts")).toEqual({
      files: core,
      packages: ["@elizaos/contracts"],
    });
  });
});
