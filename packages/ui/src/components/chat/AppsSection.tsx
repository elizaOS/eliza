/**
 * Apps widget section — shown at the top of the chat widget sidebar.
 *
 * Renders running apps first (with a health-state ring), then favorited apps
 * that are not currently running. Clicking an app launches / focuses it.
 */

import { logger } from "@elizaos/logger";
import { LayoutGrid, MoreHorizontal } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { type AppRunSummary, client, type RegistryAppInfo } from "../../api";
import { useAppSelectorShallow } from "../../state";
import { openExternalUrl } from "../../utils";
import { AppIdentityTile } from "../apps/app-identity";
import { loadMergedCatalogApps } from "../apps/catalog-loader";
import { getAppShortName } from "../apps/helpers";
import { getInternalToolAppTargetTab } from "../apps/internal-tool-apps";
import { isOverlayApp } from "../apps/overlay-app-registry";
import { Button } from "../ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { WidgetSection } from "./widgets/shared";

function getRunRingClass(_run: AppRunSummary): string {
  return "";
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
  } = useAppSelectorShallow((s) => ({
    favoriteApps: s.favoriteApps,
    appRuns: s.appRuns,
    setTab: s.setTab,
    setState: s.setState,
    setActionNotice: s.setActionNotice,
    t: s.t,
  }));

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
      .catch((err: unknown) => {
        // error-policy:J4 a failed catalog load hides the sidebar app
        // launchers only (chat itself is unaffected) — logged so a broken
        // catalog endpoint is distinguishable from "no apps installed".
        logger.warn({ err }, "[AppsSection] app catalog load failed");
      });
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
        // error-policy:J4 failure surfaces as an action notice
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
        // error-policy:J4 failure surfaces as an action notice
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
        // error-policy:J4 failure surfaces as an action notice
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
            // error-policy:J4 popup blocked — surfaced as an action notice
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
        // error-policy:J4 failure surfaces as an action notice
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
                <Button
                  title={displayName}
                  aria-label={t("chatsidebar.launchApp", {
                    defaultValue: `Launch ${displayName}`,
                    name: displayName,
                  })}
                  variant="ghost"
                  className={`h-auto rounded-sm p-0 transition-transform hover:bg-transparent hover:scale-105 ${ringClass}`}
                  onClick={() => void handleLaunch(app)}
                >
                  <AppIdentityTile
                    app={app}
                    active={isRunning}
                    size="sm"
                    imageOnly
                  />
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      aria-label={`Actions for ${displayName}`}
                      data-testid={`apps-section-kebab-${app.name}`}
                      onClick={(event) => event.stopPropagation()}
                      variant="ghost"
                      size="icon-sm"
                      className="absolute -right-1 -top-1 h-5 w-5 rounded-full border border-border bg-bg text-muted opacity-0 transition-opacity hover:bg-bg hover:text-txt group-hover:opacity-100"
                    >
                      <MoreHorizontal className="h-3 w-3" aria-hidden />
                    </Button>
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
                        className="text-danger "
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
