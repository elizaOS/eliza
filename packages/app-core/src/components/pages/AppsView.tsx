import { PageLayout } from "@elizaos/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type AppRunSummary, client, type RegistryAppInfo } from "../../api";
import { getAppSlugFromPath } from "../../navigation";

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

export { shouldShowAppInAppsView } from "../apps/helpers";

/** Max items retained in the sidebar's Recent section. */
const RECENT_APPS_LIMIT = 10;

const APPS_SIDEBAR_WIDTH_KEY = "milady:apps:sidebar:width";
const APPS_SIDEBAR_COLLAPSED_KEY = "milady:apps:sidebar:collapsed";
const APPS_SIDEBAR_DEFAULT_WIDTH = 240;
const APPS_SIDEBAR_MIN_WIDTH = 200;
const APPS_SIDEBAR_MAX_WIDTH = 520;

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
  const slugAutoLaunchDone = useRef(false);

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
      if (window.location.protocol === "file:") {
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

  const handleLaunch = useCallback(
    async (app: RegistryAppInfo) => {
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

    const slug = getAppSlugFromPath(
      window.location.protocol === "file:"
        ? window.location.hash.replace(/^#/, "") || "/"
        : window.location.pathname,
    );
    if (!slug) return;

    const app = findAppBySlug(apps, slug);
    slugAutoLaunchDone.current = true;
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
    [mergeRun, pushAppsUrl, pushRecentApp, setActionNotice, setState, t],
  );

  const visibleApps = useMemo(() => {
    return filterAppsForCatalog(apps, {
      activeAppNames,
      searchQuery,
    });
  }, [activeAppNames, apps, searchQuery]);

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

  const appsSidebar = (
    <AppsSidebar
      apps={apps}
      runs={sortedRuns}
      activeAppNames={activeAppNames}
      favoriteAppNames={favoriteAppNames}
      recentAppNames={recentApps}
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
