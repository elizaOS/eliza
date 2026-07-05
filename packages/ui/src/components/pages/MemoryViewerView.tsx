/**
 * Memories page: browses the agent's memory store in three modes — a recent
 * feed, a filtered browse list, and a person-centric view scoped to a
 * relationship's member entity ids. Pulls stats, people (via the relationships
 * API), and memory rows from the typed client. On mobile the people/filter
 * sidebar is opened from a compact control in the view header rather than an
 * inline trigger.
 */

import {
  BROWSER_CONVERSATION_IMPORT_SOURCES,
  type BrowserConversationImportPreview,
  type BrowserConversationImportSource,
  enumerateBatchDocumentIds,
  type ImportManifest,
  previewConversationImportText,
  runConversationImportText,
  uninstallBatch,
} from "@elizaos/import-conversations/browser";
import {
  AlertTriangle,
  Brain,
  CheckCircle2,
  FileText,
  MessageSquareText,
  Search,
  ShieldCheck,
  Sparkles,
  Trash2,
  Upload,
} from "lucide-react";
import {
  type ChangeEvent,
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
import { SidebarContent } from "../composites/sidebar/sidebar-content";
import { SidebarPanel } from "../composites/sidebar/sidebar-panel";
import { SidebarScrollRegion } from "../composites/sidebar/sidebar-scroll-region";
import { AppPageSidebar } from "../shared/AppPageSidebar";
import { ViewHeader } from "../shared/ViewHeader";
import { ViewHeaderSidebarTrigger } from "../shared/ViewHeaderSidebarTrigger";
import { Button } from "../ui/button";
import { SegmentedControl } from "../ui/segmented-control";
import { ListSkeleton } from "../ui/skeleton-layouts";
import { ShellViewAgentSurface } from "../views/ShellViewAgentSurface";
import { createConversationImportDocumentSink } from "./conversation-import-documents";

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

type ViewMode = "feed" | "browse" | "import";

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
      className="h-auto w-full justify-start whitespace-normal rounded-sm px-3.5 py-3 text-left font-normal transition-colors hover:bg-bg-hover"
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
          <span className="text-xs-tight text-muted/70">{memory.source}</span>
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
              <span className="text-muted/70">
                {t("memoryviewer.field.entity", { defaultValue: "Entity" })}
              </span>{" "}
              <span className="font-mono text-2xs">{memory.entityId}</span>
            </div>
          ) : null}
          {memory.roomId ? (
            <div className="text-xs-tight text-muted">
              <span className="text-muted/70">
                {t("memoryviewer.field.room", { defaultValue: "Room" })}
              </span>{" "}
              <span className="font-mono text-2xs">{memory.roomId}</span>
            </div>
          ) : null}
          <div className="text-xs-tight text-muted">
            <span className="text-muted/70">
              {t("memoryviewer.field.created", { defaultValue: "Created" })}
            </span>{" "}
            {formatDateTime(memory.createdAt, {
              fallback: t("memoryviewer.unknown", { defaultValue: "unknown" }),
            })}
          </div>
          <div className="text-xs-tight text-muted">
            <span className="text-muted/70">
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
    return <PagePanel.Notice tone="danger">{error}</PagePanel.Notice>;
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
        iconTone="bg-accent/12 text-accent"
        title={t("memoryviewer.noMemoriesYet", {
          defaultValue: "No memories yet",
        })}
      />
    );
  }

  return (
    <div data-testid="memory-feed">
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
          className="mt-3 w-full"
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

  // The floating chat IS the memory-text search box while Browse is open (and
  // not scoped to a person — entity mode has no free-text search). Typing in the
  // composer drives `searchInput`; the binding clears when the view unmounts.
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
      {entityId ? null : <ChatSearchHint noun="memories" query={searchInput} />}
      {loading && !result ? (
        <ListSkeleton rows={6} />
      ) : error ? (
        <PagePanel.Notice tone="danger">{error}</PagePanel.Notice>
      ) : !result || result.memories.length === 0 ? (
        <PagePanel.FeatureEmpty
          icon={Search}
          iconTone="bg-bg-hover text-muted"
          title={t("memoryviewer.noMemoriesFound", {
            defaultValue: "No memories found",
          })}
        >
          <div className="mt-4 flex flex-wrap justify-center gap-x-4 gap-y-1.5">
            {TYPE_KEYS.slice(0, 4).map((type) => (
              <span
                key={type}
                className="inline-flex items-center gap-1.5 text-xs-tight text-muted"
              >
                <span
                  className={`memory-type-dot-${type} inline-block h-2 w-2 rounded-full`}
                />
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
                ref={prevControl.ref}
                type="button"
                size="sm"
                variant="ghost"
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
                disabled={offset + BROWSE_PAGE_SIZE >= result.total}
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

function TypeFilterButton({
  label,
  type,
  active,
  onSelect,
}: {
  label: string;
  type: string | null;
  active: boolean;
  onSelect: () => void;
}) {
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: `memory-filter-${type ?? "all"}`,
    role: "button",
    label: `Filter memories: ${label}`,
    group: "memory-type-filter",
    status: active ? "active" : "inactive",
    description: `Show only ${label} memories`,
    onActivate: onSelect,
  });
  return (
    <Button
      ref={ref}
      type="button"
      size="sm"
      variant="ghost"
      className={`h-7 rounded-full px-3 text-2xs font-semibold ${
        active ? "bg-accent/14 text-txt" : ""
      }`}
      onClick={onSelect}
      {...agentProps}
    >
      {type ? (
        <span
          className={`memory-type-dot-${memoryTypeKey(type)} mr-1.5 inline-block h-2 w-2 rounded-full`}
        />
      ) : null}
      {label}
    </Button>
  );
}

const PersonItem = memo(function PersonItem({
  person,
  active,
  onSelect,
  noPlatformsLabel,
}: {
  person: RelationshipsPersonSummary;
  active: boolean;
  onSelect: (person: RelationshipsPersonSummary) => void;
  noPlatformsLabel: string;
}) {
  const handleSelect = () => onSelect(person);
  const { ref, agentProps } = useAgentElement<HTMLElement>({
    id: `memory-person-${person.primaryEntityId}`,
    role: "list-item",
    label: `Browse memories for ${person.displayName}`,
    group: "memory-people",
    status: active ? "active" : "inactive",
    description: `Filter memories to ${person.displayName}`,
    onActivate: handleSelect,
  });
  return (
    <SidebarContent.Item
      ref={ref}
      active={active}
      onClick={handleSelect}
      aria-current={active ? "page" : undefined}
      {...agentProps}
    >
      <SidebarContent.ItemIcon active={active}>
        {person.displayName.charAt(0).toUpperCase()}
      </SidebarContent.ItemIcon>
      <span className="min-w-0 flex-1 text-left">
        <SidebarContent.ItemTitle>
          {person.displayName}
        </SidebarContent.ItemTitle>
        <SidebarContent.ItemDescription>
          {person.platforms.join(" · ") || noPlatformsLabel}
        </SidebarContent.ItemDescription>
      </span>
      <MetaPill compact>{person.factCount}</MetaPill>
    </SidebarContent.Item>
  );
});

// ── Conversation Import ──────────────────────────────────────────────────

type ImportJobStatus = "running" | "complete" | "partial" | "deleted";

interface ImportJobRecord {
  id: string;
  source: BrowserConversationImportSource;
  total: number;
  imported: number;
  deleted: number;
  documentIds: string[];
  manifest: ImportManifest;
  failed: Array<{ error: string }>;
  readback: "verified" | "unverified";
  status: ImportJobStatus;
}

function createImportBatchId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `batch-${Date.now().toString(36)}`;
}

export function ConversationImportPanel({
  onImported,
}: {
  onImported: () => void;
}) {
  const { t } = useTranslation();
  const [source, setSource] =
    useState<BrowserConversationImportSource>("chatgpt");
  const [fileName, setFileName] = useState<string | null>(null);
  const [rawText, setRawText] = useState("");
  const [preview, setPreview] =
    useState<BrowserConversationImportPreview | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [consent, setConsent] = useState(false);
  const [retainRawSession, setRetainRawSession] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [jobs, setJobs] = useState<ImportJobRecord[]>([]);

  const parseRawText = useCallback(
    async (
      text: string,
      selectedSource = source,
      selectedFileName = fileName ?? undefined,
    ) => {
      try {
        const nextPreview = await previewConversationImportText(
          selectedSource,
          text,
          { filename: selectedFileName },
        );
        setPreview(nextPreview);
        setParseError(
          nextPreview.counts.messages === 0
            ? t("memoryviewer.import.noTurns", {
                defaultValue: "No importable conversation messages found.",
              })
            : null,
        );
      } catch (err) {
        setPreview(null);
        setParseError(
          err instanceof Error
            ? err.message
            : t("memoryviewer.import.parseFailed", {
                defaultValue: "Could not parse this export.",
              }),
        );
      }
    },
    [fileName, source, t],
  );

  const handleSourceChange = (nextSource: BrowserConversationImportSource) => {
    setSource(nextSource);
    if (rawText) void parseRawText(rawText, nextSource);
  };

  const handleFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    setConsent(false);
    setFileName(file?.name ?? null);
    if (!file) {
      setRawText("");
      setPreview(null);
      setParseError(null);
      return;
    }
    const text = await file.text();
    setRawText(text);
    await parseRawText(text, source, file.name);
  };

  const handleImport = async () => {
    if (!preview || preview.counts.messages === 0 || !consent || busy) {
      return;
    }
    setBusy(true);
    const batchId = createImportBatchId();
    setProgress({ done: 0, total: preview.counts.conversations });
    try {
      const result = await runConversationImportText({
        source,
        rawText,
        filename: fileName ?? undefined,
        batchId,
        sink: createConversationImportDocumentSink(client),
        onProgress: (event) => setProgress(event),
      });
      const documentIds = enumerateBatchDocumentIds(result.manifest);
      let readback: ImportJobRecord["readback"] = "unverified";
      if (documentIds[0]) {
        try {
          await client.getDocument(documentIds[0]);
          readback = "verified";
        } catch {
          readback = "unverified";
        }
      }
      const failed =
        result.report.summary.errors > 0
          ? result.report.items
              .filter((item) => item.outcome === "error")
              .map((item) => ({ error: item.reason ?? "Import failed" }))
          : [];
      const status: ImportJobStatus =
        failed.length > 0 ? "partial" : "complete";
      setJobs((current) =>
        [
          {
            id: batchId,
            source,
            total: result.report.summary.total,
            imported: result.report.summary.documentsStored,
            deleted: 0,
            documentIds,
            manifest: result.manifest,
            failed,
            readback,
            status,
          },
          ...current,
        ].slice(0, 6),
      );
      setConsent(false);
      if (!retainRawSession) {
        setRawText("");
        setFileName(null);
        setPreview(null);
      }
      onImported();
    } catch (err) {
      setParseError(err instanceof Error ? err.message : "Import failed");
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteBatch = async (job: ImportJobRecord) => {
    if (busy || job.documentIds.length === 0) return;
    setBusy(true);
    const failed: ImportJobRecord["failed"] = [];
    let deleted = 0;
    try {
      deleted = await uninstallBatch(
        createConversationImportDocumentSink(client),
        job.manifest,
      );
    } catch (err) {
      failed.push({
        error: err instanceof Error ? err.message : "Delete failed",
      });
    }
    setJobs((current) =>
      current.map((candidate) =>
        candidate.id === job.id
          ? {
              ...candidate,
              deleted,
              failed: [...candidate.failed, ...failed],
              status:
                failed.length > 0 || deleted < job.documentIds.length
                  ? "partial"
                  : "deleted",
            }
          : candidate,
      ),
    );
    setBusy(false);
    onImported();
  };

  return (
    <div className="space-y-4" data-testid="conversation-importer">
      <PagePanel.Frame className="space-y-4 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-base font-semibold text-txt">
              {t("memoryviewer.import.title", {
                defaultValue: "Conversation import",
              })}
            </div>
            <div className="mt-1 text-sm text-muted">
              {t("memoryviewer.import.subtitle", {
                defaultValue: "Preview, scrub, consent, then write documents.",
              })}
            </div>
          </div>
          <ShieldCheck className="h-5 w-5 text-accent" aria-hidden="true" />
        </div>

        <div className="grid gap-3 md:grid-cols-[12rem_minmax(0,1fr)]">
          <label className="space-y-1.5 text-sm">
            <span className="text-xs-tight font-semibold text-muted">
              {t("memoryviewer.import.source", { defaultValue: "Source" })}
            </span>
            <select
              className="h-10 w-full rounded-sm border border-border/35 bg-bg px-3 text-sm text-txt"
              value={source}
              onChange={(event) =>
                handleSourceChange(
                  event.target.value as BrowserConversationImportSource,
                )
              }
              disabled={busy}
            >
              {BROWSER_CONVERSATION_IMPORT_SOURCES.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>

          <label className="space-y-1.5 text-sm">
            <span className="text-xs-tight font-semibold text-muted">
              {t("memoryviewer.import.file", { defaultValue: "Export file" })}
            </span>
            <span className="flex min-h-10 items-center gap-2 rounded-sm border border-dashed border-border/40 bg-bg px-3 text-sm text-muted">
              <Upload className="h-4 w-4" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate">
                {fileName ??
                  t("memoryviewer.import.noFile", {
                    defaultValue: "Choose JSON or text export",
                  })}
              </span>
              <input
                className="sr-only"
                type="file"
                accept=".json,.txt,.md,application/json,text/plain"
                onChange={handleFileChange}
                disabled={busy}
              />
            </span>
          </label>
        </div>

        <div className="flex flex-wrap gap-3 text-sm text-muted">
          <label className="inline-flex items-center gap-2">
            <input
              type="checkbox"
              checked
              readOnly
              className="h-4 w-4 accent-current"
            />
            {t("memoryviewer.import.scrubDefault", {
              defaultValue: "Scrub secrets by default",
            })}
          </label>
          <label className="inline-flex items-center gap-2">
            <input
              type="checkbox"
              checked={retainRawSession}
              onChange={(event) => setRetainRawSession(event.target.checked)}
              className="h-4 w-4 accent-current"
              disabled={busy}
            />
            {t("memoryviewer.import.retainRaw", {
              defaultValue: "Keep raw source this session",
            })}
          </label>
        </div>
      </PagePanel.Frame>

      {parseError ? (
        <PagePanel.Notice tone="danger">{parseError}</PagePanel.Notice>
      ) : null}

      {preview ? (
        <PagePanel.Frame className="space-y-4 p-4">
          <div className="grid gap-3 sm:grid-cols-3">
            <PagePanel.SummaryCard compact>
              <div className="text-xs-tight text-muted">
                {t("memoryviewer.import.conversations", {
                  defaultValue: "Conversations",
                })}
              </div>
              <div className="mt-1 text-lg font-semibold text-txt">
                {preview.counts.conversations}
              </div>
            </PagePanel.SummaryCard>
            <PagePanel.SummaryCard compact>
              <div className="text-xs-tight text-muted">
                {t("memoryviewer.import.messages", {
                  defaultValue: "Messages",
                })}
              </div>
              <div className="mt-1 text-lg font-semibold text-txt">
                {preview.counts.messages}
              </div>
            </PagePanel.SummaryCard>
            <PagePanel.SummaryCard compact>
              <div className="text-xs-tight text-muted">
                {t("memoryviewer.import.redactions", {
                  defaultValue: "Redactions",
                })}
              </div>
              <div className="mt-1 text-lg font-semibold text-txt">
                {preview.counts.redactions}
              </div>
            </PagePanel.SummaryCard>
          </div>

          {preview.warnings.length > 0 ? (
            <div className="space-y-1 rounded-sm border border-border/25 bg-bg-hover/35 p-3 text-sm text-muted">
              {preview.warnings.map((warning) => (
                <div key={warning} className="flex gap-2">
                  <AlertTriangle
                    className="mt-0.5 h-4 w-4 text-accent"
                    aria-hidden="true"
                  />
                  <span>{warning}</span>
                </div>
              ))}
            </div>
          ) : null}

          <div className="space-y-2">
            {preview.examples.map((turn) => (
              <div
                key={`${turn.title}-${turn.role}-${turn.createdAt ?? turn.text.slice(0, 24)}`}
                className="rounded-sm border border-border/20 bg-bg-hover/40 p-3"
              >
                <div className="flex flex-wrap items-center gap-2 text-xs-tight text-muted">
                  <MetaPill compact>{turn.title}</MetaPill>
                  <span>{turn.role}</span>
                </div>
                <div className="mt-2 line-clamp-3 text-sm leading-6 text-txt">
                  {turn.text}
                </div>
              </div>
            ))}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <label className="inline-flex items-center gap-2 text-sm text-muted">
              <input
                type="checkbox"
                checked={consent}
                onChange={(event) => setConsent(event.target.checked)}
                className="h-4 w-4 accent-current"
                disabled={busy || preview.counts.messages === 0}
              />
              {t("memoryviewer.import.consent", {
                defaultValue: "Import the scrubbed preview",
              })}
            </label>
            <Button
              type="button"
              size="sm"
              onClick={handleImport}
              disabled={!consent || busy || preview.counts.messages === 0}
            >
              {busy
                ? t("memoryviewer.import.progress", {
                    done: progress.done,
                    total: progress.total,
                    defaultValue: "{{done}}/{{total}}",
                  })
                : t("memoryviewer.import.importButton", {
                    defaultValue: "Import",
                  })}
            </Button>
          </div>
        </PagePanel.Frame>
      ) : null}

      {jobs.length > 0 ? (
        <PagePanel.Frame className="space-y-3 p-4">
          <div className="text-sm font-semibold text-txt">
            {t("memoryviewer.import.jobs", { defaultValue: "Import jobs" })}
          </div>
          {jobs.map((job) => (
            <div
              key={job.id}
              className="flex flex-wrap items-center gap-3 rounded-sm border border-border/20 bg-bg-hover/35 p-3"
            >
              <CheckCircle2
                className="h-4 w-4 text-accent"
                aria-hidden="true"
              />
              <div className="min-w-0 flex-1">
                <div className="text-sm text-txt">
                  {job.source} · {job.imported}/{job.total}
                </div>
                <div className="text-xs-tight text-muted">
                  {job.status}
                  {job.deleted ? ` · ${job.deleted} deleted` : ""}
                  {job.failed.length ? ` · ${job.failed.length} failed` : ""}
                  {job.readback === "verified" ? " · read back" : ""}
                </div>
              </div>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => void handleDeleteBatch(job)}
                disabled={busy || job.status === "deleted"}
              >
                <Trash2 className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
                {t("memoryviewer.import.deleteBatch", {
                  defaultValue: "Delete batch",
                })}
              </Button>
            </div>
          ))}
        </PagePanel.Frame>
      ) : null}
    </div>
  );
}

// ── Main View ────────────────────────────────────────────────────────────

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
  const [typeFilter, setTypeFilter] = useState<string | null>(null);
  const [stats, setStats] = useState<MemoryStatsResponse | null>(null);
  const [statsError, setStatsError] = useState(false);
  const [importRefreshToken, setImportRefreshToken] = useState(0);

  // People list for person-centric view. `peopleError` keeps a failed load
  // visually distinct from the designed "No people yet." empty state — a
  // 5xx/transport failure must never render as healthy-empty (three-state rule).
  const [people, setPeople] = useState<RelationshipsPersonSummary[]>([]);
  const [peopleLoading, setPeopleLoading] = useState(true);
  const [peopleError, setPeopleError] = useState(false);
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
    {
      value: "import" as const,
      label: t("memoryviewer.import.tab", { defaultValue: "Import" }),
      testId: "memory-view-import",
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

  const sidebar = (
    <AppPageSidebar
      testId="memory-viewer-sidebar"
      collapsible
      contentIdentity="memory-viewer"
      mobileTitle={t("memoryviewer.people", { defaultValue: "People" })}
    >
      <SidebarPanel>
        {/* Stats + type filter */}
        <PagePanel.SummaryCard compact className="mt-2 space-y-3">
          {stats ? (
            <>
              <div className="space-y-1">
                <div className="flex items-baseline justify-between gap-3 text-sm">
                  <span className="text-muted">
                    {t("memoryviewer.total", { defaultValue: "Total" })}
                  </span>
                  <span className="font-semibold text-txt">{stats.total}</span>
                </div>
                {Object.entries(stats.byType).map(([type, count]) => (
                  <div
                    key={type}
                    className="flex items-baseline justify-between gap-3 text-xs-tight"
                  >
                    <span className="inline-flex items-center gap-1.5 text-muted">
                      <span
                        className={`memory-type-dot-${memoryTypeKey(type)} inline-block h-2 w-2 rounded-full`}
                      />
                      {typeLabel(type, t)}
                    </span>
                    <span className="font-semibold text-txt">{count}</span>
                  </div>
                ))}
              </div>

              <div>
                <div className="text-xs-tight text-muted">
                  {t("memoryviewer.filterByType", {
                    defaultValue: "Filter by type",
                  })}
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  <TypeFilterButton
                    label={t("memoryviewer.all", { defaultValue: "All" })}
                    type={null}
                    active={typeFilter === null}
                    onSelect={() => setTypeFilter(null)}
                  />
                  {Object.keys(stats.byType).map((type) => (
                    <TypeFilterButton
                      key={type}
                      label={typeLabel(type, t)}
                      type={type}
                      active={typeFilter === type}
                      onSelect={() =>
                        setTypeFilter(typeFilter === type ? null : type)
                      }
                    />
                  ))}
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
        <div className="mt-3 px-1 text-xs-tight text-muted">
          {t("memoryviewer.people", { defaultValue: "People" })}
        </div>

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
            ) : peopleError ? (
              <div
                data-testid="memory-people-error"
                className="px-2 text-xs text-danger"
              >
                {t("memoryviewer.peopleError", {
                  defaultValue: "Could not load people.",
                })}
              </div>
            ) : people.length === 0 ? (
              <div className="px-2 text-xs text-muted">
                {t("memoryviewer.noPeopleYet", {
                  defaultValue: "No people yet.",
                })}
              </div>
            ) : (
              people.map((person) => (
                <PersonItem
                  key={person.groupId}
                  person={person}
                  active={person.primaryEntityId === selectedPersonId}
                  onSelect={handleSelectPerson}
                  noPlatformsLabel={t("memoryviewer.noPlatforms", {
                    defaultValue: "No platforms",
                  })}
                />
              ))
            )}
          </div>
        </SidebarScrollRegion>
      </SidebarPanel>
    </AppPageSidebar>
  );

  return (
    <ShellViewAgentSurface viewId="memories">
      <div className="flex h-full min-h-0 w-full flex-col">
        <ViewHeader
          title="Memories"
          right={
            <ViewHeaderSidebarTrigger control={mobileSidebarHeader.control} />
          }
        />
        <div className="min-h-0 flex-1 overflow-hidden">
          <WorkspaceMobileSidebarScope controls={mobileSidebarHeader.controls}>
            <PageLayout
              sidebar={sidebar}
              contentHeader={contentHeader}
              data-testid="memory-viewer-view"
            >
              <div className="flex min-h-0 flex-1 flex-col gap-4">
                {/* View mode toggle + person context */}
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div
                    ref={viewModeControl.ref}
                    className="min-h-11"
                    {...viewModeControl.agentProps}
                  >
                    <SegmentedControl
                      value={viewMode}
                      onValueChange={(v) => setViewMode(v as ViewMode)}
                      items={viewModeItems}
                      buttonClassName="min-h-11 px-4 py-2"
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
                        className="min-h-11 px-3 text-xs-tight"
                        onClick={handleClearPerson}
                      >
                        {t("memoryviewer.clear", { defaultValue: "Clear" })}
                      </Button>
                    </div>
                  ) : null}
                </div>

                {/* Content */}
                {viewMode === "feed" ? (
                  <MemoryFeedPanel
                    key={importRefreshToken}
                    typeFilter={typeFilter}
                  />
                ) : viewMode === "browse" ? (
                  <MemoryBrowserPanel
                    typeFilter={typeFilter}
                    entityId={selectedPersonId}
                    entityIds={selectedEntityIds}
                  />
                ) : (
                  <ConversationImportPanel
                    onImported={() => {
                      setImportRefreshToken((value) => value + 1);
                      setViewMode("feed");
                    }}
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
