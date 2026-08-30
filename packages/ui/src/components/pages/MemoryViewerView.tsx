/**
 * Memories page: browses the agent's memory store in three modes: a recent
 * feed, a filtered browse list, and a person-centric view scoped to a
 * relationship's member entity ids. Pulls stats, people (via the relationships
 * API), and memory rows from the typed client. On mobile the people/filter
 * sidebar is opened from a compact control in the view header rather than an
 * inline trigger.
 */

import { AlertTriangle, Brain, ChevronDown, Search, X } from "lucide-react";
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
import {
  isCapabilityWarmupAbort,
  useAbortableCapabilityWarmup,
} from "../../hooks/runtime-capability-retry";
import { useActiveAgentAuthority } from "../../hooks/useActiveAgentAuthority";
import { useIntervalWhenDocumentVisible } from "../../hooks/useDocumentVisibility";
import {
  FramedPage,
  FramedPageBody,
  FramedPageHeader,
} from "../../layouts/framed-page";
import { WorkspaceLayout } from "../../layouts/workspace-layout";
import { useWorkspaceMobileSidebarHeader } from "../../layouts/workspace-layout/workspace-mobile-sidebar-controls.hooks";
import { WorkspaceMobileSidebarScope } from "../../layouts/workspace-layout/workspace-mobile-sidebar-scope";
import { cn } from "../../lib/utils";
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
import { AppPageSidebar } from "../shared/AppPageSidebar";
import { ViewHeaderSidebarTrigger } from "../shared/ViewHeaderSidebarTrigger";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
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

const FEED_PAGE_SIZE = 50;
/** Max retained feed items (10 pages) so long sessions stay bounded. */
const FEED_MAX_ITEMS = 500;
/** Poll interval to keep the feed fresh in place of a manual refresh button. */
const FEED_POLL_MS = 30_000;
const BROWSE_PAGE_SIZE = 50;
/** Filled accent focus keeps keyboard position visible without a ring. */
const MEMORY_FOCUS_CLASS = "keyboard-focus-surface";

interface MemoryIssue {
  title: string;
  description: string;
  retryable: boolean;
}

function isMemoryRuntimeUnavailable(error: unknown): boolean {
  return (
    isApiError(error) &&
    (error.code === "memory_runtime_unavailable" || error.status === 404)
  );
}

function isRelationshipsRuntimeUnavailable(error: unknown): boolean {
  return (
    isApiError(error) &&
    (error.code === "relationships_runtime_unavailable" || error.status === 404)
  );
}

function memoryIssue(error: unknown, t: TranslateFn): MemoryIssue {
  if (isApiError(error) && (error.status === 401 || error.status === 403)) {
    return {
      title: t("memoryviewer.accessUnavailable", {
        defaultValue: "Memories aren't available",
      }),
      description: t("memoryviewer.accessUnavailableDescription", {
        defaultValue: "This account can't access these memories.",
      }),
      retryable: false,
    };
  }

  if (isApiError(error) && error.status === 429) {
    return {
      title: t("memoryviewer.busy", { defaultValue: "Memories are busy" }),
      description: t("memoryviewer.busyDescription", {
        defaultValue: "Wait a moment, then try again.",
      }),
      retryable: true,
    };
  }

  if (
    error instanceof TypeError ||
    (isApiError(error) && (error.status ?? 0) >= 500)
  ) {
    return {
      title: t("memoryviewer.temporarilyUnavailable", {
        defaultValue: "Memories are temporarily unavailable",
      }),
      description: t("memoryviewer.temporarilyUnavailableDescription", {
        defaultValue: "Reconnect to Eliza, then try again.",
      }),
      retryable: true,
    };
  }

  return {
    title: t("memoryviewer.couldNotLoad", {
      defaultValue: "Memories couldn't load",
    }),
    description: t("memoryviewer.couldNotLoadDescription", {
      defaultValue: "Try again in a moment.",
    }),
    retryable: true,
  };
}

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

