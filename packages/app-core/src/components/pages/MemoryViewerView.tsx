import {
  Button,
  MetaPill,
  PageLayout,
  PagePanel,
  SegmentedControl,
  SidebarContent,
  SidebarHeader,
  SidebarPanel,
  SidebarScrollRegion,
} from "@elizaos/ui";
import { RefreshCw, Search } from "lucide-react";
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
import { useApp } from "../../state";
import { formatDateTime } from "../../utils/format";
import { AppPageSidebar } from "../shared/AppPageSidebar";

// ── Constants ────────────────────────────────────────────────────────────

const TYPE_LABELS: Record<string, string> = {
  messages: "Messages",
  memories: "Memories",
  facts: "Facts",
  documents: "Documents",
};

const TYPE_COLORS: Record<string, { bg: string; fg: string }> = {
  messages: { bg: "rgba(99, 102, 241, 0.15)", fg: "rgb(99, 102, 241)" },
  memories: { bg: "rgba(168, 85, 247, 0.15)", fg: "rgb(168, 85, 247)" },
  facts: { bg: "rgba(34, 197, 94, 0.15)", fg: "rgb(34, 197, 94)" },
  documents: { bg: "rgba(245, 158, 11, 0.15)", fg: "rgb(245, 158, 11)" },
  unknown: { bg: "rgba(156, 163, 175, 0.15)", fg: "rgb(156, 163, 175)" },
};

type ViewMode = "feed" | "browse";

const VIEW_MODE_ITEMS = [
  { value: "feed" as const, label: "Feed", testId: "memory-view-feed" },
  { value: "browse" as const, label: "Browse", testId: "memory-view-browse" },
];

const FEED_PAGE_SIZE = 50;
const BROWSE_PAGE_SIZE = 50;

// ── Helpers ──────────────────────────────────────────────────────────────

function typeLabel(type: string): string {
  return TYPE_LABELS[type] ?? type;
}

function typeColor(type: string): { bg: string; fg: string } {
  return TYPE_COLORS[type] ?? TYPE_COLORS.unknown;
}

function truncateText(text: string, max = 200): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

function formatRelativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  if (diff < 0) return formatDateTime(timestamp, { fallback: "unknown" });
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  if (diff < 604_800_000) return `${Math.floor(diff / 86_400_000)}d ago`;
  return formatDateTime(timestamp, { fallback: "unknown" });
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
  const color = typeColor(memory.type);
  const text = memory.text || "(empty)";

  return (
    <button
      type="button"
      className="w-full text-left rounded-2xl border border-border/24 bg-card/32 px-3.5 py-3 transition-colors hover:border-border/40 hover:bg-card/50"
      onClick={onToggle}
      data-testid={`memory-card-${memory.id}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span
          className="inline-flex items-center rounded-full px-2 py-0.5 text-2xs font-semibold uppercase tracking-[0.12em]"
          style={{ backgroundColor: color.bg, color: color.fg }}
        >
          {typeLabel(memory.type)}
        </span>
        {memory.source ? (
          <span className="text-2xs font-semibold uppercase tracking-[0.12em] text-muted/70">
            {memory.source}
          </span>
        ) : null}
        <span className="ml-auto text-xs-tight text-muted">
          {formatRelativeTime(memory.createdAt)}
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
                Entity
              </span>{" "}
              <span className="font-mono text-2xs">{memory.entityId}</span>
            </div>
          ) : null}
          {memory.roomId ? (
            <div className="text-xs-tight text-muted">
              <span className="font-semibold uppercase tracking-[0.12em]">
                Room
              </span>{" "}
              <span className="font-mono text-2xs">{memory.roomId}</span>
            </div>
          ) : null}
          <div className="text-xs-tight text-muted">
            <span className="font-semibold uppercase tracking-[0.12em]">
              Created
            </span>{" "}
            {formatDateTime(memory.createdAt, { fallback: "unknown" })}
          </div>
          <div className="text-xs-tight text-muted">
            <span className="font-semibold uppercase tracking-[0.12em]">
              ID
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
  const [loading, setLoading] = useState(true);
  const [feed, setFeed] = useState<MemoryBrowseItem[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const loadingMore = useRef(false);

  const loadFeed = useCallback(
    async (before?: number) => {
      if (loadingMore.current && before) return;
      if (before) loadingMore.current = true;
      else setLoading(true);
      setError(null);

      try {
        const result: MemoryFeedResponse = await client.getMemoryFeed({
          type: typeFilter ?? undefined,
          limit: FEED_PAGE_SIZE,
          before,
        });
        if (before) {
          setFeed((prev) => [...prev, ...result.memories]);
        } else {
          setFeed(result.memories);
        }
        setHasMore(result.hasMore);
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Failed to load memory feed.",
        );
      } finally {
        setLoading(false);
        loadingMore.current = false;
      }
    },
    [typeFilter],
  );

  useEffect(() => {
    void loadFeed();
  }, [loadFeed]);

  const loadMore = () => {
    const last = feed[feed.length - 1];
    if (last) void loadFeed(last.createdAt);
  };

  if (loading && feed.length === 0) {
    return <PagePanel.Loading heading="Loading memory feed…" />;
  }

  if (error) {
    return (
      <div className="rounded-2xl border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">
        {error}
      </div>
    );
  }

  if (feed.length === 0) {
    return (
      <PagePanel.Empty
        variant="panel"
        className="min-h-[24rem]"
        title="No memories yet"
        description="Memories will appear here as the agent processes conversations, extracts facts, and builds relationships."
      />
    );
  }

  return (
    <div className="space-y-3" data-testid="memory-feed">
      <div className="flex items-center justify-between gap-3">
        <div className="text-xs-tight font-semibold uppercase tracking-[0.16em] text-muted/70">
          Recent activity ({feed.length}
          {hasMore ? "+" : ""})
        </div>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-7 w-7 p-0"
          onClick={() => void loadFeed()}
          aria-label="Refresh feed"
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
          Load older
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
  const [searchInput, setSearchInput] = useState("");
  const deferredSearch = useDeferredValue(searchInput);
  const [loading, setLoading] = useState(true);
  const [result, setResult] = useState<MemoryBrowseResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);

  const loadMemories = useCallback(
    async (pageOffset: number) => {
      setLoading(true);
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
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Failed to load memories.",
        );
      } finally {
        setLoading(false);
      }
    },
    [typeFilter, entityId, entityIds, deferredSearch],
  );

  useEffect(() => {
    setOffset(0);
    void loadMemories(0);
  }, [loadMemories]);

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
            placeholder="Search memory text…"
            className="h-9 w-full rounded-xl border border-border/32 bg-card/40 pl-9 pr-3 text-sm text-txt placeholder:text-muted/50 focus:border-accent/50 focus:outline-none"
            data-testid="memory-browser-search"
          />
        </div>
      ) : null}

      {loading && !result ? (
        <PagePanel.Loading heading="Loading memories…" />
      ) : error ? (
        <div className="rounded-2xl border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">
          {error}
        </div>
      ) : !result || result.memories.length === 0 ? (
        <PagePanel.Empty
          variant="panel"
          className="min-h-[20rem]"
          title="No memories found"
          description={
            deferredSearch
              ? "No memories match your search query."
              : "No memories match the current filters."
          }
        />
      ) : (
        <>
          <div className="flex items-center justify-between gap-3 text-xs-tight text-muted">
            <span>
              {offset + 1}–{offset + result.memories.length} of {result.total}
            </span>
            <div className="flex gap-2">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={offset === 0}
                onClick={() => handlePage("prev")}
              >
                Prev
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={offset + BROWSE_PAGE_SIZE >= result.total}
                onClick={() => handlePage("next")}
              >
                Next
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
          "aria-label": "Search people",
          onClear: () => setSearch(""),
        }}
      />
      <SidebarPanel>
        {/* Stats + type filter */}
        <PagePanel.SummaryCard compact className="mt-2 space-y-3">
          {stats ? (
            <>
              <div className="grid grid-cols-2 gap-2">
                <div className="rounded-xl border border-border/24 bg-card/35 px-2.5 py-2">
                  <div className="text-2xs uppercase tracking-[0.12em] text-muted/70">
                    Total
                  </div>
                  <div className="mt-1 text-sm font-semibold text-txt">
                    {stats.total}
                  </div>
                </div>
                {Object.entries(stats.byType).map(([type, count]) => (
                  <div
                    key={type}
                    className="rounded-xl border border-border/24 bg-card/35 px-2.5 py-2"
                  >
                    <div className="text-2xs uppercase tracking-[0.12em] text-muted/70">
                      {typeLabel(type)}
                    </div>
                    <div className="mt-1 text-sm font-semibold text-txt">
                      {count}
                    </div>
                  </div>
                ))}
              </div>

              <div>
                <div className="text-xs-tight font-semibold uppercase tracking-[0.14em] text-muted/70">
                  Filter by type
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
                    All
                  </Button>
                  {Object.keys(stats.byType).map((type) => {
                    const color = typeColor(type);
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
                          className="mr-1.5 inline-block h-2 w-2 rounded-full"
                          style={{ backgroundColor: color.fg }}
                        />
                        {typeLabel(type)}
                      </Button>
                    );
                  })}
                </div>
              </div>
            </>
          ) : statsError ? (
            <div className="text-xs text-muted">
              Could not load memory stats.
            </div>
          ) : (
            <div className="text-xs text-muted">Loading stats…</div>
          )}
        </PagePanel.SummaryCard>

        {/* People list */}
        <SidebarContent.SectionLabel className="mt-3">
          People
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
              Show all
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="flex-1 text-xs-tight"
              onClick={() => setTab("relationships")}
            >
              Relationships
            </Button>
          </div>
        ) : null}

        <SidebarScrollRegion className="mt-2">
          <div className="space-y-1.5">
            {peopleLoading ? (
              <div className="px-2 text-xs text-muted">Loading…</div>
            ) : filteredPeople.length === 0 ? (
              <div className="px-2 text-xs text-muted">
                {deferredSearch ? "No match." : "No people yet."}
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
                        {person.platforms.join(" · ") || "No platforms"}
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
            items={VIEW_MODE_ITEMS}
            buttonClassName="min-h-8 px-4 py-2"
          />
          {selectedPerson ? (
            <div className="flex items-center gap-2 text-sm text-muted">
              Filtered to
              <MetaPill compact>{selectedPerson.displayName}</MetaPill>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-6 px-2 text-xs-tight"
                onClick={handleClearPerson}
              >
                Clear
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
  );
}
