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

import {
  ArrowUpRight,
  Pencil,
  Pin,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  X,
} from "lucide-react";
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
import { useTranslation } from "../../state/TranslationContext";
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

function isViewManagerEntry(view: Pick<ViewRegistryEntry, "id">) {
  return view.id === "views-manager";
}

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
  const context = buildViewContext(view);
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: `view-card-open-${view.id}`,
    role: "button",
    label: `Open ${view.label}`,
    group: "view-cards",
    description: context.agentDescription,
    onActivate: () => onClick(view),
  });
  return (
    <button
      ref={ref}
      type="button"
      onClick={() => onClick(view)}
      className="min-w-0 flex-1 text-left focus:outline-none"
      data-view-context={JSON.stringify(context)}
      {...agentProps}
    >
      {children}
    </button>
  );
}

function ViewModeButton({
  view,
  onClick,
}: {
  view: ViewRegistryEntry;
  onClick: (view: ViewRegistryEntry) => void;
}) {
  const viewType = view.viewType ?? "gui";
  const context = buildViewContext(view);
  const label = viewType.toUpperCase();
  const baseLabel = cleanViewLabel(view.label);
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: `view-mode-open-${viewInstanceKey(view)}`,
    role: "button",
    label: `Open ${baseLabel} ${label}`,
    group: "view-mode-buttons",
    description: context.agentDescription,
    status: view.available ? "active" : "inactive",
    onActivate: () => onClick(view),
  });
  return (
    <button
      ref={ref}
      type="button"
      aria-label={`Open ${baseLabel} ${label}`}
      onClick={() => onClick(view)}
      disabled={!view.available}
      className="inline-flex h-8 shrink-0 items-center justify-center rounded-md border border-border/45 bg-bg/30 px-2 text-[0.68rem] font-semibold uppercase tracking-wider text-accent transition-colors hover:border-accent/45 hover:bg-accent/10 disabled:cursor-not-allowed disabled:text-muted"
      data-view-context={JSON.stringify(context)}
      {...agentProps}
    >
      {label}
    </button>
  );
}

function buildViewContext(view: ViewRegistryEntry) {
  const viewType = view.viewType ?? "gui";
  const route = view.path ?? `/apps/${view.id}`;
  const status = view.available ? "available" : "missing bundle";
  const tags = view.tags ?? [];
  return {
    id: view.id,
    label: view.label,
    viewType,
    route,
    pluginName: view.pluginName,
    builtin: Boolean(view.builtin),
    status,
    description: view.description ?? null,
    tags,
    agentDescription: [
      `Open ${view.label}.`,
      `Type: ${viewType}.`,
      `Route: ${route}.`,
      `Plugin: ${view.pluginName}.`,
      `Status: ${status}.`,
      view.description ? `Purpose: ${view.description}.` : "",
      tags.length ? `Tags: ${tags.join(", ")}.` : "",
    ]
      .filter(Boolean)
      .join(" "),
  };
}

function viewInstanceKey(view: Pick<ViewRegistryEntry, "id" | "viewType">) {
  return `${view.viewType ?? "gui"}:${view.id}`;
}

function viewGroupKey(view: Pick<ViewRegistryEntry, "id" | "pluginName">) {
  return `${view.pluginName}:${view.id}`;
}

function viewTypeRank(view: Pick<ViewRegistryEntry, "viewType">) {
  const viewType = view.viewType ?? "gui";
  if (viewType === "gui") return 0;
  if (viewType === "xr") return 1;
  return 2;
}

function cleanViewLabel(label: string) {
  return label.replace(/\s+(GUI|XR|TUI)$/i, "").trim();
}

interface ViewGroup {
  key: string;
  id: string;
  label: string;
  description?: string;
  pluginName: string;
  builtin: boolean;
  modes: ViewRegistryEntry[];
  primary: ViewRegistryEntry;
}