function memoryCopy(
  memory: MemoryBrowseItem,
  t: TranslateFn,
): {
  title: string | null;
  preview: string;
  fullText: string;
} {
  const fullText = memory.text.trim();
  if (!fullText) {
    const empty = t("memoryviewer.empty.value", {
      defaultValue: "Empty memory",
    });
    return { title: null, preview: empty, fullText: empty };
  }

  const lines = fullText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const firstLine = lines[0] ?? fullText;
  const hasUsefulDocumentTitle =
    memory.type === "documents" && lines.length > 1 && firstLine.length <= 96;
  const previewSource = hasUsefulDocumentTitle
    ? lines.slice(1).join(" ")
    : fullText.replace(/\s+/g, " ");

  return {
    title: hasUsefulDocumentTitle ? firstLine : null,
    preview: truncateText(previewSource, 220),
    fullText,
  };
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
  const copy = memoryCopy(memory, t);

  return (
    <Button
      variant="selectionNeutral"
      size="card"
      align="start"
      aria-expanded={expanded}
      className={`${MEMORY_FOCUS_CLASS} w-full`}
      onClick={() => onToggle(memory.id)}
      data-testid={`memory-card-${memory.id}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1.5 text-xs-tight text-[color:var(--settings-muted)]">
          <Badge asChild variant="statusDotMuted">
            <span className={`memory-type-dot-${typeKey}`} />
          </Badge>
          {typeLabel(memory.type, t)}
        </span>
        <span className="ml-auto tabular-nums text-xs-tight text-[color:var(--settings-muted)]">
          {formatRelativeTime(memory.createdAt, t)}
        </span>
      </div>
      {copy.title ? (
        <div className="mt-2 text-sm font-semibold leading-5 text-[color:var(--settings-foreground)]">
          {copy.title}
        </div>
      ) : null}
      <div
        className={cn(
          copy.title ? "mt-1" : "mt-2",
          "max-w-[72ch] whitespace-pre-wrap text-sm leading-6 text-[color:var(--settings-foreground)]",
        )}
      >
        {expanded ? copy.fullText : copy.preview}
      </div>
      {expanded ? (
        <Card asChild variant="topDivider" className="mt-3 pt-3">
          <div>
            <div className="text-xs-tight text-[color:var(--settings-muted)]">
              <span className="text-muted">
                {t("memoryviewer.field.created", { defaultValue: "Created" })}
              </span>{" "}
              {formatDateTime(memory.createdAt, {
                fallback: t("memoryviewer.unknown", {
                  defaultValue: "unknown",
                }),
              })}
            </div>
          </div>
        </Card>
      ) : null}
    </Button>
  );
});

function MemoryListSurface({
  memories,
  expandedId,
  onToggle,
  testId,
}: {
  memories: MemoryBrowseItem[];
  expandedId: string | null;
  onToggle: (id: string) => void;
  testId?: string;
}) {
  return (
    <Card
      variant="panel"
      radius="xlarge"
      className="overflow-hidden"
      data-testid={testId}
    >
      {memories.map((memory, index) => (
        <Card
          asChild
          key={memory.id}
          variant={index > 0 ? "topDivider" : "transparentSquare"}
        >
          <div>
            <MemoryCard
              memory={memory}
              expanded={expandedId === memory.id}
              onToggle={onToggle}
            />
          </div>
        </Card>
      ))}
    </Card>
  );
}

function MemoryStateSurface({
  children,
  plain = false,
}: {
  children: ReactNode;
  plain?: boolean;
}) {
  if (plain) {
    return <div className="overflow-hidden">{children}</div>;
  }
  return (
    <Card variant="panel" radius="xlarge" className="overflow-hidden">
      {children}
    </Card>
  );
}

// ── Memory Feed ──────────────────────────────────────────────────────────

function MemoryFeedPanel({
  typeFilter,
  authority,
  onRuntimeUnavailable,
}: {
  typeFilter: readonly string[];
  authority: string;
  onRuntimeUnavailable: () => void;
}) {
  const { t } = useTranslation();
  const runCapabilityWarmup = useAbortableCapabilityWarmup();
  // Seed the first page from the shared cache so a revisit paints the
  // last-known feed instantly and revalidates silently. Pagination appends
  // (`before`) stay uncached; only the base page is the instant-revisit win.
  const feedCacheKey = `memory:${authority}:feed:${typeFilterCacheKey(typeFilter)}`;
  const cachedFeed = getCached<MemoryFeedResponse>(feedCacheKey);
  const [loading, setLoading] = useState(!cachedFeed);
  const [feed, setFeed] = useState<MemoryBrowseItem[]>(
    cachedFeed?.data.memories ?? [],
  );
  const [hasMore, setHasMore] = useState(cachedFeed?.data.hasMore ?? false);
  const [error, setError] = useState<MemoryIssue | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const loadingMore = useRef(false);

  const toggleExpanded = useCallback((id: string) => {
    setExpandedId((prev) => (prev === id ? null : id));
  }, []);

  const loadFeed = useCallback(
    async (
      before?: { createdAt: number; id: string },
      options?: { silent?: boolean },
    ) => {
      if (loadingMore.current && before) return;
      let lifecycleAborted = false;
      if (before) loadingMore.current = true;
      else if (!options?.silent) setLoading(true);
      setError(null);

      try {
        const result: MemoryFeedResponse = await runCapabilityWarmup(() =>
          client.getMemoryFeed({
            type: serverTypeParam(typeFilter),
            limit: FEED_PAGE_SIZE,
            before: before?.createdAt,
            beforeId: before?.id,
          }),
        );
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
        if (isCapabilityWarmupAbort(err)) {
          lifecycleAborted = true;
          return;
        }
        if (isMemoryRuntimeUnavailable(err)) {
          onRuntimeUnavailable();
          return;
        }
        setError(memoryIssue(err, t));
      } finally {
        if (!lifecycleAborted) {
          setLoading(false);
          loadingMore.current = false;
        }
      }
    },
    [typeFilter, t, feedCacheKey, onRuntimeUnavailable, runCapabilityWarmup],
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
    if (last) void loadFeed({ createdAt: last.createdAt, id: last.id });
  };

  if (loading && feed.length === 0) {
    return (
      <MemoryStateSurface>
        <div className="p-4 min-[700px]:p-5">
          <ListSkeleton rows={6} />
        </div>
      </MemoryStateSurface>
    );
  }

  if (error) {
    return (
      <MemoryStateSurface>
        <PagePanel.ContentState
          state="error"
          placement="workspace"
          icon={<AlertTriangle className="size-5" />}
          title={error.title}
          description={error.description}
          action={
            error.retryable ? (
              <Button
                type="button"
                size="touch"
                variant="outline"
                className={MEMORY_FOCUS_CLASS}
                onClick={() => void loadFeed()}
              >
                {t("memoryviewer.retry", { defaultValue: "Retry" })}
              </Button>
            ) : undefined
          }
        />
      </MemoryStateSurface>
    );
  }

  if (feed.length === 0) {
    return (
      <MemoryStateSurface plain>
        <PagePanel.ContentState
          state="empty"
          placement="workspace"
          className="min-h-[20rem]"
          icon={<Brain className="size-5" />}
          title={t("memoryviewer.noMemoriesYet", {
            defaultValue: "No memories yet",
          })}
          description={t("memoryviewer.empty.description", {
            defaultValue: "Chat with Eliza and memories will appear here.",
          })}
          action={
            <Button
              type="button"
              className={MEMORY_FOCUS_CLASS}
              data-chat-open="true"
              onClick={dispatchChatOpen}
            >
              {t("memoryviewer.empty.askEliza", { defaultValue: "Ask Eliza" })}
            </Button>
          }
        />
      </MemoryStateSurface>
    );
  }

  return (
    <div className="space-y-3">
      <MemoryListSurface
        memories={feed}
        expandedId={expandedId}
        onToggle={toggleExpanded}
        testId="memory-feed"
      />
      {hasMore ? (
        <Button
          type="button"
          size="touch"
          variant="outline"
          className={`${MEMORY_FOCUS_CLASS} w-full`}
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
  authority,
  onRuntimeUnavailable,
}: {
  typeFilter: readonly string[];
  entityId: string | null;
  entityIds: string[] | null;
  authority: string;
  onRuntimeUnavailable: () => void;
}) {
  const { t } = useTranslation();
  const runCapabilityWarmup = useAbortableCapabilityWarmup();
  const [searchInput, setSearchInput] = useState("");
  const deferredSearch = useDeferredValue(searchInput);

  // The floating chat IS the memory-text search box while Browse is open (and
  // not scoped to a person because entity mode has no free-text search). Typing in the
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
    ? `memory:${authority}:browse:entity:${entityId}:${(entityIds ?? []).join(",")}:${typeKey}`
    : `memory:${authority}:browse:all:${typeKey}:${deferredSearch.trim()}`;
  const cachedBrowse = getCached<MemoryBrowseResponse>(`${browseKeyBase}:0`);
  const [loading, setLoading] = useState(!cachedBrowse);
  const [result, setResult] = useState<MemoryBrowseResponse | null>(
    cachedBrowse?.data ?? null,
  );
  const [error, setError] = useState<MemoryIssue | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);

  const toggleExpanded = useCallback((id: string) => {
    setExpandedId((prev) => (prev === id ? null : id));
  }, []);

  const loadMemories = useCallback(
    async (pageOffset: number, options?: { silent?: boolean }) => {
      const cacheKey = `${browseKeyBase}:${pageOffset}`;
      let lifecycleAborted = false;
      if (!options?.silent) setLoading(true);
      setError(null);
      try {
        const resp: MemoryBrowseResponse = await runCapabilityWarmup(() =>
          entityId
            ? client.getMemoriesByEntity(entityId, {
                type: serverTypeParam(typeFilter),
                limit: BROWSE_PAGE_SIZE,
                offset: pageOffset,
                entityIds: entityIds ?? undefined,
              })
            : client.browseMemories({
                type: serverTypeParam(typeFilter),
                q: deferredSearch.trim() || undefined,
                limit: BROWSE_PAGE_SIZE,
                offset: pageOffset,
              }),
        );
        const filtered = {
          ...resp,
          memories: filterMemoriesByTypes(resp.memories, typeFilter),
        };
        setResult(filtered);
        setCached(cacheKey, filtered);
      } catch (err) {
        if (isCapabilityWarmupAbort(err)) {
          lifecycleAborted = true;
          return;
        }
        if (isMemoryRuntimeUnavailable(err)) {
          onRuntimeUnavailable();
          return;
        }
        setError(memoryIssue(err, t));
      } finally {
        if (!lifecycleAborted) setLoading(false);
      }
    },
    [
      typeFilter,
      entityId,
      entityIds,
      deferredSearch,
      t,
      browseKeyBase,
      onRuntimeUnavailable,
      runCapabilityWarmup,
    ],
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
        <MemoryStateSurface>
          <div className="p-4 min-[700px]:p-5">
            <ListSkeleton rows={6} />
          </div>
        </MemoryStateSurface>
      ) : error ? (
        <MemoryStateSurface>
          <PagePanel.ContentState
            state="error"
            placement="workspace"
            icon={<AlertTriangle className="size-5" />}
            title={error.title}
            description={error.description}
            action={
              error.retryable ? (
                <Button
                  type="button"
                  size="touch"
                  variant="outline"
                  className={MEMORY_FOCUS_CLASS}
                  onClick={() => void loadMemories(offset)}
                >
                  {t("memoryviewer.retry", { defaultValue: "Retry" })}
                </Button>
              ) : undefined
            }
          />
        </MemoryStateSurface>
      ) : !result || result.memories.length === 0 ? (
        <MemoryStateSurface plain>
          <PagePanel.ContentState
            state="empty"
            placement="workspace"
            className="min-h-[20rem]"
            icon={<Search className="size-5" />}
            title={t("memoryviewer.noMemoriesFound", {
              defaultValue: "No memories found",
            })}
            description={
              entityId
                ? t("memoryviewer.noPersonMemoriesFoundDescription", {
                    defaultValue:
                      "This person doesn't have any matching memories.",
                  })
                : t("memoryviewer.noMemoriesFoundDescription", {
                    defaultValue:
                      "Try another filter or search from the chat bar.",
                  })
            }
            action={
              entityId ? undefined : (
                <Button
                  type="button"
                  className={MEMORY_FOCUS_CLASS}
                  data-chat-open="true"
                  onClick={dispatchChatOpen}
                >
                  {t("memoryviewer.empty.askEliza", {
                    defaultValue: "Ask Eliza",
                  })}
                </Button>
              )
            }
          />
        </MemoryStateSurface>
      ) : (
        <>
          <div className="flex items-center justify-between gap-3 text-xs-tight text-[color:var(--settings-muted)]">
            <span className="tabular-nums">
              {result.totalIsExact === false
                ? t("memoryviewer.pageRangeIncomplete", {
                    start: offset + 1,
                    end: offset + result.memories.length,
                    total: result.total,
                    defaultValue: "{{start}}-{{end}} of at least {{total}}",
                  })
                : t("memoryviewer.pageRange", {
                    start: offset + 1,
                    end: offset + result.memories.length,
                    total: result.total,
                    defaultValue: "{{start}}-{{end}} of {{total}}",
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
          <MemoryListSurface
            memories={result.memories}
            expandedId={expandedId}
            onToggle={toggleExpanded}
          />
        </>
      )}
    </div>
  );
}

// ── Sidebar controls ─────────────────────────────────────────────────────

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
          variant="outline"
          size="memorySidebar"
          className={MEMORY_FOCUS_CLASS}
          aria-label={filterLabel}
          data-testid="memory-type-filter-trigger"
        >
          <span className="flex min-w-0 items-center gap-2">
            {singleType ? (
              <span
                className={`memory-type-dot-${memoryTypeKey(singleType)} inline-block size-2 shrink-0 rounded-full`}
              />
            ) : null}
            <span className="truncate">{triggerLabel}</span>
          </span>
          <ChevronDown className="size-4 shrink-0 text-muted" aria-hidden />
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
                className={`memory-type-dot-${memoryTypeKey(type.key)} inline-block size-2 shrink-0 rounded-full`}
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
          variant="outline"
          size="memorySidebar"
          className={MEMORY_FOCUS_CLASS}
          aria-label={personLabel}
          data-testid="memory-person-picker-trigger"
        >
          <span className="flex min-w-0 items-center gap-2">
            {selected ? (
              <span className="flex size-6 shrink-0 items-center justify-center rounded-sm bg-accent-subtle text-2xs font-semibold text-[color:var(--settings-foreground)]">
                {selected.displayName.charAt(0).toUpperCase()}
              </span>
            ) : null}
            <span className="truncate">
              {selected ? selected.displayName : everyoneLabel}
            </span>
          </span>
          <ChevronDown className="size-4 shrink-0 text-muted" aria-hidden />
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
          <Button
            type="button"
            variant="selectionNeutral"
            size="touch"
            align="start"
            data-state={selectedId === null ? "on" : "off"}
            className={`${MEMORY_FOCUS_CLASS} w-full`}
            onClick={() => {
              onClear();
              setOpen(false);
            }}
          >
            {everyoneLabel}
          </Button>
          {visible.map((person) => {
            const active = person.primaryEntityId === selectedId;
            return (
              <Button
                key={person.groupId}
                type="button"
                variant="selectionNeutral"
                size="touch"
                align="start"
                data-state={active ? "on" : "off"}
                className={`${MEMORY_FOCUS_CLASS} w-full`}
                onClick={() => {
                  onSelect(person);
                  setOpen(false);
                }}
              >
                <span className="flex size-6 shrink-0 items-center justify-center rounded-sm bg-accent-subtle text-2xs font-semibold text-[color:var(--settings-foreground)]">
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
              </Button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
});

export interface MemoryViewerViewProps {
  contentHeader?: ReactNode;
}

export function MemoryViewerView(props: MemoryViewerViewProps = {}) {
  const authority = useActiveAgentAuthority();
  return (
    <MemoryViewerViewForAuthority
      key={authority}
      {...props}
      authority={authority}
    />
  );
}

function MemoryViewerViewForAuthority({
  contentHeader,
  authority,
}: MemoryViewerViewProps & { authority: string }) {
  const t = useAppSelector((s) => s.t);
  const setTab = useAppSelector((s) => s.setTab);
  const authorityRef = useRef(authority);
  authorityRef.current = authority;
  const runCapabilityWarmup = useAbortableCapabilityWarmup();
  // Mobile: the people/filter sidebar opens from a compact "People" control in
  // the view header (never an inline trigger between the header and content).
  const mobileSidebarHeader = useWorkspaceMobileSidebarHeader();
  const [viewMode, setViewMode] = useState<ViewMode>("feed");
  const [typeFilter, setTypeFilter] = useState<string[]>([]);
  const [stats, setStats] = useState<MemoryStatsResponse | null>(null);
  const [statsError, setStatsError] = useState(false);
  const [unavailableAuthority, setUnavailableAuthority] = useState<
    string | null
  >(null);
  const memoryRuntimeUnavailable = unavailableAuthority === authority;

  // People list for person-centric view. `peopleError` keeps a failed load
  // visually distinct from the designed "No people yet." empty state; a
  // 5xx/transport failure must never render as healthy-empty (three-state rule).
  const [people, setPeople] = useState<RelationshipsPersonSummary[]>([]);
  const [peopleLoading, setPeopleLoading] = useState(true);
  const [peopleError, setPeopleError] = useState(false);
  const [peopleUnavailable, setPeopleUnavailable] = useState(false);
  const [selectedPersonId, setSelectedPersonId] = useState<string | null>(null);

  const markMemoryRuntimeUnavailable = useCallback(() => {
    setUnavailableAuthority(authority);
    setStatsError(false);
  }, [authority]);

  const loadStats = useCallback(() => {
    void runCapabilityWarmup(() => client.getMemoryStats())
      .then((s) => {
        if (authorityRef.current !== authority) return;
        setStats(s);
        setStatsError(false);
      })
      .catch((err: unknown) => {
        if (authorityRef.current !== authority) return;
        if (isCapabilityWarmupAbort(err)) return;
        if (isMemoryRuntimeUnavailable(err)) {
          markMemoryRuntimeUnavailable();
          return;
        }
        // error-policy:J4 stats are a sidebar summary; show the error row
        // and keep the rest of the page usable.
        setStatsError(true);
      });
  }, [authority, markMemoryRuntimeUnavailable, runCapabilityWarmup]);

  const loadPeople = useCallback(() => {
    setPeopleLoading(true);
    setPeopleError(false);
    setPeopleUnavailable(false);
    void runCapabilityWarmup(() =>
      client.getRelationshipsPeople({ limit: 200 }),
    )
      .then((result) => {
        if (authorityRef.current !== authority) return;
        setPeople(result.people);
        setPeopleError(false);
        setPeopleUnavailable(false);
        setPeopleLoading(false);
      })
      .catch((err: unknown) => {
        if (authorityRef.current !== authority) return;
        if (isCapabilityWarmupAbort(err)) return;
        // A Shared runtime has no relationships graph to derive honest people
        // from. Treat the typed capability response (and legacy 404) as a
        // stable unavailable state; retry only genuinely transient failures.
        setPeople([]);
        setSelectedPersonId(null);
        if (isRelationshipsRuntimeUnavailable(err)) {
          setPeopleUnavailable(true);
          setPeopleError(false);
          setPeopleLoading(false);
          return;
        }
        setPeopleUnavailable(false);
        setPeopleError(true);
        setPeopleLoading(false);
      });
  }, [authority, runCapabilityWarmup]);

  useEffect(() => {
    setStats(null);
    setStatsError(false);
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
      collapsible={false}
      resizable={false}
      defaultWidth={272}
      contentIdentity="memory-viewer"
      mobileTitle={t("memoryviewer.filters", { defaultValue: "Filters" })}
      className="settings-surface settings-canvas"
    >
      <div className="flex h-full flex-col gap-5 overflow-y-auto px-4 py-4 min-[700px]:px-5 min-[700px]:py-5">
        <section className="space-y-2">
          <h2 className="px-1 text-xs font-semibold text-[color:var(--settings-muted)]">
            {t("memoryviewer.library", { defaultValue: "Library" })}
          </h2>
          <div className="space-y-4 border-b border-[color:var(--settings-hairline)] px-1 pb-5">
            <div className="flex min-h-11 items-center justify-between gap-3">
              <span className="text-sm text-[color:var(--settings-foreground)]">
                {t("memoryviewer.allMemories", {
                  defaultValue: "All memories",
                })}
              </span>
              <span className="text-sm font-semibold tabular-nums text-[color:var(--settings-foreground)]">
                {stats ? stats.total : "..."}
              </span>
            </div>
            {statsError ? (
              <div
                role="status"
                aria-label={t("memoryviewer.statsError", {
                  defaultValue: "Memory stats unavailable",
                })}
                className="text-xs leading-5 text-[color:var(--settings-muted)]"
              >
                {t("memoryviewer.statsUnavailable", {
                  defaultValue: "The total isn't available right now.",
                })}
              </div>
            ) : null}
            <div className="space-y-2 border-t border-[color:var(--settings-hairline)] pt-4">
              <div className="text-xs text-[color:var(--settings-muted)]">
                {t("memoryviewer.filterByType", {
                  defaultValue: "Type",
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
          </div>
        </section>

        <section className="space-y-2">
          <h2 className="px-1 text-xs font-semibold text-[color:var(--settings-muted)]">
            {t("memoryviewer.people", { defaultValue: "People" })}
          </h2>
          <div className="border-b border-[color:var(--settings-hairline)] px-1 pb-5">
            {peopleLoading ? (
              <div className="flex min-h-11 items-center text-sm text-[color:var(--settings-muted)]">
                {t("memoryviewer.loading", { defaultValue: "Loading..." })}
              </div>
            ) : peopleUnavailable ? (
              <div
                data-testid="memory-people-unavailable"
                className="py-2 text-sm leading-5 text-[color:var(--settings-muted)]"
              >
                {t("memoryviewer.peopleUnavailableSimple", {
                  defaultValue: "People filters aren't available here.",
                })}
              </div>
            ) : peopleError ? (
              <div
                data-testid="memory-people-error"
                className="space-y-3 py-1 text-sm text-[color:var(--settings-muted)]"
              >
                <div>
                  {t("memoryviewer.peopleCouldNotLoad", {
                    defaultValue: "People couldn't load.",
                  })}
                </div>
                <Button
                  type="button"
                  size="touch"
                  variant="outline"
                  className={MEMORY_FOCUS_CLASS}
                  onClick={loadPeople}
                >
                  {t("memoryviewer.retry", { defaultValue: "Retry" })}
                </Button>
              </div>
            ) : people.length === 0 ? (
              <div className="space-y-2 py-1">
                <div className="text-sm text-[color:var(--settings-muted)]">
                  {t("memoryviewer.noPeopleYet", {
                    defaultValue: "No people yet",
                  })}
                </div>
                <Button
                  type="button"
                  size="touch"
                  variant="ghostMuted"
                  align="start"
                  className={`${MEMORY_FOCUS_CLASS} -mx-3 w-[calc(100%+1.5rem)] justify-start`}
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
                      <X className="size-4" aria-hidden />
                    </Button>
                  ) : null}
                </div>
                <Button
                  type="button"
                  size="touch"
                  variant="ghostMuted"
                  align="start"
                  className={`${MEMORY_FOCUS_CLASS} -mx-3 mt-2 w-[calc(100%+1.5rem)] justify-start`}
                  onClick={() => setTab("relationships")}
                >
                  {t("memoryviewer.openRelationships", {
                    defaultValue: "Open Relationships",
                  })}
                </Button>
              </>
            )}
          </div>
        </section>
      </div>
    </AppPageSidebar>
  );

  return (
    <ShellViewAgentSurface viewId="memories">
      <FramedPage gutterOwner="framed-page">
        <FramedPageHeader
          title={t("memoryviewer.title", { defaultValue: "Memories" })}
          actions={
            memoryRuntimeUnavailable ? undefined : (
              <ViewHeaderSidebarTrigger
                control={mobileSidebarHeader.control}
                className={MEMORY_FOCUS_CLASS}
              />
            )
          }
        />
        <FramedPageBody scroll="view" padded={false}>
          <WorkspaceMobileSidebarScope controls={mobileSidebarHeader.controls}>
            <WorkspaceLayout
              sidebar={memoryRuntimeUnavailable ? null : sidebar}
              contentHeader={contentHeader}
              headerPlacement="outside"
              contentPadding={false}
              className="settings-canvas"
              contentClassName="settings-canvas overflow-y-hidden"
              contentInnerClassName="settings-canvas"
              data-testid="memory-viewer-view"
            >
              <div
                data-testid="memory-content-scroll-region"
                className="settings-canvas min-h-0 flex-1 overflow-y-auto"
              >
                <PagePanel.ContentRail
                  width="standard"
                  className="flex flex-col gap-4 pb-6 pt-2 min-[700px]:gap-5 min-[700px]:pb-8 min-[700px]:pt-5"
                >
                  {memoryRuntimeUnavailable ? (
                    <MemoryStateSurface>
                      <PagePanel.ContentState
                        state="error"
                        placement="workspace"
                        tone="warning"
                        role="status"
                        data-testid="memory-runtime-unavailable"
                        className="min-h-[20rem]"
                        icon={<Brain className="size-5" />}
                        title={t("memoryviewer.runtimeUnavailable", {
                          defaultValue: "Memories unavailable",
                        })}
                        description={t(
                          "memoryviewer.runtimeUnavailableSimpleDescription",
                          {
                            defaultValue:
                              "Durable memories aren't available here.",
                          },
                        )}
                      />
                    </MemoryStateSurface>
                  ) : (
                    <>
                      <div className="flex w-full flex-col items-start gap-2">
                        <div
                          ref={viewModeControl.ref}
                          className="min-h-11"
                          {...viewModeControl.agentProps}
                        >
                          <SegmentedControl
                            role="tablist"
                            aria-label={t("memoryviewer.viewMode", {
                              defaultValue: "Memory view mode",
                            })}
                            value={viewMode}
                            onValueChange={(v) => setViewMode(v as ViewMode)}
                            items={viewModeItems}
                            buttonClassName={`${MEMORY_FOCUS_CLASS} min-h-11 px-4 py-2`}
                          />
                        </div>
                        {selectedPerson ? (
                          <div className="flex min-h-11 flex-wrap items-center gap-2 text-sm text-[color:var(--settings-muted)]">
                            {t("memoryviewer.filteredTo", {
                              defaultValue: "Showing",
                            })}
                            <MetaPill compact>
                              {selectedPerson.displayName}
                            </MetaPill>
                            <Button
                              type="button"
                              size="touch"
                              variant="ghostMuted"
                              className={MEMORY_FOCUS_CLASS}
                              onClick={handleClearPerson}
                            >
                              {t("memoryviewer.clear", {
                                defaultValue: "Clear",
                              })}
                            </Button>
                          </div>
                        ) : null}
                      </div>

                      {viewMode === "feed" ? (
                        <MemoryFeedPanel
                          key={`feed:${authority}`}
                          typeFilter={typeFilter}
                          authority={authority}
                          onRuntimeUnavailable={markMemoryRuntimeUnavailable}
                        />
                      ) : (
                        <MemoryBrowserPanel
                          key={`browse:${authority}`}
                          typeFilter={typeFilter}
                          entityId={selectedPersonId}
                          entityIds={selectedEntityIds}
                          authority={authority}
                          onRuntimeUnavailable={markMemoryRuntimeUnavailable}
                        />
                      )}
                    </>
                  )}
                </PagePanel.ContentRail>
              </div>
            </WorkspaceLayout>
          </WorkspaceMobileSidebarScope>
        </FramedPageBody>
      </FramedPage>
    </ShellViewAgentSurface>
  );
}
