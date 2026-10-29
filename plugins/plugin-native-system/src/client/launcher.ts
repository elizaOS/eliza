import type {
  DefaultAppStatus as DefaultApp,
  LauncherApp,
  LauncherRefusalCode,
  SystemPlugin,
} from "../definitions";
/** Builtin views can omit a native activity; Android entries retain the exact component. */
export type InstalledApp = Omit<LauncherApp, "activityName"> & {
  activityName?: string;
};
type Bag = Record<string, unknown>;

type LaunchTarget = {
  packageName: string;
  activityName?: string;
  user?: string;
};
/** The installed-app bridge the drawer needs; DeviceApps on Android, BrowserDevice on the web. */
export interface LauncherBridge {
  list(options?: { icons?: boolean }): Promise<{ apps: InstalledApp[] }>;
  launch(options: LaunchTarget): Promise<void>;
  resolveDefault?(options: { role: "dial" }): Promise<DefaultApp>;
  openDefault?(options: { role: "dial" }): Promise<void>;
  /** `appsChanged`: a package was added, removed or changed, or a profile was paused/unlocked. */
  addListener?(event: "appsChanged", listener: (change: Bag) => void): unknown;
}
/** The `ElizaSystem` methods a launcher uses; the registered plugin satisfies it. */
export type SystemLauncherPlugin = Pick<
  SystemPlugin,
  | "listLauncherApps"
  | "launchApp"
  | "resolveDefaultApp"
  | "openDefaultApp"
  | "addListener"
>;

/** Every stable rejection `code` of a launcher read or launch. */
export const LAUNCHER_REFUSAL_CODES: readonly LauncherRefusalCode[] = [
  "not-installed",
  "disabled",
  "no-launcher",
  "profile-locked",
  "profile-unavailable",
  "failed",
];

/** The stable refusal code a native rejection carries, or undefined for any other error. */
export function launcherRefusalCode(
  error: unknown,
): LauncherRefusalCode | undefined {
  const code =
    error && typeof error === "object"
      ? (error as { code?: unknown }).code
      : undefined;
  return typeof code === "string" &&
    (LAUNCHER_REFUSAL_CODES as readonly string[]).includes(code)
    ? (code as LauncherRefusalCode)
    : undefined;
}

/**
 * The one launcher bridge over `ElizaSystem`. Native plugin proxies resolve
 * their methods when read, so each call is delegated by name at call time;
 * nothing is cached or spread. The default-handler and change methods are
 * offered only when the plugin has them.
 */
export function createSystemLauncherBridge(
  system: SystemLauncherPlugin,
): LauncherBridge {
  const bridge: LauncherBridge = {
    list: (options) =>
      system.listLauncherApps(options?.icons ? { icons: true } : undefined),
    launch: (target) => {
      const request: LaunchTarget = { packageName: target.packageName };
      if (target.activityName) request.activityName = target.activityName;
      if (target.user) request.user = target.user;
      return system.launchApp(request);
    },
  };
  if (typeof system.resolveDefaultApp === "function")
    bridge.resolveDefault = (options) => system.resolveDefaultApp(options);
  if (typeof system.openDefaultApp === "function")
    bridge.openDefault = (options) => system.openDefaultApp(options);
  if (typeof system.addListener === "function")
    bridge.addListener = (_event, listener) =>
      system.addListener("launcherAppsChanged", (change) =>
        listener({ ...change }),
      );
  return bridge;
}

/** Ordered favorite keys, kept on this device only. `write` throws when storage refuses. */
export interface FavoritesStore {
  read(): string[] | null;
  write(
    keys: string[],
  ): void /** v1 only controlled installed shortcuts, not product Home apps. */;
  legacy?(): boolean /** Old v2 wrote every installed app as the default. */;
  legacyHomeDefaults?(): boolean;
}
export type LauncherStatus = "idle" | "loading" | "ready" | "failed";
export interface LauncherSnapshot {
  status: LauncherStatus;
  apps: InstalledApp[];
  dial: DefaultApp | null;
  /** Entry currently being opened; repeated taps are ignored until it settles. */
  launching: string | null;
  /** Last open failure, shown inline until the next search, load or launch. */
  launchError: string | null;
  /** Saved favorite keys in the user's order. May name entries that are not installed now. */
  favorites: string[];
}

export const FAVORITES_KEY = "eliza.launcher.favorites.v1";
export const MAX_FAVORITES = 4096;
const PROFILES = ["work", "private", "clone", "other"];
const PROFILE_LABEL: Record<string, string> = {
  work: "Work",
  private: "Private",
  clone: "Clone",
  other: "Other profile",
};

