/**
 * ViewManagerPage — the "Views" tab content.
 *
 * Shows a searchable grid of registered views fetched from GET /api/views.
 * While the /api/views endpoint is not yet live the page renders gracefully
 * by falling back to an empty list.
 *
 * This page is navigated to via the "Views" (formerly "Apps") bottom nav tab
 * or via the `eliza:navigate:view` custom event dispatched by VIEWS actions.
 */

import { Pencil, Pin, Plus, Search, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { fetchWithCsrf } from "../../api/csrf-client";
import {
  type DynamicViewManifest,
  registerDynamicView,
  unregisterDynamicView,
} from "../../bridge/electrobun-rpc";
import { isElectrobunRuntime } from "../../bridge/electrobun-runtime";
import {
  useAvailableViews,
  type ViewRegistryEntry,
} from "../../hooks/useAvailableViews";
import { useDesktopTabs } from "../../hooks/useDesktopTabs";
import { useIsDeveloperMode } from "../../state/useDeveloperMode";
import {
  readRecentViewIds,
  recordRecentViewId,
  TOP_VIEW_LIMIT,
} from "../../view-recents";

const VIEW_LOADING_SKELETON_KEYS = [
  "view-skeleton-1",
  "view-skeleton-2",
  "view-skeleton-3",
  "view-skeleton-4",
  "view-skeleton-5",
  "view-skeleton-6",
];

function ViewCard({
  view,
  onClick,
  onPin,
  onEdit,
  onDelete,
  compact = false,
}: {
  view: ViewRegistryEntry;
  onClick: (view: ViewRegistryEntry) => void;
  onPin?: (view: ViewRegistryEntry) => void;
  onEdit?: (view: ViewRegistryEntry) => void;
  onDelete?: (view: ViewRegistryEntry) => void;
  compact?: boolean;
}) {
  const isDesktop = isElectrobunRuntime();
  const showPinButton = isDesktop && view.desktopTabEnabled !== false && onPin;
  const showManagementButtons = Boolean(onEdit || onDelete);

  return (
    <div
      className="group relative flex flex-col gap-2 rounded-xl border border-border/50 bg-card p-4 text-left transition-colors hover:bg-card/80 hover:border-border"
      data-testid={`view-card-${view.id}`}
    >
      {(showPinButton || showManagementButtons) && (
        <div className="absolute right-2 top-2 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
          {showPinButton && (
            <button
              type="button"
              title="Pin as desktop tab"
              onClick={(e) => {
                e.stopPropagation();
                onPin(view);
              }}
              className="flex h-6 w-6 items-center justify-center rounded-md border border-border/40 bg-card/80 text-muted hover:border-accent hover:text-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={`Pin ${view.label} as desktop tab`}
            >
              <Pin className="h-3 w-3" />
            </button>
          )}
          {onEdit && (
            <button
              type="button"
              title="Edit dynamic view"
              onClick={(e) => {
                e.stopPropagation();
                onEdit(view);
              }}
              className="flex h-6 w-6 items-center justify-center rounded-md border border-border/40 bg-card/80 text-muted hover:border-accent hover:text-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={`Edit ${view.label}`}
            >
              <Pencil className="h-3 w-3" />
            </button>
          )}
          {onDelete && (
            <button
              type="button"
              title="Delete dynamic view"
              onClick={(e) => {
                e.stopPropagation();
                onDelete(view);
              }}
              className="flex h-6 w-6 items-center justify-center rounded-md border border-border/40 bg-card/80 text-muted hover:border-destructive hover:text-destructive focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={`Delete ${view.label}`}
            >
              <Trash2 className="h-3 w-3" />
            </button>
          )}
        </div>
      )}

      <button
        type="button"
        onClick={() => onClick(view)}
        className="flex flex-col gap-2 text-left focus:outline-none"
      >
        {view.heroImageUrl && !compact && (
          <div className="aspect-video w-full overflow-hidden rounded-lg bg-muted">
            <img
              src={view.heroImageUrl}
              alt={view.label}
              className="h-full w-full object-cover"
              loading="lazy"
            />
          </div>
        )}

        <div className="flex items-start gap-3">
          {view.icon && !view.heroImageUrl && (
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-lg">
              {view.icon}
            </div>
          )}

          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-txt group-hover:text-accent transition-colors">
              {view.label}
            </p>
            {view.description && (
              <p className="mt-0.5 line-clamp-2 text-xs text-muted">
                {view.description}
              </p>
            )}
            {view.pluginName && (
              <p className="mt-1 text-xs text-muted/60 truncate">
                {view.pluginName}
              </p>
            )}
          </div>
        </div>

        {view.tags && view.tags.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {view.tags.slice(0, 3).map((tag) => (
              <span
                key={tag}
                className="inline-flex items-center rounded-full bg-muted/40 px-2 py-0.5 text-xs text-muted"
              >
                {tag}
              </span>
            ))}
          </div>
        )}
      </button>
    </div>
  );
}

