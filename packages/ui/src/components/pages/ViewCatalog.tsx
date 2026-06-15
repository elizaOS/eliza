/**
 * ViewCatalog — the "Views" tab content.
 *
 * Shows a searchable grid of registered views fetched from GET /api/views.
 * While the /api/views endpoint is not yet live the page renders gracefully
 * by falling back to an empty list.
 *
 * This page is navigated to via the "Views" (formerly "Apps") bottom nav tab
 * or via the `eliza:navigate:view` custom event dispatched by VIEWS actions.
 */

import {
  ArrowDownAZ,
  ArrowUpRight,
  Boxes,
  Clock3,
  Layers,
  type LucideIcon,
  Pencil,
  Pin,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  Trash2,
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

type ViewSortMode = "recommended" | "name" | "recent";

const VIEW_SORT_OPTIONS: Array<{
  icon: LucideIcon;
  label: string;
  mode: ViewSortMode;
}> = [
  { mode: "recommended", label: "Recommended", icon: Sparkles },
  { mode: "name", label: "A-Z", icon: ArrowDownAZ },
  { mode: "recent", label: "Recent", icon: Clock3 },
];

/** A small uppercase metadata chip. */
function MetaChip({ children }: { children: React.ReactNode }) {
  return (
    <span className="max-w-full truncate rounded-sm border border-border/60 bg-bg-accent px-2 py-1 text-[11px] font-semibold leading-none text-muted-strong">
      {children}
    </span>
  );
}

/** A "Loaded" status chip with an explicit text label instead of an icon. */
function LoadedChip({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-sm border border-[#1f7a3b]/45 bg-[#11351f]/70 px-2 py-1 text-[11px] font-bold uppercase leading-none tracking-wide text-[#3ddc6d]">
      <span className="h-1.5 w-1.5 rounded-full bg-[#3ddc6d]" />
      {label}
    </span>
  );
}

/** Compact section header: icon + uppercase label + count chip. */
function SectionHeader({
  icon: Icon,
  title,
  count,
  testId,
}: {
  icon: LucideIcon;
  title: string;
  count: number;
  testId?: string;
}) {
  return (
    <h2
      className="mb-2.5 flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.12em] text-muted-strong"
      data-testid={testId}
    >
      <Icon className="h-3.5 w-3.5 text-accent" aria-hidden="true" />
      <span>{title}</span>
      <span className="rounded-full bg-muted/15 px-1.5 py-0.5 text-[9px] font-semibold tabular-nums text-muted">
        {count}
      </span>
    </h2>
  );
}

function sourceLabel(entry: Pick<ViewRegistryEntry, "builtin" | "pluginName">) {
  return entry.builtin ? "Core" : "Plugin";
}

function routeLabel(entry: Pick<ViewRegistryEntry, "id" | "path">) {
  return entry.path ?? `/apps/${entry.id}`;
}

function ViewVisual({
  id,
  icon,
  label,
  heroUrl,
  showHero,
  compact = false,
}: {
  id: string;
  icon?: string | null;
  label: string;
  heroUrl?: string | null;
  showHero: boolean;
  compact?: boolean;
}) {
  const sizeClass = compact ? "h-14 w-14" : "h-[68px] w-[68px]";
  if (showHero && heroUrl) {
    return (
      <div
        className={`${sizeClass} shrink-0 overflow-hidden rounded-md border border-border/70 bg-bg-accent`}
      >
        <img
          src={heroUrl}
          alt=""
          className="h-full w-full object-cover"
          loading="lazy"
        />
      </div>
    );
  }

  return (
    <div
      className={`${sizeClass} shrink-0 rounded-md border border-accent/35 bg-accent-subtle text-accent shadow-[inset_0_0_0_1px_rgba(var(--accent-rgb),0.08)]`}
      data-view-visual={id}
    >
      <div className="flex h-full w-full items-center justify-center">
        <ViewIcon
          icon={icon}
          label={label}
          className={compact ? "h-6 w-6" : "h-7 w-7"}
        />
      </div>
    </div>
  );
}

function isViewManagerEntry(view: Pick<ViewRegistryEntry, "id">) {
  return view.id === "views-manager";
}

function isShellNavigationEntry(view: Pick<ViewRegistryEntry, "id" | "path">) {
  return (
    view.id === "chat" ||
    view.path === "/chat" ||
    view.id === "character" ||
    view.path === "/character"
  );
}

function isVisibleCatalogView(
  view: ViewRegistryEntry,
  isDeveloperMode: boolean,
  activeModality: ViewModality,
) {
  if (isViewManagerEntry(view)) return false;
  if (isShellNavigationEntry(view)) return false;
  if ((view.viewType ?? "gui") !== activeModality) return false;
  if (view.developerOnly && !isDeveloperMode) return false;
  if (view.visibleInManager === false) return false;
  return true;
}

function viewCatalogKey(view: Pick<ViewRegistryEntry, "id" | "viewType">) {
  return `${view.viewType ?? "gui"}:${view.id}`;
}

function compareLabels(left: { label: string }, right: { label: string }) {
  return left.label.localeCompare(right.label, undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

function sortViewsForMode(
  views: ViewRegistryEntry[],
  mode: ViewSortMode,
  recentViewIds: string[],
) {
  if (mode === "recommended") return views;
  if (mode === "name") return [...views].sort(compareLabels);

  const recentRanks = new Map(
    recentViewIds.map((viewId, index) => [viewId, index]),
  );
  return [...views].sort((left, right) => {
    const leftRank = recentRanks.get(left.id) ?? Number.POSITIVE_INFINITY;
    const rightRank = recentRanks.get(right.id) ?? Number.POSITIVE_INFINITY;
    if (leftRank !== rightRank) return leftRank - rightRank;
    return compareLabels(left, right);
  });
}

function sortCatalogEntriesForMode(entries: ViewEntry[], mode: ViewSortMode) {
  if (mode === "recommended") return entries;
  return [...entries].sort(compareLabels);
}

function SortControls({
  sortMode,
  onSortModeChange,
}: {
  sortMode: ViewSortMode;
  onSortModeChange: (mode: ViewSortMode) => void;
}) {
  const { t } = useTranslation();
  const label = t("viewmanager.sort.aria", {
    defaultValue: "Sort views",
  });
  return (
    <fieldset className="flex w-fit max-w-full shrink-0 flex-wrap gap-1.5">
      <legend className="sr-only">{label}</legend>
      {VIEW_SORT_OPTIONS.map(({ icon: Icon, label, mode }) => {
        const active = sortMode === mode;
        return (
          <button
            key={mode}
            type="button"
            onClick={() => onSortModeChange(mode)}
            className={`inline-flex h-9 items-center justify-center gap-2 rounded-lg border px-3 text-sm font-semibold transition-colors ${
              active
                ? "border-accent/45 bg-accent-subtle text-accent"
                : "border-border bg-card text-muted hover:border-accent/35 hover:bg-bg-accent hover:text-txt"
            }`}
            aria-pressed={active}
          >
            <Icon className="h-3.5 w-3.5" aria-hidden="true" />
            {label}
          </button>
        );
      })}
    </fieldset>
  );
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
      className="min-w-0 flex-1 text-left focus:outline-none"
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
  const { t } = useTranslation();
  const isDesktop = isElectrobunRuntime();
  const showPinButton = isDesktop && view.desktopTabEnabled !== false && onPin;
  const showManagementButtons = Boolean(onEdit || onDelete);
  const showHero = Boolean(view.hasHeroImage && view.heroImageUrl);
  const modality = view.viewType ?? "gui";
  const path = routeLabel(view);
  const description =
    view.description ??
    t("viewmanager.card.fallbackDescription", {
      label: view.label,
      defaultValue: "Open {{label}}.",
    });

  return (
    <div
      className={`group relative flex min-w-0 overflow-hidden rounded-lg border border-border/55 bg-card text-left shadow-sm transition-[background-color,border-color,box-shadow] hover:border-accent/55 hover:bg-bg-accent/70 hover:shadow-[0_8px_28px_-24px_rgba(var(--accent-rgb),0.5)] ${
        compact ? "min-h-[8.25rem] p-3" : "min-h-[9.25rem] p-3.5"
      }`}
      data-testid={`view-card-${view.id}`}
    >
      {(showPinButton || showManagementButtons) && (
        <div className="absolute right-2 top-2 z-20 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
          {showPinButton && <ViewCardPinButton view={view} onPin={onPin} />}
          {onEdit && <ViewCardEditButton view={view} onEdit={onEdit} />}
          {onDelete && <ViewCardDeleteButton view={view} onDelete={onDelete} />}
        </div>
      )}

      <ViewCardOpenButton view={view} onClick={onClick}>
        <div className="flex min-w-0 gap-3">
          <ViewVisual
            id={view.id}
            icon={view.icon}
            label={view.label}
            heroUrl={view.heroImageUrl}
            showHero={showHero}
            compact={compact}
          />
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-start gap-2">
              <h3 className="min-w-0 flex-1 truncate text-sm font-semibold leading-5 text-txt transition-colors group-hover:text-accent">
                {view.label}
              </h3>
              {!compact && (
                <ArrowUpRight
                  className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted transition-colors group-hover:text-accent"
                  aria-hidden="true"
                />
              )}
            </div>
            <p
              className={`mt-1 text-sm leading-5 text-muted ${
                compact ? "line-clamp-2" : "line-clamp-2"
              }`}
            >
              {description}
            </p>
            <div className="mt-3 flex min-w-0 flex-wrap items-center gap-1.5">
              <LoadedChip
                label={t("viewmanager.chip.loaded", { defaultValue: "Loaded" })}
              />
              <MetaChip>{sourceLabel(view)}</MetaChip>
              <MetaChip>{modality.toUpperCase()}</MetaChip>
              {!compact && view.pluginName && (
                <MetaChip>{view.pluginName}</MetaChip>
              )}
              {!compact && <MetaChip>{path}</MetaChip>}
            </div>
          </div>
        </div>
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
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
      {VIEW_LOADING_SKELETON_KEYS.map((key) => (
        <div
          key={key}
          className="h-36 animate-pulse rounded-lg border border-border/40 bg-muted/20"
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
      className="group relative flex min-h-[9.25rem] overflow-hidden rounded-lg border border-border/55 bg-card p-3.5 text-left shadow-sm transition-[background-color,border-color,box-shadow] hover:border-accent/55 hover:bg-bg-accent/70 hover:shadow-[0_8px_28px_-24px_rgba(var(--accent-rgb),0.5)]"
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
        className="flex min-w-0 flex-1 gap-3 text-left focus:outline-none disabled:cursor-not-allowed"
      >
        <ViewVisual
          id={entry.id}
          icon={entry.icon}
          label={entry.label}
          heroUrl={entry.heroUrl}
          showHero={showHero}
        />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-start gap-2">
            <h3 className="min-w-0 flex-1 truncate text-sm font-semibold leading-5 text-txt transition-colors group-hover:text-accent">
              {entry.label}
            </h3>
            <ArrowUpRight
              className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted transition-colors group-hover:text-accent"
              aria-hidden="true"
            />
          </div>
          {entry.description && (
            <p className="mt-1 line-clamp-2 text-sm leading-5 text-muted">
              {entry.description}
            </p>
          )}
          <div className="mt-3 flex min-w-0 flex-wrap items-center gap-1.5">
            {entry.category && <MetaChip>{entry.category}</MetaChip>}
            <MetaChip>{entry.kind}</MetaChip>
            <MetaChip>{(entry.modality ?? "gui").toUpperCase()}</MetaChip>
            {entry.appName && <MetaChip>{entry.appName}</MetaChip>}
          </div>
        </div>
        <span
          data-testid={`view-get-${entry.id}`}
          className={`ml-auto mt-auto shrink-0 rounded-sm px-2.5 py-1.5 text-[11px] font-bold uppercase tracking-wide transition-colors ${
            errored
              ? "border border-destructive/35 bg-destructive/15 text-destructive"
              : "border border-accent/45 bg-accent-subtle text-accent group-hover:bg-accent group-hover:text-accent-foreground"
          } ${busy ? "opacity-70" : ""}`}
        >
          {actionLabel}
        </span>
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
    <div className="mb-6" data-testid="views-catalog-section">
      <SectionHeader
        icon={Sparkles}
        title={title}
        count={entries.length}
        testId="views-catalog-header"
      />
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {entries.map((entry) => (
          <CatalogGetCard key={entry.key} entry={entry} onGet={onGet} />
        ))}
      </div>
    </div>
  );
}

function ViewSection({
  title,
  icon,
  views,
  onViewClick,
  onViewPin,
  onViewEdit,
  onViewDelete,
}: {
  title: string;
  icon: LucideIcon;
  views: ViewRegistryEntry[];
  onViewClick: (view: ViewRegistryEntry) => void;
  onViewPin: (view: ViewRegistryEntry) => void;
  onViewEdit?: (view: ViewRegistryEntry) => void;
  onViewDelete?: (view: ViewRegistryEntry) => void;
}) {
  if (views.length === 0) return null;
  return (
    <div className="mb-6">
      <SectionHeader icon={icon} title={title} count={views.length} />
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {views.map((view) => (
          <ViewCard
            key={viewCatalogKey(view)}
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
  onViewEdit,
  onViewDelete,
}: {
  views: ViewRegistryEntry[];
  onViewClick: (view: ViewRegistryEntry) => void;
  onViewPin: (view: ViewRegistryEntry) => void;
  onViewEdit?: (view: ViewRegistryEntry) => void;
  onViewDelete?: (view: ViewRegistryEntry) => void;
}) {
  const { t } = useTranslation();
  if (views.length === 0) return null;
  return (
    <div className="mb-6" data-testid="views-top-section">
      <SectionHeader
        icon={Pin}
        title={t("viewmanager.section.quickAccess", {
          defaultValue: "Quick access",
        })}
        count={views.length}
        testId="views-top-header"
      />
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {views.map((view) => (
          <ViewCard
            key={viewCatalogKey(view)}
            view={view}
            onClick={onViewClick}
            onPin={onViewPin}
            onEdit={onViewEdit}
            onDelete={onViewDelete}
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

export function ViewCatalog() {
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
  const [sortMode, setSortMode] = useState<ViewSortMode>("recommended");
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
    // When the search endpoint returned results, display those ranked by score.
    if (searchResults !== null) {
      const visible = searchResults.filter((v) => {
        return isVisibleCatalogView(v, isDeveloperMode, activeModality);
      });
      return {
        builtinViews: visible.filter((v) => v.builtin),
        pluginViews: visible.filter((v) => !v.builtin),
      };
    }
    // No active search — show all views with client-side visibility rules.
    const q = query.trim().toLowerCase();
    const visible = views.filter((v) => {
      if (!isVisibleCatalogView(v, isDeveloperMode, activeModality)) {
        return false;
      }
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
  const sortedBuiltinViews = useMemo(
    () => sortViewsForMode(builtinViews, sortMode, recentViewIds),
    [builtinViews, recentViewIds, sortMode],
  );
  const sortedPluginViews = useMemo(
    () => sortViewsForMode(pluginViews, sortMode, recentViewIds),
    [pluginViews, recentViewIds, sortMode],
  );
  const topViews = useMemo(() => {
    const byId = new Map(visibleViews.map((view) => [view.id, view]));
    const ordered: ViewRegistryEntry[] = [];
    for (const tab of desktopTabs) {
      if (!tab.pinned) continue;
      const view = byId.get(tab.viewId);
      if (
        view &&
        !ordered.some(
          (existing) => viewCatalogKey(existing) === viewCatalogKey(view),
        )
      ) {
        ordered.push(view);
      }
    }
    for (const id of recentViewIds) {
      const view = byId.get(id);
      if (
        view &&
        !ordered.some(
          (existing) => viewCatalogKey(existing) === viewCatalogKey(view),
        )
      ) {
        ordered.push(view);
      }
      if (ordered.length >= TOP_VIEW_LIMIT) break;
    }
    return ordered.slice(0, TOP_VIEW_LIMIT);
  }, [desktopTabs, recentViewIds, visibleViews]);
  const sortedTopViews = useMemo(
    () => sortViewsForMode(topViews, sortMode, recentViewIds),
    [recentViewIds, sortMode, topViews],
  );

  const totalVisible = builtinViews.length + pluginViews.length;
  const hasQuery = query.trim().length > 0;
  const topViewKeys = useMemo(
    () => new Set(topViews.map((view) => viewCatalogKey(view))),
    [topViews],
  );
  const sectionBuiltinViews = useMemo(() => {
    if (hasQuery) return sortedBuiltinViews;
    return sortedBuiltinViews.filter(
      (view) => !topViewKeys.has(viewCatalogKey(view)),
    );
  }, [hasQuery, sortedBuiltinViews, topViewKeys]);
  const sectionPluginViews = useMemo(() => {
    if (hasQuery) return sortedPluginViews;
    return sortedPluginViews.filter(
      (view) => !topViewKeys.has(viewCatalogKey(view)),
    );
  }, [hasQuery, sortedPluginViews, topViewKeys]);
  const isSearching = searchLoading && hasQuery;
  const availableEntries = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = catalogAllEntries
      .filter((e) => e.state !== "loaded")
      .filter((e) => (e.modality ?? "gui") === activeModality)
      .filter(
        (e) =>
          !q ||
          e.label.toLowerCase().includes(q) ||
          (e.description?.toLowerCase().includes(q) ?? false) ||
          (e.category?.toLowerCase().includes(q) ?? false),
      );
    return sortCatalogEntriesForMode(filtered, sortMode);
  }, [activeModality, catalogAllEntries, query, sortMode]);

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
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="shrink-0 border-b border-border/50 bg-bg px-5 pb-4 pt-5">
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <h1 className="text-3xl font-semibold leading-tight text-txt">
                  {t("viewmanager.title", { defaultValue: "Views" })}
                </h1>
                <p className="mt-1 max-w-2xl text-sm leading-5 text-muted">
                  {t("viewmanager.subtitle", {
                    defaultValue:
                      "Apps and interfaces for your ElizaOS system.",
                  })}
                </p>
                <div className="mt-3 flex min-w-0 flex-wrap gap-1.5">
                  <MetaChip>
                    {t("viewmanager.summary.views", {
                      count: totalVisible,
                      defaultValue: "{{count}} views",
                    })}
                  </MetaChip>
                  <MetaChip>
                    {t("viewmanager.summary.core", {
                      count: builtinViews.length,
                      defaultValue: "{{count}} core",
                    })}
                  </MetaChip>
                  <MetaChip>
                    {t("viewmanager.summary.plugins", {
                      count: pluginViews.length,
                      defaultValue: "{{count}} plugin",
                    })}
                  </MetaChip>
                  <MetaChip>{activeModality.toUpperCase()}</MetaChip>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2 sm:justify-end">
                <SortControls
                  sortMode={sortMode}
                  onSortModeChange={setSortMode}
                />
                <button
                  type="button"
                  onClick={() => void refresh()}
                  disabled={loading}
                  className="inline-flex h-10 shrink-0 items-center justify-center gap-2 rounded-lg border border-border bg-card px-3 text-sm font-semibold text-txt transition-colors hover:border-accent/50 hover:text-accent disabled:cursor-not-allowed disabled:opacity-60"
                  aria-label={t("viewmanager.refresh", {
                    defaultValue: "Refresh views",
                  })}
                >
                  <RefreshCw
                    className={`h-4 w-4 ${loading ? "animate-spin" : ""}`}
                    aria-hidden="true"
                  />
                  {t("viewmanager.refreshShort", { defaultValue: "Refresh" })}
                </button>
              </div>
            </div>

            <div className="relative min-w-0">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
              <input
                ref={searchInput.ref}
                type="search"
                placeholder={t("viewmanager.searchPlaceholder", {
                  defaultValue: "Search views…",
                })}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="h-12 w-full rounded-lg border border-border bg-card py-2 pl-10 pr-3 text-base text-txt placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-ring"
                {...searchInput.agentProps}
              />
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

        {/* Content — extra bottom padding clears the floating chat pill. */}
        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-28 pt-5">
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
                views={sortedTopViews}
                onViewClick={handleViewClick}
                onViewPin={handleViewPin}
                onViewEdit={
                  canManageDynamicViews ? fillManagementForm : undefined
                }
                onViewDelete={
                  canManageDynamicViews ? handleDeleteView : undefined
                }
              />
              <ViewSection
                title={t("viewmanager.section.core", { defaultValue: "Core" })}
                icon={Boxes}
                views={sectionBuiltinViews}
                onViewClick={handleViewClick}
                onViewPin={handleViewPin}
              />
              <ViewSection
                title={t("viewmanager.section.plugins", {
                  defaultValue: "Plugins",
                })}
                icon={Layers}
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
