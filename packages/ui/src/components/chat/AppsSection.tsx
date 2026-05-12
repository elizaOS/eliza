/**
 * Apps widget section — shown at the top of the chat widget sidebar.
 *
 * Renders running apps first (with a health-state ring), then favorited apps
 * that are not currently running. Clicking an app launches / focuses it.
 */

import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../ui/dropdown-menu";
import { LayoutGrid, MoreHorizontal } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { type AppRunSummary, client, type RegistryAppInfo } from "../../api";
import { useApp } from "../../state";
import { openExternalUrl } from "../../utils";
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

function isOverlayLaunchApp(app: RegistryAppInfo): boolean {
  return isOverlayApp(app.name) || app.launchType === "overlay";
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
  // Kebab menu actions: relaunch, edit, stop. Launch stays as the tile click.
  // -------------------------------------------------------------------------

  const handleRelaunch = useCallback(
    async (app: RegistryAppInfo) => {
      try {
        await client.fetch("/api/apps/relaunch", {
          method: "POST",
          body: JSON.stringify({ name: app.name }),
        });
        setActionNotice(
          `${app.displayName ?? app.name} relaunched.`,
          "success",
          3000,
        );
      } catch (err) {
        setActionNotice(
          err instanceof Error
            ? err.message
            : t("appsview.LaunchFailed", {
                name: app.displayName ?? app.name,
                message: t("common.error"),
              }),
          "error",
          4000,
        );
      }
    },
    [setActionNotice, t],
  );

  const handleEdit = useCallback(
    async (app: RegistryAppInfo) => {
      try {
        await client.fetch("/api/apps/create", {
          method: "POST",
          body: JSON.stringify({ intent: "edit", editTarget: app.name }),
        });
        setActionNotice(
          `Editing ${app.displayName ?? app.name}…`,
          "info",
          3500,
        );
      } catch (err) {
        setActionNotice(
          err instanceof Error
            ? err.message
            : `Couldn't start an edit for ${app.displayName ?? app.name}.`,
          "error",
          4000,
        );
      }
    },
    [setActionNotice],
  );

  const handleStop = useCallback(
    async (app: RegistryAppInfo) => {
      try {
        await client.stopApp(app.name);
        setActionNotice(
          `${app.displayName ?? app.name} stopped.`,
          "success",
          3000,
        );
      } catch (err) {
        setActionNotice(
          err instanceof Error
            ? err.message
            : `Couldn't stop ${app.displayName ?? app.name}.`,
          "error",
          4000,
        );
      }
    },
    [setActionNotice],
  );

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
      if (isOverlayLaunchApp(app)) {
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
        if (primaryRun) {
          setTab("apps");
          setState("appsSubTab", "running");
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
    [setActionNotice, setState, setTab, t],
  );

  // Hide the section entirely when there is nothing to show AND no header
  // action to render (i.e. no collapse-affordance owner).
  if (orderedApps.length === 0 && !headerAction) return null;

  return (
    <WidgetSection
      title={t("nav.apps", { defaultValue: "Apps" })}
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
            const isRunning = Boolean(run);
            return (
              <div
                key={app.name}
                className="group relative"
                data-testid={`apps-section-tile-${app.name}`}
              >
                <button
                  type="button"
                  title={displayName}
                  aria-label={t("chatsidebar.launchApp", {
                    defaultValue: `Launch ${displayName}`,
                    name: displayName,
                  })}
                  className={`rounded-2xl transition-transform hover:scale-105 ${ringClass}`}
                  onClick={() => void handleLaunch(app)}
                >
                  <AppIdentityTile
                    app={app}
                    active={isRunning}
                    size="sm"
                    imageOnly
                  />
                </button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      aria-label={`Actions for ${displayName}`}
                      data-testid={`apps-section-kebab-${app.name}`}
                      onClick={(event) => event.stopPropagation()}
                      className="absolute -right-1 -top-1 inline-flex h-5 w-5 items-center justify-center rounded-full border border-border bg-bg text-muted opacity-0 shadow-sm transition-opacity hover:text-txt focus:opacity-100 focus-visible:opacity-100 group-hover:opacity-100"
                    >
                      <MoreHorizontal className="h-3 w-3" aria-hidden />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent
                    align="end"
                    sideOffset={4}
                    className="w-36"
                    onClick={(event: React.MouseEvent) =>
                      event.stopPropagation()
                    }
                  >
                    <DropdownMenuItem
                      data-testid={`apps-section-launch-${app.name}`}
                      onSelect={() => void handleLaunch(app)}
                    >
                      {t("settings.sections.apps.launch", {
                        defaultValue: "Launch",
                      })}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      data-testid={`apps-section-relaunch-${app.name}`}
                      onSelect={() => void handleRelaunch(app)}
                    >
                      {t("settings.sections.apps.relaunch", {
                        defaultValue: "Relaunch",
                      })}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      data-testid={`apps-section-edit-${app.name}`}
                      onSelect={() => void handleEdit(app)}
                    >
                      {t("settings.sections.apps.edit", {
                        defaultValue: "Edit",
                      })}
                    </DropdownMenuItem>
                    {isRunning ? (
                      <DropdownMenuItem
                        data-testid={`apps-section-stop-${app.name}`}
                        className="text-danger focus:text-danger"
                        onSelect={() => void handleStop(app)}
                      >
                        {t("settings.sections.apps.stop", {
                          defaultValue: "Stop",
                        })}
                      </DropdownMenuItem>
                    ) : null}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            );
          })}
        </div>
      ) : null}
    </WidgetSection>
  );
}
