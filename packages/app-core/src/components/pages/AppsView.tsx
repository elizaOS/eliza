import { PageLayout } from "@elizaos/ui";
import { Pin, PinOff } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type AppRunSummary, client, type RegistryAppInfo } from "../../api";
import {
  invokeDesktopBridgeRequest,
  isElectrobunRuntime,
  subscribeDesktopBridgeEvent,
} from "../../bridge";
import { getAppSlugFromPath, type Tab } from "../../navigation";

import { useApp } from "../../state";
import { openExternalUrl } from "../../utils";
import { AppsCatalogGrid } from "../apps/AppsCatalogGrid";
import { AppsSidebar } from "../apps/AppsSidebar";
import {
  filterAppsForCatalog,
  findAppBySlug,
  getAppSlug,
} from "../apps/helpers";
import {
  getInternalToolApps,
  getInternalToolAppTargetTab,
} from "../apps/internal-tool-apps";
import {
  getAllOverlayApps,
  isOverlayApp,
  overlayAppToRegistryInfo,
} from "../apps/overlay-app-registry";
import { RunningAppsRow } from "../apps/RunningAppsRow";
import {
  resolveEmbeddedViewerUrl,
  shouldUseEmbeddedAppViewer,
} from "../apps/viewer-auth";

export { shouldShowAppInAppsView } from "../apps/helpers";

/** Max items retained in launch history. */
const RECENT_APPS_LIMIT = 10;

const APPS_SIDEBAR_WIDTH_KEY = "milady:apps:sidebar:width";
const APPS_SIDEBAR_COLLAPSED_KEY = "milady:apps:sidebar:collapsed";
const APPS_SIDEBAR_DEFAULT_WIDTH = 240;
const APPS_SIDEBAR_MIN_WIDTH = 200;
const APPS_SIDEBAR_MAX_WIDTH = 520;
const APP_WINDOW_ALWAYS_ON_TOP_KEY = "milady:apps:window:always-on-top";
const APP_WINDOW_HEARTBEAT_MS = 15_000;

interface AppWindowRecord {
  id: string;
  kind: "managed" | "game";
  runId: string;
  appName: string;
  displayName: string;
  alwaysOnTop: boolean;
}

interface ManagedWindowSnapshot {
  id: string;
  surface: string;
  title: string;
  alwaysOnTop: boolean;
}

type NativeAppSurface =
  | "chat"
  | "browser"
  | "release"
  | "triggers"
  | "plugins"
  | "connectors"
  | "cloud";

function nativeSurfaceForInternalToolTab(
  tab: Tab | null,
): NativeAppSurface | null {
  switch (tab) {
    case "plugins":
      return "plugins";
    case "connectors":
      return "connectors";
    case "browser":
      return "browser";
    case "automations":
    case "triggers":
      return "triggers";
    default:
      return null;
  }
}

function clampWidth(value: number): number {
  return Math.min(
    Math.max(value, APPS_SIDEBAR_MIN_WIDTH),
    APPS_SIDEBAR_MAX_WIDTH,
  );
}

function loadInitialSidebarWidth(): number {
  if (typeof window === "undefined") return APPS_SIDEBAR_DEFAULT_WIDTH;
  try {
    const raw = window.localStorage.getItem(APPS_SIDEBAR_WIDTH_KEY);
    const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
    if (Number.isFinite(parsed)) return clampWidth(parsed);
  } catch {
    /* ignore sandboxed storage */
  }
  return APPS_SIDEBAR_DEFAULT_WIDTH;
}

function loadInitialSidebarCollapsed(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(APPS_SIDEBAR_COLLAPSED_KEY) === "true";
  } catch {
    return false;
  }
}

function loadInitialAppWindowAlwaysOnTop(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(APP_WINDOW_ALWAYS_ON_TOP_KEY) === "true";
  } catch {
    return false;
  }
}

function isAppRouteWindow(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return new URLSearchParams(window.location.search).get("appWindow") === "1";
  } catch {
    return false;
  }
}

function shouldUseHashNavigation(): boolean {
  if (typeof window === "undefined") return false;
  return window.location.protocol === "file:" || isAppRouteWindow();
}

