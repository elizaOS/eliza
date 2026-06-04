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
  Box,
  ChevronDown,
  Pencil,
  Pin,
  Plus,
  RefreshCw,
  Search,
  SlidersHorizontal,
  Star,
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

const SOURCE_FILTERS = ["all", "core", "plugins"] as const;
const VIEW_TYPE_FILTERS = ["all", "gui", "xr", "tui"] as const;

type SourceFilter = (typeof SOURCE_FILTERS)[number];
type ViewTypeFilter = (typeof VIEW_TYPE_FILTERS)[number];

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
      className="inline-flex h-7 shrink-0 items-center justify-center rounded-md border border-accent/25 bg-accent/8 px-2 text-[0.66rem] font-semibold uppercase tracking-wider text-accent shadow-[0_0_18px_rgba(255,115,0,0.08)] transition-colors hover:border-accent/55 hover:bg-accent/15 disabled:cursor-not-allowed disabled:text-muted"
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
    <span className="inline-flex min-w-0 items-center rounded-md border border-border/45 bg-bg/45 px-1.5 py-0.5 text-[0.68rem] font-medium text-muted">
      {children}
    </span>
  );
}

function ViewIdentityTile({
  view,
  size = "regular",
}: {
  view: ViewRegistryEntry;
  size?: "compact" | "regular" | "featured";
}) {
  const tileClass =
    size === "featured"
      ? "h-16 w-16"
      : size === "compact"
        ? "h-10 w-10"
        : "h-14 w-14";
  const iconClass =
    size === "featured"
      ? "h-8 w-8"
      : size === "compact"
        ? "h-5 w-5"
        : "h-7 w-7";
  return (
    <div
      className={`relative flex ${tileClass} shrink-0 items-center justify-center overflow-hidden rounded-lg border border-accent/22 bg-[radial-gradient(circle_at_35%_20%,rgba(255,115,0,0.32),rgba(255,115,0,0.12)_34%,rgba(255,255,255,0.04)_70%)] text-accent shadow-[inset_0_1px_0_rgba(255,255,255,0.08),0_0_30px_rgba(255,115,0,0.10)]`}
    >
      <span
        className="absolute inset-x-3 bottom-2 h-px bg-accent/45"
        aria-hidden
      />
      <ViewIcon icon={view.icon} label={view.label} className={iconClass} />
    </div>
  );
}