/** Identity of one launcher entry: package, then exact activity, then profile. Labels never identify. */
export function appKey(app: LaunchTarget): string {
  return (
    app.packageName +
    (app.activityName ? `/${app.activityName}` : "") +
    (app.user ? `#${app.user}` : "")
  );
}

const fold = (value: string) =>
  value.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase();
/** Label (then package) match, ignoring case and accents; prefix matches sort first. */
export function filterLauncherApps(
  apps: InstalledApp[],
  query: string,
): InstalledApp[] {
  const needle = fold(query.trim());
  const collator = new Intl.Collator(undefined, {
    sensitivity: "base",
    numeric: true,
  });
  const sorted = [...apps].sort(
    (a, b) =>
      collator.compare(a.label, b.label) ||
      a.packageName.localeCompare(b.packageName) ||
      appKey(a).localeCompare(appKey(b)),
  );
  if (!needle) return sorted;
  const score = (app: InstalledApp) => {
    const label = fold(app.label);
    return label.startsWith(needle)
      ? 0
      : label.includes(needle)
        ? 1
        : fold(app.packageName).includes(needle)
          ? 2
          : -1;
  };
  return sorted
    .map((app) => [app, score(app)] as const)
    .filter(([, rank]) => rank >= 0)
    .sort((a, b) => a[1] - b[1])
    .map(([app]) => app);
}

/** Secondary text per entry key. Entries that share a label in the same profile are told apart by
 * package, by activity inside one package, and by profile number when two profiles of one kind hold
 * the same component; another profile's entries always name the profile. No two entries read alike. */
export function describeLauncherApps(
  apps: InstalledApp[],
  branding: { builtinPrefix?: string; productName?: string } = {},
): Map<string, string[]> {
  const groups = new Map<string, InstalledApp[]>();
  for (const app of apps) {
    const id = `${fold(app.label)}\n${app.profile || ""}`;
    groups.set(id, [...(groups.get(id) || []), app]);
  }
  const short = (app: InstalledApp) =>
    app.activityName
      ? app.activityName.slice(app.activityName.lastIndexOf(".") + 1) ||
        app.activityName
      : "";
  const details = new Map<string, string[]>();
  for (const group of groups.values()) {
    for (const app of group) {
      const parts: string[] = [];
      if (app.profile)
        parts.push(
          PROFILE_LABEL[app.profile] + (app.locked ? " · locked" : ""),
        );
      if (group.length > 1) {
        const packageLabel = app.packageName.startsWith(
          branding.builtinPrefix ?? "eliza:",
        )
          ? (branding.productName ?? "Eliza")
          : app.packageName;
        const siblings = group.filter(
          (other) => other.packageName === app.packageName,
        );
        const before = parts.length;
        if (siblings.length < group.length) parts.push(packageLabel);
        if (siblings.length > 1 && app.activityName) {
          parts.push(
            siblings.filter((other) => short(other) === short(app)).length === 1
              ? short(app)
              : app.activityName,
          );
          if (
            app.user &&
            siblings.filter((other) => other.activityName === app.activityName)
              .length > 1
          )
            parts.push(`profile ${app.user}`);
        }
        if (parts.length === before) parts.push(packageLabel);
      }
      details.set(appKey(app), parts);
    }
  }
  // Last resort for shapes the rules above do not separate (a profile entry without an activity,
  // an activity whose short name reads like a profile): rows that still read the same get their
  // full identity, so two different entries are never presented as one.
  const shown = new Map<string, InstalledApp[]>();
  for (const app of apps) {
    const id = `${fold(app.label)}\n${(details.get(appKey(app)) || []).join("\n")}`;
    shown.set(id, [...(shown.get(id) || []), app]);
  }
  for (const same of shown.values()) {
    if (new Set(same.map(appKey)).size < 2) continue;
    for (const app of same) {
      const parts = details.get(appKey(app)) || [];
      for (const part of [
        app.packageName,
        app.activityName,
        app.user ? `profile ${app.user}` : "",
      ])
        if (part && !parts.includes(part)) parts.push(part);
    }
  }
  return details;
}

const valid = (value: unknown): value is InstalledApp => {
  if (!value || typeof value !== "object") return false;
  const app = value as InstalledApp;
  return (
    typeof app.packageName === "string" &&
    !!app.packageName &&
    typeof app.label === "string" &&
    (app.icon === undefined ||
      (typeof app.icon === "string" &&
        /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(app.icon))) &&
    (app.activityName === undefined ||
      (typeof app.activityName === "string" && !!app.activityName)) &&
    (app.user === undefined ||
      (typeof app.user === "string" && /^\d{1,19}$/.test(app.user))) &&
    (app.profile === undefined || PROFILES.includes(app.profile)) &&
    (app.locked === undefined || typeof app.locked === "boolean")
  );
};

