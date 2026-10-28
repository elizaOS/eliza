/**
 * Joins a product's views to the shared installed-app launcher. Product
 * entries open inside the shell and never reach the platform launcher;
 * installed apps launch by their exact component as before. The favorites
 * list is the product's installed record: its older view ids are migrated
 * once, before the launcher first reads it.
 */
import {
  appKey,
  createLauncher,
  type FavoritesStore,
  type InstalledApp,
  type Launcher,
  type LauncherBridge,
  localFavorites,
  observeLauncher,
} from "@elizaos/capacitor-system/launcher";
import {
  type LauncherViewIdMigration,
  migrateLauncherViewIds,
} from "./view-id-migration";
import type {
  MobileViewRegistration,
  MobileViewRegistry,
} from "./view-registry";

export type MobileHomeEntry =
  | { kind: "view"; key: string; view: MobileViewRegistration }
  | { kind: "app"; key: string; app: InstalledApp };

export interface MobileShellLauncher {
  launcher: Launcher;
  /**
   * Outcome of the one migration of older view ids in the installed
   * favorites; absent when the host supplied its own favorites store.
   */
  migration?: LauncherViewIdMigration;
  /** Offers the views available now. Availability can change, so call it before each render. */
  syncViews(): void;
  /** Home: the favorites in saved order, product views and installed apps alike. */
  homeEntries(): MobileHomeEntry[];
  /** Reads the installed inventory once when Home must show installed favorites. */
  prepareHome(): void;
  /** Follows installs, removals and resume; returns the stop function. */
  observe(options?: { follow?: boolean }): () => void;
}

export function createMobileShellLauncher(options: {
  bridge: LauncherBridge;
  registry: MobileViewRegistry;
  /** Opens a product view in the shell. */
  open: (view: MobileViewRegistration) => void;
  changed: () => void;
  /** Replaces the product's installed favorites record (tests, previews). */
  favorites?: FavoritesStore;
  /** Storage of the installed favorites record; `localStorage` by default. */
  storage?: () => Pick<Storage, "getItem" | "setItem">;
  icons?: boolean;
  /** Exact device mirror keys of product views; never inferred from labels. */
  aliases?: Record<string, string>;
}): MobileShellLauncher {
  const { bridge, registry } = options;
  const { storage: names } = registry.product;
  const prefix = names.launcherBuiltinPrefix;
  let store = options.favorites;
  let migration: LauncherViewIdMigration | undefined;
  if (!store) {
    const storage = options.storage ?? (() => globalThis.localStorage);
    try {
      migration = migrateLauncherViewIds(storage(), registry.product);
    } catch (error) {
      // Storage itself is unavailable; the launcher then reads no favorites either.
      migration = { status: "failed", message: String(error) };
    }
    const local = localFavorites(storage, {
      key: names.launcherFavorites,
      defaultPolicy: names.launcherDefaultPolicy,
    });
    // Unavailable storage holds no saved choice, so Home starts from the
    // product's defaults; saving still fails visibly through the launcher.
    store = {
      ...local,
      read() {
        try {
          storage().getItem(names.launcherFavorites);
        } catch {
          return null;
        }
        return local.read();
      },
    };
  }
  // Native plugin proxies resolve methods when they are read, so each method
  // is delegated by name; spreading the bridge would drop them.
  const shellBridge: LauncherBridge = {
    list: (listOptions) => bridge.list(listOptions),
    launch(target) {
      const view = registry.fromLauncherKey(appKey(target));
      if (!view) return bridge.launch(target);
      options.open(view);
      return Promise.resolve();
    },
  };
  if (bridge.resolveDefault)
    shellBridge.resolveDefault = (role) =>
      bridge.resolveDefault?.(role) ?? Promise.reject(new Error("Unavailable"));
  if (bridge.openDefault)
    shellBridge.openDefault = (role) =>
      bridge.openDefault?.(role) ?? Promise.reject(new Error("Unavailable"));
  const launcher = createLauncher(shellBridge, options.changed, {
    icons: options.icons,
    favorites: store,
    aliases: options.aliases,
  });
  return {
    launcher,
    ...(migration ? { migration } : {}),
    syncViews() {
      launcher.setBuiltins(
        registry.available().map((view) => ({
          packageName: registry.launcherKey(view),
          label: view.label,
        })),
      );
    },
    homeEntries: () =>
      launcher.favoriteApps().map((app): MobileHomeEntry => {
        const key = appKey(app);
        const view = registry.fromLauncherKey(key);
        return view ? { kind: "view", key, view } : { kind: "app", key, app };
      }),
    prepareHome() {
      const { favorites, status } = launcher.snapshot();
      if (status === "idle" && favorites.some((key) => !key.startsWith(prefix)))
        void launcher.load();
    },
    observe: (observeOptions) =>
      observeLauncher(bridge, launcher, observeOptions),
  };
}
