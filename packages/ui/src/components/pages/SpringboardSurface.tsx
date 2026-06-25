import { type EnabledViewKinds, isViewVisible } from "@elizaos/core";
import * as React from "react";
import type { ViewRegistryEntry } from "../../hooks/useAvailableViews";
import { useRoutableViews } from "../../hooks/useAvailableViews";
import { useViewCatalog } from "../../hooks/useViewCatalog";
import { type ViewEntry, viewToEntry } from "../../hooks/view-catalog";
import {
  getActiveViewModality,
  type ViewModality,
} from "../../platform/platform-guards";
import {
  setSpringboardEditing,
  setSpringboardPage,
  setSpringboardPageCount,
  useShellSurface,
} from "../../state/shell-surface-store";
import { useEnabledViewKinds } from "../../state/useViewKinds";
import { recordRecentViewId } from "../../view-recents";
import { Springboard } from "./Springboard";

const HIDDEN_SPRINGBOARD_VIEW_IDS = new Set([
  "chat",
  "views",
  "apps",
  "views-manager",
  "character",
  "character-select",
  "voice",
]);

const HIDDEN_SPRINGBOARD_PATHS = new Set(["/chat", "/views", "/apps"]);

const SPRINGBOARD_SYSTEM_ENTRY_IDS = new Set([
  "settings",
  "tasks",
  "automations",
  "triggers",
  "browser",
  "inventory",
  "documents",
  "files",
  "plugins",
  "skills",
  "trajectories",
  "transcripts",
  "relationships",
  "memories",
  "runtime",
  "database",
  "logs",
  "background",
  "stream",
  "desktop",
]);

function isVisibleSpringboardView(
  view: ViewRegistryEntry,
  enabledKinds: EnabledViewKinds,
  activeModality: ViewModality,
): boolean {
  if (HIDDEN_SPRINGBOARD_VIEW_IDS.has(view.id)) return false;
  if (view.path && HIDDEN_SPRINGBOARD_PATHS.has(view.path)) return false;
  if ((view.viewType ?? "gui") !== activeModality) return false;
  if (!isViewVisible(view, enabledKinds)) return false;
  if (
    view.visibleInManager === false &&
    !SPRINGBOARD_SYSTEM_ENTRY_IDS.has(view.id)
  ) {
    return false;
  }
  return true;
}

function compareEntryLabels(left: { label: string }, right: { label: string }) {
  return left.label.localeCompare(right.label, undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

function dedupeEntries(entries: ViewEntry[]): ViewEntry[] {
  const seen = new Set<string>();
  const out: ViewEntry[] = [];
  for (const entry of entries) {
    const key = `${entry.modality}:${entry.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out;
}

export interface SpringboardSurfaceProps {
  onNavigateHomeFromEdge?: () => void;
}

export const SpringboardSurface = React.memo(function SpringboardSurface({
  onNavigateHomeFromEdge,
}: SpringboardSurfaceProps): React.JSX.Element {
  const { views, loading } = useRoutableViews();
  const { entries: catalogEntries, get: getCatalogEntry } = useViewCatalog();
  const enabledKinds = useEnabledViewKinds();
  const activeModality = React.useMemo(() => getActiveViewModality(), []);
  // Page index + edit mode come from the single shell-surface store, so the
  // springboard, the rail, and its one indicator can never disagree (and edit
  // mode is auto-reset by the store when the user leaves the springboard).
  const { springboardPage, springboardEditing } = useShellSurface();

  const loadedEntries = React.useMemo(
    () =>
      views
        .filter((view) =>
          isVisibleSpringboardView(view, enabledKinds, activeModality),
        )
        .map(viewToEntry),
    [activeModality, enabledKinds, views],
  );

  const availableEntries = React.useMemo(
    () =>
      catalogEntries
        .filter((entry) => entry.state !== "loaded")
        .filter((entry) => entry.modality === activeModality)
        .sort(compareEntryLabels),
    [activeModality, catalogEntries],
  );

  const entries = React.useMemo(
    () => dedupeEntries([...loadedEntries, ...availableEntries]),
    [availableEntries, loadedEntries],
  );

  const entryById = React.useMemo(
    () => new Map(entries.map((entry) => [entry.id, entry])),
    [entries],
  );

  const handleLaunch = React.useCallback(
    (entry: ViewEntry) => {
      if (entry.state !== "loaded") {
        void getCatalogEntry(entry).catch(() => {
          /* useViewCatalog marks the entry as errored; keep launch best-effort */
        });
        return;
      }
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
    },
    [getCatalogEntry],
  );

  return (
    <div className="absolute inset-0 flex min-h-0 flex-col px-0 pt-2 pb-[calc(var(--eliza-mobile-nav-offset,0px)+var(--safe-area-bottom,0px)+var(--eliza-continuous-chat-clearance,5.25rem)+1.75rem)]">
      <Springboard
        entries={entries}
        loading={loading}
        onLaunch={(entry) => handleLaunch(entryById.get(entry.id) ?? entry)}
        onEdgeSwipeRight={onNavigateHomeFromEdge}
        page={springboardPage}
        onPageChange={setSpringboardPage}
        onPageCountChange={setSpringboardPageCount}
        editing={springboardEditing}
        onEditingChange={setSpringboardEditing}
        showPageDots={false}
      />
    </div>
  );
});
