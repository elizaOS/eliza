import { type EnabledViewKinds, isViewVisible } from "@elizaos/core";
import * as React from "react";
import {
  type DynamicViewManifest,
  getElectrobunRendererRpc,
  registerDynamicView,
  unregisterDynamicView,
} from "../../bridge/electrobun-rpc";
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
import { useIsDeveloperMode } from "../../state/useDeveloperMode";
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
  "background",
]);

const HIDDEN_SPRINGBOARD_PATHS = new Set([
  "/chat",
  "/views",
  "/apps",
  "/background",
]);

const SPRINGBOARD_SYSTEM_ENTRY_IDS = new Set([
  "phone",
  "messages",
  "contacts",
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

function compareSpringboardEntries(left: ViewEntry, right: ViewEntry): number {
  const leftOrder = left.order ?? (left.kind === "view" ? 500 : 1000);
  const rightOrder = right.order ?? (right.kind === "view" ? 500 : 1000);
  if (leftOrder !== rightOrder) return leftOrder - rightOrder;
  return compareEntryLabels(left, right);
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

interface DynamicViewFormState {
  id: string;
  title: string;
  entrypoint: string;
  description: string;
}

const EMPTY_DYNAMIC_VIEW_FORM: DynamicViewFormState = {
  id: "",
  title: "",
  entrypoint: "",
  description: "",
};

function dynamicViewBridgeAvailable(): boolean {
  const request = getElectrobunRendererRpc()?.request;
  return (
    typeof request?.dynamicViewRegister === "function" &&
    typeof request?.dynamicViewUnregister === "function"
  );
}

function editableEntrypointFor(entry: ViewEntry): string {
  return (
    entry.view?.bundleUrl ??
    entry.view?.path ??
    entry.path ??
    `/apps/${entry.id}`
  );
}

export interface SpringboardSurfaceProps {
  onNavigateHomeFromEdge?: () => void;
}

export const SpringboardSurface = React.memo(function SpringboardSurface({
  onNavigateHomeFromEdge,
}: SpringboardSurfaceProps): React.JSX.Element {
  const { views, loading, refresh: refreshViews } = useRoutableViews();
  const {
    entries: catalogEntries,
    get: getCatalogEntry,
    refresh: refreshCatalog,
  } = useViewCatalog();
  const enabledKinds = useEnabledViewKinds();
  const developerMode = useIsDeveloperMode();
  const activeModality = React.useMemo(() => getActiveViewModality(), []);
  const [dynamicViewForm, setDynamicViewForm] =
    React.useState<DynamicViewFormState>(EMPTY_DYNAMIC_VIEW_FORM);
  const [dynamicViewStatus, setDynamicViewStatus] = React.useState<
    string | null
  >(null);
  // Page index + edit mode come from the single shell-surface store, so the
  // springboard, the rail, and its one indicator can never disagree (and edit
  // mode is auto-reset by the store when the user leaves the springboard).
  const { springboardPage, springboardEditing } = useShellSurface();
  const showDynamicViewControls = developerMode && dynamicViewBridgeAvailable();

  const loadedEntries = React.useMemo(
    () =>
      views
        .filter((view) =>
          isVisibleSpringboardView(view, enabledKinds, activeModality),
        )
        .map(viewToEntry)
        .sort(compareSpringboardEntries),
    [activeModality, enabledKinds, views],
  );

  const availableEntries = React.useMemo(
    () =>
      catalogEntries
        .filter((entry) => entry.state !== "loaded")
        .filter((entry) => entry.modality === activeModality)
        .sort(compareSpringboardEntries),
    [activeModality, catalogEntries],
  );

  const entries = React.useMemo(
    () =>
      dedupeEntries([...loadedEntries, ...availableEntries]).sort(
        compareSpringboardEntries,
      ),
    [availableEntries, loadedEntries],
  );

  const entryById = React.useMemo(
    () => new Map(entries.map((entry) => [entry.id, entry])),
    [entries],
  );

  const refreshDynamicViews = React.useCallback(() => {
    refreshViews();
    refreshCatalog();
  }, [refreshCatalog, refreshViews]);

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

  const canManageView = React.useCallback(
    (id: string) => {
      if (!showDynamicViewControls) return false;
      const entry = entryById.get(id);
      return (
        entry?.state === "loaded" && entry.kind === "view" && !entry.builtin
      );
    },
    [entryById, showDynamicViewControls],
  );

  const updateDynamicField = React.useCallback(
    (field: keyof DynamicViewFormState, value: string) => {
      setDynamicViewForm((current) => ({ ...current, [field]: value }));
    },
    [],
  );

  const handleEditDynamicView = React.useCallback(
    (id: string) => {
      const entry = entryById.get(id);
      if (!entry) return;
      setDynamicViewForm({
        id: entry.id,
        title: entry.label,
        entrypoint: editableEntrypointFor(entry),
        description: entry.description ?? "",
      });
      setDynamicViewStatus(null);
    },
    [entryById],
  );

  const handleSaveDynamicView = React.useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const id = dynamicViewForm.id.trim();
      const title = dynamicViewForm.title.trim();
      const entrypoint = dynamicViewForm.entrypoint.trim();
      const description = dynamicViewForm.description.trim();
      if (!id || !title || !entrypoint) {
        setDynamicViewStatus(
          "Dynamic view ID, title, and entrypoint are required.",
        );
        return;
      }

      const manifest: DynamicViewManifest = {
        id,
        title,
        source: "developer",
        entrypoint,
        placement: "canvas",
      };
      if (description) manifest.description = description;

      try {
        const saved = await registerDynamicView(manifest, { update: true });
        if (!saved) {
          setDynamicViewStatus("Dynamic view bridge is unavailable.");
          return;
        }
        setDynamicViewStatus(`Saved ${saved.title}.`);
        refreshDynamicViews();
      } catch (error) {
        setDynamicViewStatus(
          error instanceof Error ? error.message : String(error),
        );
      }
    },
    [dynamicViewForm, refreshDynamicViews],
  );

  const handleDeleteDynamicView = React.useCallback(
    async (id: string) => {
      const entry = entryById.get(id);
      if (!entry) return;
      try {
        const result = await unregisterDynamicView(id);
        if (!result) {
          setDynamicViewStatus("Dynamic view bridge is unavailable.");
          return;
        }
        if (!result.removed) {
          setDynamicViewStatus(`${entry.label} was not registered.`);
          return;
        }
        setDynamicViewStatus(`Deleted ${entry.label}.`);
        setDynamicViewForm((current) =>
          current.id === id ? { ...EMPTY_DYNAMIC_VIEW_FORM } : current,
        );
        refreshDynamicViews();
      } catch (error) {
        setDynamicViewStatus(
          error instanceof Error ? error.message : String(error),
        );
      }
    },
    [entryById, refreshDynamicViews],
  );

  return (
    <div className="absolute inset-0 flex min-h-0 flex-col px-0 pb-[calc(var(--eliza-mobile-nav-offset,0px)+var(--safe-area-bottom,0px)+var(--eliza-continuous-chat-clearance,5.25rem)+1.75rem)]">
      {showDynamicViewControls ? (
        <form
          aria-label="Dynamic view management"
          onSubmit={handleSaveDynamicView}
          className="mx-3 mb-2 grid flex-none gap-2 rounded-lg border border-white/10 bg-black/55 p-3 text-white sm:mx-4"
        >
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="grid gap-1 text-xs font-medium">
              Dynamic view ID
              <input
                className="h-9 rounded-md border border-white/15 bg-black/40 px-2 text-sm text-white outline-none"
                value={dynamicViewForm.id}
                onChange={(event) =>
                  updateDynamicField("id", event.currentTarget.value)
                }
              />
            </label>
            <label className="grid gap-1 text-xs font-medium">
              Dynamic view title
              <input
                className="h-9 rounded-md border border-white/15 bg-black/40 px-2 text-sm text-white outline-none"
                value={dynamicViewForm.title}
                onChange={(event) =>
                  updateDynamicField("title", event.currentTarget.value)
                }
              />
            </label>
            <label className="grid gap-1 text-xs font-medium">
              Dynamic view entrypoint
              <input
                className="h-9 rounded-md border border-white/15 bg-black/40 px-2 text-sm text-white outline-none"
                value={dynamicViewForm.entrypoint}
                onChange={(event) =>
                  updateDynamicField("entrypoint", event.currentTarget.value)
                }
              />
            </label>
            <label className="grid gap-1 text-xs font-medium">
              Dynamic view description
              <input
                className="h-9 rounded-md border border-white/15 bg-black/40 px-2 text-sm text-white outline-none"
                value={dynamicViewForm.description}
                onChange={(event) =>
                  updateDynamicField("description", event.currentTarget.value)
                }
              />
            </label>
          </div>
          <div className="flex min-h-9 flex-wrap items-center gap-2">
            <button
              type="submit"
              className="h-8 rounded-md bg-accent px-3 text-sm font-semibold text-white hover:bg-accent/85"
            >
              Save
            </button>
            <button
              type="button"
              className="h-8 rounded-md border border-white/15 px-3 text-sm font-semibold text-white hover:bg-white/10"
              onClick={() => {
                setDynamicViewForm({ ...EMPTY_DYNAMIC_VIEW_FORM });
                setDynamicViewStatus(null);
              }}
            >
              Clear
            </button>
            {dynamicViewStatus ? (
              <p role="status" className="text-sm text-white/80">
                {dynamicViewStatus}
              </p>
            ) : null}
          </div>
        </form>
      ) : null}
      <Springboard
        entries={entries}
        loading={loading}
        onLaunch={(entry) => handleLaunch(entryById.get(entry.id) ?? entry)}
        onEdgeSwipeRight={onNavigateHomeFromEdge}
        canManageView={showDynamicViewControls ? canManageView : undefined}
        onEditView={showDynamicViewControls ? handleEditDynamicView : undefined}
        onDeleteView={
          showDynamicViewControls ? handleDeleteDynamicView : undefined
        }
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
