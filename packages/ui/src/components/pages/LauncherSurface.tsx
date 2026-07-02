import * as React from "react";
import { useRoutableViews } from "../../hooks/useAvailableViews";
import { type ViewEntry, viewToEntry } from "../../hooks/view-catalog";
import { isAospShellEnabled } from "../../navigation";
import { getActiveViewModality } from "../../platform/platform-guards";
import { useAppSelectorShallow } from "../../state";
import {
  setLauncherPage,
  setLauncherPageCount,
  useShellSurface,
} from "../../state/shell-surface-store";
import { useEnabledViewKinds } from "../../state/useViewKinds";
import { recordRecentViewId } from "../../view-recents";
import { Launcher } from "./Launcher";
import { curateLauncherPages } from "./launcher-curation";

export interface LauncherSurfaceProps {
  onNavigateHomeFromEdge?: () => void;
}

export const LauncherSurface = React.memo(function LauncherSurface({
  onNavigateHomeFromEdge,
}: LauncherSurfaceProps): React.JSX.Element {
  const { views, loading } = useRoutableViews();
  const enabledKinds = useEnabledViewKinds();
  const { elizaCloudConnected } = useAppSelectorShallow((state) => ({
    elizaCloudConnected: state.elizaCloudConnected,
  }));
  const activeModality = React.useMemo(() => getActiveViewModality(), []);
  const isAosp = React.useMemo(() => isAospShellEnabled(), []);
  // Page index comes from the single shell-surface store, so the launcher, the
  // rail, and its one indicator can never disagree.
  const { launcherPage } = useShellSurface();

  // The launcher renders the loaded views for the active modality; the curation
  // layer owns removal, dedup, AOSP-gating, and developer/preview visibility.
  const modalEntries = React.useMemo(
    () =>
      views
        .filter((view) => (view.viewType ?? "gui") === activeModality)
        .map(viewToEntry),
    [activeModality, views],
  );

  const pages = React.useMemo(
    () =>
      curateLauncherPages(modalEntries, {
        isAosp,
        enabledKinds,
        cloudActive: elizaCloudConnected,
      }),
    [modalEntries, isAosp, enabledKinds, elizaCloudConnected],
  );

  const entries = React.useMemo<ViewEntry[]>(() => pages.flat(), [pages]);
  const pageGroups = React.useMemo(
    () => pages.map((page) => page.map((entry) => entry.id)),
    [pages],
  );
  const entryById = React.useMemo(
    () => new Map(entries.map((entry) => [entry.id, entry])),
    [entries],
  );

  const handleLaunch = React.useCallback((entry: ViewEntry) => {
    const path = entry.path ?? `/apps/${entry.id}`;
    recordRecentViewId(entry.id);
    try {
      if (typeof window === "undefined") return;
      if (window.location.protocol === "file:") {
        window.location.hash = path;
      } else {
        window.history.pushState(null, "", path);
        window.dispatchEvent(new PopStateEvent("popstate"));
      }
    } catch {
      // Sandboxed navigation is best-effort.
    }
  }, []);

  return (
    <div className="absolute inset-0 flex min-h-0 flex-col px-0 pb-[calc(var(--eliza-mobile-nav-offset,0px)+max(var(--safe-area-bottom,0px),var(--android-gesture-inset-bottom,0px))+var(--eliza-continuous-chat-clearance,5.25rem)+1.75rem)]">
      <Launcher
        entries={entries}
        pageGroups={pageGroups}
        loading={loading}
        onLaunch={(entry) => handleLaunch(entryById.get(entry.id) ?? entry)}
        onEdgeSwipeRight={onNavigateHomeFromEdge}
        page={launcherPage}
        onPageChange={setLauncherPage}
        onPageCountChange={setLauncherPageCount}
        showPageDots={false}
      />
    </div>
  );
});
