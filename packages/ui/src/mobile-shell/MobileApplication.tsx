/** The production mobile application root. Session, actions and chat retain
 * their existing owners; this root owns Home, app placement and All apps. */
import type {
  FavoritesStore,
  LauncherBridge,
} from "@elizaos/capacitor-system/launcher";
import {
  type HTMLAttributes,
  type ReactNode,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useSyncExternalStore,
} from "react";
import {
  getAppShellPageRegistrySnapshot,
  subscribeAppShellPages,
} from "../app-shell-pages";
import type {
  MobileApplicationCatalog,
  MobileApplicationPage,
} from "./application-catalog";
import { MobileAllAppsDrawer } from "./MobileAllAppsDrawer";
import {
  MobileHomeScreen,
  type MobileHomeScreenProps,
} from "./MobileHomeScreen";
import { createMobileShellLauncher } from "./mobile-launcher";
import type {
  MobileShellNavigation,
  MobileShellNavigationAction,
} from "./navigation";
import {
  type MobileShellAppearance,
  mobileShellIconUrl,
  mobileShellThemeVariables,
} from "./product-registration";

export interface MobileApplicationProps extends HTMLAttributes<HTMLDivElement> {
  catalog: MobileApplicationCatalog;
  navigation: MobileShellNavigation;
  /** The existing host navigation authority admits leave/Back before changing state. */
  navigate: (action: MobileShellNavigationAction) => void;
  bridge: LauncherBridge;
  appearance: MobileShellAppearance;
  home?: Omit<MobileHomeScreenProps, "tiles" | "onOpenAllApps" | "covered">;
  renderView: (page: MobileApplicationPage) => ReactNode;
  renderViewIcon?: (
    page: MobileApplicationPage,
    placement: "home" | "list",
  ) => ReactNode;
  renderUnavailable?: (view: string) => ReactNode;
  /** Persistent current-owner view instances, such as an open Notes editor. */
  retainedViews?: ReactNode;
  /** One existing chat/voice owner stays mounted across app navigation. */
  assistant: ReactNode;
  overlays?: ReactNode;
  favorites?: FavoritesStore;
  storage?: () => Pick<Storage, "getItem" | "setItem">;
  installedIcons?: boolean;
  followInstalledApps?: boolean;
  /** Exact mirror keys for a browser/platform adapter; never inferred from labels. */
  aliases?: Record<string, string>;
  homeCovered?: boolean;
  drawerProps?: Omit<
    import("./MobileAllAppsDrawer").MobileAllAppsDrawerProps<MobileApplicationPage>,
    "shellLauncher" | "registry" | "query" | "onQuery" | "onClose"
  >;
  homeTiles?: (
    tiles: readonly import("./MobileHomeScreen").MobileHomeTile[],
  ) => readonly import("./MobileHomeScreen").MobileHomeTile[];
}

export function MobileApplication({
  catalog,
  navigation,
  navigate,
  bridge,
  appearance,
  home,
  renderView,
  renderViewIcon,
  renderUnavailable,
  retainedViews,
  assistant,
  overlays,
  favorites,
  storage,
  installedIcons,
  followInstalledApps,
  aliases,
  homeCovered,
  drawerProps,
  homeTiles,
  style,
  ...attributes
}: MobileApplicationProps) {
  useSyncExternalStore(
    subscribeAppShellPages,
    getAppShellPageRegistrySnapshot,
    getAppShellPageRegistrySnapshot,
  );
  const [, changed] = useReducer((value) => value + 1, 0);
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  const shell = useMemo(
    () =>
      createMobileShellLauncher({
        bridge,
        registry: catalog,
        favorites,
        storage,
        icons: installedIcons,
        aliases,
        changed,
        open: (page) => navigateRef.current({ type: "open", view: page.id }),
      }),
    [bridge, catalog, favorites, storage, installedIcons, aliases],
  );
  useEffect(() => {
    const stop = shell.observe({ follow: followInstalledApps });
    shell.prepareHome();
    return () => {
      stop();
      shell.launcher.cancelPending();
    };
  }, [shell, followInstalledApps]);
  shell.syncViews();
  const page = navigation.view ? catalog.find(navigation.view) : undefined;
  const grid = mobileShellIconUrl(
    catalog.product,
    catalog.product.icons.allApps,
  );
  const view =
    navigation.view === null ? null : page ? (
      renderView(page)
    ) : renderUnavailable ? (
      renderUnavailable(navigation.view)
    ) : (
      <p role="status">This app is unavailable.</p>
    );
  const tiles = shell.homeEntries().map((entry) =>
    entry.kind === "view"
      ? {
          key: entry.key,
          label: entry.view.label,
          glyphUrl: catalog.iconUrl(entry.view),
          face: renderViewIcon?.(entry.view, "home"),
          onOpen: () => navigate({ type: "open", view: entry.view.id }),
        }
      : {
          key: entry.key,
          label: entry.app.label,
          image: entry.app.icon,
          onOpen: () => {
            void shell.launcher.launch(entry.app);
          },
        },
  );
  return (
    <div
      {...attributes}
      data-mobile-application=""
      data-mobile-product={catalog.product.identity.appId}
      style={{
        position: "relative",
        width: "100%",
        height: "100%",
        overflow: "hidden",
        ...mobileShellThemeVariables(catalog.product, appearance),
        ...style,
      }}
    >
      <MobileHomeScreen
        {...home}
        covered={homeCovered || navigation.view !== null || navigation.drawer}
        allAppsGlyphUrl={grid}
        allAppsIconId={catalog.product.icons.allApps}
        tiles={homeTiles?.(tiles) ?? tiles}
        onOpenAllApps={() => {
          navigate({ type: "drawer", open: true });
          void shell.launcher.load();
        }}
      />
      {retainedViews}
      {view != null ? (
        <div
          data-mobile-application-view=""
          style={{ position: "absolute", inset: 0 }}
        >
          {view}
        </div>
      ) : null}
      {navigation.drawer ? (
        <MobileAllAppsDrawer
          {...drawerProps}
          shellLauncher={shell}
          registry={catalog}
          renderViewIcon={
            renderViewIcon ? (page) => renderViewIcon(page, "list") : undefined
          }
          query={navigation.drawerQuery}
          onQuery={(query) => navigate({ type: "drawer-query", query })}
          onClose={() => navigate({ type: "drawer", open: false })}
        />
      ) : null}
      {assistant}
      {overlays}
    </div>
  );
}