function ViewsEmptyState({ hasQuery }: { hasQuery: boolean }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 py-16 text-center">
      <p className="text-sm font-medium text-muted">
        {hasQuery ? "No views match your search" : "No views available"}
      </p>
      {!hasQuery && (
        <p className="max-w-xs text-xs text-muted/60">
          Views are registered by plugins. Install a plugin that provides a view
          to see it here.
        </p>
      )}
    </div>
  );
}

function ViewsLoadingSkeleton() {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
      {VIEW_LOADING_SKELETON_KEYS.map((key) => (
        <div
          key={key}
          className="h-24 animate-pulse rounded-xl bg-muted/30"
          aria-hidden
        />
      ))}
    </div>
  );
}

function ViewSection({
  title,
  views,
  onViewClick,
  onViewPin,
  onViewEdit,
  onViewDelete,
}: {
  title: string;
  views: ViewRegistryEntry[];
  onViewClick: (view: ViewRegistryEntry) => void;
  onViewPin: (view: ViewRegistryEntry) => void;
  onViewEdit?: (view: ViewRegistryEntry) => void;
  onViewDelete?: (view: ViewRegistryEntry) => void;
}) {
  if (views.length === 0) return null;
  return (
    <div className="mb-5">
      <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted/70">
        {title}
      </h2>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        {views.map((view) => (
          <ViewCard
            key={view.id}
            view={view}
            onClick={onViewClick}
            onPin={onViewPin}
            onEdit={onViewEdit}
            onDelete={onViewDelete}
          />
        ))}
      </div>
    </div>
  );
}

function TopViewsSection({
  views,
  onViewClick,
  onViewPin,
}: {
  views: ViewRegistryEntry[];
  onViewClick: (view: ViewRegistryEntry) => void;
  onViewPin: (view: ViewRegistryEntry) => void;
}) {
  if (views.length === 0) return null;
  return (
    <div className="mb-5" data-testid="views-top-section">
      <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted/70">
        Pinned & recent
      </h2>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {views.map((view) => (
          <ViewCard
            key={view.id}
            view={view}
            onClick={onViewClick}
            onPin={onViewPin}
            compact
          />
        ))}
      </div>
    </div>
  );
}

/** Fetch semantic search results from /api/views/search. */
async function fetchSearchResults(
  q: string,
  limit: number,
): Promise<ViewRegistryEntry[]> {
  const url = new URL("/api/views/search", window.location.origin);
  url.searchParams.set("q", q);
  url.searchParams.set("limit", String(limit));
  const resp = await fetchWithCsrf(url.pathname + url.search);
  if (!resp.ok) return [];
  const body = (await resp.json()) as unknown;
  if (!body || typeof body !== "object" || !("results" in body)) return [];
  const { results } = body as { results: unknown };
  return Array.isArray(results) ? (results as ViewRegistryEntry[]) : [];
}

