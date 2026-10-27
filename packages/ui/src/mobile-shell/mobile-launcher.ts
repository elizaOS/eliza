/**
 * Joins a product's views to the shared installed-app launcher. Product
 * entries open inside the shell and never reach the platform launcher;
 * installed apps launch by their exact component as before.
 */
import {
  appKey,
  createLauncher,
  type FavoritesStore,
  type InstalledApp,
  type Launcher,
  type LauncherBridge,
  observeLauncher,
} from "@elizaos/capacitor-system/launcher";
import type {
  MobileViewRegistration,
  MobileViewRegistry,
} from "./view-registry";

export type MobileHomeEntry =
  | { kind: "view"; key: string; view: MobileViewRegistration }
  | { kind: "app"; key: string; app: InstalledApp };

export interface MobileShellLauncher {
  launcher: Launcher;
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
  favorites?: FavoritesStore;
  icons?: boolean;
  /** Exact device mirror keys of product views; never inferred from labels. */
  aliases?: Record<string, string>;
}): MobileShellLauncher {
  const { bridge, registry } = options;
  const prefix = registry.product.storage.launcherBuiltinPrefix;
  const launcher = createLauncher(
    {
      ...bridge,
      launch(target) {
        const view = registry.fromLauncherKey(appKey(target));
        if (!view) return bridge.launch(target);
        options.open(view);
        return Promise.resolve();
      },
    },
    options.changed,
    {
      icons: options.icons,
      favorites: options.favorites,
      aliases: options.aliases,
    },
  );
  return {
    launcher,
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
