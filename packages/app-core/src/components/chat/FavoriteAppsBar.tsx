/**
 * Favorite apps quick-launch bar — shown at the top of the chat widget sidebar.
 *
 * Renders emoji icons for each favorited app. Clicking one launches it immediately.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { client, type RegistryAppInfo } from "../../api";
import { useApp } from "../../state";
import { getAppEmoji, getAppShortName } from "../apps/helpers";
import {
  getInternalToolApps,
  getInternalToolAppTargetTab,
} from "../apps/internal-tool-apps";
import {
  getAllOverlayApps,
  isOverlayApp,
  overlayAppToRegistryInfo,
} from "../apps/overlay-app-registry";

export function FavoriteAppsBar() {
  const {
    favoriteApps: favoriteAppsValue,
    setState,
    setActionNotice,
    t,
  } = useApp();
  const favoriteApps = Array.isArray(favoriteAppsValue)
    ? favoriteAppsValue
    : [];
  const [apps, setApps] = useState<RegistryAppInfo[]>([]);

  useEffect(() => {
    if (favoriteApps.length === 0) return;

    let cancelled = false;
    void (async () => {
      try {
        const serverApps = await client.listApps();
        const internalToolApps = getInternalToolApps();
        const overlayDescriptors = getAllOverlayApps()
          .filter((oa) => !serverApps.some((a) => a.name === oa.name))
          .map(overlayAppToRegistryInfo);
        const all = [
          ...internalToolApps,
          ...overlayDescriptors,
          ...serverApps,
        ].filter(
          (app, index, items) =>
            items.findIndex((c) => c.name === app.name) === index,
        );
        if (!cancelled) setApps(all);
      } catch {
        // Silently fail — the main apps view handles errors
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [favoriteApps.length]);

  const favoriteAppList = useMemo(
    () => apps.filter((app) => favoriteApps.includes(app.name)),
    [apps, favoriteApps],
  );

  const handleLaunch = useCallback(
    async (app: RegistryAppInfo) => {
      const internalToolTab = getInternalToolAppTargetTab(app.name);
      if (internalToolTab) {
        setState("tab", internalToolTab);
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
          setState("tab", "apps");
          setState("appsSubTab", "games");
          return;
        }
        if (primaryRun) {
          setState("tab", "apps");
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
    [setState, setActionNotice, t],
  );

  if (favoriteAppList.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-2">
      {favoriteAppList.map((app) => {
        const displayName = app.displayName ?? getAppShortName(app);
        return (
          <button
            key={app.name}
            type="button"
            title={displayName}
            aria-label={`Launch ${displayName}`}
            className="flex h-9 w-9 items-center justify-center rounded-xl border border-border/35 bg-card/72 text-base transition-all hover:border-accent/30 hover:bg-bg-hover/70 hover:scale-110"
            onClick={() => void handleLaunch(app)}
          >
            {getAppEmoji(app)}
          </button>
        );
      })}
    </div>
  );
}
