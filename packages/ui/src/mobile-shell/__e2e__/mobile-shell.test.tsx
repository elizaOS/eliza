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
import {
  applyMobileShellTheme,
  createMobileShellLauncher,
  createMobileViewRegistry,
  defineMobileProductRegistration,
  MOBILE_SHELL_HOME,
  type MobileProductRegistration,
  MobileAllAppsDrawer,
  MobileHomeScreen,
  MobileViewHost,
  migrateLauncherViewIds,
  mobileShellThemeVariables,
  mobileShellViewPaths,
  navigateMobileShell,
  resolveMobileShellAppearance,
  validateMobileProductRegistration,
} from "../index";

afterEach(cleanup);

const chrome = { scrim: "rgba(0,0,0,.2)", shadow: "rgba(0,0,0,.1)", frame: "#ddd" };
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
    aliases: { "--s2": "surface", "--serif": "fontDisplay", "--frame": "frame" },
  },
  icons: {
    baseUrl: "/icons/",
    views: { notes: "sticky-note", automations: "workflow" },
    allApps: "layout-grid",
  },
  backgrounds: { home: { dark: "#050505" } },
  views: {
    order: ["notes", "calendar", "automations", "settings"],
    legacyIds: { home: "chat", workflows: "automations", wallet: "inventory" },
    serves: { calendar: ["reminders"] },
  },
  storage: {
    launcherFavorites: "example.launcher.favorites.v1",
    launcherBuiltinPrefix: "example:",
    retained: { appearance: "example.appearance.v1" },
  },
});

const registryFor = (available = (_id: string) => true) =>
  createMobileViewRegistry(
    defineMobileProductRegistration(product()),
    [
      { id: "notes", label: "Notes" },
      { id: "calendar", label: "Calendar" },
      { id: "automations", label: "Workflows", hostKey: "workflows" },
      { id: "settings", label: "Settings", hidden: true },
    ],
    { available: (view) => available(view.id) },
  );

