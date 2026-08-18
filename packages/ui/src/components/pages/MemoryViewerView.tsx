/**
 * Memories page: browses the agent's memory store in three modes — a recent
 * feed, a filtered browse list, and a person-centric view scoped to a
 * relationship's member entity ids. Pulls stats, people (via the relationships
 * API), and memory rows from the typed client. On mobile the people/filter
 * sidebar is opened from a compact control in the view header rather than an
 * inline trigger.
 */

import {
  Brain,
  ChevronDown,
  FileText,
  MessageSquareText,
  Search,
  Sparkles,
  X,
} from "lucide-react";
import {
  memo,
  type ReactNode,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useAgentElement } from "../../agent-surface";
import { client } from "../../api/client";
import type {
  MemoryBrowseItem,
  MemoryBrowseResponse,
  MemoryFeedResponse,
  MemoryStatsResponse,
} from "../../api/client-types-chat";
import { isApiError } from "../../api/client-types-core";
import type { RelationshipsPersonSummary } from "../../api/client-types-relationships";
import { dispatchChatOpen } from "../../events";
import { getCached, setCached } from "../../hooks/resource-cache";
import { useIntervalWhenDocumentVisible } from "../../hooks/useDocumentVisibility";
import { PageLayout } from "../../layouts/page-layout/page-layout";
import { useWorkspaceMobileSidebarHeader } from "../../layouts/workspace-layout/workspace-mobile-sidebar-controls.hooks";
import { WorkspaceMobileSidebarScope } from "../../layouts/workspace-layout/workspace-mobile-sidebar-scope";
import { useAppSelector } from "../../state";
import {
  type TranslationContextValue,
  useTranslation,
} from "../../state/TranslationContext.hooks";
import { useRegisterViewChatBinding } from "../../state/view-chat-binding";
import { formatDateTime } from "../../utils/format";
import { ChatSearchHint } from "../composites/chat-search-hint";
import { PagePanel } from "../composites/page-panel";
import { MetaPill } from "../composites/page-panel/page-panel-header";
import { SidebarPanel } from "../composites/sidebar/sidebar-panel";
import { AppPageSidebar } from "../shared/AppPageSidebar";
import { ViewHeader } from "../shared/ViewHeader";
import { ViewHeaderSidebarTrigger } from "../shared/ViewHeaderSidebarTrigger";
import { Button } from "../ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { Input } from "../ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
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
    tone: "text-muted-strong",
  },
  {
    id: "facts",
    labelKey: "memoryviewer.empty.facts",
    defaultLabel: "Facts",
    icon: Sparkles,
    tone: "text-muted-strong",
  },
  {
    id: "docs",
    labelKey: "memoryviewer.empty.docs",
    defaultLabel: "Docs",
    icon: FileText,
    tone: "text-muted-strong",
  },
] as const;

const FEED_PAGE_SIZE = 50;
/** Max retained feed items (10 pages) so long sessions stay bounded. */
const FEED_MAX_ITEMS = 500;
/** Poll interval to keep the feed fresh in place of a manual refresh button. */
const FEED_POLL_MS = 30_000;
const BROWSE_PAGE_SIZE = 50;
/** Filled accent focus — the product bans rings, not keyboard position. */
const MEMORY_FOCUS_CLASS = "keyboard-focus-surface";

// ── Helpers ──────────────────────────────────────────────────────────────

function typeLabel(type: string, t: TranslateFn): string {
  const entry = TYPE_LABELS[type];
  return entry ? t(entry.key, { defaultValue: entry.defaultLabel }) : type;
}

const KNOWN_TYPE_KEYS = TYPE_KEYS.filter((key) => key !== "unknown");

function typeOptionsFromStats(
  byType: Record<string, number> | undefined,
  t: TranslateFn,
): Array<{ key: string; label: string; count: number }> {
  const keys = [
    ...KNOWN_TYPE_KEYS,
    ...Object.keys(byType ?? {}).filter(
      (key) => !(KNOWN_TYPE_KEYS as readonly string[]).includes(key),
    ),
  ];
  return keys.map((key) => ({
    key,
    label: typeLabel(key, t),
    count: byType?.[key] ?? 0,
  }));
}

