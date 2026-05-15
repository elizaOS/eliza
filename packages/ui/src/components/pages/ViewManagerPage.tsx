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

import { Search } from "lucide-react";
import { useMemo, useState } from "react";
import {
  type ViewRegistryEntry,
  useAvailableViews,
} from "../../hooks/useAvailableViews";
import { useIsDeveloperMode } from "../../state/useDeveloperMode";

// ---------------------------------------------------------------------------
// Internal sub-components
// ---------------------------------------------------------------------------

function ViewCard({
  view,
  onClick,
}: {
  view: ViewRegistryEntry;
  onClick: (view: ViewRegistryEntry) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onClick(view)}
      className="group flex flex-col gap-2 rounded-xl border border-border/50 bg-card p-4 text-left transition-colors hover:bg-card/80 hover:border-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {view.heroImageUrl && (
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
      {Array.from({ length: 6 }, (_, i) => (
        <div
          key={i}
          className="h-24 animate-pulse rounded-xl bg-muted/30"
          aria-hidden
        />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function ViewManagerPage() {
  const { views, loading, error } = useAvailableViews();
  const isDeveloperMode = useIsDeveloperMode();
  const [query, setQuery] = useState("");

  const visibleViews = useMemo(() => {
    const q = query.trim().toLowerCase();
    return views.filter((v) => {
      // Hide developer-only views when not in developer mode.
      if (v.developerOnly && !isDeveloperMode) return false;
      // Hide views explicitly excluded from the manager grid.
      if (v.visibleInManager === false) return false;
      // Text search across label, description, tags, and plugin name.
      if (!q) return true;
      return (
        v.label.toLowerCase().includes(q) ||
        (v.description?.toLowerCase().includes(q) ?? false) ||
        (v.pluginName?.toLowerCase().includes(q) ?? false) ||
        (v.tags?.some((t) => t.toLowerCase().includes(q)) ?? false)
      );
    });
  }, [views, isDeveloperMode, query]);

  function handleViewClick(view: ViewRegistryEntry) {
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

  return (
    <div className="flex flex-1 min-h-0 flex-col">
      {/* Header */}
      <div className="shrink-0 border-b border-border/50 px-4 py-3">
        <h1 className="text-sm font-semibold text-txt">Views</h1>
        <p className="text-xs text-muted">
          Agent-provided views from installed plugins
        </p>
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

      {/* Content */}
      <div className="flex-1 min-h-0 overflow-y-auto px-4 pb-4">
        {error && (
          <div className="mb-3 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
            Failed to load views: {error.message}
          </div>
        )}

        {loading && views.length === 0 ? (
          <ViewsLoadingSkeleton />
        ) : visibleViews.length === 0 ? (
          <ViewsEmptyState hasQuery={query.trim().length > 0} />
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {visibleViews.map((view) => (
              <ViewCard key={view.id} view={view} onClick={handleViewClick} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