const cleanKeys = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value
    .filter(
      (key): key is string =>
        typeof key === "string" &&
        !!key &&
        key.length <= 512 &&
        !seen.has(key) &&
        !!seen.add(key),
    )
    .slice(0, MAX_FAVORITES);
};
/** Favorites in this origin's localStorage. A missing setting is distinct from an explicitly empty list; malformed data preserves an empty choice. */
export function localFavorites(
  storage: () => Pick<Storage, "getItem" | "setItem"> = () =>
    globalThis.localStorage,
  options: { key?: string; defaultPolicy?: string } = {},
): FavoritesStore {
  const storageKey = options.key ?? FAVORITES_KEY;
  const legacyDefaults = (): string[] | null => {
    try {
      const saved = JSON.parse(storage().getItem(storageKey) || "null");
      return saved?.version === 2 &&
        Object.keys(saved).sort().join(",") === "keys,version" &&
        Array.isArray(saved.keys) &&
        saved.keys.length <= MAX_FAVORITES &&
        cleanKeys(saved.keys).length === saved.keys.length
        ? saved.keys
        : null;
    } catch {
      return null;
    }
  };
  return {
    read() {
      try {
        const raw = storage().getItem(storageKey);
        if (raw === null) return null;
        const saved = JSON.parse(raw);
        return saved?.version === 1 || saved?.version === 2
          ? cleanKeys(saved.keys)
          : [];
      } catch {
        return [];
      }
    },
    legacy() {
      try {
        return (
          JSON.parse(storage().getItem(storageKey) || "null")?.version === 1
        );
      } catch {
        return false;
      }
    },
    legacyHomeDefaults: () => legacyDefaults() !== null,
    write(keys) {
      const original = legacyDefaults();
      let previousDefaults: string[] | null = null;
      try {
        const saved = JSON.parse(storage().getItem(storageKey) || "null");
        if (Array.isArray(saved?.previousDefaults))
          previousDefaults = cleanKeys(saved.previousDefaults);
      } catch {
        /* Keep the existing explicit write behavior. */
      }
      // Retain the old default's choices once; this is migration evidence, not a second live list.
      storage().setItem(
        storageKey,
        JSON.stringify({
          version: 2,
          keys,
          defaultPolicy: options.defaultPolicy ?? "eliza-apps",
          ...(previousDefaults || original
            ? { previousDefaults: previousDefaults || original }
            : {}),
        }),
      );
    },
  };
}

/** Reads installed apps on each open and whenever Android reports a change (installs and removals
 * happen outside the launcher), and launches only from an explicit tap. Failures stay visible; nothing is
 * retried automatically. */