describe("product registration", () => {
  it("accepts a complete record and reuses the shared theme definition", () => {
    expect(validateMobileProductRegistration(product())).toEqual([]);
    const eliza = {
      ...product(),
      theme: { ...ELIZA_DEFAULT_THEME, defaultAppearance: "dark", chrome: { light: chrome, dark: chrome } },
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
    broken.views.serves = { calendar: ["notes"] };
    broken.storage.retained.again = "example.launcher.favorites.v1";
    broken.identity.appId = "not an id";
    const issues = validateMobileProductRegistration(broken);
    expect(issues).toEqual(
      expect.arrayContaining([
        "identity.appId: must be a reverse-domain application id",
        "theme.dark.accent: is required",
        "theme.aliases.--bg: must be a product property name",
        "views.legacyIds.notes: must be a non-canonical id",
        "views.serves.calendar: cannot serve notes",
        "storage: example.launcher.favorites.v1 is named twice",
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
    expect(resolveMobileShellAppearance(registration, "light", true)).toBe("light");
  });
});

describe("view registry", () => {
  it("resolves host keys, older ids and served ids to one canonical view", () => {
    const registry = registryFor();
    expect(registry.canonicalId("workflows")).toBe("automations");
    expect(registry.canonicalId("home")).toBe("chat");
    expect(registry.target("chat")).toEqual({ kind: "home" });
    expect(registry.target("reminders")).toMatchObject({ kind: "view", view: { id: "calendar" } });
    expect(registry.target("unknown")).toBeUndefined();
    const automations = registry.find("workflows");
    expect(automations && registry.hostKey(automations)).toBe("workflows");
    expect(automations && registry.launcherKey(automations)).toBe("example:automations");
    expect(registry.fromLauncherKey("example:automations")).toBe(automations);
    expect(registry.fromLauncherKey("example:workflows")).toBeUndefined();
    expect(mobileShellViewPaths("chat")).toEqual(["/chat", "/apps/chat", "/"]);
  });

  it("offers available views in product order and refuses navigation to the rest", () => {
    let calendar = true;
    const registry = registryFor((id) => id !== "calendar" || calendar);
    expect(registry.available().map((view) => view.id)).toEqual(["notes", "calendar", "automations"]);
    calendar = false;
    expect(registry.available().map((view) => view.id)).toEqual(["notes", "automations"]);
    expect(registry.target("reminders")).toBeUndefined();
    expect(registry.target("settings")).toMatchObject({ kind: "view" });
    expect(() =>
      createMobileViewRegistry(product(), [{ id: "notes", label: "Notes", hostKey: "memo" }]),
    ).toThrow(/legacy id/);
  });
});

describe("navigation", () => {
  it("pushes, limits, pops and returns Home like device Back", () => {
    let state = navigateMobileShell(MOBILE_SHELL_HOME, { type: "drawer", open: true });
    state = navigateMobileShell(state, { type: "drawer-query", query: "no" });
    expect(state).toMatchObject({ drawer: true, drawerQuery: "no" });
    expect(navigateMobileShell(state, { type: "back" })).toMatchObject({ drawer: false, drawerQuery: "" });
    state = navigateMobileShell(state, { type: "open", view: "a" });
    expect(state).toEqual({ view: "a", stack: [], drawer: false, drawerQuery: "" });
    for (const view of ["b", "c", "d", "e", "f", "g", "h"])
      state = navigateMobileShell(state, { type: "open", view, history: "push" });
    expect(state.stack).toEqual(["b", "c", "d", "e", "f", "g"]);
    expect(navigateMobileShell(state, { type: "open", view: "h", history: "push" }).stack).toEqual([]);
    expect(navigateMobileShell(state, { type: "open", view: "x", history: "keep" }).stack).toEqual(state.stack);
    state = navigateMobileShell(state, { type: "back" });
    expect(state).toMatchObject({ view: "g", stack: ["b", "c", "d", "e", "f"] });
    expect(navigateMobileShell({ ...state, stack: [] }, { type: "back" })).toBe(MOBILE_SHELL_HOME);
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
        keys: ["example:notes", "com.android.settings", "example:workflows", "example:automations"],
        defaultPolicy: "example-apps",
        previousDefaults: ["example:wallet"],
      }),
    );
    expect(migrateLauncherViewIds(storage, product())).toEqual({ status: "migrated", renamed: 2 });
    expect(JSON.parse(storage.getItem("example.launcher.favorites.v1") ?? "")).toEqual({
      version: 2,
      keys: ["example:notes", "com.android.settings", "example:automations"],
      defaultPolicy: "example-apps",
      previousDefaults: ["example:inventory"],
    });
    expect(migrateLauncherViewIds(storage, product())).toEqual({ status: "unchanged" });
  });

  it("leaves absent and unreadable records alone and reports a refused write", () => {
    expect(migrateLauncherViewIds(memory(null), product())).toEqual({ status: "absent" });
    for (const value of ["{", '{"version":9,"keys":[]}', '{"version":2,"keys":[1]}']) {
      const storage = memory(value);
      expect(migrateLauncherViewIds(storage, product())).toEqual({ status: "unreadable" });
      expect(storage.getItem("example.launcher.favorites.v1")).toBe(value);
    }
    const refusing = memory(JSON.stringify({ version: 1, keys: ["example:workflows"] }));
    refusing.setItem = () => {
      throw new Error("quota");
    };
    expect(migrateLauncherViewIds(refusing, product())).toMatchObject({ status: "failed" });
  });
});

const installed: InstalledApp[] = [
  { packageName: "com.android.settings", activityName: "com.android.settings.Settings", label: "Settings" },
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
    favorites: { read: () => favorites, write: (keys) => void (favorites = [...keys]) },
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
    const settings = shell.launcher.snapshot().apps.find((app) => app.packageName === "com.android.settings");
    if (!settings) throw new Error("installed app missing");
    shell.launcher.toggleFavorite(settings);
    expect(shell.homeEntries().at(-1)).toMatchObject({ kind: "app", app: { label: "Settings" } });
    await shell.launcher.launch(settings);
    expect(launches).toEqual([{ packageName: "com.android.settings", activityName: "com.android.settings.Settings" }]);
  });

  it("reads the inventory for Home only when an installed app is a favorite", () => {
    const productOnly = shellLauncher(["example:notes"]);
    productOnly.shell.prepareHome();
    expect(productOnly.bridge.list).not.toHaveBeenCalled();
    const withApp = shellLauncher(["example:notes", "com.android.settings/com.android.settings.Settings"]);
    withApp.shell.prepareHome();
    expect(withApp.bridge.list).toHaveBeenCalledTimes(1);
  });
});

