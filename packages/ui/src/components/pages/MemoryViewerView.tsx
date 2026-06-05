import {
  Brain,
  FileText,
  MessageSquareText,
  RefreshCw,
  Search,
  Sparkles,
} from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useDeferredValue,
  useEffect,
  useRef,
  useState,
} from "react";
import { client } from "../../api/client";
import type {
  MemoryBrowseItem,
  MemoryBrowseResponse,
  MemoryFeedResponse,
  MemoryStatsResponse,
} from "../../api/client-types-chat";
import type { RelationshipsPersonSummary } from "../../api/client-types-relationships";
import { getCached, setCached } from "../../hooks/resource-cache";
import { PageLayout } from "../../layouts/page-layout/page-layout";
import { useApp } from "../../state";
import {
  type TranslationContextValue,
  useTranslation,
} from "../../state/TranslationContext.hooks";
import { formatDateTime } from "../../utils/format";
import { PagePanel } from "../composites/page-panel";
import { MetaPill } from "../composites/page-panel/page-panel-header";
import { SidebarContent } from "../composites/sidebar/sidebar-content";
import { SidebarHeader } from "../composites/sidebar/sidebar-header";
import { SidebarPanel } from "../composites/sidebar/sidebar-panel";
import { SidebarScrollRegion } from "../composites/sidebar/sidebar-scroll-region";
import { AppPageSidebar } from "../shared/AppPageSidebar";
import { Button } from "../ui/button";
import { SegmentedControl } from "../ui/segmented-control";
import { ListSkeleton } from "../ui/skeleton-layouts";
import { ShellViewAgentSurface } from "../views/ShellViewAgentSurface";

// ── Constants ────────────────────────────────────────────────────────────

type TranslateFn = TranslationContextValue["t"];

const TYPE_LABELS: Record<string, { key: string; defaultLabel: string }> = {
  messages: { key: "memoryviewer.type.messages", defaultLabel: "Messages" },
  memories: { key: "memoryviewer.type.memories", defaultLabel: "Memories" },
  facts: { key: "memoryviewer.type.facts", defaultLabel: "Facts" },
  documents: { key: "memoryviewer.type.documents", defaultLabel: "Documents" },
};

// Memory type color tokens are defined as CSS custom properties in
// `packages/ui/src/styles/brand-gold.css` (`--memory-type-<key>-bg/fg`)
// and exposed via `.memory-type-badge-<key>` / `.memory-type-dot-<key>`.
// Components reference them by class name instead of inline rgba literals.
const TYPE_KEYS = [
  "messages",
  "memories",
  "facts",
  "documents",
  "unknown",
] as const;
type MemoryTypeKey = (typeof TYPE_KEYS)[number];

function memoryTypeKey(type: string): MemoryTypeKey {
  return (TYPE_KEYS as readonly string[]).includes(type)
    ? (type as MemoryTypeKey)
    : "unknown";
}

type ViewMode = "feed" | "browse";

const MEMORY_FEED_EMPTY_FEATURES = [
  {
    id: "chat",
    labelKey: "memoryviewer.empty.chat",
    defaultLabel: "Chat",
    icon: MessageSquareText,
    tone: "text-info",
  },
  {
    id: "facts",
    labelKey: "memoryviewer.empty.facts",
    defaultLabel: "Facts",
    icon: Sparkles,
    tone: "text-warning",
  },
  {
    id: "docs",
    labelKey: "memoryviewer.empty.docs",
    defaultLabel: "Docs",
    icon: FileText,
    tone: "text-ok",
  },
] as const;

const FEED_PAGE_SIZE = 50;
/** Max retained feed items (10 pages) so long sessions stay bounded. */
const FEED_MAX_ITEMS = 500;
const BROWSE_PAGE_SIZE = 50;

// ── Helpers ──────────────────────────────────────────────────────────────

function typeLabel(type: string, t: TranslateFn): string {
  const entry = TYPE_LABELS[type];
  return entry ? t(entry.key, { defaultValue: entry.defaultLabel }) : type;
}

function truncateText(text: string, max = 200): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