export function createLauncher(
  bridge: LauncherBridge,
  changed: () => void,
  options: {
    icons?: boolean;
    favorites?: FavoritesStore;
    aliases?: Record<string, string>;
  } = {},
) {
  const store = options.favorites;
  const rawSaved = store ? store.read() : [];
  const saved =
    rawSaved === null
      ? null
      : cleanKeys(rawSaved.map((key) => options.aliases?.[key] || key));
  let migrationPending = !!store?.legacy?.();
  let legacyHomeDefaultsPending = !!store?.legacyHomeDefaults?.();
  let defaultsPending = saved === null;
  let builtins: InstalledApp[] = [];
  let state: LauncherSnapshot = {
    status: "idle",
    apps: [],
    dial: null,
    launching: null,
    launchError: null,
    favorites: saved || [],
  };
  let generation = 0;
  let lifetime = 0;
  const update = (patch: Partial<LauncherSnapshot>) => {
    state = { ...state, ...patch };
    changed();
  };
  const message = (error: unknown) =>
    error instanceof Error && error.message
      ? error.message
      : String(error || "Unavailable");
  const saveFavorites = (favorites: string[]) => {
    if (!store) {
      update({ launchError: "Favorites cannot be saved on this device." });
      return;
    }
    try {
      store.write(favorites);
      defaultsPending = false;
      migrationPending = false;
      legacyHomeDefaultsPending = false;
      update({ favorites, launchError: null });
    } catch {
      update({ launchError: "Favorites could not be saved. Nothing changed." });
    }
  };
  const installed = (key: string) =>
    state.apps.some((app) => appKey(app) === key);
  async function load(mode: { quiet?: boolean } = {}) {
    const current = ++generation;
    // A quiet refresh keeps the visible list and any launch error until the new read lands.
    update(
      mode.quiet && state.status !== "idle"
        ? {}
        : { status: "loading", launchError: null },
    );
    const [listed, dial] = await Promise.allSettled([
      bridge.list(options.icons ? { icons: true } : undefined),
      bridge.resolveDefault
        ? bridge.resolveDefault({ role: "dial" })
        : Promise.reject(Error("Unsupported")),
    ]);
    if (current !== generation) return;
    const dialApp =
      dial.status === "fulfilled" && dial.value && dial.value.available === true
        ? dial.value
        : null;
    // A failed read never leaves an older inventory on screen as if it were current.
    if (listed.status === "rejected" || !Array.isArray(listed.value?.apps)) {
      update({ status: "failed", apps: [...builtins], dial: dialApp });
      return;
    }
    const seen = new Set<string>();
    const apps = [
      ...builtins,
      ...listed.value.apps
        .filter(valid)
        .filter((app) => !options.aliases?.[appKey(app)]),
    ].filter((app) => !seen.has(appKey(app)) && !!seen.add(appKey(app)));
    if (defaultsPending || migrationPending || legacyHomeDefaultsPending) {
      const liveSaved = store ? store.read() : [];
      const unchanged =
        rawSaved === null
          ? liveSaved === null
          : liveSaved !== null &&
            rawSaved.length === liveSaved.length &&
            rawSaved.every((key, index) => key === liveSaved[index]);
      if (
        !unchanged ||
        (legacyHomeDefaultsPending && !store?.legacyHomeDefaults?.()) ||
        (migrationPending && !store?.legacy?.())
      ) {
        // An explicit choice made while the inventory read was pending wins.
        defaultsPending = migrationPending = legacyHomeDefaultsPending = false;
        update({
          status: "ready",
          apps,
          dial: dialApp,
          favorites: cleanKeys(
            (liveSaved || []).map((key) => options.aliases?.[key] || key),
          ),
        });
        return;
      }
      let favorites = defaultsPending
        ? (builtins.length ? builtins : apps).map(appKey)
        : state.favorites;
      if (legacyHomeDefaultsPending && builtins.length) {
        const currentKeys = apps.map(appKey),
          current = new Set(currentKeys),
          product = new Set(builtins.map(appKey));
        const visible = favorites.filter((key) => current.has(key));
        if (
          visible.length === currentKeys.length &&
          visible.every((key, index) => key === currentKeys[index])
        )
          favorites = favorites.filter(
            (key) => product.has(key) || !current.has(key),
          );
      }
      try {
        store?.write(favorites);
        defaultsPending = false;
        migrationPending = false;
        legacyHomeDefaultsPending = false;
        state = { ...state, favorites };
      } catch {
        state = {
          ...state,
          favorites,
          launchError: "Favorites could not be saved.",
        };
      }
    }
    update({ status: "ready", apps, dial: dialApp });
  }
  return {
    snapshot: () => state,
    /** Retire pending reads and late handoff replies without undoing a native launch.
     * A later load can reuse this controller, including a StrictMode remount. */
    cancelPending() {
      generation++;
      lifetime++;
      state = { ...state, launching: null };
    },
    /** Product apps already passed the shell's capability policy. Never dispatch these to Android. */
    setBuiltins(apps: InstalledApp[]) {
      const old = new Set(builtins.map(appKey));
      builtins = apps;
      state = {
        ...state,
        apps: [
          ...builtins,
          ...state.apps.filter((app) => !old.has(appKey(app))),
        ],
      };
      if (defaultsPending)
        state = {
          ...state,
          favorites: (builtins.length ? builtins : state.apps).map(appKey),
        };
      else if (migrationPending)
        state = {
          ...state,
          favorites: cleanKeys([...state.favorites, ...builtins.map(appKey)]),
        };
    },
    load,
    /** Re-reads after an outside change. Does nothing before the first open; never shows the loading state over a list. */
    async refresh() {
      if (state.status !== "idle") await load({ quiet: true });
    },
    async launch(app: InstalledApp) {
      if (state.launching) return;
      const currentLifetime = lifetime;
      const key = appKey(app);
      // Only an entry from the current read can be opened; a removed one is never sent to Android.
      if (!installed(key)) {
        update({ launchError: `${app.label} is no longer installed.` });
        return;
      }
      update({ launching: key, launchError: null });
      const target: LaunchTarget = { packageName: app.packageName };
      if (app.activityName) target.activityName = app.activityName;
      if (app.user) target.user = app.user;
      try {
        await bridge.launch(target);
        if (currentLifetime !== lifetime) return;
        update({ launching: null });
      } catch (error) {
        if (currentLifetime !== lifetime) return;
        update({
          launching: null,
          launchError: `${app.label} could not be opened. ${message(error)}`,
        });
        // The entry may be gone, disabled or locked now: show the device's current list. This is a
        // full read, so one it overtakes (the drawer was still opening) cannot strand the loading state.
        await load({ quiet: true });
      }
    },
    async openDial() {
      if (state.launching || !state.dial || !bridge.openDefault) return;
      const currentLifetime = lifetime;
      const label = state.dial.label || "Phone";
      update({ launching: "dial", launchError: null });
      try {
        await bridge.openDefault({ role: "dial" });
        if (currentLifetime !== lifetime) return;
        update({ launching: null });
      } catch (error) {
        if (currentLifetime !== lifetime) return;
        update({
          launching: null,
          launchError: `${label} could not be opened. ${message(error)}`,
        });
        // The handler may have been removed or disabled: re-resolve it so a dead shortcut does not stay.
        await load({ quiet: true });
      }
    },
    isFavorite: (app: InstalledApp) => state.favorites.includes(appKey(app)),
    /** Installed favorites in the saved order. A saved favorite that is not installed is not shown. */
    favoriteApps(): InstalledApp[] {
      const byKey = new Map(
        state.apps.map((app) => [appKey(app), app] as const),
      );
      return state.favorites
        .map((key) => byKey.get(key))
        .filter((app): app is InstalledApp => !!app);
    },
    toggleFavorite(app: InstalledApp) {
      const key = appKey(app);
      if (state.favorites.includes(key)) {
        saveFavorites(state.favorites.filter((item) => item !== key));
        return;
      }
      if (!installed(key)) return;
      // Room is made from favorites that are no longer installed before refusing a new one.
      let kept = state.favorites;
      if (kept.length >= MAX_FAVORITES) kept = kept.filter(installed);
      if (kept.length >= MAX_FAVORITES) {
        update({
          launchError: `You can keep ${MAX_FAVORITES} favorites. Remove one to add ${app.label}.`,
        });
        return;
      }
      saveFavorites([...kept, key]);
    },
    /** Moves a favorite one place among the installed favorites; uninstalled ones keep their slots. */
    moveFavorite(app: InstalledApp, direction: -1 | 1) {
      const key = appKey(app),
        visible = state.favorites.filter(installed),
        at = visible.indexOf(key),
        other = visible[at + direction];
      if (at < 0 || !other) return;
      const next = [...state.favorites],
        a = next.indexOf(key),
        b = next.indexOf(other);
      next[a] = other;
      next[b] = key;
      saveFavorites(next);
    },
    /** Drops a stale launch error (new search or reopened drawer). An in-flight read keeps its
     * generation, so typing while apps load never strands the drawer in its loading state. */
    clearError() {
      if (state.launchError) state = { ...state, launchError: null };
    },
  };
}
export type Launcher = ReturnType<typeof createLauncher>;