describe("Home, All apps and view host", () => {
  it("renders host notices, cards and tiles, and leaves the tree when covered", () => {
    const opened: string[] = [];
    const tiles = [
      { key: "notes", label: "Notes", glyphUrl: "/icons/sticky-note.svg", onOpen: () => opened.push("notes") },
      { key: "app", label: "Clock", image: "data:image/png;base64,AA==", badge: true, onOpen: () => opened.push("app") },
    ];
    const allApps = vi.fn();
    const { rerender } = render(
      <MobileHomeScreen
        tiles={tiles}
        header={<p>Notice</p>}
        cards={<button type="button">Next event</button>}
        onOpenAllApps={allApps}
        data-host-layer="home"
        gridProps={{ "data-host-apps": "" }}
      />,
    );
    const home = screen.getByRole("region", { name: "Home" });
    expect(home.getAttribute("data-host-layer")).toBe("home");
    expect(home.querySelector("[data-host-apps]")?.hasAttribute("data-mobile-shell-apps")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Notes" }));
    fireEvent.click(screen.getByRole("button", { name: "All apps" }));
    expect(opened).toEqual(["notes"]);
    expect(allApps).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Next event" })).toBeTruthy();
    expect(home.querySelector("[data-mobile-shell-tile-badge]")).toBeTruthy();
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
    expect(dialog.querySelector('[data-launcher-favorite="example:notes"]')).toBeTruthy();
    expect(dialog.querySelector('[data-launcher-app="com.android.settings/com.android.settings.Settings"]')).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open Workflows" }));
    await vi.waitFor(() => expect(opened).toEqual(["automations"]));
    fireEvent.change(screen.getByRole("searchbox", { name: "Search apps" }), { target: { value: "set" } });
    expect(onQuery).toHaveBeenCalledWith("set");
  });

  it("loads a registered view lazily and keeps a failed load visible with a retry", async () => {
    let fail = true;
    const loader = vi.fn(async () => {
      if (fail) throw new Error("chunk");
      return { default: ({ viewId }: { viewId: string }) => <p>Loaded {viewId}</p> };
    });
    const registry = createMobileViewRegistry(product(), [{ id: "notes", label: "Notes", loader }]);
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    render(<MobileViewHost registry={registry} view="notes" onClose={() => {}} />);
    expect((await screen.findByRole("alert")).textContent).toContain("Notes could not be opened.");
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect((await screen.findByText(/Loaded/)).textContent).toBe("Loaded notes");
    expect(loader).toHaveBeenCalledTimes(2);
    quiet.mockRestore();
    cleanup();
    const { container } = render(<MobileViewHost registry={registry} view="calendar" onClose={() => {}} />);
    expect(container.innerHTML).toBe("");
  });
});

it("the entry imports only its own leaves, never the package barrel", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = path.resolve(here, "../..");
  const allowedExternal = new Set(["react", "@elizaos/contracts", "@elizaos/capacitor-system/launcher"]);
  const seen = new Set<string>();
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    const source = fs.readFileSync(file, "utf8");
    for (const [, specifier] of source.matchAll(/(?:\bfrom\s+|^import\s+)["']([^"']+)["'];/gm)) {
      if (!specifier.startsWith(".")) {
        expect(allowedExternal.has(specifier), `${file}: ${specifier}`).toBe(true);
        continue;
      }
      const base = path.resolve(path.dirname(file), specifier);
      const resolved = [`${base}.ts`, `${base}.tsx`, base].find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
      if (!resolved) throw new Error(`${file}: cannot resolve ${specifier}`);
      visit(resolved);
    }
  };
  visit(path.join(src, "mobile-shell/index.ts"));
  expect([...seen].map((file) => path.relative(src, file)).sort()).toEqual([
    "components/pages/InstalledAppsLauncher.tsx",
    "config/theme.ts",
    "mobile-shell/MobileAllAppsDrawer.tsx",
    "mobile-shell/MobileHomeScreen.tsx",
    "mobile-shell/MobileViewHost.tsx",
    "mobile-shell/index.ts",
    "mobile-shell/mobile-launcher.ts",
    "mobile-shell/navigation.ts",
    "mobile-shell/product-registration.ts",
    "mobile-shell/view-id-migration.ts",
    "mobile-shell/view-ids.ts",
    "mobile-shell/view-registry.ts",
  ]);
});