function getCurrentAppsPath(): string {
  if (typeof window === "undefined") return "/";
  return shouldUseHashNavigation()
    ? window.location.hash.replace(/^#/, "") || "/"
    : window.location.pathname;
}

function resolveDesktopViewerUrl(viewerUrl: string): string | null {
  const resolved = resolveEmbeddedViewerUrl(viewerUrl);
  if (!resolved) return null;
  try {
    const parsed = new URL(resolved);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

function getApiStatus(err: unknown): number | null {
  if (
    err &&
    typeof err === "object" &&
    "status" in err &&
    typeof (err as { status?: unknown }).status === "number"
  ) {
    return (err as { status: number }).status;
  }
  return null;
}

function isClosedCanvasWindowEvent(
  payload: unknown,
): payload is { windowId: string; event: "closed" } {
  if (payload === null || typeof payload !== "object") return false;
  const candidate = payload as { windowId?: unknown; event?: unknown };
  return (
    "windowId" in payload &&
    typeof candidate.windowId === "string" &&
    "event" in payload &&
    candidate.event === "closed"
  );
}

function isManagedWindowsChangedEvent(
  payload: unknown,
): payload is { windows: ManagedWindowSnapshot[] } {
  if (payload === null || typeof payload !== "object") return false;
  const windows = (payload as { windows?: unknown }).windows;
  return Array.isArray(windows);
}

export function AppsView() {
  const {
    appRuns,
    activeGameRunId,
    activeGameViewerUrl,
    appsSubTab,
    favoriteApps,
    recentApps,
    setTab,
    setState,
    setActionNotice,
    t,
  } = useApp();
  const [apps, setApps] = useState<RegistryAppInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, _setSearchQuery] = useState("");
  const [busyRunId, setBusyRunId] = useState<string | null>(null);
  const [stoppingRunId, setStoppingRunId] = useState<string | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(
    loadInitialSidebarCollapsed,
  );
  const [sidebarWidth, setSidebarWidth] = useState<number>(
    loadInitialSidebarWidth,
  );
  const [appWindowAlwaysOnTop, setAppWindowAlwaysOnTop] = useState<boolean>(
    loadInitialAppWindowAlwaysOnTop,
  );
  const [isAppWindow] = useState<boolean>(isAppRouteWindow);
  const [appWindows, setAppWindows] = useState<AppWindowRecord[]>([]);
  const [busyAppWindowId, setBusyAppWindowId] = useState<string | null>(null);
  const slugAutoLaunchDone = useRef(false);
  const appWindowsRef = useRef<AppWindowRecord[]>([]);

  const handleSidebarCollapsedChange = useCallback((next: boolean) => {
    setSidebarCollapsed(next);
    try {
      window.localStorage.setItem(APPS_SIDEBAR_COLLAPSED_KEY, String(next));
    } catch {
      /* ignore */
    }
  }, []);

  const handleSidebarWidthChange = useCallback((next: number) => {
    const clamped = clampWidth(next);
    setSidebarWidth(clamped);
    try {
      window.localStorage.setItem(APPS_SIDEBAR_WIDTH_KEY, String(clamped));
    } catch {
      /* ignore */
    }
  }, []);

  const handleAppWindowAlwaysOnTopChange = useCallback((next: boolean) => {
    setAppWindowAlwaysOnTop(next);
    try {
      window.localStorage.setItem(APP_WINDOW_ALWAYS_ON_TOP_KEY, String(next));
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    appWindowsRef.current = appWindows;
  }, [appWindows]);

  useEffect(() => {
    return subscribeDesktopBridgeEvent({
      rpcMessage: "canvasWindowEvent",
      ipcChannel: "canvas:windowEvent",
      listener: (payload) => {
        if (!isClosedCanvasWindowEvent(payload)) return;
        setAppWindows((current) =>
          current.filter((item) => item.id !== payload.windowId),
        );
      },
    });
  }, []);

  useEffect(() => {
    return subscribeDesktopBridgeEvent({
      rpcMessage: "desktopManagedWindowsChanged",
      ipcChannel: "desktop:managedWindowsChanged",
      listener: (payload) => {
        if (!isManagedWindowsChangedEvent(payload)) return;
        const managedWindows = payload.windows
          .filter((windowRecord) => windowRecord.surface !== "settings")
          .map(
            (windowRecord): AppWindowRecord => ({
              id: windowRecord.id,
              kind: "managed",
              runId: "",
              appName: windowRecord.title,
              displayName: windowRecord.title,
              alwaysOnTop: windowRecord.alwaysOnTop,
            }),
          );
        setAppWindows((current) => [
          ...managedWindows,
          ...current.filter((record) => record.kind === "game"),
        ]);
      },
    });
  }, []);

  const activeAppNames = useMemo(
    () => new Set(appRuns.map((run) => run.appName)),
    [appRuns],
  );
  const favoriteAppNames = useMemo(() => new Set(favoriteApps), [favoriteApps]);
  const activeGameRun = useMemo(
    () => appRuns.find((run) => run.runId === activeGameRunId) ?? null,
    [activeGameRunId, appRuns],
  );
  const currentGameViewerUrl =
    typeof activeGameViewerUrl === "string" ? activeGameViewerUrl.trim() : "";
  const hasActiveRun = Boolean(activeGameRun);
  const hasCurrentGame =
    currentGameViewerUrl.length > 0 &&
    activeGameRun?.viewerAttachment === "attached";

  /** Push or replace the browser URL to reflect the active app (or browse). */
  const pushAppsUrl = useCallback((slug?: string) => {
    try {
      const path = slug ? `/apps/${slug}` : "/apps";
      if (shouldUseHashNavigation()) {
        window.location.hash = path;
      } else {
        window.history.replaceState(null, "", path);
      }
    } catch {
      /* ignore — sandboxed iframe or SSR */
    }
  }, []);

  const sortedRuns = useMemo(
    () => [...appRuns].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [appRuns],
  );
  const mergeRun = useCallback(
    (run: AppRunSummary) => {
      const nextRuns = [
        run,
        ...appRuns.filter((item) => item.runId !== run.runId),
      ].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      setState("appRuns", nextRuns);
      return nextRuns;
    },
    [appRuns, setState],
  );

  const refreshRuns = useCallback(async () => {
    const runs = await client.listAppRuns();
    setState("appRuns", runs);
    return runs;
  }, [setState]);

  useEffect(() => {
    if (appWindows.length === 0) return;
    let cancelled = false;

    const heartbeat = async () => {
      const records = appWindowsRef.current;
      for (const record of records) {
        if (!record.runId) continue;
        try {
          await client.heartbeatAppRun(record.runId);
        } catch (err) {
          if (cancelled || getApiStatus(err) !== 404) continue;
          setAppWindows((current) =>
            current.filter((item) => item.runId !== record.runId),
          );
          void refreshRuns().catch(() => {});
        }
      }
    };

    void heartbeat();
    const timer = window.setInterval(() => {
      void heartbeat();
    }, APP_WINDOW_HEARTBEAT_MS);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [appWindows.length, refreshRuns]);

  const loadApps = useCallback(async () => {
    setLoading(true);
    setError(null);
    void refreshRuns().catch((err: unknown) => {
      console.warn("[AppsView] Failed to list app runs:", err);
    });
    try {
      const serverAppsResult = await client
        .listApps()
        .then((apps) => ({
          status: "fulfilled" as const,
          value: apps,
        }))
        .catch((reason) => ({
          status: "rejected" as const,
          reason,
        }));
      const serverApps =
        serverAppsResult.status === "fulfilled" ? serverAppsResult.value : [];
      if (serverAppsResult.status === "rejected") {
        console.warn(
          "[AppsView] Failed to list apps:",
          serverAppsResult.reason,
        );
      }
      // Internal tool apps are client-owned navigation surfaces. The registry
      // augments them with curated apps, but it must not be able to hide them.
      let catalogApps: RegistryAppInfo[];
      try {
        catalogApps = [
          ...getInternalToolApps(),
          ...(await client.listCatalogApps()),
        ];
      } catch (catalogErr) {
        console.warn(
          "[AppsView] Failed to load catalog apps; using internal tools:",
          catalogErr,
        );
        catalogApps = getInternalToolApps();
      }
      // Inject registered overlay apps (e.g. companion) if not already from server
      const overlayDescriptors = getAllOverlayApps()
        .filter((oa) => !serverApps.some((a) => a.name === oa.name))
        .filter((oa) => !catalogApps.some((a) => a.name === oa.name))
        .map(overlayAppToRegistryInfo);
      // Server-discovered apps win on conflicts — they have live runtime data.
      // Catalog apps fill in known-but-not-installed entries (scape, vincent,
      // hyperscape, etc.) so the page keeps showing them.
      const list = [
        ...catalogApps,
        ...overlayDescriptors,
        ...serverApps,
      ].filter(
        (app, index, items) =>
          !items
            .slice(index + 1)
            .some((candidate: RegistryAppInfo) => candidate.name === app.name),
      );
      setApps(list);
    } catch (err) {
      setError(
        t("appsview.LoadError", {
          message:
            err instanceof Error ? err.message : t("appsview.NetworkError"),
        }),
      );
    } finally {
      setLoading(false);
    }
  }, [refreshRuns, t]);

  useEffect(() => {
    void loadApps();
  }, [loadApps]);

  useEffect(() => {
    let cancelled = false;

    const refresh = async () => {
      try {
        await refreshRuns();
      } catch (err) {
        if (!cancelled) {
          console.warn("[AppsView] Failed to refresh app runs:", err);
        }
      }
    };

    const timer = setInterval(() => {
      void refresh();
    }, 5_000);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [refreshRuns]);

  useEffect(() => {
    if (appsSubTab !== "running") return;
    setState("appsSubTab", "browse");
  }, [appsSubTab, setState]);

  const pushRecentApp = useCallback(
    (appName: string) => {
      const next = [appName, ...recentApps.filter((name) => name !== appName)];
      if (next.length > RECENT_APPS_LIMIT) next.length = RECENT_APPS_LIMIT;
      setState("recentApps", next);
    },
    [recentApps, setState],
  );

  const openAppRouteWindow = useCallback(
    async (app: RegistryAppInfo): Promise<boolean> => {
      if (isAppWindow || !isElectrobunRuntime()) return false;
      const nativeSurface = nativeSurfaceForInternalToolTab(
        getInternalToolAppTargetTab(app.name),
      );
      if (nativeSurface) {
        const created =
          await invokeDesktopBridgeRequest<ManagedWindowSnapshot | null>({
            rpcMethod: "desktopOpenSurfaceWindow",
            ipcChannel: "desktop:openSurfaceWindow",
            params: {
              surface: nativeSurface,
              alwaysOnTop: appWindowAlwaysOnTop,
            },
          });
        if (!created?.id) return false;
        setAppWindows((current) => [
          {
            id: created.id,
            kind: "managed",
            runId: "",
            appName: app.name,
            displayName: app.displayName ?? app.name,
            alwaysOnTop: created.alwaysOnTop,
          },
          ...current.filter((item) => item.id !== created.id),
        ]);
        pushRecentApp(app.name);
        setState("appsSubTab", "browse");
        pushAppsUrl(getAppSlug(app.name));
        setActionNotice(
          t("appsview.OpenedInDesktopWindow", {
            defaultValue: `${app.displayName ?? app.name} opened in a desktop window.`,
            name: app.displayName ?? app.name,
          }),
          "success",
          2600,
        );
        return true;
      }

      const slug = getAppSlug(app.name);
      const created = await invokeDesktopBridgeRequest<{
        id: string;
        alwaysOnTop: boolean;
      }>({
        rpcMethod: "desktopOpenAppWindow",
        ipcChannel: "desktop:openAppWindow",
        params: {
          title: app.displayName ?? app.name,
          path: `/apps/${encodeURIComponent(slug)}`,
          alwaysOnTop: appWindowAlwaysOnTop,
        },
      });
      if (!created?.id) return false;
      setAppWindows((current) => [
        {
          id: created.id,
          kind: "managed",
          runId: "",
          appName: app.name,
          displayName: app.displayName ?? app.name,
          alwaysOnTop: created.alwaysOnTop,
        },
        ...current.filter((item) => item.id !== created.id),
      ]);
      pushRecentApp(app.name);
      setState("appsSubTab", "browse");
      pushAppsUrl(getAppSlug(app.name));
      setActionNotice(
        t("appsview.OpenedInDesktopWindow", {
          defaultValue: `${app.displayName ?? app.name} opened in a desktop window.`,
          name: app.displayName ?? app.name,
        }),
        "success",
        2600,
      );
      return true;
    },
    [
      appWindowAlwaysOnTop,
      isAppWindow,
      pushAppsUrl,
      pushRecentApp,
      setActionNotice,
      setState,
      t,
    ],
  );

  const openRunInDesktopWindow = useCallback(
    async (run: AppRunSummary): Promise<boolean> => {
      if (
        !run.viewer?.url ||
        shouldUseEmbeddedAppViewer(run) ||
        !isElectrobunRuntime()
      ) {
        return false;
      }

      const viewerUrl = resolveDesktopViewerUrl(run.viewer.url);
      if (!viewerUrl) return false;

      let runForWindow = run;
      if (run.viewerAttachment !== "attached") {
        const attached = await client.attachAppRun(run.runId);
        runForWindow =
          attached.run ??
          ({
            ...run,
            viewerAttachment: "attached",
          } satisfies AppRunSummary);
        mergeRun(runForWindow);
      }

      const created = await invokeDesktopBridgeRequest<{ id: string }>({
        rpcMethod: "gameOpenWindow",
        ipcChannel: "game:openWindow",
        params: {
          url: viewerUrl,
          title: runForWindow.displayName,
          alwaysOnTop: appWindowAlwaysOnTop,
        },
      });

      if (!created?.id) return false;

      setAppWindows((current) => [
        {
          id: created.id,
          kind: "game",
          runId: runForWindow.runId,
          appName: runForWindow.appName,
          displayName: runForWindow.displayName,
          alwaysOnTop: appWindowAlwaysOnTop,
        },
        ...current.filter((item) => item.id !== created.id),
      ]);
      setState("activeGameRunId", runForWindow.runId);
      setState("tab", "apps");
      setState("appsSubTab", "browse");
      pushAppsUrl(getAppSlug(runForWindow.appName));
      void client.heartbeatAppRun(runForWindow.runId).catch(() => {});
      setActionNotice(
        t("appsview.OpenedInDesktopWindow", {
          defaultValue: `${runForWindow.displayName} opened in a desktop window.`,
          name: runForWindow.displayName,
        }),
        "success",
        2600,
      );
      return true;
    },
    [appWindowAlwaysOnTop, mergeRun, pushAppsUrl, setActionNotice, setState, t],
  );

  const handleLaunch = useCallback(
    async (app: RegistryAppInfo) => {
      slugAutoLaunchDone.current = true;
      const openedRouteWindow = await openAppRouteWindow(app).catch(
        () => false,
      );
      if (openedRouteWindow) return;

      const internalToolTab = getInternalToolAppTargetTab(app.name);
      if (internalToolTab) {
        pushRecentApp(app.name);
        setTab(internalToolTab);
        return;
      }

      // Overlay apps (e.g. companion) are local-only — launch without server round-trip
      if (isOverlayApp(app.name)) {
        pushRecentApp(app.name);
        setState("activeOverlayApp", app.name);
        pushAppsUrl(getAppSlug(app.name));
        return;
      }
      try {
        const result = await client.launchApp(app.name);
        const primaryLaunchDiagnostic =
          result.diagnostics?.find(
            (diagnostic) => diagnostic.severity === "error",
          ) ?? result.diagnostics?.[0];
        const launchedRun = result.run ? mergeRun(result.run) : null;
        const primaryRun =
          launchedRun?.find((run) => run.appName === app.name) ?? result.run;

        if (primaryRun) pushRecentApp(app.name);

        if (primaryRun?.viewer?.url) {
          const openedInDesktopWindow = await openRunInDesktopWindow(
            primaryRun,
          ).catch(() => false);
          if (openedInDesktopWindow) {
            if (primaryLaunchDiagnostic?.severity === "error") {
              setActionNotice(primaryLaunchDiagnostic.message, "error", 6500);
            }
            return;
          }

          setState("activeGameRunId", primaryRun.runId);
          if (
            primaryRun.viewer.postMessageAuth &&
            !primaryRun.viewer.authMessage
          ) {
            setActionNotice(
              t("appsview.IframeAuthMissing", {
                name: app.displayName ?? app.name,
              }),
              "error",
              4800,
            );
          }
          if (primaryLaunchDiagnostic) {
            setActionNotice(
              primaryLaunchDiagnostic.message,
              primaryLaunchDiagnostic.severity === "error" ? "error" : "info",
              6500,
            );
          }
          setState("tab", "apps");
          setState("appsSubTab", "games");
          pushAppsUrl(getAppSlug(app.name));
          return;
        }

        if (primaryRun) {
          setState("appsSubTab", "browse");
          pushAppsUrl(getAppSlug(app.name));
        }

        if (primaryLaunchDiagnostic) {
          setActionNotice(
            primaryLaunchDiagnostic.message,
            primaryLaunchDiagnostic.severity === "error" ? "error" : "info",
            6500,
          );
        }
        const targetUrl = result.launchUrl ?? app.launchUrl;
        if (targetUrl) {
          try {
            await openExternalUrl(targetUrl);
            setActionNotice(
              t("appsview.OpenedInNewTab", {
                name: app.displayName ?? app.name,
              }),
              "success",
              2600,
            );
          } catch {
            setActionNotice(
              t("appsview.PopupBlockedOpen", {
                name: app.displayName ?? app.name,
              }),
              "error",
              4200,
            );
          }
          return;
        }
        setActionNotice(
          t("appsview.LaunchedNoViewer", {
            name: app.displayName ?? app.name,
          }),
          "error",
          4000,
        );
      } catch (err) {
        setActionNotice(
          t("appsview.LaunchFailed", {
            name: app.displayName ?? app.name,
            message: err instanceof Error ? err.message : t("common.error"),
          }),
          "error",
          4000,
        );
      }
    },
    [
      mergeRun,
      openAppRouteWindow,
      openRunInDesktopWindow,
      pushAppsUrl,
      pushRecentApp,
      setActionNotice,
      setState,
      setTab,
      t,
    ],
  );

  // Auto-launch from URL slug on first load (e.g. /apps/babylon after refresh)
  useEffect(() => {
    if (slugAutoLaunchDone.current || apps.length === 0) return;

    const slug = getAppSlugFromPath(getCurrentAppsPath());
    slugAutoLaunchDone.current = true;
    if (!slug) return;

    const app = findAppBySlug(apps, slug);
    if (!app) return;

    // Restored game runs should not block direct overlay-app routes like
    // /apps/companion, which are expected to take over immediately.
    if (activeGameRunId && !isOverlayApp(app.name)) return;

    void handleLaunch(app);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-time on first apps load
  }, [apps, handleLaunch, activeGameRunId]);

  const handleOpenCurrentGame = useCallback(() => {
    if (!hasActiveRun || !activeGameRun) return;
    setState("tab", "apps");
    setState("appsSubTab", "games");
    pushAppsUrl(getAppSlug(activeGameRun.appName));
  }, [activeGameRun, hasActiveRun, pushAppsUrl, setState]);

  const handleOpenRun = useCallback(
    async (run: AppRunSummary) => {
      if (!run.viewer?.url) {
        if (run.launchUrl) {
          try {
            await openExternalUrl(run.launchUrl);
            setActionNotice(
              t("appsview.OpenedInNewTab", {
                name: run.displayName,
              }),
              "success",
              2600,
            );
          } catch {
            setActionNotice(
              t("appsview.PopupBlockedOpen", {
                name: run.displayName,
              }),
              "error",
              4200,
            );
          }
          return;
        }

        setActionNotice(
          t("appsview.LaunchedNoViewer", {
            name: run.displayName,
          }),
          "info",
          3200,
        );
        return;
      }

      setBusyRunId(run.runId);
      try {
        const openedInDesktopWindow = await openRunInDesktopWindow(run).catch(
          () => false,
        );
        if (openedInDesktopWindow) {
          pushRecentApp(run.appName);
          return;
        }

        const result =
          run.viewerAttachment === "attached"
            ? {
                success: true,
                message: `${run.displayName} attached.`,
                run,
              }
            : await client.attachAppRun(run.runId);
        const nextRun =
          result.run ??
          ({
            ...run,
            viewerAttachment: "attached",
          } satisfies AppRunSummary);
        mergeRun(nextRun);
        pushRecentApp(nextRun.appName);
        setState("activeGameRunId", nextRun.runId);
        setState("tab", "apps");
        setState("appsSubTab", "games");
        pushAppsUrl(getAppSlug(nextRun.appName));
        if (nextRun.viewer?.postMessageAuth && !nextRun.viewer.authMessage) {
          setActionNotice(
            t("appsview.IframeAuthMissing", {
              name: nextRun.displayName,
            }),
            "error",
            4800,
          );
        } else if (result.message) {
          setActionNotice(result.message, "success", 2200);
        }
      } catch (err) {
        setActionNotice(
          t("appsview.LaunchFailed", {
            name: run.displayName,
            message: err instanceof Error ? err.message : t("common.error"),
          }),
          "error",
          4000,
        );
      } finally {
        setBusyRunId(null);
      }
    },
    [
      mergeRun,
      openRunInDesktopWindow,
      pushAppsUrl,
      pushRecentApp,
      setActionNotice,
      setState,
      t,
    ],
  );

  const visibleApps = useMemo(() => {
    return filterAppsForCatalog(apps, {
      activeAppNames,
      searchQuery,
    });
  }, [activeAppNames, apps, searchQuery]);

  const browseApps = useMemo(() => {
    return filterAppsForCatalog(apps);
  }, [apps]);

  const handleToggleFavorite = useCallback(
    (appName: string) => {
      const current = favoriteApps;
      const next = current.includes(appName)
        ? current.filter((name) => name !== appName)
        : [...current, appName];
      setState("favoriteApps", next);
    },
    [favoriteApps, setState],
  );

  const handleStopRun = useCallback(
    async (run: AppRunSummary) => {
      if (stoppingRunId === run.runId) return;
      setStoppingRunId(run.runId);
      try {
        await client.stopAppRun(run.runId);
        // Remove the run from local state so the UI updates immediately.
        const nextRuns = appRuns.filter((r) => r.runId !== run.runId);
        setState("appRuns", nextRuns);
        if (activeGameRunId === run.runId) {
          setState("activeGameRunId", "");
        }
        setActionNotice(
          t("appsview.Stopped", {
            defaultValue: `${run.displayName} stopped.`,
          }),
          "success",
          2600,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setActionNotice(
          t("appsview.StopFailed", {
            defaultValue: `Could not stop ${run.displayName}: ${message}`,
          }),
          "error",
          4000,
        );
      } finally {
        setStoppingRunId(null);
      }
    },
    [activeGameRunId, appRuns, setActionNotice, setState, stoppingRunId, t],
  );

  const handleToggleAppWindowAlwaysOnTop = useCallback(
    async (windowRecord: AppWindowRecord) => {
      if (busyAppWindowId === windowRecord.id) return;
      const next = !windowRecord.alwaysOnTop;
      setBusyAppWindowId(windowRecord.id);
      try {
        if (windowRecord.kind === "managed") {
          const result = await invokeDesktopBridgeRequest<{ success: boolean }>(
            {
              rpcMethod: "desktopSetManagedWindowAlwaysOnTop",
              ipcChannel: "desktop:setManagedWindowAlwaysOnTop",
              params: { id: windowRecord.id, flag: next },
            },
          );
          if (!result?.success) {
            throw new Error("Window is no longer open.");
          }
        } else {
          await invokeDesktopBridgeRequest<void>({
            rpcMethod: "canvasSetAlwaysOnTop",
            ipcChannel: "canvas:setAlwaysOnTop",
            params: { id: windowRecord.id, flag: next },
          });
        }
        setAppWindows((current) =>
          current.map((item) =>
            item.id === windowRecord.id
              ? {
                  ...item,
                  alwaysOnTop: next,
                }
              : item,
          ),
        );
        setActionNotice(
          next
            ? t("appsview.AppWindowPinned", {
                defaultValue: `${windowRecord.displayName} will stay on top.`,
                name: windowRecord.displayName,
              })
            : t("appsview.AppWindowNormal", {
                defaultValue: `${windowRecord.displayName} is a normal window.`,
                name: windowRecord.displayName,
              }),
          "success",
          2200,
        );
      } catch (err) {
        setActionNotice(
          t("appsview.AppWindowPinFailed", {
            defaultValue: `Could not update ${windowRecord.displayName}: ${
              err instanceof Error ? err.message : t("common.error")
            }`,
            name: windowRecord.displayName,
            message: err instanceof Error ? err.message : t("common.error"),
          }),
          "error",
          3600,
        );
      } finally {
        setBusyAppWindowId(null);
      }
    },
    [busyAppWindowId, setActionNotice, t],
  );

  const appsSidebar = (
    <AppsSidebar
      apps={apps}
      browseApps={browseApps}
      runs={sortedRuns}
      activeAppNames={activeAppNames}
      favoriteAppNames={favoriteAppNames}
      selectedAppName={activeGameRun?.appName ?? null}
      collapsed={sidebarCollapsed}
      onCollapsedChange={handleSidebarCollapsedChange}
      width={sidebarWidth}
      onWidthChange={handleSidebarWidthChange}
      minWidth={APPS_SIDEBAR_MIN_WIDTH}
      maxWidth={APPS_SIDEBAR_MAX_WIDTH}
      onLaunchApp={(app) => void handleLaunch(app)}
      onOpenRun={(run) => void handleOpenRun(run)}
    />
  );

  return (
    <PageLayout
      className="h-full bg-transparent"
      data-testid="apps-shell"
      sidebar={appsSidebar}
      contentInnerClassName="w-full"
      contentClassName="![scrollbar-width:none] [&::-webkit-scrollbar]:!hidden"
    >
      <div className="device-layout mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-4 lg:px-6">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/35 pb-3">
          <div className="min-w-0">
            <h2 className="text-xs-tight font-semibold uppercase tracking-[0.18em] text-accent">
              App Windows
            </h2>
          </div>
          <label className="inline-flex cursor-pointer items-center gap-2 rounded-full border border-border/60 bg-card/60 px-3 py-1.5 text-xs font-medium text-muted transition-colors hover:text-foreground">
            <input
              type="checkbox"
              className="h-3.5 w-3.5 accent-accent"
              checked={appWindowAlwaysOnTop}
              onChange={(event) =>
                handleAppWindowAlwaysOnTopChange(event.currentTarget.checked)
              }
            />
            <Pin className="h-3.5 w-3.5" aria-hidden="true" />
            <span>Keep new windows on top</span>
          </label>
        </div>

        {appWindows.length > 0 ? (
          <section
            data-testid="app-window-controls"
            className="flex flex-wrap items-center gap-2"
          >
            {appWindows.map((windowRecord) => {
              const busy = busyAppWindowId === windowRecord.id;
              return (
                <div
                  key={windowRecord.id}
                  className="inline-flex min-w-0 items-center gap-2 rounded-full border border-border/55 bg-card/70 px-3 py-1.5 text-xs text-muted"
                >
                  <span className="max-w-44 truncate font-medium text-foreground">
                    {windowRecord.displayName}
                  </span>
                  <button
                    type="button"
                    className="inline-flex items-center gap-1.5 rounded-full border border-border/60 px-2 py-1 text-[0.68rem] font-semibold uppercase tracking-[0.16em] text-muted transition-colors hover:border-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
                    onClick={() =>
                      void handleToggleAppWindowAlwaysOnTop(windowRecord)
                    }
                    disabled={busy}
                    aria-label={
                      windowRecord.alwaysOnTop
                        ? `Let ${windowRecord.displayName} act like a normal window`
                        : `Keep ${windowRecord.displayName} on top`
                    }
                  >
                    {windowRecord.alwaysOnTop ? (
                      <PinOff className="h-3.5 w-3.5" aria-hidden="true" />
                    ) : (
                      <Pin className="h-3.5 w-3.5" aria-hidden="true" />
                    )}
                    {windowRecord.alwaysOnTop ? "Normal" : "On top"}
                  </button>
                </div>
              );
            })}
          </section>
        ) : null}

        {hasActiveRun ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <button
              type="button"
              className="rounded-full border border-ok/35 bg-ok/10 px-3 py-1.5 text-xs-tight font-medium text-ok transition-colors hover:bg-ok/15"
              onClick={handleOpenCurrentGame}
            >
              {hasCurrentGame ? "Live viewer" : "Active run"}
            </button>
          </div>
        ) : null}

        <RunningAppsRow
          runs={sortedRuns}
          catalogApps={apps}
          busyRunId={busyRunId}
          onOpenRun={(run) => void handleOpenRun(run)}
          onStopRun={(run) => void handleStopRun(run)}
          stoppingRunId={stoppingRunId}
        />

        <AppsCatalogGrid
          activeAppNames={activeAppNames}
          error={error}
          favoriteAppNames={favoriteAppNames}
          loading={loading}
          searchQuery={searchQuery}
          visibleApps={visibleApps}
          onLaunch={(app) => void handleLaunch(app)}
          onToggleFavorite={handleToggleFavorite}
        />
      </div>
    </PageLayout>
  );
}
