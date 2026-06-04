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
import { useAgentElement } from "../../agent-surface";
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
import { useViewCatalog } from "../../hooks/useViewCatalog";
import type { ViewEntry } from "../../hooks/view-catalog";
import {
  getActiveViewModality,
  type ViewModality,
} from "../../platform/platform-guards";
import { useTranslation } from "../../state/TranslationContext.hooks";
import { useIsDeveloperMode } from "../../state/useDeveloperMode";
import {
  readRecentViewIds,
  recordRecentViewId,
  TOP_VIEW_LIMIT,
} from "../../view-recents";
import { ShellViewAgentSurface } from "../views/ShellViewAgentSurface";
import { ViewIcon } from "../views/ViewIcon";

const VIEW_LOADING_SKELETON_KEYS = [
  "view-skeleton-1",
  "view-skeleton-2",
  "view-skeleton-3",
  "view-skeleton-4",
  "view-skeleton-5",
  "view-skeleton-6",
];

function ViewCardPinButton({
  view,
  onPin,
}: {
  view: ViewRegistryEntry;
  onPin: (view: ViewRegistryEntry) => void;
}) {
  const { t } = useTranslation();
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: `view-card-pin-${view.id}`,
    role: "button",
    label: t("viewmanager.card.pinAria", {
      label: view.label,
      defaultValue: "Pin {{label}} as desktop tab",
    }),
    group: "view-cards",
    description: `Pin the ${view.label} view as a desktop tab`,
    onActivate: () => onPin(view),
  });
  return (
    <button
      ref={ref}
      type="button"
      title={t("viewmanager.card.pinTitle", {
        defaultValue: "Pin as desktop tab",
      })}
      onClick={(e) => {
        e.stopPropagation();
        onPin(view);
      }}
      className="flex h-6 w-6 items-center justify-center rounded-sm border border-border/40 bg-card/80 text-muted hover:border-accent hover:text-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      aria-label={t("viewmanager.card.pinAria", {
        label: view.label,
        defaultValue: "Pin {{label}} as desktop tab",
      })}
      {...agentProps}
    >
      <Pin className="h-3 w-3" />
    </button>
  );
}

function ViewCardEditButton({
  view,
  onEdit,
}: {
  view: ViewRegistryEntry;
  onEdit: (view: ViewRegistryEntry) => void;
}) {
  const { t } = useTranslation();
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: `view-card-edit-${view.id}`,
    role: "button",
    label: t("viewmanager.card.editAria", {
      label: view.label,
      defaultValue: "Edit {{label}}",
    }),
    group: "view-cards",
    description: `Edit the ${view.label} dynamic view`,
    onActivate: () => onEdit(view),
  });
  return (
    <button
      ref={ref}
      type="button"
      title={t("viewmanager.card.editTitle", {
        defaultValue: "Edit dynamic view",
      })}
      onClick={(e) => {
        e.stopPropagation();
        onEdit(view);
      }}
      className="flex h-6 w-6 items-center justify-center rounded-sm border border-border/40 bg-card/80 text-muted hover:border-accent hover:text-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      aria-label={t("viewmanager.card.editAria", {
        label: view.label,
        defaultValue: "Edit {{label}}",
      })}
      {...agentProps}
    >
      <Pencil className="h-3 w-3" />
    </button>
  );
}

function ViewCardDeleteButton({
  view,
  onDelete,
}: {
  view: ViewRegistryEntry;
  onDelete: (view: ViewRegistryEntry) => void;
}) {
  const { t } = useTranslation();
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: `view-card-delete-${view.id}`,
    role: "button",
    label: t("viewmanager.card.deleteAria", {
      label: view.label,
      defaultValue: "Delete {{label}}",
    }),
    group: "view-cards",
    description: `Delete the ${view.label} dynamic view`,
    onActivate: () => onDelete(view),
  });
  return (
    <button
      ref={ref}
      type="button"
      title={t("viewmanager.card.deleteTitle", {
        defaultValue: "Delete dynamic view",
      })}
      onClick={(e) => {
        e.stopPropagation();
        onDelete(view);
      }}
      className="flex h-6 w-6 items-center justify-center rounded-sm border border-border/40 bg-card/80 text-muted hover:border-destructive hover:text-destructive focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      aria-label={t("viewmanager.card.deleteAria", {
        label: view.label,
        defaultValue: "Delete {{label}}",
      })}
      {...agentProps}
    >
      <Trash2 className="h-3 w-3" />
    </button>
  );
}