function ViewCard({
  group,
  onClick,
  onPin,
  onEdit,
  onDelete,
  variant = "standard",
}: {
  group: ViewGroup;
  onClick: (view: ViewRegistryEntry) => void;
  onPin?: (view: ViewRegistryEntry) => void;
  onEdit?: (view: ViewRegistryEntry) => void;
  onDelete?: (view: ViewRegistryEntry) => void;
  variant?: "featured" | "compact" | "standard";
}) {
  const isDesktop = isElectrobunRuntime();
  const view = group.primary;
  const showPinButton = isDesktop && view.desktopTabEnabled !== false && onPin;
  const showManagementButtons = Boolean(onEdit || onDelete);
  const sourceLabel = group.builtin ? "Core" : "Plugin";
  const isFeatured = variant === "featured";
  const isCompact = variant === "compact";
  const cardClass = isFeatured
    ? "group relative min-h-[10.25rem] overflow-hidden rounded-lg border border-border/55 bg-[linear-gradient(135deg,rgba(255,115,0,0.16),rgba(255,255,255,0.045)_42%,rgba(20,20,24,0.86))] p-3.5 text-left shadow-[0_18px_44px_rgba(0,0,0,0.26)] transition-colors hover:border-accent/65 focus-within:ring-2 focus-within:ring-ring/50"
    : isCompact
      ? "group relative overflow-hidden rounded-lg border border-border/45 bg-[linear-gradient(135deg,rgba(255,115,0,0.10),rgba(255,255,255,0.035)_48%,rgba(20,20,24,0.78))] p-2.5 text-left transition-colors hover:border-accent/45 hover:bg-card focus-within:ring-2 focus-within:ring-ring/50"
      : "group relative overflow-hidden rounded-lg border border-border/45 bg-[linear-gradient(135deg,rgba(255,115,0,0.08),rgba(255,255,255,0.035)_45%,rgba(20,20,24,0.78))] p-3 text-left transition-colors hover:border-accent/45 hover:bg-card focus-within:ring-2 focus-within:ring-ring/50";

  return (
    <div className={cardClass} data-testid={`view-card-${group.id}`}>
      <div
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_84%_18%,rgba(255,115,0,0.13),transparent_32%),linear-gradient(90deg,rgba(255,255,255,0.035)_1px,transparent_1px),linear-gradient(0deg,rgba(255,255,255,0.025)_1px,transparent_1px)] bg-[length:auto,24px_24px,24px_24px] opacity-70"
        aria-hidden
      />
      {(showPinButton || showManagementButtons) && (
        <div className="absolute right-2 top-2 z-10 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
          {showPinButton && <ViewCardPinButton view={view} onPin={onPin} />}
          {onEdit && <ViewCardEditButton view={view} onEdit={onEdit} />}
          {onDelete && <ViewCardDeleteButton view={view} onDelete={onDelete} />}
        </div>
      )}

      <div
        className={`relative z-[1] flex min-w-0 ${isFeatured ? "h-full flex-col items-start gap-3" : "items-center gap-3"}`}
      >
        <ViewCardOpenButton view={view} onClick={onClick}>
          <div
            className={`flex min-w-0 ${isFeatured ? "h-full flex-col items-start gap-3" : "items-center gap-3"}`}
          >
            <ViewIdentityTile
              view={view}
              size={isFeatured ? "featured" : isCompact ? "compact" : "regular"}
            />

            <div className="min-w-0 flex-1">
              <div className="min-w-0">
                <p
                  className={`${isFeatured ? "text-base" : "text-sm"} truncate font-semibold text-txt transition-colors group-hover:text-accent`}
                >
                  {group.label}
                </p>
                <p
                  className={`${isFeatured ? "line-clamp-2" : "line-clamp-1"} mt-0.5 text-xs leading-5 text-muted`}
                >
                  {group.description ?? `Open the ${group.label} view.`}
                </p>
              </div>

              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <ViewBadge>{sourceLabel}</ViewBadge>
                {group.pluginName && <ViewBadge>{group.pluginName}</ViewBadge>}
                {!isCompact && !isFeatured && (
                  <ViewBadge>{view.path ?? `/apps/${view.id}`}</ViewBadge>
                )}
              </div>
            </div>
          </div>
        </ViewCardOpenButton>

        <div
          className={`${isFeatured ? "mt-auto w-full justify-end" : "ml-auto"} flex shrink-0 items-center gap-2`}
        >
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
  icon,
  layout = "grid",
  views,
  onViewClick,
  onViewPin,
  onViewEdit,
  onViewDelete,
}: {
  title: string;
  icon: React.ReactNode;
  layout?: "grid" | "wide";
  views: ViewGroup[];
  onViewClick: (view: ViewRegistryEntry) => void;
  onViewPin: (view: ViewRegistryEntry) => void;
  onViewEdit?: (view: ViewRegistryEntry) => void;
  onViewDelete?: (view: ViewRegistryEntry) => void;
}) {
  if (views.length === 0) return null;
  return (
    <section className="mb-5 rounded-lg border border-border/30 bg-black/18 p-3 shadow-[0_18px_44px_rgba(0,0,0,0.18)]">
      <div className="mb-2 flex items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted/80">
          <span className="text-accent">{icon}</span>
          {title}
        </h2>
        <span className="text-xs text-muted">{views.length}</span>
      </div>
      <div
        className={
          layout === "wide"
            ? "grid gap-2"
            : "grid gap-2 md:grid-cols-2 xl:grid-cols-3"
        }
      >
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
  if (views.length === 0) return null;
  return (
    <section
      className="mb-5 rounded-lg border border-border/30 bg-black/18 p-3 shadow-[0_18px_44px_rgba(0,0,0,0.18)]"
      data-testid="views-top-section"
    >
      <div className="mb-2 flex items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted/80">
          <Star className="h-3.5 w-3.5 text-accent" aria-hidden />
          Featured views
        </h2>
        <span className="text-xs text-muted">{views.length}</span>
      </div>
      <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-4">
        {views.map((view) => (
          <ViewCard
            key={view.key}
            group={view}
            onClick={onViewClick}
            onPin={onViewPin}
            variant="compact"
          />
        ))}
      </div>
    </section>
  );
}

function ToolbarSegmentButton({
  active,
  children,
  onClick,
}: {
  active: boolean;
  children: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex h-9 items-center justify-center rounded-md px-3 text-xs font-semibold transition-colors ${
        active
          ? "border border-accent/75 bg-accent/12 text-txt shadow-[0_0_22px_rgba(255,115,0,0.18)]"
          : "border border-transparent text-muted hover:border-border/50 hover:bg-card/70 hover:text-txt"
      }`}
    >
      {children}
    </button>
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
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>("all");
  const [viewTypeFilter, setViewTypeFilter] = useState<ViewTypeFilter>("all");
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
        if (sourceFilter === "core" && !v.builtin) return false;
        if (sourceFilter === "plugins" && v.builtin) return false;
        if (
          viewTypeFilter !== "all" &&
          (v.viewType ?? "gui") !== viewTypeFilter
        ) {
          return false;
        }
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
      if (sourceFilter === "core" && !v.builtin) return false;
      if (sourceFilter === "plugins" && v.builtin) return false;
      if (
        viewTypeFilter !== "all" &&
        (v.viewType ?? "gui") !== viewTypeFilter
      ) {
        return false;
      }
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
  }, [
    views,
    isDeveloperMode,
    query,
    searchResults,
    sourceFilter,
    viewTypeFilter,
  ]);
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
      <div className="flex flex-1 min-h-0 flex-col bg-[radial-gradient(circle_at_18%_0%,rgba(255,115,0,0.13),transparent_34%),radial-gradient(circle_at_86%_10%,rgba(255,115,0,0.08),transparent_28%)]">
        {/* Header */}
        <div className="shrink-0 border-b border-border/45 px-6 pb-4 pt-5">
          <div className="flex flex-col gap-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h1 className="shrink-0 text-3xl font-semibold text-txt">
                  {t("viewmanager.title", { defaultValue: "Views" })}
                </h1>
                <p className="mt-1 text-sm text-muted">
                  Apps and interfaces for your ElizaOS system.
                </p>
                <div className="mt-2 flex min-w-0 flex-wrap gap-1.5">
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
              <button
                type="button"
                className="inline-flex h-9 shrink-0 items-center gap-2 rounded-md border border-border/45 bg-card/72 px-3 text-xs font-semibold text-muted"
              >
                <SlidersHorizontal className="h-3.5 w-3.5" aria-hidden />
                Popular
                <ChevronDown className="h-3.5 w-3.5" aria-hidden />
              </button>
            </div>

            <div className="grid w-full min-w-0 gap-3 xl:grid-cols-[minmax(22rem,1fr)_auto_auto] xl:items-center">
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
                  className="h-11 w-full rounded-lg border border-border/65 bg-card/76 py-2 pl-9 pr-9 text-sm shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-ring"
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
              <div className="flex shrink-0 flex-wrap items-center gap-3">
                <div className="inline-flex rounded-lg border border-border/45 bg-card/60 p-1">
                  {SOURCE_FILTERS.map((filter) => (
                    <ToolbarSegmentButton
                      key={filter}
                      active={sourceFilter === filter}
                      onClick={() => setSourceFilter(filter)}
                    >
                      {filter === "all"
                        ? "All"
                        : filter === "core"
                          ? "Core"
                          : "Plugins"}
                    </ToolbarSegmentButton>
                  ))}
                </div>
                <div className="inline-flex rounded-lg border border-border/45 bg-card/60 p-1">
                  {VIEW_TYPE_FILTERS.map((filter) => (
                    <ToolbarSegmentButton
                      key={filter}
                      active={viewTypeFilter === filter}
                      onClick={() => setViewTypeFilter(filter)}
                    >
                      {filter.toUpperCase()}
                    </ToolbarSegmentButton>
                  ))}
                </div>
              </div>
              <button
                ref={refreshButton.ref}
                type="button"
                disabled={loading}
                onClick={() => void refresh()}
                className="inline-flex h-11 shrink-0 items-center justify-center gap-2 rounded-lg border border-border/55 bg-card/72 px-3 text-sm font-medium text-txt transition-colors hover:border-accent/45 hover:bg-card disabled:cursor-not-allowed disabled:opacity-60"
                {...refreshButton.agentProps}
              >
                <RefreshCw
                  className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`}
                  aria-hidden
                />
                {t("viewmanager.refreshShort", { defaultValue: "Refresh" })}
              </button>
              {isSearching && (
                <span className="rounded-md border border-border/45 bg-bg/35 px-2 py-1 text-[0.68rem] text-muted xl:col-start-3">
                  Searching
                </span>
              )}
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
        <div className="flex-1 min-h-0 overflow-y-auto px-6 py-5">
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
                icon={<Box className="h-3.5 w-3.5" aria-hidden />}
                views={sectionBuiltinViews}
                onViewClick={handleViewClick}
                onViewPin={handleViewPin}
              />
              <ViewSection
                title={t("viewmanager.section.plugins", {
                  defaultValue: "Plugins",
                })}
                icon={<SlidersHorizontal className="h-3.5 w-3.5" aria-hidden />}
                layout="wide"
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
