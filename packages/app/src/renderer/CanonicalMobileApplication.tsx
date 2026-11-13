/** Mobile composition of the existing app router, session and chat owners. */
import { System } from "@elizaos/capacitor-system";
import { createSystemLauncherBridge } from "@elizaos/capacitor-system/launcher";
import {
  dispatchBackIntent,
  dispatchNavigateViewEvent,
  shellLocalStorage,
  useAppSelector,
  useEnabledViewKinds,
  WidgetHost,
} from "@elizaos/ui";
import {
  createMobileApplicationCatalog,
  ELIZA_MOBILE_PRODUCT,
  MobileApplication,
  type MobileShellNavigationAction,
} from "@elizaos/ui/mobile-shell";
import {
  type CSSProperties,
  type ReactNode,
  useCallback,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  type AppShellPageRegistration,
  listAppShellPages,
} from "../../../ui/src/app-shell-registry";
import { curateLauncherPages } from "../../../ui/src/components/pages/launcher-curation";
import { DefaultHomeWidgets } from "../../../ui/src/components/shell/DefaultHomeWidgets";
import {
  HOME_SCREEN_CSS,
  useHomeDashboard,
} from "../../../ui/src/components/shell/HomeScreen";
import { NotificationsHomeCenter } from "../../../ui/src/components/shell/NotificationsHomeCenter";
import { LauncherAppIcon } from "../../../ui/src/components/views/LauncherAppIcon";
import { useViewCatalog } from "../../../ui/src/hooks/useViewCatalog";
import { isAospShellEnabled } from "../../../ui/src/navigation";
import {
  setShellSurfacePage,
  useShellSurface,
} from "../../../ui/src/state/shell-surface-store";

const launcherStorage = () => ({
  getItem: (key: string) => window.localStorage.getItem(key),
  setItem: (key: string, value: string) =>
    shellLocalStorage.setItem(key, value),
});

export function CanonicalMobileApplication({
  content,
  assistant,
  cloudAuthenticated,
}: {
  content: ReactNode;
  assistant: ReactNode;
  cloudAuthenticated: boolean;
}) {
  const tab = useAppSelector((state) => state.tab);
  const setTab = useAppSelector((state) => state.setTab);
  const appearance =
    useAppSelector((state) => state.uiTheme) === "dark" ? "dark" : "light";
  const { entries } = useViewCatalog({ includeApps: false });
  const enabledKinds = useEnabledViewKinds();
  const surface = useShellSurface();
  const [query, setQuery] = useState("");
  const pages = useRef<readonly AppShellPageRegistration[]>([]);
  const registered = listAppShellPages();
  // useViewCatalog merges the authoritative registrations and existing builtin
  // route declarations. Keep its shared visibility policy and exact paths.
  pages.current = curateLauncherPages(entries, {
    isAosp: isAospShellEnabled(),
    enabledKinds,
    cloudActive: cloudAuthenticated,
  }).flatMap((entry) => {
    if (entry.kind !== "view" || entry.state !== "loaded" || !entry.path)
      return [];
    return [
      registered.find(
        (page) =>
          page.id === entry.id ||
          page.agentViewId === entry.id ||
          page.path === entry.path,
      ) ?? {
        id: entry.id,
        pluginId: entry.pluginName ?? "@elizaos/builtin",
        label: entry.label,
        path: entry.path,
        icon: entry.icon,
        order: entry.order,
        viewKind: entry.viewKind,
      },
    ];
  });
  const catalog = useMemo(
    () =>
      createMobileApplicationCatalog(ELIZA_MOBILE_PRODUCT, () => pages.current),
    [],
  );
  const bridge = useMemo(() => createSystemLauncherBridge(System), []);
  const navigate = useCallback(
    (action: MobileShellNavigationAction) => {
      if (action.type === "drawer-query") {
        setQuery(action.query);
        return;
      }
      if (action.type === "drawer") {
        setQuery("");
        setShellSurfacePage(action.open ? "launcher" : "home");
        return;
      }
      if (action.type === "open") {
        const page = catalog.find(action.view);
        if (page) {
          setShellSurfacePage("home");
          dispatchNavigateViewEvent({ viewPath: page.path });
        }
        return;
      }
      if (action.type === "home") {
        setShellSurfacePage("home");
        setTab("chat");
        return;
      }
      if (action.type === "back") {
        if (surface.page === "launcher") {
          setShellSurfacePage("home");
          return;
        }
        if (!dispatchBackIntent()) setTab("chat");
      }
    },
    [catalog, setTab, surface.page],
  );
  const dashboard = useHomeDashboard<HTMLDivElement>();
  const home = tab === "chat" || tab === "views";
  return (
    <MobileApplication
      catalog={catalog}
      bridge={bridge}
      appearance={appearance}
      installedIcons
      storage={launcherStorage}
      style={
        {
          "--mobile-shell-home-background": "transparent",
          "--mobile-shell-composer-clearance":
            "calc(var(--eliza-chat-clearance, 5.25rem) + max(var(--safe-area-bottom, 0px), var(--android-gesture-inset-bottom, 0px)) + 1.5rem)",
        } as CSSProperties
      }
      drawerProps={{
        style: { paddingBottom: "var(--mobile-shell-composer-clearance)" },
      }}
      navigation={{
        view: home ? null : tab,
        stack: [],
        drawer: home && surface.page === "launcher",
        drawerQuery: query,
        assistant: "input",
      }}
      navigate={navigate}
      home={{
        allAppsFace: (
          <LauncherAppIcon
            entry={{ id: "views", label: "All apps", icon: "grid" }}
            className="!size-16"
          />
        ),
        ref: dashboard.homeScreenRef,
        "data-testid": "home-screen",
        layoutProps: { ref: dashboard.homeContentColumnRef },
        header: (
          <>
            <style>{HOME_SCREEN_CSS}</style>
            <div style={{ paddingInline: 16 }}>
              <DefaultHomeWidgets />
            </div>
            <NotificationsHomeCenter
              emptyGestureTargetRef={dashboard.homeScreenRef}
              shadeLayoutTargetRef={dashboard.homeContentColumnRef}
              onShadeOccupancyChange={dashboard.handleShadeExpandedChange}
              openRequestId={dashboard.notificationCenterOpenRequestId}
              onOpenRequestHandled={
                dashboard.handleNotificationCenterOpenRequestHandled
              }
            />
          </>
        ),
        cards: (
          <WidgetHost
            slot="home"
            layout="grid"
            events={dashboard.events}
            clearEvents={dashboard.clearEvents}
          />
        ),
        cardsProps: {
          inert: dashboard.appsDisplaced || undefined,
          "aria-hidden": dashboard.appsDisplaced || undefined,
        },
        gridProps: {
          ref: dashboard.appsRegionRef,
          inert: dashboard.appsDisplaced || undefined,
          "aria-hidden": dashboard.appsDisplaced || undefined,
          onFocusCapture: dashboard.handleAppsFocusCapture,
          onBlurCapture: dashboard.handleAppsBlurCapture,
        },
      }}
      retainedViews={
        <div
          data-mobile-routed-content=""
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            minHeight: 0,
            pointerEvents: home ? "none" : undefined,
          }}
        >
          {content}
        </div>
      }
      renderViewIcon={(page, placement) => (
        <LauncherAppIcon
          entry={{
            id: page.id,
            label: page.label,
            icon: page.registration.icon,
          }}
          className={placement === "home" ? "!size-16" : "!size-8"}
        />
      )}
      renderView={() => null}
      renderUnavailable={() => null}
      assistant={assistant}
    />
  );
}