function formatRelativeTime(timestamp: number, t: TranslateFn): string {
  const diff = Date.now() - timestamp;
  const unknown = t("memoryviewer.unknown", { defaultValue: "unknown" });
  if (diff < 0) return formatDateTime(timestamp, { fallback: unknown });
  if (diff < 60_000)
    return t("memoryviewer.justNow", { defaultValue: "just now" });
  if (diff < 3_600_000)
    return t("memoryviewer.minutesAgo", {
      minutes: Math.floor(diff / 60_000),
      defaultValue: "{{minutes}}m ago",
    });
  if (diff < 86_400_000)
    return t("memoryviewer.hoursAgo", {
      hours: Math.floor(diff / 3_600_000),
      defaultValue: "{{hours}}h ago",
    });
  if (diff < 604_800_000)
    return t("memoryviewer.daysAgo", {
      days: Math.floor(diff / 86_400_000),
      defaultValue: "{{days}}d ago",
    });
  return formatDateTime(timestamp, { fallback: unknown });
}

// ── Memory Card ──────────────────────────────────────────────────────────

function MemoryCard({
  memory,
  expanded,
  onToggle,
}: {
  memory: MemoryBrowseItem;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  const typeKey = memoryTypeKey(memory.type);
  const text =
    memory.text || t("memoryviewer.empty.value", { defaultValue: "(empty)" });

  return (
    <button
      type="button"
      className="w-full text-left rounded-sm border border-border/24 bg-card/32 px-3.5 py-3 transition-colors hover:border-border/40 hover:bg-card/50"
      onClick={onToggle}
      data-testid={`memory-card-${memory.id}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={`memory-type-badge-${typeKey} inline-flex items-center rounded-full px-2 py-0.5 text-2xs font-semibold uppercase tracking-[0.12em]`}
        >
          {typeLabel(memory.type, t)}
        </span>
        {memory.source ? (
          <span className="text-2xs font-semibold uppercase tracking-[0.12em] text-muted/70">
            {memory.source}
          </span>
        ) : null}
        <span className="ml-auto text-xs-tight text-muted">
          {formatRelativeTime(memory.createdAt, t)}
        </span>
      </div>
      <div className="mt-2 text-sm leading-6 text-txt">
        {expanded ? text : truncateText(text)}
      </div>
      {expanded ? (
        <div className="mt-3 space-y-1.5 pt-3">
          {memory.entityId ? (
            <div className="text-xs-tight text-muted">
              <span className="font-semibold uppercase tracking-[0.12em]">
                {t("memoryviewer.field.entity", { defaultValue: "Entity" })}
              </span>{" "}
              <span className="font-mono text-2xs">{memory.entityId}</span>
            </div>
          ) : null}
          {memory.roomId ? (
            <div className="text-xs-tight text-muted">
              <span className="font-semibold uppercase tracking-[0.12em]">
                {t("memoryviewer.field.room", { defaultValue: "Room" })}
              </span>{" "}
              <span className="font-mono text-2xs">{memory.roomId}</span>
            </div>
          ) : null}
          <div className="text-xs-tight text-muted">
            <span className="font-semibold uppercase tracking-[0.12em]">
              {t("memoryviewer.field.created", { defaultValue: "Created" })}
            </span>{" "}
            {formatDateTime(memory.createdAt, {
              fallback: t("memoryviewer.unknown", { defaultValue: "unknown" }),
            })}
          </div>
          <div className="text-xs-tight text-muted">
            <span className="font-semibold uppercase tracking-[0.12em]">
              {t("memoryviewer.field.id", { defaultValue: "ID" })}
            </span>{" "}
            <span className="font-mono text-2xs">{memory.id}</span>
          </div>
        </div>
      ) : null}
    </button>
  );
}

// ── Memory Feed ──────────────────────────────────────────────────────────

function MemoryFeedPanel({ typeFilter }: { typeFilter: string | null }) {
  const { t } = useTranslation();
  // Seed the first page from the shared cache so a revisit paints the
  // last-known feed instantly and revalidates silently. Pagination appends
  // (`before`) stay uncached — only the base page is the instant-revisit win.
  const feedCacheKey = `memory:feed:${typeFilter ?? "all"}`;
  const cachedFeed = getCached<MemoryFeedResponse>(feedCacheKey);
  const [loading, setLoading] = useState(!cachedFeed);
  const [feed, setFeed] = useState<MemoryBrowseItem[]>(
    cachedFeed?.data.memories ?? [],
  );
  const [hasMore, setHasMore] = useState(cachedFeed?.data.hasMore ?? false);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const loadingMore = useRef(false);

  const loadFeed = useCallback(
    async (before?: number, options?: { silent?: boolean }) => {
      if (loadingMore.current && before) return;
      if (before) loadingMore.current = true;
      else if (!options?.silent) setLoading(true);
      setError(null);

      try {
        const result: MemoryFeedResponse = await client.getMemoryFeed({
          type: typeFilter ?? undefined,
          limit: FEED_PAGE_SIZE,
          before,
        });
        if (before) {
          // Cap retained items so a long pagination session can't grow the
          // feed unboundedly. 500 covers many pages of scrollback while
          // bounding memory; older items drop off the top.
          setFeed((prev) =>
            [...prev, ...result.memories].slice(-FEED_MAX_ITEMS),
          );
        } else {
          setFeed(result.memories);
          setCached(feedCacheKey, result);
        }
        setHasMore(result.hasMore);
      } catch (err) {
        setError(
          err instanceof Error
            ? err.message
            : t("memoryviewer.error.feed", {
                defaultValue: "Failed to load memory feed.",
              }),
        );
      } finally {
        setLoading(false);
        loadingMore.current = false;
      }
    },
    [typeFilter, t, feedCacheKey],
  );

  useEffect(() => {
    // Revalidate silently when a cached page is already on screen.
    void loadFeed(undefined, {
      silent: getCached<MemoryFeedResponse>(feedCacheKey) != null,
    });
  }, [loadFeed, feedCacheKey]);

  const loadMore = () => {
    const last = feed[feed.length - 1];
    if (last) void loadFeed(last.createdAt);
  };

  if (loading && feed.length === 0) {
    return <ListSkeleton rows={6} />;
  }

  if (error) {
    return (
      <div className="rounded-sm border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">
        {error}
      </div>
    );
  }

  if (feed.length === 0) {
    return (
      <PagePanel.FeatureEmpty
        className="min-h-[24rem]"
        features={MEMORY_FEED_EMPTY_FEATURES.map((feature) => ({
          ...feature,
          label: t(feature.labelKey, { defaultValue: feature.defaultLabel }),
        }))}
        icon={Brain}
        iconTone="border-accent/25 bg-accent/12 text-accent"
        title={t("memoryviewer.noMemoriesYet", {
          defaultValue: "No memories yet",
        })}
      />
    );
  }

  return (
    <div className="space-y-3" data-testid="memory-feed">
      <div className="flex items-center justify-between gap-3">
        <div className="text-xs-tight font-semibold uppercase tracking-[0.16em] text-muted/70">
          {t("memoryviewer.recentActivity", {
            count: feed.length,
            more: hasMore ? "+" : "",
            defaultValue: "Recent activity ({{count}}{{more}})",
          })}
        </div>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-7 w-7 p-0"
          onClick={() => void loadFeed()}
          aria-label={t("memoryviewer.refreshFeed", {
            defaultValue: "Refresh feed",
          })}
        >
          <RefreshCw className="h-3.5 w-3.5" />
        </Button>
      </div>
      {feed.map((memory) => (
        <MemoryCard
          key={memory.id}
          memory={memory}
          expanded={expandedId === memory.id}
          onToggle={() =>
            setExpandedId((prev) => (prev === memory.id ? null : memory.id))
          }
        />
      ))}
      {hasMore ? (
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="w-full"
          onClick={loadMore}
        >
          {t("memoryviewer.loadOlder", { defaultValue: "Load older" })}
        </Button>
      ) : null}
    </div>
  );
}

// ── Memory Browser ───────────────────────────────────────────────────────

function MemoryBrowserPanel({
  typeFilter,
  entityId,
  entityIds,
}: {
  typeFilter: string | null;
  entityId: string | null;
  entityIds: string[] | null;
}) {
  const { t } = useTranslation();
  const [searchInput, setSearchInput] = useState("");
  const deferredSearch = useDeferredValue(searchInput);
  // Cache key spans every fetch parameter so each filter/search/page combo
  // revisits instantly without colliding. Offset is appended per-call below.
  const browseKeyBase = entityId
    ? `memory:browse:entity:${entityId}:${(entityIds ?? []).join(",")}:${typeFilter ?? "all"}`
    : `memory:browse:all:${typeFilter ?? "all"}:${deferredSearch.trim()}`;
  const cachedBrowse = getCached<MemoryBrowseResponse>(`${browseKeyBase}:0`);
  const [loading, setLoading] = useState(!cachedBrowse);
  const [result, setResult] = useState<MemoryBrowseResponse | null>(
    cachedBrowse?.data ?? null,
  );
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);

  const loadMemories = useCallback(
    async (pageOffset: number, options?: { silent?: boolean }) => {
      const cacheKey = `${browseKeyBase}:${pageOffset}`;
      if (!options?.silent) setLoading(true);
      setError(null);
      try {
        const resp: MemoryBrowseResponse = entityId
          ? await client.getMemoriesByEntity(entityId, {
              type: typeFilter ?? undefined,
              limit: BROWSE_PAGE_SIZE,
              offset: pageOffset,
              entityIds: entityIds ?? undefined,
            })
          : await client.browseMemories({
              type: typeFilter ?? undefined,
              q: deferredSearch.trim() || undefined,
              limit: BROWSE_PAGE_SIZE,
              offset: pageOffset,
            });
        setResult(resp);
        setCached(cacheKey, resp);
      } catch (err) {
        setError(
          err instanceof Error
            ? err.message
            : t("memoryviewer.error.memories", {
                defaultValue: "Failed to load memories.",
              }),
        );
      } finally {
        setLoading(false);
      }
    },
    [typeFilter, entityId, entityIds, deferredSearch, t, browseKeyBase],
  );

  useEffect(() => {
    setOffset(0);
    // Revalidate silently when the first page is already cached on screen.
    void loadMemories(0, {
      silent: getCached<MemoryBrowseResponse>(`${browseKeyBase}:0`) != null,
    });
  }, [loadMemories, browseKeyBase]);

  const handlePage = (direction: "prev" | "next") => {
    const newOffset =
      direction === "next"
        ? offset + BROWSE_PAGE_SIZE
        : Math.max(0, offset - BROWSE_PAGE_SIZE);
    setOffset(newOffset);
    void loadMemories(newOffset);
  };

  return (
    <div className="space-y-3" data-testid="memory-browser">
      {!entityId ? (
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted/50" />
          <input
            type="text"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder={t("memoryviewer.searchMemoryText", {
              defaultValue: "Search memory text…",
            })}
            className="h-9 w-full rounded-sm border border-border/32 bg-card/40 pl-9 pr-3 text-sm text-txt placeholder:text-muted/50 focus:border-accent/50 focus:outline-none"
            data-testid="memory-browser-search"
          />
        </div>
      ) : null}

      {loading && !result ? (
        <ListSkeleton rows={6} />
      ) : error ? (
        <div className="rounded-sm border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">
          {error}
        </div>
      ) : !result || result.memories.length === 0 ? (
        <PagePanel.FeatureEmpty
          icon={Search}
          iconTone="border-border/30 bg-bg-hover text-muted"
          title={t("memoryviewer.noMemoriesFound", {
            defaultValue: "No memories found",
          })}
        >
          <div className="mt-4 flex flex-wrap justify-center gap-2">
            {TYPE_KEYS.slice(0, 4).map((type) => (
              <span
                key={type}
                className={`memory-type-badge-${type} rounded-full px-2.5 py-1 text-2xs font-semibold uppercase tracking-[0.12em]`}
              >
                {typeLabel(type, t)}
              </span>
            ))}
          </div>
        </PagePanel.FeatureEmpty>
      ) : (
        <>
          <div className="flex items-center justify-between gap-3 text-xs-tight text-muted">
            <span>
              {t("memoryviewer.pageRange", {
                start: offset + 1,
                end: offset + result.memories.length,
                total: result.total,
                defaultValue: "{{start}}–{{end}} of {{total}}",
              })}
            </span>
            <div className="flex gap-2">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={offset === 0}
                onClick={() => handlePage("prev")}
              >
                {t("memoryviewer.prev", { defaultValue: "Prev" })}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={offset + BROWSE_PAGE_SIZE >= result.total}
                onClick={() => handlePage("next")}
              >
                {t("memoryviewer.next", { defaultValue: "Next" })}
              </Button>
            </div>
          </div>
          {result.memories.map((memory) => (
            <MemoryCard
              key={memory.id}
              memory={memory}
              expanded={expandedId === memory.id}
              onToggle={() =>
                setExpandedId((prev) => (prev === memory.id ? null : memory.id))
              }
            />
          ))}
        </>
      )}
    </div>
  );
}

// ── Main View ────────────────────────────────────────────────────────────

export function MemoryViewerView({
  contentHeader,
}: {
  contentHeader?: ReactNode;
} = {}) {
  const { t, setTab } = useApp();
  const [viewMode, setViewMode] = useState<ViewMode>("feed");
  const [typeFilter, setTypeFilter] = useState<string | null>(null);
  const [stats, setStats] = useState<MemoryStatsResponse | null>(null);
  const [statsError, setStatsError] = useState(false);
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search);

  // People list for person-centric view
  const [people, setPeople] = useState<RelationshipsPersonSummary[]>([]);
  const [peopleLoading, setPeopleLoading] = useState(true);
  const [selectedPersonId, setSelectedPersonId] = useState<string | null>(null);

  // Load stats
  useEffect(() => {
    void client
      .getMemoryStats()
      .then((s) => {
        setStats(s);
        setStatsError(false);
      })
      .catch(() => setStatsError(true));
  }, []);

  // Load people from relationships
  useEffect(() => {
    setPeopleLoading(true);
    void client
      .getRelationshipsPeople({ limit: 200 })
      .then((result) => setPeople(result.people))
      .catch(() => setPeople([]))
      .finally(() => setPeopleLoading(false));
  }, []);

  const filteredPeople = deferredSearch
    ? people.filter((p) =>
        p.displayName.toLowerCase().includes(deferredSearch.toLowerCase()),
      )
    : people;

  const selectedPerson = selectedPersonId
    ? (people.find((p) => p.primaryEntityId === selectedPersonId) ?? null)
    : null;

  // All entity IDs for the selected person (multi-identity support)
  const selectedEntityIds = selectedPerson?.memberEntityIds ?? null;

  const handleSelectPerson = (person: RelationshipsPersonSummary) => {
    setSelectedPersonId(person.primaryEntityId);
    setViewMode("browse");
  };

  const handleClearPerson = () => {
    setSelectedPersonId(null);
  };

  const viewModeItems = [
    {
      value: "feed" as const,
      label: t("memoryviewer.feed", { defaultValue: "Feed" }),
      testId: "memory-view-feed",
    },
    {
      value: "browse" as const,
      label: t("memoryviewer.browse", { defaultValue: "Browse" }),
      testId: "memory-view-browse",
    },
  ];

  const sidebar = (
    <AppPageSidebar
      testId="memory-viewer-sidebar"
      collapsible
      contentIdentity="memory-viewer"
    >
      <SidebarHeader
        search={{
          value: search,
          onChange: (e) => setSearch(e.target.value),
          placeholder: t("memoryviewer.SearchPeople", {
            defaultValue: "Search people…",
          }),
          "aria-label": t("memoryviewer.SearchPeople", {
            defaultValue: "Search people…",
          }),
          onClear: () => setSearch(""),
        }}
      />
      <SidebarPanel>
        {/* Stats + type filter */}
        <PagePanel.SummaryCard compact className="mt-2 space-y-3">
          {stats ? (
            <>
              <div className="grid grid-cols-2 gap-2">
                <div className="rounded-sm border border-border/24 bg-card/35 px-2.5 py-2">
                  <div className="text-2xs uppercase tracking-[0.12em] text-muted/70">
                    {t("memoryviewer.total", { defaultValue: "Total" })}
                  </div>
                  <div className="mt-1 text-sm font-semibold text-txt">
                    {stats.total}
                  </div>
                </div>
                {Object.entries(stats.byType).map(([type, count]) => (
                  <div
                    key={type}
                    className="rounded-sm border border-border/24 bg-card/35 px-2.5 py-2"
                  >
                    <div className="text-2xs uppercase tracking-[0.12em] text-muted/70">
                      {typeLabel(type, t)}
                    </div>
                    <div className="mt-1 text-sm font-semibold text-txt">
                      {count}
                    </div>
                  </div>
                ))}
              </div>

              <div>
                <div className="text-xs-tight font-semibold uppercase tracking-[0.14em] text-muted/70">
                  {t("memoryviewer.filterByType", {
                    defaultValue: "Filter by type",
                  })}
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className={`h-7 rounded-full px-3 text-2xs font-semibold tracking-[0.12em] ${
                      typeFilter === null
                        ? "border-accent/40 bg-accent/14 text-txt"
                        : ""
                    }`}
                    onClick={() => setTypeFilter(null)}
                  >
                    {t("memoryviewer.all", { defaultValue: "All" })}
                  </Button>
                  {Object.keys(stats.byType).map((type) => {
                    const typeKey = memoryTypeKey(type);
                    const active = typeFilter === type;
                    return (
                      <Button
                        key={type}
                        type="button"
                        size="sm"
                        variant="outline"
                        className={`h-7 rounded-full px-3 text-2xs font-semibold tracking-[0.12em] ${
                          active ? "border-accent/40 bg-accent/14 text-txt" : ""
                        }`}
                        onClick={() => setTypeFilter(active ? null : type)}
                      >
                        <span
                          className={`memory-type-dot-${typeKey} mr-1.5 inline-block h-2 w-2 rounded-full`}
                        />
                        {typeLabel(type, t)}
                      </Button>
                    );
                  })}
                </div>
              </div>
            </>
          ) : statsError ? (
            <div className="text-xs text-muted">
              {t("memoryviewer.statsError", {
                defaultValue: "Could not load memory stats.",
              })}
            </div>
          ) : (
            <div className="text-xs text-muted">
              {t("memoryviewer.loadingStats", {
                defaultValue: "Loading stats…",
              })}
            </div>
          )}
        </PagePanel.SummaryCard>

        {/* People list */}
        <SidebarContent.SectionLabel className="mt-3">
          {t("memoryviewer.people", { defaultValue: "People" })}
        </SidebarContent.SectionLabel>

        {selectedPersonId ? (
          <div className="mt-2 flex gap-1.5 px-1">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="flex-1 text-xs-tight"
              onClick={handleClearPerson}
            >
              {t("memoryviewer.showAll", { defaultValue: "Show all" })}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="flex-1 text-xs-tight"
              onClick={() => setTab("relationships")}
            >
              {t("memoryviewer.relationships", {
                defaultValue: "Relationships",
              })}
            </Button>
          </div>
        ) : null}

        <SidebarScrollRegion className="mt-2">
          <div className="space-y-1.5">
            {peopleLoading ? (
              <div className="px-2 text-xs text-muted">
                {t("memoryviewer.loading", { defaultValue: "Loading…" })}
              </div>
            ) : filteredPeople.length === 0 ? (
              <div className="px-2 text-xs text-muted">
                {deferredSearch
                  ? t("memoryviewer.noMatch", { defaultValue: "No match." })
                  : t("memoryviewer.noPeopleYet", {
                      defaultValue: "No people yet.",
                    })}
              </div>
            ) : (
              filteredPeople.map((person) => {
                const active = person.primaryEntityId === selectedPersonId;
                return (
                  <SidebarContent.Item
                    key={person.groupId}
                    active={active}
                    onClick={() => handleSelectPerson(person)}
                    aria-current={active ? "page" : undefined}
                  >
                    <SidebarContent.ItemIcon active={active}>
                      {person.displayName.charAt(0).toUpperCase()}
                    </SidebarContent.ItemIcon>
                    <span className="min-w-0 flex-1 text-left">
                      <SidebarContent.ItemTitle>
                        {person.displayName}
                      </SidebarContent.ItemTitle>
                      <SidebarContent.ItemDescription>
                        {person.platforms.join(" · ") ||
                          t("memoryviewer.noPlatforms", {
                            defaultValue: "No platforms",
                          })}
                      </SidebarContent.ItemDescription>
                    </span>
                    <MetaPill compact>{person.factCount}</MetaPill>
                  </SidebarContent.Item>
                );
              })
            )}
          </div>
        </SidebarScrollRegion>
      </SidebarPanel>
    </AppPageSidebar>
  );

  return (
    <ShellViewAgentSurface viewId="memories">
      <PageLayout
        sidebar={sidebar}
        contentHeader={contentHeader}
        data-testid="memory-viewer-view"
      >
        <div className="flex min-h-0 flex-1 flex-col gap-4">
          {/* View mode toggle + person context */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <SegmentedControl
              value={viewMode}
              onValueChange={(v) => setViewMode(v as ViewMode)}
              items={viewModeItems}
              buttonClassName="min-h-8 px-4 py-2"
            />
            {selectedPerson ? (
              <div className="flex items-center gap-2 text-sm text-muted">
                {t("memoryviewer.filteredTo", { defaultValue: "Filtered to" })}
                <MetaPill compact>{selectedPerson.displayName}</MetaPill>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-6 px-2 text-xs-tight"
                  onClick={handleClearPerson}
                >
                  {t("memoryviewer.clear", { defaultValue: "Clear" })}
                </Button>
              </div>
            ) : null}
          </div>

          {/* Content */}
          {viewMode === "feed" ? (
            <MemoryFeedPanel typeFilter={typeFilter} />
          ) : (
            <MemoryBrowserPanel
              typeFilter={typeFilter}
              entityId={selectedPersonId}
              entityIds={selectedEntityIds}
            />
          )}
        </div>
      </PageLayout>
    </ShellViewAgentSurface>
  );
}
