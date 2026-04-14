
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type AppRunSummary, client, type RegistryAppInfo } from "../../api";
import { getAppSlugFromPath } from "../../navigation";

import { useApp } from "../../state";
import { openExternalUrl } from "../../utils";
import { AppsCatalogGrid } from "../apps/AppsCatalogGrid";
import {
  filterAppsForCatalog,
  findAppBySlug,
  getAppSlug,
  shouldShowAppInAppsView,
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
import {
import { PagePanel } from "@elizaos/ui";
  getRunAttentionReasons,
  RunningAppsPanel,
} from "../apps/RunningAppsPanel";

export { shouldShowAppInAppsView } from "../apps/helpers";

export function AppsView() {
  const {
    appRuns,
    activeGameRunId,
    activeGameViewerUrl,
    appsSubTab,
    favoriteApps,
    setTab,
    setState,
    setActionNotice,
    t,
  } = useApp();
  const [apps, setApps] = useState<RegistryAppInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [showActiveOnly, setShowActiveOnly] = useState(false);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [busyRunId, setBusyRunId] = useState<string | null>(null);
  const slugAutoLaunchDone = useRef(false);

  const activeAppNames = useMemo(
    () => new Set(appRuns.map((run) => run.appName)),
    [appRuns],
  );
  const hasActiveApps = activeAppNames.size > 0;
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
  const attentionRuns = useMemo(
    () => sortedRuns.filter((run) => getRunAttentionReasons(run).length > 0),
    [sortedRuns],
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

  const removeRun = useCallback(
    (runId: string) => {
      const nextRuns = appRuns.filter((run) => run.runId !== runId);
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
      const internalToolApps = getInternalToolApps();
      // Inject registered overlay apps (e.g. companion) if not already from server
      const overlayDescriptors = getAllOverlayApps()
        .filter((oa) => !serverApps.some((a) => a.name === oa.name))
        .map(overlayAppToRegistryInfo);
      const list = [
        ...internalToolApps,
        ...overlayDescriptors,
        ...serverApps,
      ].filter(
        (app, index, items) =>
          items.findIndex((candidate) => candidate.name === app.name) === index,
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

  const refreshApps = useCallback(async () => {
    try {
      await client.refreshRegistry();
    } catch (err) {
      console.warn("[AppsView] Failed to refresh registry:", err);
    }
    await loadApps();
  }, [loadApps]);

  useEffect(() => {
    void loadApps();
  }, [loadApps]);

  // Auto-launch from URL slug on first load (e.g. /apps/babylon after refresh)
  useEffect(() => {
    if (slugAutoLaunchDone.current || apps.length === 0) return;
    slugAutoLaunchDone.current = true;

    // Skip if a game run is already restored from sessionStorage
    if (activeGameRunId) return;

    const slug = getAppSlugFromPath(
      window.location.protocol === "file:"
        ? window.location.hash.replace(/^#/, "") || "/"
        : window.location.pathname,
    );
    if (!slug) return;

    const app = findAppBySlug(apps, slug);
    if (app) {
      void handleLaunch(app);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-time on first apps load
  }, [apps]);

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
    if (sortedRuns.length === 0) {
      if (selectedRunId !== null) setSelectedRunId(null);
      return;
    }
    if (
      selectedRunId &&
      sortedRuns.some((run) => run.runId === selectedRunId)
    ) {
      return;
    }
    const preferredRunId =
      activeGameRunId && sortedRuns.some((run) => run.runId === activeGameRunId)
        ? activeGameRunId
        : (attentionRuns[0]?.runId ?? sortedRuns[0].runId);
    setSelectedRunId(preferredRunId);
  }, [activeGameRunId, attentionRuns, selectedRunId, sortedRuns]);

  useEffect(() => {
    if (appsSubTab !== "running") return;
    setState("appsSubTab", "browse");
    setShowActiveOnly(hasActiveApps);
  }, [appsSubTab, hasActiveApps, setState]);

  useEffect(() => {
    if (hasActiveApps || !showActiveOnly) return;
    setShowActiveOnly(false);
  }, [hasActiveApps, showActiveOnly]);

  const handleLaunch = useCallback(
    async (app: RegistryAppInfo) => {
      const internalToolTab = getInternalToolAppTargetTab(app.name);
      if (internalToolTab) {
        setTab(internalToolTab);
        return;
      }

      // Overlay apps (e.g. companion) are local-only — launch without server round-trip
      if (isOverlayApp(app.name)) {
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
          setSelectedRunId(primaryRun.runId);
          setState("appsSubTab", "browse");
          setShowActiveOnly(true);
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
      setActionNotice,
      setShowActiveOnly,
      setState,
      setTab,
      t,
    ],
  );

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
    [mergeRun, pushAppsUrl, setActionNotice, setState, t],
  );

  const handleDetachRun = useCallback(
    async (run: AppRunSummary) => {
      setBusyRunId(run.runId);
      try {
        const result = await client.detachAppRun(run.runId);
        const nextRun =
          result.run ??
          ({
            ...run,
            viewerAttachment: run.viewer ? "detached" : "unavailable",
          } satisfies AppRunSummary);
        mergeRun(nextRun);
        if (activeGameRunId === run.runId) {
          setState("activeGameRunId", "");
          setState("appsSubTab", "browse");
          setShowActiveOnly(true);
          pushAppsUrl();
        }
        setActionNotice(result.message, "success", 2200);
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
      activeGameRunId,
      mergeRun,
      pushAppsUrl,
      setActionNotice,
      setShowActiveOnly,
      setState,
      t,
    ],
  );

  const handleStopRun = useCallback(
    async (run: AppRunSummary) => {
      setBusyRunId(run.runId);
      try {
        const result = await client.stopAppRun(run.runId);
        const nextRuns = removeRun(run.runId);
        if (activeGameRunId === run.runId) {
          setState("activeGameRunId", "");
          setState("appsSubTab", "browse");
          setShowActiveOnly(nextRuns.length > 0);
          pushAppsUrl();
        }
        setActionNotice(
          result.message,
          result.success ? "success" : "info",
          result.needsRestart ? 5000 : 3200,
        );
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
      activeGameRunId,
      pushAppsUrl,
      removeRun,
      setActionNotice,
      setShowActiveOnly,
      setState,
      t,
    ],
  );

  const visibleApps = useMemo(() => {
    return filterAppsForCatalog(apps, {
      activeAppNames,
      searchQuery,
      showActiveOnly,
    });
  }, [activeAppNames, apps, searchQuery, showActiveOnly]);

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

  return (
    <div className="device-layout mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-4 lg:px-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-lg font-semibold tracking-[-0.01em] text-txt">
          Apps
        </h1>
        {hasActiveRun ? (
          <button
            type="button"
            className="rounded-full border border-ok/35 bg-ok/10 px-3 py-1.5 text-xs-tight font-medium text-ok transition-colors hover:bg-ok/15"
            onClick={handleOpenCurrentGame}
          >
            {hasCurrentGame ? "Live viewer" : "Active run"}
          </button>
        ) : null}
      </div>

      <AppsCatalogGrid
        activeAppNames={activeAppNames}
        error={error}
        favoriteAppNames={favoriteAppNames}
        loading={loading}
        searchQuery={searchQuery}
        showActiveOnly={showActiveOnly}
        visibleApps={visibleApps}
        onLaunch={(app) => void handleLaunch(app)}
        onRefresh={() => void refreshApps()}
        onSearchQueryChange={setSearchQuery}
        onToggleActiveOnly={() => setShowActiveOnly((current) => !current)}
        onToggleFavorite={handleToggleFavorite}
      />

      {sortedRuns.length > 0 ? (
        <PagePanel variant="inset" className="rounded-2xl p-4 lg:p-5">
          <RunningAppsPanel
            runs={sortedRuns}
            catalogApps={apps}
            selectedRunId={selectedRunId}
            busyRunId={busyRunId}
            onSelectRun={setSelectedRunId}
            onOpenRun={(run) => void handleOpenRun(run)}
            onDetachRun={(run) => void handleDetachRun(run)}
            onStopRun={(run) => void handleStopRun(run)}
          />
        </PagePanel>
      ) : null}
    </div>
  );
}