function groupViewModes(views: ViewRegistryEntry[]): ViewGroup[] {
  const groups = new Map<string, ViewRegistryEntry[]>();
  for (const view of views) {
    const key = viewGroupKey(view);
    groups.set(key, [...(groups.get(key) ?? []), view]);
  }

  return [...groups.entries()].map(([key, modes]) => {
    const sortedModes = [...modes].sort(
      (a, b) => viewTypeRank(a) - viewTypeRank(b),
    );
    const primary = sortedModes[0];
    return {
      key,
      id: primary.id,
      label: cleanViewLabel(primary.label),
      description: primary.description,
      pluginName: primary.pluginName,
      builtin: Boolean(primary.builtin),
      modes: sortedModes,
      primary,
    };
  });
}

function ViewStatusBadge({ available }: { available: boolean }) {
  return (
    <span
      className={`inline-flex h-7 shrink-0 items-center justify-center rounded-md border px-2 text-[0.68rem] font-semibold uppercase tracking-wider ${
        available
          ? "border-ok/35 bg-ok/10 text-ok"
          : "border-border/45 bg-muted/20 text-muted"
      }`}
      title={available ? "Available" : "Bundle missing"}
    >
      {available ? "Ready" : "Missing"}
    </span>
  );
}

function ViewBadge({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-md border border-border/45 bg-bg/35 px-1.5 py-0.5 text-[0.68rem] font-medium text-muted">
      {children}
    </span>
  );
}

function ViewIdentityTile({ view }: { view: ViewRegistryEntry }) {
  return (
    <div className="flex h-12 w-14 shrink-0 flex-col items-center justify-center rounded-md border border-border/45 bg-muted/25 text-accent">
      <ViewIcon icon={view.icon} label={view.label} className="h-5 w-5" />
      <span className="mt-1 h-1 w-6 rounded-full bg-accent/45" aria-hidden />
    </div>
  );
}

