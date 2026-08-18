/**
 * Data + state wrapper around `Launcher`: merges loaded views with the
 * installable app catalog, curates them into the ordered page
 * (`curateLauncherPages`), and wires tile taps to either first-install launch or
 * view navigation. `Launcher` itself is pure presentation — one flat grid, no
 * favorites, recents, or section zones.
 */
import { logger } from "@elizaos/logger";
import * as React from "react";
import { isManagedCloudRuntime } from "../../cloud/managed-cloud-runtime";
import { dispatchChatOpen } from "../../events";
import { useViewCatalog } from "../../hooks/useViewCatalog";
import type { ViewEntry } from "../../hooks/view-catalog";
import { cn } from "../../lib/utils";
import { isAospShellEnabled } from "../../navigation";
import { useAppSelectorShallow } from "../../state/app-store";
import { useEnabledViewKinds } from "../../state/useViewKinds";
import { shellHistory } from "../../surface-realm-channel";
import { openExternalUrl } from "../../utils/openExternalUrl";
import { getAppSlug } from "../apps/helpers";
import { Launcher } from "./Launcher";
import {
  canonicalLauncherId,
  curateLauncherPages,
  LAUNCHER_AOSP_ONLY_IDS,
  LAUNCHER_APPS_ORDER,
  LAUNCHER_DEVELOPER_ORDER,
} from "./launcher-curation";

export interface LauncherSurfaceProps {
  /** Full-screen route or natural-height content inside Home's app scroller. */
  layout?: "page" | "embedded";
  /**
   * Whether this surface may add installable catalog entries. The Home↔Apps
   * rail is a demo navigation surface and shows only the curated registered
   * set; the dedicated `/apps` page keeps the full catalog so users can
   * discover and launch installable apps.
   */
  catalogMode?: "all" | "demo";
}

export const LauncherSurface = React.memo(function LauncherSurface({
  layout = "page",
  catalogMode = "all",
}: LauncherSurfaceProps): React.JSX.Element {
  const { entries, get, loading } = useViewCatalog();
  const enabledKinds = useEnabledViewKinds();
  const { appRuns, runtimeTarget, setActionNotice, setState, setTab, t } =
    useAppSelectorShallow((state) => ({
      appRuns: state.appRuns,
      runtimeTarget: state.startupCoordinator.target,
      setActionNotice: state.setActionNotice,
      setState: state.setState,
      setTab: state.setTab,
      t: state.t,
    }));
  const managedCloudRuntime = isManagedCloudRuntime(runtimeTarget);
  const isAosp = React.useMemo(() => isAospShellEnabled(), []);

  const page = React.useMemo<ViewEntry[]>(
    () =>
      curateLauncherPages(
        catalogMode === "demo"
          ? entries.filter((entry) => {
              if (entry.kind !== "view") return false;
              const id = canonicalLauncherId(entry.id);
              return (
                LAUNCHER_APPS_ORDER.includes(id) ||
                LAUNCHER_DEVELOPER_ORDER.includes(id) ||
                LAUNCHER_AOSP_ONLY_IDS.includes(id)
              );
            })
          : entries,
        {
          isAosp,
          enabledKinds,
          cloudActive: managedCloudRuntime,
        },
      ),
    [catalogMode, entries, isAosp, enabledKinds, managedCloudRuntime],
  );

  const handleLaunch = React.useCallback(
    async (entry: ViewEntry) => {
      // Catalog entries have no route until their package is installed and
      // loaded. Use the launch response itself to open a viewer on this first
      // click; the app manager intentionally resolves registry metadata before
      // installation, so no manifest rehydration/restart is required.
      if (entry.kind === "app" && entry.appName && !entry.path) {
        try {
          const result = await get(entry);
          if (!result) return;
          const run = result.run;
          if (run?.viewer?.url) {
            setState("appRuns", [
              ...appRuns.filter((candidate) => candidate.runId !== run.runId),
              run,
            ]);
            setState("activeGameRunId", run.runId);
            setState("appsSubTab", "games");
            const path = `/apps/${getAppSlug(run.appName)}`;
            if (window.location.protocol === "file:") {
              window.location.hash = path;
            } else {
              shellHistory.pushState(null, "", path);
              window.dispatchEvent(new PopStateEvent("popstate"));
            }
            return;
          }
          const targetUrl = result.launchUrl ?? entry.launchUrl;
          if (targetUrl) {
            // launchUrl is a wire value — a rejected target (helper returns
            // false) surfaces the launch-failed notice instead of a false
            // "opened" success.
            if (await openExternalUrl(targetUrl)) {
              setActionNotice(
                t("appsview.OpenedInNewTab", { name: entry.label }),
                "success",
                2600,
              );
            } else {
              setActionNotice(
                t("appsview.PopupBlockedOpen", { name: entry.label }),
                "error",
                4200,
              );
            }
            return;
          }
          if (run) {
            setState("appRuns", [
              ...appRuns.filter((candidate) => candidate.runId !== run.runId),
              run,
            ]);
            setTab("apps");
            setState("appsSubTab", "running");
            return;
          }
          setActionNotice(
            t("appsview.LaunchedNoViewer", { name: entry.label }),
            "error",
            4000,
          );
        } catch (err) {
          // error-policy:J4 a failed catalog install/launch remains visible on
          // the tile and in the shell notice instead of navigating to an empty
          // app surface.
          setActionNotice(
            t("appsview.LaunchFailed", {
              name: entry.label,
              message: err instanceof Error ? err.message : t("common.error"),
            }),
            "error",
            4000,
          );
        }
        return;
      }

      const path = entry.path ?? `/apps/${entry.id}`;
      try {
        if (typeof window === "undefined") return;
        if (window.location.protocol === "file:") {
          window.location.hash = path;
        } else {
          shellHistory.pushState(null, "", path);
          window.dispatchEvent(new PopStateEvent("popstate"));
        }
        if (entry.id === "chat") {
          // The Messages tile lands on `/chat` (the ambient home). Open the chat
          // so the user arrives in a conversation, not on a collapsed pill.
          dispatchChatOpen();
        }
      } catch (err) {
        // error-policy:J4 sandboxed webviews (embeds) can reject history
        // navigation with a SecurityError; the tile tap degrades to a no-op
        // there. Logged so a launcher that silently stops navigating is
        // diagnosable.
        logger.warn({ err, path }, "[LauncherSurface] tile navigation failed");
      }
    },
    [appRuns, get, setActionNotice, setState, setTab, t],
  );

  return (
    <div
      data-testid="launcher-surface"
      data-layout={layout}
      className={cn(
        "flex flex-col px-0",
        layout === "page"
          ? "absolute inset-0 min-h-0"
          : "relative w-full flex-none",
      )}
    >
      <Launcher
        entries={page}
        loading={loading}
        onLaunch={handleLaunch}
        embedded={layout === "embedded"}
      />
    </div>
  );
});