/** One selected type can be sent to the API; 0 or 2+ types fetch unfiltered. */
function serverTypeParam(selected: readonly string[]): string | undefined {
  return selected.length === 1 ? selected[0] : undefined;
}

function filterMemoriesByTypes(
  memories: MemoryBrowseItem[],
  selected: readonly string[],
): MemoryBrowseItem[] {
  if (selected.length <= 1) return memories;
  const allowed = new Set(selected);
  return memories.filter((memory) => allowed.has(memory.type));
}

function typeFilterCacheKey(selected: readonly string[]): string {
  return selected.length === 0 ? "all" : [...selected].sort().join(",");
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

const MemoryCard = memo(function MemoryCard({
  memory,
  expanded,
  onToggle,
}: {
  memory: MemoryBrowseItem;
  expanded: boolean;
  onToggle: (id: string) => void;
}) {
  const { t } = useTranslation();
  const typeKey = memoryTypeKey(memory.type);
  const text =
    memory.text || t("memoryviewer.empty.value", { defaultValue: "(empty)" });

  return (
    <Button
      variant="ghost"
      aria-expanded={expanded}
      className={`${MEMORY_FOCUS_CLASS} flex h-auto w-full flex-col items-stretch justify-start whitespace-normal rounded-sm bg-card/40 px-3.5 py-3 text-left font-normal transition-colors hover:bg-card/70`}
      onClick={() => onToggle(memory.id)}
      data-testid={`memory-card-${memory.id}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1.5 text-xs-tight text-muted">
          <span
            className={`memory-type-dot-${typeKey} inline-block h-2 w-2 rounded-full`}
          />
          {typeLabel(memory.type, t)}
        </span>
        {memory.source ? (
          <span className="text-xs-tight text-muted">{memory.source}</span>
        ) : null}
        <span className="ml-auto tabular-nums text-xs-tight text-muted">
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
              <span className="text-muted">
                {t("memoryviewer.field.entity", { defaultValue: "Entity" })}
              </span>{" "}
              <span className="font-mono text-2xs">{memory.entityId}</span>
            </div>
          ) : null}
          {memory.roomId ? (
            <div className="text-xs-tight text-muted">
              <span className="text-muted">
                {t("memoryviewer.field.room", { defaultValue: "Room" })}
              </span>{" "}
              <span className="font-mono text-2xs">{memory.roomId}</span>
            </div>
          ) : null}
          <div className="text-xs-tight text-muted">
            <span className="text-muted">
              {t("memoryviewer.field.created", { defaultValue: "Created" })}
            </span>{" "}
            {formatDateTime(memory.createdAt, {
              fallback: t("memoryviewer.unknown", { defaultValue: "unknown" }),
            })}
          </div>
          <div className="text-xs-tight text-muted">
            <span className="text-muted">
              {t("memoryviewer.field.id", { defaultValue: "ID" })}
            </span>{" "}
            <span className="font-mono text-2xs">{memory.id}</span>
          </div>
        </div>
      ) : null}
    </Button>
  );
});

// ── Memory Feed ──────────────────────────────────────────────────────────

function MemoryFeedPanel({ typeFilter }: { typeFilter: readonly string[] }) {
  const { t } = useTranslation();
  // Seed the first page from the shared cache so a revisit paints the
  // last-known feed instantly and revalidates silently. Pagination appends
  // (`before`) stay uncached — only the base page is the instant-revisit win.
  const feedCacheKey = `memory:feed:${typeFilterCacheKey(typeFilter)}`;
  const cachedFeed = getCached<MemoryFeedResponse>(feedCacheKey);
  const [loading, setLoading] = useState(!cachedFeed);
  const [feed, setFeed] = useState<MemoryBrowseItem[]>(
    cachedFeed?.data.memories ?? [],
  );
  const [hasMore, setHasMore] = useState(cachedFeed?.data.hasMore ?? false);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const loadingMore = useRef(false);

  const toggleExpanded = useCallback((id: string) => {
    setExpandedId((prev) => (prev === id ? null : id));
  }, []);

  const loadFeed = useCallback(
    async (before?: number, options?: { silent?: boolean }) => {
      if (loadingMore.current && before) return;
      if (before) loadingMore.current = true;
      else if (!options?.silent) setLoading(true);
      setError(null);

      try {
        const result: MemoryFeedResponse = await client.getMemoryFeed({
          type: serverTypeParam(typeFilter),
          limit: FEED_PAGE_SIZE,
          before,
        });
        const memories = filterMemoriesByTypes(result.memories, typeFilter);
        if (before) {
          // Cap retained items so a long pagination session can't grow the
          // feed unboundedly. 500 covers many pages of scrollback while
          // bounding memory; older items drop off the top.
          setFeed((prev) => [...prev, ...memories].slice(-FEED_MAX_ITEMS));
        } else {
          setFeed(memories);
          setCached(feedCacheKey, { ...result, memories });
        }
        setHasMore(result.hasMore);
      } catch (err) {
        setError(
          err instanceof Error
            ? err.message
            : t("memoryviewer.error.feed", {
                defaultValue:
                  "Unable to load the memory feed. Check the connection and try again.",
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

  // Poll for fresh memories so the feed stays current without a manual refresh;
  // pauses while the document is hidden and resumes on visibilitychange.
  useIntervalWhenDocumentVisible(() => {
    if (!loadingMore.current) void loadFeed(undefined, { silent: true });
  }, FEED_POLL_MS);

  const loadMore = () => {
    const last = feed[feed.length - 1];
    if (last) void loadFeed(last.createdAt);
  };

  if (loading && feed.length === 0) {
    return <ListSkeleton rows={6} />;
  }

  if (error) {
    return (
      <PagePanel.Notice
        tone="danger"
        actions={
          <Button
            type="button"
            size="sm"
            variant="outline"
            className={MEMORY_FOCUS_CLASS}
            onClick={() => void loadFeed()}
          >
            {t("memoryviewer.retry", { defaultValue: "Retry" })}
          </Button>
        }
      >
        {error}
      </PagePanel.Notice>
    );
  }

  if (feed.length === 0) {
    return (
      <PagePanel.FeatureEmpty
        className="memory-feed-empty min-h-[24rem]"
        features={MEMORY_FEED_EMPTY_FEATURES.map((feature) => ({
          ...feature,
          label: t(feature.labelKey, { defaultValue: feature.defaultLabel }),
        }))}
        icon={Brain}
        iconTone="bg-accent/12 text-accent"
        title={t("memoryviewer.noMemoriesYet", {
          defaultValue: "No memories yet",
        })}
        description={t("memoryviewer.empty.description", {
          defaultValue: "Chat with Eliza and memories will show up here.",
        })}
      >
        <Button
          type="button"
          className={MEMORY_FOCUS_CLASS}
          data-chat-open="true"
          onClick={dispatchChatOpen}
        >
          {t("memoryviewer.empty.askEliza", { defaultValue: "Ask Eliza" })}
        </Button>
      </PagePanel.FeatureEmpty>
    );
  }

  return (
    <div className="space-y-2" data-testid="memory-feed">
      {feed.map((memory) => (
        <MemoryCard
          key={memory.id}
          memory={memory}
          expanded={expandedId === memory.id}
          onToggle={toggleExpanded}
        />
      ))}
      {hasMore ? (
        <Button
          type="button"
          size="sm"
          variant="outline"
          className={`${MEMORY_FOCUS_CLASS} mt-3 w-full`}
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
  typeFilter: readonly string[];
  entityId: string | null;
  entityIds: string[] | null;
}) {
  const { t } = useTranslation();
  const [searchInput, setSearchInput] = useState("");
  const deferredSearch = useDeferredValue(searchInput);

  // The floating chat IS the memory-text search box while Browse is open (and
  // not scoped to a person — entity mode has no free-text search). Typing in the
  // composer drives `searchInput`; the binding clears when the view unmounts.
  const searchNoun = t("memoryviewer.searchNoun", {
    defaultValue: "memories",
  });
  const searchPlaceholder = t("memoryviewer.searchMemoryText", {
    defaultValue: "Search memory text…",
  });
  const chatBinding = useMemo(
    () =>
      entityId
        ? null
        : { placeholder: searchPlaceholder, onQuery: setSearchInput },
    [entityId, searchPlaceholder],
  );
  useRegisterViewChatBinding(chatBinding);
  // Cache key spans every fetch parameter so each filter/search/page combo
  // revisits instantly without colliding. Offset is appended per-call below.
  const typeKey = typeFilterCacheKey(typeFilter);
  const browseKeyBase = entityId
    ? `memory:browse:entity:${entityId}:${(entityIds ?? []).join(",")}:${typeKey}`
    : `memory:browse:all:${typeKey}:${deferredSearch.trim()}`;
  const cachedBrowse = getCached<MemoryBrowseResponse>(`${browseKeyBase}:0`);
  const [loading, setLoading] = useState(!cachedBrowse);
  const [result, setResult] = useState<MemoryBrowseResponse | null>(
    cachedBrowse?.data ?? null,
  );
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);

  const toggleExpanded = useCallback((id: string) => {
    setExpandedId((prev) => (prev === id ? null : id));
  }, []);

  const loadMemories = useCallback(
    async (pageOffset: number, options?: { silent?: boolean }) => {
      const cacheKey = `${browseKeyBase}:${pageOffset}`;
      if (!options?.silent) setLoading(true);
      setError(null);
      try {
        const resp: MemoryBrowseResponse = entityId
          ? await client.getMemoriesByEntity(entityId, {
              type: serverTypeParam(typeFilter),
              limit: BROWSE_PAGE_SIZE,
              offset: pageOffset,
              entityIds: entityIds ?? undefined,
            })
          : await client.browseMemories({
              type: serverTypeParam(typeFilter),
              q: deferredSearch.trim() || undefined,
              limit: BROWSE_PAGE_SIZE,
              offset: pageOffset,
            });
        const filtered = {
          ...resp,
          memories: filterMemoriesByTypes(resp.memories, typeFilter),
        };
        setResult(filtered);
        setCached(cacheKey, filtered);
      } catch (err) {
        setError(
          err instanceof Error
            ? err.message
            : t("memoryviewer.error.memories", {
                defaultValue:
                  "Unable to load memories. Check the connection and try again.",
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

  const prevControl = useAgentElement<HTMLButtonElement>({
    id: "memory-page-prev",
    role: "button",
    label: t("memoryviewer.prev", { defaultValue: "Prev" }),
    group: "memory-pager",
    description: "Go to the previous page of memories",
    onActivate: () => handlePage("prev"),
  });
  const nextControl = useAgentElement<HTMLButtonElement>({
    id: "memory-page-next",
    role: "button",
    label: t("memoryviewer.next", { defaultValue: "Next" }),
    group: "memory-pager",
    description: "Go to the next page of memories",
    onActivate: () => handlePage("next"),
  });

  return (
    <div className="space-y-3" data-testid="memory-browser">
      {entityId ? null : (
        <ChatSearchHint noun={searchNoun} query={searchInput} />
      )}
      {loading && !result ? (
        <ListSkeleton rows={6} />
      ) : error ? (
        <PagePanel.Notice
          tone="danger"
          actions={
            <Button
              type="button"
              size="sm"
              variant="outline"
              className={MEMORY_FOCUS_CLASS}
              onClick={() => void loadMemories(offset)}
            >
              {t("memoryviewer.retry", { defaultValue: "Retry" })}
            </Button>
          }
        >
          {error}
        </PagePanel.Notice>
      ) : !result || result.memories.length === 0 ? (
        <PagePanel.FeatureEmpty
          icon={Search}
          iconTone="bg-bg-hover text-muted"
          title={t("memoryviewer.noMemoriesFound", {
            defaultValue: "No memories found",
          })}
          description={t("memoryviewer.noMemoriesFoundDescription", {
            defaultValue:
              "Try another type filter, or search by typing in the chat.",
          })}
        >
          <div className="flex flex-wrap justify-center gap-x-4 gap-y-1.5">
            {TYPE_KEYS.slice(0, 4).map((type) => (
              <span
                key={type}
                className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap text-xs-tight text-muted"
              >
                <span
                  className={`memory-type-dot-${type} inline-block h-2 w-2 rounded-full`}
                />
                {typeLabel(type, t)}
              </span>
            ))}
          </div>
          {entityId ? null : (
            <Button
              type="button"
              className={`${MEMORY_FOCUS_CLASS} mt-4`}
              data-chat-open="true"
              onClick={dispatchChatOpen}
            >
              {t("memoryviewer.empty.askEliza", { defaultValue: "Ask Eliza" })}
            </Button>
          )}
        </PagePanel.FeatureEmpty>
      ) : (
        <>
          <div className="flex items-center justify-between gap-3 text-xs-tight text-muted">
            <span className="tabular-nums">
              {result.totalIsExact === false
                ? t("memoryviewer.pageRangeIncomplete", {
                    start: offset + 1,
                    end: offset + result.memories.length,
                    total: result.total,
                    defaultValue: "{{start}}–{{end}} of at least {{total}}",
                  })
                : t("memoryviewer.pageRange", {
                    start: offset + 1,
                    end: offset + result.memories.length,
                    total: result.total,
                    defaultValue: "{{start}}–{{end}} of {{total}}",
                  })}
            </span>
            <div className="flex gap-2">
              <Button
                ref={prevControl.ref}
                type="button"
                size="sm"
                variant="ghost"
                className={MEMORY_FOCUS_CLASS}
                disabled={offset === 0}
                onClick={() => handlePage("prev")}
                {...prevControl.agentProps}
              >
                {t("memoryviewer.prev", { defaultValue: "Prev" })}
              </Button>
              <Button
                ref={nextControl.ref}
                type="button"
                size="sm"
                variant="ghost"
                className={MEMORY_FOCUS_CLASS}
                disabled={
                  result.hasMore === undefined
                    ? offset + BROWSE_PAGE_SIZE >= result.total
                    : !result.hasMore
                }
                onClick={() => handlePage("next")}
                {...nextControl.agentProps}
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
              onToggle={toggleExpanded}
            />
          ))}
        </>
      )}
    </div>
  );
}

// ── Sidebar controls ─────────────────────────────────────────────────────

const sidebarTriggerClass = `${MEMORY_FOCUS_CLASS} h-11 w-full justify-between gap-2 rounded-sm border border-border bg-card/40 px-3 text-start text-sm font-medium text-txt hover:bg-card/70`;

function TypeFilterMenu({
  types,
  selected,
  onChange,
  allLabel,
  typeCountLabel,
  filterLabel,
}: {
  types: Array<{ key: string; label: string; count: number }>;
  selected: readonly string[];
  onChange: (next: string[]) => void;
  allLabel: string;
  typeCountLabel: (count: number) => string;
  filterLabel: string;
}) {
  const selectedSet = new Set(selected);
  const triggerLabel =
    selected.length === 0
      ? allLabel
      : selected.length === 1
        ? (types.find((type) => type.key === selected[0])?.label ?? allLabel)
        : typeCountLabel(selected.length);
  const singleType = selected.length === 1 ? selected[0] : null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          className={sidebarTriggerClass}
          aria-label={filterLabel}
          data-testid="memory-type-filter-trigger"
        >
          <span className="flex min-w-0 items-center gap-2">
            {singleType ? (
              <span
                className={`memory-type-dot-${memoryTypeKey(singleType)} inline-block h-2 w-2 shrink-0 rounded-full`}
              />
            ) : null}
            <span className="truncate">{triggerLabel}</span>
          </span>
          <ChevronDown className="h-4 w-4 shrink-0 text-muted" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="w-[var(--radix-dropdown-menu-trigger-width)]"
      >
        <DropdownMenuLabel>{filterLabel}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {types.map((type) => (
          <DropdownMenuCheckboxItem
            key={type.key}
            checked={selectedSet.has(type.key)}
            onSelect={(event) => event.preventDefault()}
            onCheckedChange={(checked) => {
              onChange(
                checked
                  ? [...selected, type.key]
                  : selected.filter((key) => key !== type.key),
              );
            }}
            data-testid={`memory-type-filter-${type.key}`}
          >
            <span className="flex min-w-0 flex-1 items-center gap-2">
              <span
                className={`memory-type-dot-${memoryTypeKey(type.key)} inline-block h-2 w-2 shrink-0 rounded-full`}
              />
              <span className="min-w-0 truncate">{type.label}</span>
            </span>
            <span className="ms-auto tabular-nums text-muted">
              {type.count}
            </span>
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const PeoplePicker = memo(function PeoplePicker({
  people,
  selectedId,
  onSelect,
  onClear,
  everyoneLabel,
  searchLabel,
  personLabel,
}: {
  people: RelationshipsPersonSummary[];
  selectedId: string | null;
  onSelect: (person: RelationshipsPersonSummary) => void;
  onClear: () => void;
  everyoneLabel: string;
  searchLabel: string;
  personLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const selected = selectedId
    ? (people.find((person) => person.primaryEntityId === selectedId) ?? null)
    : null;
  const needle = query.trim().toLowerCase();
  const visible = needle
    ? people.filter((person) =>
        person.displayName.toLowerCase().includes(needle),
      )
    : people;

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery("");
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          className={sidebarTriggerClass}
          aria-label={personLabel}
          data-testid="memory-person-picker-trigger"
        >
          <span className="flex min-w-0 items-center gap-2">
            {selected ? (
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-sm bg-bg-accent text-2xs font-semibold">
                {selected.displayName.charAt(0).toUpperCase()}
              </span>
            ) : null}
            <span className="truncate">
              {selected ? selected.displayName : everyoneLabel}
            </span>
          </span>
          <ChevronDown className="h-4 w-4 shrink-0 text-muted" aria-hidden />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="min-w-[14rem] space-y-2 p-2">
        <Input
          density="compact"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={searchLabel}
          aria-label={searchLabel}
          data-testid="memory-person-search"
        />
        <div className="max-h-56 overflow-auto">
          <button
            type="button"
            className={`${MEMORY_FOCUS_CLASS} flex min-h-11 w-full items-center rounded-sm px-2 text-start text-sm ${
              selectedId === null
                ? "bg-accent/14 text-txt"
                : "text-txt hover:bg-bg-hover"
            }`}
            onClick={() => {
              onClear();
              setOpen(false);
            }}
          >
            {everyoneLabel}
          </button>
          {visible.map((person) => {
            const active = person.primaryEntityId === selectedId;
            return (
              <button
                key={person.groupId}
                type="button"
                className={`${MEMORY_FOCUS_CLASS} flex min-h-11 w-full items-center gap-2 rounded-sm px-2 text-start text-sm ${
                  active
                    ? "bg-accent/14 text-txt"
                    : "text-txt hover:bg-bg-hover"
                }`}
                onClick={() => {
                  onSelect(person);
                  setOpen(false);
                }}
              >
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-sm bg-bg-accent text-2xs font-semibold">
                  {person.displayName.charAt(0).toUpperCase()}
                </span>
                <span className="min-w-0 flex-1 truncate">
                  {person.displayName}
                </span>
                {person.factCount > 0 ? (
                  <span className="tabular-nums text-xs text-muted">
                    {person.factCount}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
});

export function MemoryViewerView({
  contentHeader,
}: {
  contentHeader?: ReactNode;
} = {}) {
  const t = useAppSelector((s) => s.t);
  const setTab = useAppSelector((s) => s.setTab);
  // Mobile: the people/filter sidebar opens from a compact "People" control in
  // the view header (never an inline trigger between the header and content).
  const mobileSidebarHeader = useWorkspaceMobileSidebarHeader();
  const [viewMode, setViewMode] = useState<ViewMode>("feed");
  const [typeFilter, setTypeFilter] = useState<string[]>([]);
  const [stats, setStats] = useState<MemoryStatsResponse | null>(null);
  const [statsError, setStatsError] = useState(false);

  // People list for person-centric view. `peopleError` keeps a failed load
  // visually distinct from the designed "No people yet." empty state — a
  // 5xx/transport failure must never render as healthy-empty (three-state rule).
  const [people, setPeople] = useState<RelationshipsPersonSummary[]>([]);
  const [peopleLoading, setPeopleLoading] = useState(true);
  const [peopleError, setPeopleError] = useState(false);
  const [selectedPersonId, setSelectedPersonId] = useState<string | null>(null);

  const loadStats = useCallback(() => {
    void client
      .getMemoryStats()
      .then((s) => {
        setStats(s);
        setStatsError(false);
      })
      .catch(() => {
        // error-policy:J4 stats are a sidebar summary — show the error row
        // and keep the rest of the page usable.
        setStatsError(true);
      });
  }, []);

  const loadPeople = useCallback(() => {
    setPeopleLoading(true);
    setPeopleError(false);
    void client
      .getRelationshipsPeople({ limit: 200 })
      .then((result) => {
        setPeople(result.people);
        setPeopleError(false);
      })
      .catch((err: unknown) => {
        // error-policy:J4 a 404 means the relationships surface isn't hosted
        // here — the designed empty state is correct. Anything else (5xx,
        // transport, parse) flips the sidebar into an explicit error render
        // instead of masquerading as "No people yet."
        setPeople([]);
        setPeopleError(!(isApiError(err) && err.status === 404));
      })
      .finally(() => setPeopleLoading(false));
  }, []);

  useEffect(() => {
    loadStats();
  }, [loadStats]);

  useEffect(() => {
    loadPeople();
  }, [loadPeople]);

  const selectedPerson = selectedPersonId
    ? (people.find((p) => p.primaryEntityId === selectedPersonId) ?? null)
    : null;

  // All entity IDs for the selected person (multi-identity support)
  const selectedEntityIds = selectedPerson?.memberEntityIds ?? null;

  const handleSelectPerson = useCallback(
    (person: RelationshipsPersonSummary) => {
      setSelectedPersonId(person.primaryEntityId);
      setViewMode("browse");
    },
    [],
  );

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

  const viewModeControl = useAgentElement<HTMLDivElement>({
    id: "memory-view-mode",
    role: "toggle",
    label: t("memoryviewer.viewMode", { defaultValue: "Memory view mode" }),
    group: "memory-toolbar",
    status: viewMode === "browse" ? "active" : "inactive",
    description: "Switch between the memory feed and the memory browser",
    onActivate: () =>
      setViewMode((prev) => (prev === "feed" ? "browse" : "feed")),
  });

  const typeOptions = typeOptionsFromStats(stats?.byType, t);

  const sidebar = (
    <AppPageSidebar
      testId="memory-viewer-sidebar"
      collapsible
      contentIdentity="memory-viewer"
      mobileTitle={t("memoryviewer.people", { defaultValue: "People" })}
    >
      <SidebarPanel>
        <div className="flex flex-col gap-6 px-1 pt-2">
          <div className="space-y-2">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-xs-tight text-muted">
                {t("memoryviewer.total", { defaultValue: "Total" })}
              </span>
              <span className="text-sm font-semibold tabular-nums text-txt">
                {stats ? stats.total : "—"}
              </span>
            </div>
            {statsError ? (
              <div className="space-y-2 text-xs text-danger">
                <div>
                  {t("memoryviewer.statsError", {
                    defaultValue:
                      "Unable to load memory stats. Check the connection and try again.",
                  })}
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className={MEMORY_FOCUS_CLASS}
                  onClick={loadStats}
                >
                  {t("memoryviewer.retry", { defaultValue: "Retry" })}
                </Button>
              </div>
            ) : null}
            <div className="text-xs-tight text-muted">
              {t("memoryviewer.filterByType", {
                defaultValue: "Filter by type",
              })}
            </div>
            <TypeFilterMenu
              types={typeOptions}
              selected={typeFilter}
              onChange={setTypeFilter}
              allLabel={t("memoryviewer.allTypes", {
                defaultValue: "All types",
              })}
              typeCountLabel={(count) =>
                t("memoryviewer.typeCount", {
                  count,
                  defaultValue: "{{count}} types",
                })
              }
              filterLabel={t("memoryviewer.filterByType", {
                defaultValue: "Filter by type",
              })}
            />
          </div>

          <div className="space-y-2">
            <div className="text-xs-tight text-muted">
              {t("memoryviewer.person", { defaultValue: "Person" })}
            </div>
            {peopleLoading ? (
              <div className="text-xs text-muted">
                {t("memoryviewer.loading", { defaultValue: "Loading…" })}
              </div>
            ) : peopleError ? (
              <div
                data-testid="memory-people-error"
                className="space-y-2 text-xs text-danger"
              >
                <div>
                  {t("memoryviewer.peopleError", {
                    defaultValue:
                      "Unable to load people. Check the connection and try again.",
                  })}
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className={MEMORY_FOCUS_CLASS}
                  onClick={loadPeople}
                >
                  {t("memoryviewer.retry", { defaultValue: "Retry" })}
                </Button>
              </div>
            ) : people.length === 0 ? (
              <div className="space-y-2">
                <div className="text-xs text-muted">
                  {t("memoryviewer.noPeopleYet", {
                    defaultValue: "No people yet.",
                  })}
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className={`${MEMORY_FOCUS_CLASS} h-auto px-0 text-xs-tight`}
                  onClick={() => setTab("relationships")}
                >
                  {t("memoryviewer.openRelationships", {
                    defaultValue: "Open Relationships",
                  })}
                </Button>
              </div>
            ) : (
              <>
                <div className="flex items-center gap-2">
                  <div className="min-w-0 flex-1">
                    <PeoplePicker
                      people={people}
                      selectedId={selectedPersonId}
                      onSelect={handleSelectPerson}
                      onClear={handleClearPerson}
                      everyoneLabel={t("memoryviewer.everyone", {
                        defaultValue: "Everyone",
                      })}
                      searchLabel={t("memoryviewer.SearchPeople", {
                        defaultValue: "Search people…",
                      })}
                      personLabel={t("memoryviewer.person", {
                        defaultValue: "Person",
                      })}
                    />
                  </div>
                  {selectedPersonId ? (
                    <Button
                      type="button"
                      size="icon-sm"
                      variant="ghost"
                      className={MEMORY_FOCUS_CLASS}
                      aria-label={t("memoryviewer.clear", {
                        defaultValue: "Clear",
                      })}
                      onClick={handleClearPerson}
                    >
                      <X className="h-4 w-4" aria-hidden />
                    </Button>
                  ) : null}
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className={`${MEMORY_FOCUS_CLASS} h-auto justify-start px-0 text-xs-tight text-muted hover:text-txt`}
                  onClick={() => setTab("relationships")}
                >
                  {t("memoryviewer.openRelationships", {
                    defaultValue: "Open Relationships",
                  })}
                </Button>
              </>
            )}
          </div>
        </div>
      </SidebarPanel>
    </AppPageSidebar>
  );

  return (
    <ShellViewAgentSurface viewId="memories">
      <div className="flex h-full min-h-0 w-full flex-col">
        <ViewHeader
          title={t("memoryviewer.title", { defaultValue: "Memories" })}
          right={
            <ViewHeaderSidebarTrigger
              control={mobileSidebarHeader.control}
              className={MEMORY_FOCUS_CLASS}
            />
          }
        />
        <div className="min-h-0 flex-1 overflow-hidden">
          <WorkspaceMobileSidebarScope controls={mobileSidebarHeader.controls}>
            <PageLayout
              sidebar={sidebar}
              contentHeader={contentHeader}
              data-testid="memory-viewer-view"
            >
              <div className="flex min-h-0 flex-1 flex-col gap-5">
                <div className="flex w-full flex-col items-start gap-3">
                  <div
                    ref={viewModeControl.ref}
                    className="min-h-11"
                    {...viewModeControl.agentProps}
                  >
                    <SegmentedControl
                      value={viewMode}
                      onValueChange={(v) => setViewMode(v as ViewMode)}
                      items={viewModeItems}
                      buttonClassName={`${MEMORY_FOCUS_CLASS} min-h-11 px-4 py-2`}
                    />
                  </div>
                  {selectedPerson ? (
                    <div className="flex items-center gap-2 text-sm text-muted">
                      {t("memoryviewer.filteredTo", {
                        defaultValue: "Filtered to",
                      })}
                      <MetaPill compact>{selectedPerson.displayName}</MetaPill>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        className={`${MEMORY_FOCUS_CLASS} min-h-11 px-3 text-xs-tight`}
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
          </WorkspaceMobileSidebarScope>
        </div>
      </div>
    </ShellViewAgentSurface>
  );
}