function ViewCard({
  group,
  onClick,
  onPin,
  onEdit,
  onDelete,
  compact = false,
}: {
  group: ViewGroup;
  onClick: (view: ViewRegistryEntry) => void;
  onPin?: (view: ViewRegistryEntry) => void;
  onEdit?: (view: ViewRegistryEntry) => void;
  onDelete?: (view: ViewRegistryEntry) => void;
  compact?: boolean;
}) {
  const isDesktop = isElectrobunRuntime();
  const view = group.primary;
  const showPinButton = isDesktop && view.desktopTabEnabled !== false && onPin;
  const showManagementButtons = Boolean(onEdit || onDelete);
  const sourceLabel = group.builtin ? "Core" : "Plugin";

  return (
    <div
      className="group relative rounded-md border border-border/45 bg-card/72 p-2.5 text-left transition-colors hover:border-accent/45 hover:bg-card focus-within:ring-2 focus-within:ring-ring/50"
      data-testid={`view-card-${group.id}`}
    >
      {(showPinButton || showManagementButtons) && (
        <div className="absolute right-2 top-2 z-10 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
          {showPinButton && <ViewCardPinButton view={view} onPin={onPin} />}
          {onEdit && <ViewCardEditButton view={view} onEdit={onEdit} />}
          {onDelete && <ViewCardDeleteButton view={view} onDelete={onDelete} />}
        </div>
      )}

      <div className="flex min-w-0 items-center gap-3">
        <ViewCardOpenButton view={view} onClick={onClick}>
          <div className="flex min-w-0 items-center gap-3">
            <ViewIdentityTile view={view} />

            <div className="min-w-0 flex-1">
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-txt transition-colors group-hover:text-accent">
                  {group.label}
                </p>
                <p className="mt-0.5 line-clamp-1 text-xs text-muted">
                  {group.description ?? `Open the ${group.label} view.`}
                </p>
              </div>

              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <ViewBadge>{sourceLabel}</ViewBadge>
                {group.pluginName && <ViewBadge>{group.pluginName}</ViewBadge>}
                {!compact && (
                  <ViewBadge>{view.path ?? `/apps/${view.id}`}</ViewBadge>
                )}
              </div>
            </div>
          </div>
        </ViewCardOpenButton>

        <div className="ml-auto flex shrink-0 items-center gap-2">
          {group.modes.length > 1 ? (
            group.modes.map((mode) => (
              <ViewModeButton
                key={viewInstanceKey(mode)}
                view={mode}
                onClick={onClick}
              />
            ))
          ) : (
            <>
              <ViewStatusBadge available={view.available} />
              <button
                type="button"
                onClick={() => onClick(view)}
                className="flex h-8 min-w-8 items-center justify-center rounded-md border border-border/45 bg-bg/30 px-2 text-accent transition-colors hover:border-accent/45 hover:bg-accent/10"
                aria-label={`Open ${group.label}`}
              >
                <ArrowUpRight className="h-3.5 w-3.5" aria-hidden />
              </button>
            </>
          )}
        </div>
      </div>
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
    <div className="grid gap-2">
      {VIEW_LOADING_SKELETON_KEYS.map((key) => (
        <div
          key={key}
          className="h-20 animate-pulse rounded-md bg-muted/30"
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
  views: ViewGroup[];
  onViewClick: (view: ViewRegistryEntry) => void;
  onViewPin: (view: ViewRegistryEntry) => void;
  onViewEdit?: (view: ViewRegistryEntry) => void;
  onViewDelete?: (view: ViewRegistryEntry) => void;
}) {
  if (views.length === 0) return null;
  return (
    <section className="mb-6">
      <div className="mb-2 flex items-center justify-between gap-3">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted/70">
          {title}
        </h2>
        <span className="text-xs text-muted">{views.length}</span>
      </div>
      <div className="grid gap-2">
        {views.map((view) => (
          <ViewCard
            key={view.key}
            group={view}
            onClick={onViewClick}
            onPin={onViewPin}
            onEdit={onViewEdit}
            onDelete={onViewDelete}
          />
        ))}
      </div>
    </section>
  );
}

function TopViewsSection({
  views,
  onViewClick,
  onViewPin,
}: {
  views: ViewGroup[];
  onViewClick: (view: ViewRegistryEntry) => void;
  onViewPin: (view: ViewRegistryEntry) => void;
}) {
  const { t } = useTranslation();
  if (views.length === 0) return null;
  return (
    <section className="mb-6" data-testid="views-top-section">
      <div className="mb-2 flex items-center justify-between gap-3">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted/70">
          {t("viewmanager.section.pinnedRecent", {
            defaultValue: "Pinned & recent",
          })}
        </h2>
        <span className="text-xs text-muted">{views.length}</span>
      </div>
      <div className="grid gap-2">
        {views.map((view) => (
          <ViewCard
            key={view.key}
            group={view}
            onClick={onViewClick}
            onPin={onViewPin}
            compact
          />
        ))}
      </div>
    </section>
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
  const { t } = useTranslation();
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
  const refreshButton = useAgentElement<HTMLButtonElement>({
    id: "views-refresh",
    role: "button",
    label: t("viewmanager.refresh", { defaultValue: "Refresh views" }),
    group: "views-toolbar",
    description: "Reload the registered view directory from the agent runtime",
    status: loading ? "active" : "inactive",
    onActivate: () => void refresh(),
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
        if (isViewManagerEntry(v)) return false;
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
      if (isViewManagerEntry(v)) return false;
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
  const visibleViewGroups = useMemo(
    () => groupViewModes(visibleViews),
    [visibleViews],
  );
  const builtinViewGroups = useMemo(
    () => groupViewModes(builtinViews),
    [builtinViews],
  );
  const pluginViewGroups = useMemo(
    () => groupViewModes(pluginViews),
    [pluginViews],
  );
  const topViews = useMemo(() => {
    const byId = new Map(visibleViewGroups.map((group) => [group.id, group]));
    const ordered: ViewGroup[] = [];
    for (const tab of desktopTabs) {
      if (!tab.pinned) continue;
      const group = byId.get(tab.viewId);
      if (group && !ordered.some((existing) => existing.key === group.key)) {
        ordered.push(group);
      }
    }
    for (const id of recentViewIds) {
      const group = byId.get(id);
      if (group && !ordered.some((existing) => existing.key === group.key)) {
        ordered.push(group);
      }
      if (ordered.length >= TOP_VIEW_LIMIT) break;
    }
    return ordered.slice(0, TOP_VIEW_LIMIT);
  }, [desktopTabs, recentViewIds, visibleViewGroups]);
  const topViewKeys = useMemo(
    () => new Set(topViews.map((group) => group.key)),
    [topViews],
  );
  const hasQuery = query.trim().length > 0;
  const sectionBuiltinViews = useMemo(() => {
    if (hasQuery) return builtinViewGroups;
    return builtinViewGroups.filter((group) => !topViewKeys.has(group.key));
  }, [builtinViewGroups, hasQuery, topViewKeys]);
  const sectionPluginViews = useMemo(() => {
    if (hasQuery) return pluginViewGroups;
    return pluginViewGroups.filter((group) => !topViewKeys.has(group.key));
  }, [hasQuery, pluginViewGroups, topViewKeys]);

  const totalVisible = visibleViewGroups.length;
  const isSearching = searchLoading && hasQuery;
  const availableCount = visibleViews.filter((view) => view.available).length;
  const pluginCount = pluginViewGroups.length;
  const typeCounts = visibleViews.reduce(
    (counts, view) => {
      const viewType = view.viewType ?? "gui";
      counts[viewType] += 1;
      return counts;
    },
    { gui: 0, tui: 0, xr: 0 },
  );

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
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-2">
                <h1 className="shrink-0 text-lg font-semibold text-txt">
                  {t("viewmanager.title", { defaultValue: "Views" })}
                </h1>
                <div className="flex min-w-0 flex-wrap gap-1.5">
                  <ViewBadge>{totalVisible} views</ViewBadge>
                  <ViewBadge>{availableCount} ready</ViewBadge>
                  <ViewBadge>{pluginCount} plugin</ViewBadge>
                  <ViewBadge>{typeCounts.gui} GUI</ViewBadge>
                  <ViewBadge>{typeCounts.tui} TUI</ViewBadge>
                  {typeCounts.xr > 0 && (
                    <ViewBadge>{typeCounts.xr} XR</ViewBadge>
                  )}
                </div>
              </div>
              {isSearching && (
                <span className="rounded-md border border-border/45 bg-bg/35 px-1.5 py-0.5 text-[0.68rem] text-muted">
                  Searching
                </span>
              )}
            </div>

            <div className="flex w-full min-w-0 flex-row gap-2">
              <div className="relative min-w-0 flex-1">
                <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted pointer-events-none" />
                <input
                  ref={searchInput.ref}
                  type="search"
                  placeholder={t("viewmanager.searchPlaceholder", {
                    defaultValue: "Search views…",
                  })}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  className="h-10 w-full rounded-md border border-border bg-card/72 py-2 pl-9 pr-9 text-sm placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-ring"
                  {...searchInput.agentProps}
                />
                {query && (
                  <button
                    type="button"
                    aria-label={t("viewmanager.clearSearch", {
                      defaultValue: "Clear view search",
                    })}
                    onClick={() => setQuery("")}
                    className="absolute right-1.5 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md text-muted transition-colors hover:bg-muted/30 hover:text-txt"
                  >
                    <X className="h-3.5 w-3.5" aria-hidden />
                  </button>
                )}
              </div>
              <button
                ref={refreshButton.ref}
                type="button"
                disabled={loading}
                onClick={() => void refresh()}
                className="inline-flex h-10 shrink-0 items-center justify-center gap-2 rounded-md border border-border bg-card/72 px-3 text-sm font-medium text-txt transition-colors hover:border-accent/45 hover:bg-card disabled:cursor-not-allowed disabled:opacity-60"
                {...refreshButton.agentProps}
              >
                <RefreshCw
                  className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`}
                  aria-hidden
                />
                {t("viewmanager.refreshShort", { defaultValue: "Refresh" })}
              </button>
            </div>
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
          ) : totalVisible === 0 ? (
            <ViewsEmptyState hasQuery={query.trim().length > 0} />
          ) : (
            <>
              {!hasQuery && (
                <TopViewsSection
                  views={topViews}
                  onViewClick={handleViewClick}
                  onViewPin={handleViewPin}
                />
              )}
              <ViewSection
                title={t("viewmanager.section.core", { defaultValue: "Core" })}
                views={sectionBuiltinViews}
                onViewClick={handleViewClick}
                onViewPin={handleViewPin}
              />
              <ViewSection
                title={t("viewmanager.section.plugins", {
                  defaultValue: "Plugins",
                })}
                views={sectionPluginViews}
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
    </ShellViewAgentSurface>
  );
}
