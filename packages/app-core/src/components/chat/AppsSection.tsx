/**
 * Apps widget section — shown at the top of the chat widget sidebar.
 *
 * Renders running apps first (with a health-state ring), then favorited apps
 * that are not currently running. Clicking an app launches / focuses it.
 */

import { LayoutGrid } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { type AppRunSummary, client, type RegistryAppInfo } from "../../api";
import { useApp } from "../../state";
import { AppIdentityTile } from "../apps/app-identity";
import { loadMergedCatalogApps } from "../apps/catalog-loader";
import { getAppShortName } from "../apps/helpers";
import { getInternalToolAppTargetTab } from "../apps/internal-tool-apps";
import { isOverlayApp } from "../apps/overlay-app-registry";
import { WidgetSection } from "./widgets/shared";

// ---------------------------------------------------------------------------
// Ring classes derived from AppRunSummary.health.state
// ---------------------------------------------------------------------------

function getRunRingClass(run: AppRunSummary): string {
  const state = run.health?.state;
  if (state === "healthy") return "ring-2 ring-ok/60";
  if (state === "degraded") return "ring-2 ring-warn/60";
  return "ring-2 ring-danger/60";
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface AppsSectionProps {
  /** Optional action node rendered at the top-right of the section header. */
  headerAction?: ReactNode;
}

export function AppsSection({ headerAction }: AppsSectionProps = {}) {
  const {
    favoriteApps: favoriteAppsValue,
    appRuns,
    setTab,
    setState,
    setActionNotice,
    t,
  } = useApp();

  const favoriteApps = Array.isArray(favoriteAppsValue)
    ? favoriteAppsValue
    : [];

  const [catalogApps, setCatalogApps] = useState<RegistryAppInfo[]>([]);

  // Fetch the full catalog once for sidebar launch targets.
  useEffect(() => {
    let cancelled = false;
    void loadMergedCatalogApps()
      .then((apps) => {
        if (!cancelled) {
          setCatalogApps(apps);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  // -------------------------------------------------------------------------
  // Derive the ordered button list:
  //   1. Running apps (by appName), in their natural order
  //   2. Favorited apps not already in the running set
  // -------------------------------------------------------------------------

  const { orderedApps, runByName } = useMemo(() => {
    const catalogByName = new Map(catalogApps.map((a) => [a.name, a]));
    const runMap = new Map<string, AppRunSummary>();
    for (const run of appRuns) {
      runMap.set(run.appName, run);
    }

    // Running apps (deduplicated by appName, stable order)
    const runningAppNames = [...new Set(appRuns.map((r) => r.appName))];
    const runningItems = runningAppNames
      .map((name) => catalogByName.get(name))
      .filter((app): app is RegistryAppInfo => app !== undefined);

    // Favorite apps not already running
    const runningSet = new Set(runningAppNames);
    const favOnlyItems = catalogApps.filter(
      (app) => favoriteApps.includes(app.name) && !runningSet.has(app.name),
    );

    return {
      orderedApps: [...runningItems, ...favOnlyItems],
      runByName: runMap,
    };
  }, [catalogApps, appRuns, favoriteApps]);

  // -------------------------------------------------------------------------
  // Launch handler (identical logic to FavoriteAppsBar)
  // -------------------------------------------------------------------------

  const handleLaunch = useCallback(
    async (app: RegistryAppInfo) => {
      const internalToolTab = getInternalToolAppTargetTab(app.name);
      if (internalToolTab) {
        setTab(internalToolTab);
        return;
      }
      if (isOverlayApp(app.name)) {
        setState("activeOverlayApp", app.name);
        return;
      }
      try {
        const result = await client.launchApp(app.name);
        const primaryRun = result.run;
        if (primaryRun?.viewer?.url) {
          setState("activeGameRunId", primaryRun.runId);
          setTab("apps");
          setState("appsSubTab", "games");
          return;
        }
        if (primaryRun) {
          setTab("apps");
          setState("appsSubTab", "running");
        }
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
    [setActionNotice, setState, setTab, t],
  );

  // Hide the section entirely when there is nothing to show AND no header
  // action to render (i.e. no collapse-affordance owner).
  if (orderedApps.length === 0 && !headerAction) return null;

  return (
    <WidgetSection
      title={t("chatsidebar.Apps", { defaultValue: "Apps" })}
      icon={<LayoutGrid className="h-4 w-4" />}
      action={headerAction}
      testId="chat-widget-apps-section"
    >
      {orderedApps.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2">
          {orderedApps.map((app) => {
            const run = runByName.get(app.name);
            const displayName = app.displayName ?? getAppShortName(app);
            const ringClass = run ? getRunRingClass(run) : "";
            return (
              <button
                key={app.name}
                type="button"
                title={displayName}
                aria-label={t("chatsidebar.launchApp", {
                  defaultValue: `Launch ${displayName}`,
                  name: displayName,
                })}
                className={`rounded-2xl transition-transform hover:scale-105 ${ringClass}`}
                onClick={() => void handleLaunch(app)}
              >
                <AppIdentityTile app={app} active={Boolean(run)} size="sm" />
              </button>
            );
          })}
        </div>
      ) : null}
    </WidgetSection>
  );
}