function ViewCardOpenButton({
  view,
  onClick,
  children,
}: {
  view: ViewRegistryEntry;
  onClick: (view: ViewRegistryEntry) => void;
  children: React.ReactNode;
}) {
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: `view-card-open-${view.id}`,
    role: "button",
    label: view.label,
    group: "view-cards",
    description: view.description ?? `Open the ${view.label} view`,
    onActivate: () => onClick(view),
  });
  return (
    <button
      ref={ref}
      type="button"
      onClick={() => onClick(view)}
      className="flex flex-col gap-2 text-left focus:outline-none"
      {...agentProps}
    >
      {children}
    </button>
  );
}

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
  const showHero = Boolean(view.hasHeroImage && view.heroImageUrl);

  return (
    <div
      className="group relative flex flex-col overflow-hidden rounded-md border border-border/50 bg-card text-left transition-colors hover:border-accent/60"
      data-testid={`view-card-${view.id}`}
    >
      {(showPinButton || showManagementButtons) && (
        <div className="absolute right-2 top-2 z-10 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
          {showPinButton && <ViewCardPinButton view={view} onPin={onPin} />}
          {onEdit && <ViewCardEditButton view={view} onEdit={onEdit} />}
          {onDelete && <ViewCardDeleteButton view={view} onDelete={onDelete} />}
        </div>
      )}

      <ViewCardOpenButton view={view} onClick={onClick}>
        <div
          className={`w-full overflow-hidden ${compact ? "aspect-square" : "aspect-video"}`}
        >
          {showHero ? (
            <img
              src={view.heroImageUrl}
              alt=""
              className="h-full w-full object-cover transition-transform duration-200 group-hover:scale-[1.03]"
              loading="lazy"
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-accent/25 via-accent/10 to-card text-accent transition-colors group-hover:from-accent/35">
              <ViewIcon
                icon={view.icon}
                label={view.label}
                className={compact ? "h-7 w-7" : "h-12 w-12"}
              />
            </div>
          )}
        </div>
        <p className="truncate px-3 pb-2 text-sm font-semibold text-txt transition-colors group-hover:text-accent">
          {view.label}
        </p>
      </ViewCardOpenButton>
    </div>
  );
}

function ViewsEmptyState({ hasQuery }: { hasQuery: boolean }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 py-16 text-center">
      <p className="text-sm font-medium text-muted">
        {hasQuery
          ? t("viewmanager.empty.noMatch", {
              defaultValue: "No views match your search",
            })
          : t("viewmanager.empty.none", {
              defaultValue: "No views available",
            })}
      </p>
      {!hasQuery && (
        <p className="max-w-xs text-xs text-muted/60">
          {t("viewmanager.empty.hint", {
            defaultValue:
              "Views are registered by plugins. Install a plugin that provides a view to see it here.",
          })}
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
          className="h-24 animate-pulse rounded-sm bg-muted/30"
          aria-hidden
        />
      ))}
    </div>
  );
}

/**
 * Card for a not-loaded catalog entry: hero/icon + label + a Get action that
 * installs/loads the app (its view appears once the plugin registers).
 */
