/**
 * ViewCatalog — the "Views" tab content.
 *
 * A minimal launcher: a grid of icon tiles for every registered view, plus a
 * "Get more" row for installable apps not yet loaded. Search is the floating
 * chat composer (no in-page search box). Navigated to via the "Views" nav tab
 * or the `eliza:navigate:view` event dispatched by VIEWS actions.
 */

import {
  ArrowDownAZ,
  Clock3,
  type LucideIcon,
  Pencil,
  Pin,
  Plus,
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
import { useRegisterViewChatBinding } from "../../state/view-chat-binding";
import {
  readRecentViewIds,
  recordRecentViewId,
  TOP_VIEW_LIMIT,
} from "../../view-recents";
import { ChatSearchHint } from "../composites/chat-search-hint";
import { ShellViewAgentSurface } from "../views/ShellViewAgentSurface";
import { ViewIcon } from "../views/ViewIcon";

const VIEW_LOADING_SKELETON_KEYS = [
  "view-skeleton-1",
  "view-skeleton-2",
  "view-skeleton-3",
  "view-skeleton-4",
  "view-skeleton-5",
  "view-skeleton-6",
  "view-skeleton-7",
  "view-skeleton-8",
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

/** A quiet, sentence-case section label. No eyebrow, no count chip. */
function SectionLabel({
  children,
  testId,
}: {
  children: React.ReactNode;
  testId?: string;
}) {
  return (
    <h2
      className="mb-3 px-1 text-xs font-medium text-muted"
      data-testid={testId}
    >
      {children}
    </h2>
  );
}

function ViewVisual({
  id,
  icon,
  label,
  heroUrl,
  showHero,
}: {
  id: string;
  icon?: string | null;
  label: string;
  heroUrl?: string | null;
  showHero: boolean;
}) {
  if (showHero && heroUrl) {
    return (
      <div className="h-14 w-14 shrink-0 overflow-hidden rounded-2xl bg-bg-accent">
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
      className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-accent-subtle text-accent transition-colors group-hover:bg-accent group-hover:text-accent-foreground"
      data-view-visual={id}
    >
      <ViewIcon icon={icon} label={label} id={id} className="h-6 w-6" />
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

/** Icon-only sort toggle. Tooltips carry the labels — no on-screen text. */
function SortControls({
  sortMode,
  onSortModeChange,
}: {
  sortMode: ViewSortMode;
  onSortModeChange: (mode: ViewSortMode) => void;
}) {
  const { t } = useTranslation();
  const label = t("viewmanager.sort.aria", { defaultValue: "Sort views" });
  return (
    <fieldset className="flex shrink-0 items-center gap-1">
      <legend className="sr-only">{label}</legend>
      {VIEW_SORT_OPTIONS.map(({ icon: Icon, label, mode }) => {
        const active = sortMode === mode;
        return (
          <button
            key={mode}
            type="button"
            onClick={() => onSortModeChange(mode)}
            title={label}
            aria-label={label}
            className={`flex h-8 w-8 items-center justify-center rounded-lg transition-colors ${
              active
                ? "bg-accent-subtle text-accent"
                : "text-muted hover:bg-bg-accent hover:text-txt"
            }`}
            aria-pressed={active}
          >
            <Icon className="h-4 w-4" aria-hidden="true" />
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
      className="flex h-6 w-6 items-center justify-center rounded-md bg-card/80 text-muted hover:text-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
      className="flex h-6 w-6 items-center justify-center rounded-md bg-card/80 text-muted hover:text-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
      className="flex h-6 w-6 items-center justify-center rounded-md bg-card/80 text-muted hover:text-destructive focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
      className="w-full focus:outline-none"
      {...agentProps}
    >
      {children}
    </button>
  );
}

/** A launcher tile: icon chip + label. No border, no description, no chips. */
function ViewCard({
  view,
  onClick,
  onPin,
  onEdit,
  onDelete,
}: {
  view: ViewRegistryEntry;
  onClick: (view: ViewRegistryEntry) => void;
  onPin?: (view: ViewRegistryEntry) => void;
  onEdit?: (view: ViewRegistryEntry) => void;
  onDelete?: (view: ViewRegistryEntry) => void;
}) {
  const isDesktop = isElectrobunRuntime();
  const showPinButton = isDesktop && view.desktopTabEnabled !== false && onPin;
  const showManagementButtons = Boolean(onEdit || onDelete);
  const showHero = Boolean(view.hasHeroImage && view.heroImageUrl);

  return (
    <div className="group relative" data-testid={`view-card-${view.id}`}>
      {(showPinButton || showManagementButtons) && (
        <div className="absolute right-1.5 top-1.5 z-20 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
          {showPinButton && <ViewCardPinButton view={view} onPin={onPin} />}
          {onEdit && <ViewCardEditButton view={view} onEdit={onEdit} />}
          {onDelete && <ViewCardDeleteButton view={view} onDelete={onDelete} />}
        </div>
      )}

      <ViewCardOpenButton view={view} onClick={onClick}>
        <div className="flex flex-col items-center gap-2 rounded-2xl px-2 py-4 text-center transition-colors hover:bg-bg-accent/70">
          <ViewVisual
            id={view.id}
            icon={view.icon}
            label={view.label}
            heroUrl={view.heroImageUrl}
            showHero={showHero}
          />
          <span className="line-clamp-2 max-w-full text-xs font-medium leading-4 text-txt transition-colors group-hover:text-accent">
            {view.label}
          </span>
        </div>
      </ViewCardOpenButton>
    </div>
  );
}

function ViewsEmptyState({ hasQuery }: { hasQuery: boolean }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 py-20 text-center">
      <p className="text-sm font-medium text-muted">
        {hasQuery
          ? t("viewmanager.empty.noMatch", {
              defaultValue: "No views match your search",
            })
          : t("viewmanager.empty.none", {
              defaultValue: "No views available",
            })}
      </p>
    </div>
  );
}

function ViewsLoadingSkeleton() {
  return (
    <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6">
      {VIEW_LOADING_SKELETON_KEYS.map((key) => (
        <div
          key={key}
          className="h-[7.5rem] animate-pulse rounded-2xl bg-muted/15"
          aria-hidden
        />
      ))}
    </div>
  );
}

/**
 * Tile for a not-loaded catalog entry: icon + label + a Get action that
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
    <button
      type="button"
      onClick={() => onGet(entry)}
      disabled={busy}
      data-testid={`view-card-${entry.id}`}
      aria-label={t("viewmanager.catalog.getAria", {
        label: entry.label,
        defaultValue: "Get {{label}}",
      })}
      className="group flex flex-col items-center gap-2 rounded-2xl px-2 py-4 text-center transition-colors hover:bg-bg-accent/70 focus:outline-none disabled:cursor-not-allowed"
    >
      <ViewVisual
        id={entry.id}
        icon={entry.icon}
        label={entry.label}
        heroUrl={entry.heroUrl}
        showHero={showHero}
      />
      <span className="line-clamp-2 max-w-full text-xs font-medium leading-4 text-txt">
        {entry.label}
      </span>
      <span
        data-testid={`view-get-${entry.id}`}
        className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
          errored
            ? "bg-destructive/15 text-destructive"
            : "bg-accent-subtle text-accent group-hover:bg-accent group-hover:text-accent-foreground"
        } ${busy ? "opacity-70" : ""}`}
      >
        {actionLabel}
      </span>
    </button>
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
    <div className="mb-7" data-testid="views-catalog-section">
      <SectionLabel testId="views-catalog-header">{title}</SectionLabel>
      <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6">
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
  testId,
}: {
  title?: string;
  views: ViewRegistryEntry[];
  onViewClick: (view: ViewRegistryEntry) => void;
  onViewPin: (view: ViewRegistryEntry) => void;
  onViewEdit?: (view: ViewRegistryEntry) => void;
  onViewDelete?: (view: ViewRegistryEntry) => void;
  testId?: string;
}) {
  if (views.length === 0) return null;
  return (
    <div className="mb-7" data-testid={testId}>
      {title ? <SectionLabel>{title}</SectionLabel> : null}
      <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6">
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

  // The floating chat composer IS the search box for this view: while it's open
  // it takes over the composer placeholder and receives the live draft via
  // onQuery, feeding the same `query` state the filtering below reads. setQuery
  // (a useState setter) is stable, so the binding only re-registers if the
  // localized placeholder string changes.
  const searchPlaceholder = t("viewmanager.searchPlaceholder", {
    defaultValue: "Search views…",
  });
  const chatSearchBinding = useMemo(
    () => ({ placeholder: searchPlaceholder, onQuery: setQuery }),
    [searchPlaceholder],
  );
  useRegisterViewChatBinding(chatSearchBinding);

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
  // Core + plugin views read as one flat launcher grid — the source split is
  // dev metadata the user doesn't need.
  const sortedAllViews = useMemo(
    () => sortViewsForMode(visibleViews, sortMode, recentViewIds),
    [visibleViews, recentViewIds, sortMode],
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

  const totalVisible = visibleViews.length;
  const hasQuery = query.trim().length > 0;
  const topViewKeys = useMemo(
    () => new Set(topViews.map((view) => viewCatalogKey(view))),
    [topViews],
  );
  const sectionViews = useMemo(() => {
    if (hasQuery) return sortedAllViews;
    return sortedAllViews.filter(
      (view) => !topViewKeys.has(viewCatalogKey(view)),
    );
  }, [hasQuery, sortedAllViews, topViewKeys]);
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
        <div className="shrink-0 border-b border-border/40 bg-bg px-5 pb-3 pt-5">
          <div className="flex items-center justify-between gap-3">
            <h1 className="text-2xl font-semibold leading-tight text-txt">
              {t("viewmanager.title", { defaultValue: "Views" })}
            </h1>
            <SortControls sortMode={sortMode} onSortModeChange={setSortMode} />
          </div>
          <div className="mt-2">
            <ChatSearchHint noun="views" query={query} />
          </div>
        </div>

        {canManageDynamicViews && (
          <form
            className="shrink-0 border-b border-border/40 px-4 py-3"
            aria-label={t("viewmanager.management.aria", {
              defaultValue: "Dynamic view management",
            })}
            onSubmit={(event) => {
              event.preventDefault();
              void handleRegisterView();
            }}
          >
            <div className="mb-2 flex items-center justify-between gap-3">
              <h2 className="text-xs font-medium text-muted">
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
              <ViewSection
                testId="views-top-section"
                title={
                  sortedTopViews.length > 0
                    ? t("viewmanager.section.quickAccess", {
                        defaultValue: "Quick access",
                      })
                    : undefined
                }
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
                title={
                  sortedTopViews.length > 0
                    ? t("viewmanager.section.all", { defaultValue: "All" })
                    : undefined
                }
                views={sectionViews}
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