/** Share package/resume refresh ownership across hosts; initial inventory remains explicit. */
export function observeLauncher(
  bridge: LauncherBridge,
  launcher: Launcher,
  options: { follow?: boolean } = {},
): () => void {
  let active = true;
  let pending: ReturnType<typeof setTimeout> | null = null;
  const refresh = () => {
    if (pending || !active) return;
    pending = setTimeout(() => {
      pending = null;
      if (active) void launcher.refresh();
    }, 120);
  };
  const visible = () => {
    if (!document.hidden) refresh();
  };
  document.addEventListener("visibilitychange", visible);
  document.addEventListener("resume", refresh);
  let subscription: unknown = null;
  try {
    subscription =
      options.follow !== false && bridge.addListener
        ? Promise.resolve(bridge.addListener("appsChanged", refresh)).catch(
            () => null,
          )
        : null;
  } catch {
    subscription = null;
  }
  return () => {
    active = false;
    document.removeEventListener("visibilitychange", visible);
    document.removeEventListener("resume", refresh);
    if (pending) clearTimeout(pending);
    void Promise.resolve(subscription)
      .then((handle) => {
        if (
          handle &&
          typeof handle === "object" &&
          "remove" in handle &&
          typeof handle.remove === "function"
        )
          handle.remove();
      })
      .catch(() => {});
  };
}