function CatalogGetCard({
  entry,
  onGet,
}: {
  entry: ViewEntry;
  onGet: (entry: ViewEntry) => void;
}) {
  const { t } = useTranslation();
  const showHero = Boolean(entry.hasHero && entry.heroUrl);
  const busy = entry.state === "installing";
  const errored = entry.state === "error";
  const actionLabel = busy
    ? t("viewmanager.catalog.getting", { defaultValue: "Getting…" })
    : errored
      ? t("viewmanager.catalog.retry", { defaultValue: "Retry" })
      : t("viewmanager.catalog.get", { defaultValue: "Get" });
  return (
    <div
      className="group relative flex flex-col overflow-hidden rounded-md border border-border/50 bg-card text-left transition-colors hover:border-accent/60"
      data-testid={`view-card-${entry.id}`}
    >
      <button
        type="button"
        onClick={() => onGet(entry)}
        disabled={busy}
        aria-label={t("viewmanager.catalog.getAria", {
          label: entry.label,
          defaultValue: "Get {{label}}",
        })}
        className="flex flex-col text-left focus:outline-none disabled:cursor-not-allowed"
      >
        <div className="aspect-video w-full overflow-hidden">
          {showHero ? (
            <img
              src={entry.heroUrl}
              alt=""
              className="h-full w-full object-cover transition-transform duration-200 group-hover:scale-[1.03]"
              loading="lazy"
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-accent/25 via-accent/10 to-card text-accent transition-colors group-hover:from-accent/35">
              <ViewIcon
                icon={entry.icon}
                label={entry.label}
                className="h-12 w-12"
              />
            </div>
          )}
        </div>
        <div className="flex items-center justify-between gap-2 px-3 py-2">
          <span className="truncate text-sm font-semibold text-txt transition-colors group-hover:text-accent">
            {entry.label}
          </span>
          <span
            data-testid={`view-get-${entry.id}`}
            className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${
              errored
                ? "bg-destructive/15 text-destructive"
                : "bg-accent text-accent-foreground"
            } ${busy ? "opacity-70" : ""}`}
          >
            {actionLabel}
          </span>
        </div>
      </button>
    </div>
  );
}

function CatalogSection({
  title,
  entries,
  onGet,
}: {
  title: string;
  entries: ViewEntry[];
  onGet: (entry: ViewEntry) => void;
}) {
  if (entries.length === 0) return null;
  return (
    <div className="mb-5" data-testid="views-catalog-section">
      <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted/70">
        {title}
      </h2>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        {entries.map((entry) => (
          <CatalogGetCard key={entry.key} entry={entry} onGet={onGet} />
        ))}
      </div>
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
            key={`${view.viewType ?? "gui"}:${view.id}`}
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
  const { t } = useTranslation();
  if (views.length === 0) return null;
  return (
    <div className="mb-5" data-testid="views-top-section">
      <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted/70">
        {t("viewmanager.section.pinnedRecent", {
          defaultValue: "Pinned & recent",
        })}
      </h2>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {views.map((view) => (
          <ViewCard
            key={`${view.viewType ?? "gui"}:${view.id}`}
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

/** Fetch semantic search results from /api/views/search for one modality. */
async function fetchSearchResults(
  q: string,
  limit: number,
  viewType: ViewModality,
): Promise<ViewRegistryEntry[]> {
  const url = new URL("/api/views/search", window.location.origin);
  url.searchParams.set("q", q);
  url.searchParams.set("limit", String(limit));
  // GUI is the server default — only the XR/TUI surfaces scope the query.
  if (viewType !== "gui") url.searchParams.set("viewType", viewType);
  const resp = await fetchWithCsrf(url.pathname + url.search);
  if (!resp.ok) return [];
  const body = (await resp.json()) as unknown;
  if (!body || typeof body !== "object" || !("results" in body)) return [];
  const { results } = body as { results: unknown };
  return Array.isArray(results) ? (results as ViewRegistryEntry[]) : [];
}

export function ViewManagerPage() {
  const { t } = useTranslation();
  const { views, loading, error, refresh } = useAvailableViews();
  const { tabs: desktopTabs } = useDesktopTabs();
  const isDeveloperMode = useIsDeveloperMode();
  const canManageDynamicViews = isDeveloperMode && isElectrobunRuntime();
  // Views are scoped to the surface modality: a GUI surface lists only GUI
  // views (TUI/XR hidden entirely); an XR surface lists only XR views.
  const activeModality = useMemo(() => getActiveViewModality(), []);
  // Installable catalog (apps/games not loaded yet) — surfaced as "Get" cards
  // alongside the loaded views, decoupled from plugin loading.
  const { entries: catalogAllEntries, get: getCatalogEntry } = useViewCatalog();
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

  const searchInput = useAgentElement<HTMLInputElement>({
    id: "views-search-input",
    role: "text-input",
    label: t("viewmanager.searchPlaceholder", {
      defaultValue: "Search views…",
    }),
    group: "views-toolbar",
    description: "Search the registered views by name, description, or tag",
    getValue: () => query,
    onFill: (value) => setQuery(value),
  });
  const formIdInput = useAgentElement<HTMLInputElement>({
    id: "views-form-id",
    role: "text-input",
    label: t("viewmanager.form.idAria", { defaultValue: "Dynamic view ID" }),
    group: "views-management",
    description: "ID of the dynamic view to register",
    getValue: () => formViewId,
    onFill: (value) => setFormViewId(value),
  });
  const formTitleInput = useAgentElement<HTMLInputElement>({
    id: "views-form-title",
    role: "text-input",
    label: t("viewmanager.form.titleAria", {
      defaultValue: "Dynamic view title",
    }),
    group: "views-management",
    description: "Title of the dynamic view to register",
    getValue: () => formTitle,
    onFill: (value) => setFormTitle(value),
  });
  const formEntrypointInput = useAgentElement<HTMLInputElement>({
    id: "views-form-entrypoint",
    role: "text-input",
    label: t("viewmanager.form.entrypointAria", {
      defaultValue: "Dynamic view entrypoint",
    }),
    group: "views-management",
    description: "Entrypoint URL or path of the dynamic view bundle",
    getValue: () => formEntrypoint,
    onFill: (value) => setFormEntrypoint(value),
  });
  const formDescriptionInput = useAgentElement<HTMLInputElement>({
    id: "views-form-description",
    role: "text-input",
    label: t("viewmanager.form.descriptionAria", {
      defaultValue: "Dynamic view description",
    }),
    group: "views-management",
    description: "Description of the dynamic view to register",
    getValue: () => formDescription,
    onFill: (value) => setFormDescription(value),
  });
  const formSaveButton = useAgentElement<HTMLButtonElement>({
    id: "views-form-save",
    role: "button",
    label: t("viewmanager.form.save", { defaultValue: "Save" }),
    group: "views-management",
    description: "Register or update the dynamic view from the form fields",
  });

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
        const results = await fetchSearchResults(q, 10, activeModality);
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
  }, [query, activeModality]);

  const { builtinViews, pluginViews } = useMemo(() => {
    // Views of a different modality than the current surface are hidden
    // entirely — a GUI surface never lists TUI/XR views, and vice versa.
    const inActiveModality = (v: ViewRegistryEntry) =>
      (v.viewType ?? "gui") === activeModality;
    // When the search endpoint returned results, display those ranked by score.
    if (searchResults !== null) {
      const visible = searchResults.filter((v) => {
        if (!inActiveModality(v)) return false;
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
      if (!inActiveModality(v)) return false;
      if (v.developerOnly && !isDeveloperMode) return false;
      if (v.visibleInManager === false) return false;
      if (!q) return true;
      return (
        v.label.toLowerCase().includes(q) ||
        (v.description?.toLowerCase().includes(q) ?? false) ||
        (v.pluginName?.toLowerCase().includes(q) ?? false) ||
        (v.tags?.some((tag) => tag.toLowerCase().includes(q)) ?? false)
      );
    });
    return {
      builtinViews: visible.filter((v) => v.builtin),
      pluginViews: visible.filter((v) => !v.builtin),
    };
  }, [views, isDeveloperMode, query, searchResults, activeModality]);
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
  const availableEntries = useMemo(() => {
    const q = query.trim().toLowerCase();
    return catalogAllEntries
      .filter((e) => e.state !== "loaded")
      .filter(
        (e) =>
          !q ||
          e.label.toLowerCase().includes(q) ||
          (e.description?.toLowerCase().includes(q) ?? false) ||
          (e.category?.toLowerCase().includes(q) ?? false),
      );
  }, [catalogAllEntries, query]);

  function handleGet(entry: ViewEntry) {
    void getCatalogEntry(entry);
  }

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
    setFormStatus(
      t("viewmanager.form.editing", {
        label: view.label,
        defaultValue: "Editing {{label}}",
      }),
    );
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
        setFormStatus(
          t("viewmanager.form.required", {
            defaultValue: "View ID, title, and entrypoint are required.",
          }),
        );
        return;
      }
      const registered = await registerDynamicView(manifest, { update: true });
      if (!registered) {
        setFormStatus(
          t("viewmanager.form.bridgeUnavailable", {
            defaultValue: "Dynamic view bridge unavailable.",
          }),
        );
        return;
      }
      await refresh();
      setFormStatus(
        t("viewmanager.form.saved", {
          title: registered.title,
          defaultValue: "Saved {{title}}.",
        }),
      );
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
        setFormStatus(
          t("viewmanager.form.bridgeUnavailable", {
            defaultValue: "Dynamic view bridge unavailable.",
          }),
        );
        return;
      }
      await refresh();
      setFormStatus(
        result.removed
          ? t("viewmanager.form.deleted", {
              label: view.label,
              defaultValue: "Deleted {{label}}.",
            })
          : t("viewmanager.form.notRegistered", {
              label: view.label,
              defaultValue: "{{label}} was not registered.",
            }),
      );
    } catch (err) {
      setFormStatus(err instanceof Error ? err.message : String(err));
    } finally {
      setFormBusy(false);
    }
  }

  return (
    <ShellViewAgentSurface viewId="views">
      <div className="flex flex-1 min-h-0 flex-col">
        {/* Header */}
        <div className="shrink-0 border-b border-border/50 px-4 py-3">
          <h1 className="text-sm font-semibold text-txt">
            {t("viewmanager.title", { defaultValue: "Views" })}
          </h1>
        </div>

        {/* Search */}
        <div className="shrink-0 px-4 pt-3 pb-2">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted pointer-events-none" />
            <input
              ref={searchInput.ref}
              type="search"
              placeholder={t("viewmanager.searchPlaceholder", {
                defaultValue: "Search views…",
              })}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="w-full rounded-sm border border-border bg-muted/20 py-2 pl-9 pr-3 text-sm placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-ring"
              {...searchInput.agentProps}
            />
          </div>
        </div>

        {canManageDynamicViews && (
          <form
            className="shrink-0 border-y border-border/40 px-4 py-3"
            aria-label={t("viewmanager.management.aria", {
              defaultValue: "Dynamic view management",
            })}
            onSubmit={(event) => {
              event.preventDefault();
              void handleRegisterView();
            }}
          >
            <div className="mb-2 flex items-center justify-between gap-3">
              <h2 className="text-xs font-semibold uppercase tracking-wider text-muted/70">
                {t("viewmanager.management.heading", {
                  defaultValue: "Dynamic view management",
                })}
              </h2>
              {formStatus && (
                <p className="text-xs text-muted" role="status">
                  {formStatus}
                </p>
              )}
            </div>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_1.4fr_1.4fr_auto]">
              <input
                ref={formIdInput.ref}
                aria-label={t("viewmanager.form.idAria", {
                  defaultValue: "Dynamic view ID",
                })}
                value={formViewId}
                onChange={(event) => setFormViewId(event.target.value)}
                className="rounded-sm border border-border bg-muted/20 px-3 py-2 text-sm placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-ring"
                placeholder={t("viewmanager.form.idPlaceholder", {
                  defaultValue: "View ID",
                })}
                {...formIdInput.agentProps}
              />
              <input
                ref={formTitleInput.ref}
                aria-label={t("viewmanager.form.titleAria", {
                  defaultValue: "Dynamic view title",
                })}
                value={formTitle}
                onChange={(event) => setFormTitle(event.target.value)}
                className="rounded-sm border border-border bg-muted/20 px-3 py-2 text-sm placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-ring"
                placeholder={t("viewmanager.form.titlePlaceholder", {
                  defaultValue: "Title",
                })}
                {...formTitleInput.agentProps}
              />
              <input
                ref={formEntrypointInput.ref}
                aria-label={t("viewmanager.form.entrypointAria", {
                  defaultValue: "Dynamic view entrypoint",
                })}
                value={formEntrypoint}
                onChange={(event) => setFormEntrypoint(event.target.value)}
                className="rounded-sm border border-border bg-muted/20 px-3 py-2 text-sm placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-ring"
                placeholder="/dynamic-views/view.js"
                {...formEntrypointInput.agentProps}
              />
              <input
                ref={formDescriptionInput.ref}
                aria-label={t("viewmanager.form.descriptionAria", {
                  defaultValue: "Dynamic view description",
                })}
                value={formDescription}
                onChange={(event) => setFormDescription(event.target.value)}
                className="rounded-sm border border-border bg-muted/20 px-3 py-2 text-sm placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-ring"
                placeholder={t("viewmanager.form.descriptionPlaceholder", {
                  defaultValue: "Description",
                })}
                {...formDescriptionInput.agentProps}
              />
              <button
                ref={formSaveButton.ref}
                type="submit"
                disabled={formBusy}
                className="inline-flex items-center justify-center gap-2 rounded-sm border border-border bg-accent px-3 py-2 text-sm font-medium text-accent-foreground transition-colors hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-60"
                {...formSaveButton.agentProps}
              >
                <Plus className="h-3.5 w-3.5" />
                {t("viewmanager.form.save", { defaultValue: "Save" })}
              </button>
            </div>
          </form>
        )}

        {/* Content */}
        <div className="flex-1 min-h-0 overflow-y-auto px-4 pb-4">
          {error && (
            <div className="mb-3 rounded-sm border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
              {t("viewmanager.loadError", {
                message: error.message,
                defaultValue: "Failed to load views: {{message}}",
              })}
            </div>
          )}

          {(loading && views.length === 0) || isSearching ? (
            <ViewsLoadingSkeleton />
          ) : totalVisible === 0 && availableEntries.length === 0 ? (
            <ViewsEmptyState hasQuery={query.trim().length > 0} />
          ) : (
            <>
              <TopViewsSection
                views={topViews}
                onViewClick={handleViewClick}
                onViewPin={handleViewPin}
              />
              <ViewSection
                title={t("viewmanager.section.core", { defaultValue: "Core" })}
                views={builtinViews}
                onViewClick={handleViewClick}
                onViewPin={handleViewPin}
              />
              <ViewSection
                title={t("viewmanager.section.plugins", {
                  defaultValue: "Plugins",
                })}
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
              <CatalogSection
                title={t("viewmanager.section.getMore", {
                  defaultValue: "Get more",
                })}
                entries={availableEntries}
                onGet={handleGet}
              />
            </>
          )}
        </div>
      </div>
    </ShellViewAgentSurface>
  );
}