export function ViewManagerPage() {
  const { views, loading, error, refresh } = useAvailableViews();
  const { tabs: desktopTabs } = useDesktopTabs();
  const isDeveloperMode = useIsDeveloperMode();
  const canManageDynamicViews = isDeveloperMode && isElectrobunRuntime();
  const [query, setQuery] = useState("");
  const [formViewId, setFormViewId] = useState("agent.quick-view");
  const [formTitle, setFormTitle] = useState("Quick View");
  const [formEntrypoint, setFormEntrypoint] = useState(
    "/dynamic-views/quick-view.js",
  );
  const [formDescription, setFormDescription] = useState(
    "Developer-created dynamic view",
  );
  const [formStatus, setFormStatus] = useState<string | null>(null);
  const [formBusy, setFormBusy] = useState(false);
  const [recentViewIds, setRecentViewIds] = useState(readRecentViewIds);
  const [searchResults, setSearchResults] = useState<
    ViewRegistryEntry[] | null
  >(null);
  const [searchLoading, setSearchLoading] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // When the query changes, debounce a call to the semantic search endpoint.
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const q = query.trim();
    if (!q) {
      setSearchResults(null);
      setSearchLoading(false);
      return;
    }
    setSearchLoading(true);
    debounceRef.current = setTimeout(async () => {
      try {
        const results = await fetchSearchResults(q, 10);
        setSearchResults(results);
      } catch {
        // Semantic search unavailable — fall back to client-side filtering.
        setSearchResults(null);
      } finally {
        setSearchLoading(false);
      }
    }, 200);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query]);

  const { builtinViews, pluginViews } = useMemo(() => {
    // When the search endpoint returned results, display those ranked by score.
    if (searchResults !== null) {
      const visible = searchResults.filter((v) => {
        if (v.developerOnly && !isDeveloperMode) return false;
        if (v.visibleInManager === false) return false;
        return true;
      });
      return {
        builtinViews: visible.filter((v) => v.builtin),
        pluginViews: visible.filter((v) => !v.builtin),
      };
    }
    // No active search — show all views with client-side visibility rules.
    const q = query.trim().toLowerCase();
    const visible = views.filter((v) => {
      if (v.developerOnly && !isDeveloperMode) return false;
      if (v.visibleInManager === false) return false;
      if (!q) return true;
      return (
        v.label.toLowerCase().includes(q) ||
        (v.description?.toLowerCase().includes(q) ?? false) ||
        (v.pluginName?.toLowerCase().includes(q) ?? false) ||
        (v.tags?.some((t) => t.toLowerCase().includes(q)) ?? false)
      );
    });
    return {
      builtinViews: visible.filter((v) => v.builtin),
      pluginViews: visible.filter((v) => !v.builtin),
    };
  }, [views, isDeveloperMode, query, searchResults]);
  const visibleViews = useMemo(
    () => [...builtinViews, ...pluginViews],
    [builtinViews, pluginViews],
  );
  const topViews = useMemo(() => {
    const byId = new Map(visibleViews.map((view) => [view.id, view]));
    const ordered: ViewRegistryEntry[] = [];
    for (const tab of desktopTabs) {
      if (!tab.pinned) continue;
      const view = byId.get(tab.viewId);
      if (view && !ordered.some((existing) => existing.id === view.id)) {
        ordered.push(view);
      }
    }
    for (const id of recentViewIds) {
      const view = byId.get(id);
      if (view && !ordered.some((existing) => existing.id === view.id)) {
        ordered.push(view);
      }
      if (ordered.length >= TOP_VIEW_LIMIT) break;
    }
    return ordered.slice(0, TOP_VIEW_LIMIT);
  }, [desktopTabs, recentViewIds, visibleViews]);

  const totalVisible = builtinViews.length + pluginViews.length;
  const isSearching = searchLoading && query.trim().length > 0;

  function handleViewClick(view: ViewRegistryEntry) {
    setRecentViewIds(recordRecentViewId(view.id));
    const path = view.path ?? `/apps/${view.id}`;
    try {
      if (
        typeof window !== "undefined" &&
        window.location.protocol === "file:"
      ) {
        window.location.hash = path;
      } else if (typeof window !== "undefined") {
        window.history.pushState(null, "", path);
        window.dispatchEvent(new PopStateEvent("popstate"));
      }
    } catch {
      // sandboxed — best effort navigation
    }
  }

  function handleViewPin(view: ViewRegistryEntry) {
    // Dispatch a navigate event with action="pin-tab" so the App shell's
    // eliza:navigate:view handler adds this view to the desktop tab bar.
    if (typeof window === "undefined") return;
    window.dispatchEvent(
      new CustomEvent("eliza:navigate:view", {
        detail: {
          viewId: view.id,
          viewPath: view.path ?? `/apps/${view.id}`,
          viewLabel: view.label,
          action: "pin-tab",
        },
      }),
    );
  }

  function fillManagementForm(view: ViewRegistryEntry) {
    setFormViewId(view.id);
    setFormTitle(view.label);
    setFormEntrypoint(view.bundleUrl ?? view.path ?? `/apps/${view.id}`);
    setFormDescription(view.description ?? "");
    setFormStatus(`Editing ${view.label}`);
  }

  function buildManagedManifest(): DynamicViewManifest {
    const entrypoint = formEntrypoint.trim();
    return {
      id: formViewId.trim(),
      title: formTitle.trim(),
      description: formDescription.trim() || undefined,
      source: entrypoint.startsWith("http") ? "remote" : "developer",
      entrypoint,
      placement: "canvas",
      metadata: { managedBy: "view-manager" },
    };
  }

  async function handleRegisterView() {
    setFormBusy(true);
    setFormStatus(null);
    try {
      const manifest = buildManagedManifest();
      if (!manifest.id || !manifest.title || !manifest.entrypoint) {
        setFormStatus("View ID, title, and entrypoint are required.");
        return;
      }
      const registered = await registerDynamicView(manifest, { update: true });
      if (!registered) {
        setFormStatus("Dynamic view bridge unavailable.");
        return;
      }
      await refresh();
      setFormStatus(`Saved ${registered.title}.`);
    } catch (err) {
      setFormStatus(err instanceof Error ? err.message : String(err));
    } finally {
      setFormBusy(false);
    }
  }

  async function handleDeleteView(view: ViewRegistryEntry) {
    setFormBusy(true);
    setFormStatus(null);
    try {
      const result = await unregisterDynamicView(view.id);
      if (!result) {
        setFormStatus("Dynamic view bridge unavailable.");
        return;
      }
      await refresh();
      setFormStatus(
        result.removed
          ? `Deleted ${view.label}.`
          : `${view.label} was not registered.`,
      );
    } catch (err) {
      setFormStatus(err instanceof Error ? err.message : String(err));
    } finally {
      setFormBusy(false);
    }
  }

  return (
    <div className="flex flex-1 min-h-0 flex-col">
      {/* Header */}
      <div className="shrink-0 border-b border-border/50 px-4 py-3">
        <h1 className="text-sm font-semibold text-txt">Views</h1>
      </div>

      {/* Search */}
      <div className="shrink-0 px-4 pt-3 pb-2">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted pointer-events-none" />
          <input
            type="search"
            placeholder="Search views…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="w-full rounded-lg border border-border bg-muted/20 py-2 pl-9 pr-3 text-sm placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </div>
      </div>

      {canManageDynamicViews && (
        <form
          className="shrink-0 border-y border-border/40 px-4 py-3"
          aria-label="Dynamic view management"
          onSubmit={(event) => {
            event.preventDefault();
            void handleRegisterView();
          }}
        >
          <div className="mb-2 flex items-center justify-between gap-3">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-muted/70">
              Dynamic view management
            </h2>
            {formStatus && (
              <p className="text-xs text-muted" role="status">
                {formStatus}
              </p>
            )}
          </div>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_1.4fr_1.4fr_auto]">
            <input
              aria-label="Dynamic view ID"
              value={formViewId}
              onChange={(event) => setFormViewId(event.target.value)}
              className="rounded-lg border border-border bg-muted/20 px-3 py-2 text-sm placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-ring"
              placeholder="View ID"
            />
            <input
              aria-label="Dynamic view title"
              value={formTitle}
              onChange={(event) => setFormTitle(event.target.value)}
              className="rounded-lg border border-border bg-muted/20 px-3 py-2 text-sm placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-ring"
              placeholder="Title"
            />
            <input
              aria-label="Dynamic view entrypoint"
              value={formEntrypoint}
              onChange={(event) => setFormEntrypoint(event.target.value)}
              className="rounded-lg border border-border bg-muted/20 px-3 py-2 text-sm placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-ring"
              placeholder="/dynamic-views/view.js"
            />
            <input
              aria-label="Dynamic view description"
              value={formDescription}
              onChange={(event) => setFormDescription(event.target.value)}
              className="rounded-lg border border-border bg-muted/20 px-3 py-2 text-sm placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-ring"
              placeholder="Description"
            />
            <button
              type="submit"
              disabled={formBusy}
              className="inline-flex items-center justify-center gap-2 rounded-lg border border-border bg-accent px-3 py-2 text-sm font-medium text-accent-foreground transition-colors hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <Plus className="h-3.5 w-3.5" />
              Save
            </button>
          </div>
        </form>
      )}

      {/* Content */}
      <div className="flex-1 min-h-0 overflow-y-auto px-4 pb-4">
        {error && (
          <div className="mb-3 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
            Failed to load views: {error.message}
          </div>
        )}

        {(loading && views.length === 0) || isSearching ? (
          <ViewsLoadingSkeleton />
        ) : totalVisible === 0 ? (
          <ViewsEmptyState hasQuery={query.trim().length > 0} />
        ) : (
          <>
            <TopViewsSection
              views={topViews}
              onViewClick={handleViewClick}
              onViewPin={handleViewPin}
            />
            <ViewSection
              title="Core"
              views={builtinViews}
              onViewClick={handleViewClick}
              onViewPin={handleViewPin}
            />
            <ViewSection
              title="Plugins"
              views={pluginViews}
              onViewClick={handleViewClick}
              onViewPin={handleViewPin}
              onViewEdit={
                canManageDynamicViews ? fillManagementForm : undefined
              }
              onViewDelete={
                canManageDynamicViews ? handleDeleteView : undefined
              }
            />
          </>
        )}
      </div>
    </div>
  );
}
