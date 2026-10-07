/**
 * Media gallery view: scans agent database tables for attachment/media rows and
 * renders them as a filterable, searchable grid with a full-size detail modal
 * plus download/share affordances. Search is driven by the floating chat via
 * useRegisterViewChatBinding rather than an in-view input. Mounted as a tab of
 * the Database page surface.
 */

import type { TranslateFn } from "@elizaos/contracts";
import { Download, Share2 } from "lucide-react";
import {
  memo,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { useAgentElement } from "../../agent-surface/useAgentElement";
import { client } from "../../api/client";
import { PageLayout } from "../../layouts/page-layout";
import { useAppSelector } from "../../state/app-store";
import { useRegisterViewChatBinding } from "../../state/view-chat-binding";
import { resolveAppAssetUrl } from "../../utils/asset-url";
import {
  canShareFiles,
  downloadAttachment,
  filenameForMime,
  shareAttachment,
} from "../../utils/download-share";
import { ChatSearchHint } from "../composites/chat-search-hint";
import { PagePanel } from "../composites/page-panel";
import { MetaPill } from "../composites/page-panel/page-panel-header";
import { SidebarContent } from "../composites/sidebar/sidebar-content";
import {
  SidebarPanel,
  SidebarScrollRegion,
} from "../composites/sidebar/sidebar-layout";
import { AppPageSidebar } from "../shared/AppPageSidebar";
import { Button } from "../ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";

const MEDIA_TYPES = ["all", "image", "video", "audio"] as const;
type MediaType = (typeof MEDIA_TYPES)[number];

interface MediaItem {
  url: string;
  type: "image" | "video" | "audio";
  filename: string;
  source: string;
  createdAt: string;
}

const IMAGE_EXTS = /\.(png|jpe?g|gif|webp|svg|bmp|ico|avif)(\?|$)/i;
const VIDEO_EXTS = /\.(mp4|webm|mov|avi|mkv|ogv)(\?|$)/i;
const AUDIO_EXTS = /\.(mp3|wav|ogg|flac|aac|m4a|opus)(\?|$)/i;
const DATA_URI_IMG = /^data:image\//i;
const DATA_URI_VID = /^data:video\//i;
const DATA_URI_AUD = /^data:audio\//i;
const MEDIA_URL_PREFIX =
  /^(https?:|data:|blob:|file:|capacitor:|electrobun:|app:|\/|\.\/|\.\.\/)/i;
const MEDIA_SCAN_PAGE_SIZE = 500;

function mediaScanSortColumn(table: {
  columns?: ReadonlyArray<{ name: string; isPrimaryKey?: boolean }>;
}): string | undefined {
  const primary = (table.columns ?? []).filter((column) => column.isPrimaryKey);
  // The rows API accepts one sort column and then orders by the whole primary
  // key. Sending only the first column of a composite key is not that order.
  if (primary.length !== 1) return undefined;
  return primary[0]?.name;
}

function classifyUrl(url: string): "image" | "video" | "audio" | null {
  if (IMAGE_EXTS.test(url) || DATA_URI_IMG.test(url)) return "image";
  if (VIDEO_EXTS.test(url) || DATA_URI_VID.test(url)) return "video";
  if (AUDIO_EXTS.test(url) || DATA_URI_AUD.test(url)) return "audio";
  return null;
}

function filenameFromUrl(url: string): string {
  try {
    const path = new URL(url, "https://placeholder").pathname;
    const segments = path.split("/").filter(Boolean);
    return segments[segments.length - 1] || "";
  } catch {
    // error-policy:J3 display-name extraction only — an unparseable URL gets
    // no derived filename; the item still renders with its media kind.
    return "";
  }
}

function looksLikePotentialMediaUrl(value: string): boolean {
  const candidate = value.trim();
  if (!candidate) return false;
  if (classifyUrl(candidate)) return true;
  return MEDIA_URL_PREFIX.test(candidate);
}

function normalizeMediaUrl(url: string): string {
  const candidate = url.trim();
  if (!candidate) return candidate;
  return MEDIA_URL_PREFIX.test(candidate)
    ? resolveAppAssetUrl(candidate)
    : candidate;
}

function mediaTypeLabel(t: TranslateFn, type: MediaType): string {
  switch (type) {
    case "all":
      return t("common.all", { defaultValue: "All" });
    case "image":
      return t("mediagalleryview.Images", { defaultValue: "Images" });
    case "video":
      return t("common.video", { defaultValue: "Video" });
    case "audio":
      return t("common.audio", { defaultValue: "Audio" });
  }
}

function isMediaType(value: string): value is MediaType {
  return MEDIA_TYPES.some((type) => type === value);
}

/** Extract media URLs from arbitrary row data by scanning all string values. */
function extractMediaFromRows(
  rows: Record<string, unknown>[],
  tableName: string,
  seen = new Set<string>(),
): MediaItem[] {
  const items: MediaItem[] = [];

  for (const row of rows) {
    const createdAt = String(
      row.createdAt ?? row.created_at ?? row.timestamp ?? "",
    );
    for (const val of Object.values(row)) {
      if (typeof val !== "string") continue;

      // Try parsing as JSON content field (elizaOS memories store JSON in content)
      const urls = extractUrlsFromValue(val);
      for (const url of urls) {
        const mediaType = classifyUrl(url);
        if (mediaType && !seen.has(url)) {
          seen.add(url);
          items.push({
            url,
            type: mediaType,
            filename: filenameFromUrl(url),
            source: tableName,
            createdAt,
          });
        }
      }
    }
  }
  return items;
}

/** Pull URLs out of a string value — handles plain URLs and JSON blobs. */
function extractUrlsFromValue(val: string): string[] {
  const urls = new Set<string>();

  // If it looks like JSON, parse it and search recursively
  if (val.startsWith("{") || val.startsWith("[")) {
    try {
      const parsed = JSON.parse(val);
      collectStrings(parsed, urls);
      return Array.from(urls);
    } catch {
      // not JSON, fall through to regex
    }
  }

  // Absolute URL/scheme match
  const urlRegex =
    /(?:https?:\/\/|file:\/\/|blob:|capacitor:\/\/|electrobun:\/\/|app:\/\/)[^\s"'<>]+/gi;
  const matches = val.match(urlRegex);
  if (matches) {
    for (const match of matches) urls.add(match);
  }

  // Relative/path-like token match
  const tokens = val
    .split(/[\s"'<>]+/)
    .map((token) => token.replace(/^[([{]+/, "").replace(/[)\]},;.!?]+$/, ""));
  for (const token of tokens) {
    if (looksLikePotentialMediaUrl(token)) urls.add(token);
  }

  // Data URI match
  if (val.startsWith("data:")) urls.add(val);

  return Array.from(urls);
}

function collectStrings(obj: unknown, out: Set<string>) {
  if (typeof obj === "string") {
    if (looksLikePotentialMediaUrl(obj)) out.add(obj.trim());
    return;
  }
  if (Array.isArray(obj)) {
    for (const item of obj) collectStrings(item, out);
    return;
  }
  if (obj && typeof obj === "object") {
    for (const v of Object.values(obj)) collectStrings(v, out);
  }
}

const MediaListItem = memo(function MediaListItem({
  item,
  index,
  isActive,
  typeLabel,
  fallbackTitle,
  onSelect,
}: {
  item: MediaItem;
  index: number;
  isActive: boolean;
  typeLabel: string;
  fallbackTitle: string;
  onSelect: (url: string) => void;
}) {
  const title = item.filename || fallbackTitle;
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: `media-item-${index}`,
    role: "list-item",
    label: title,
    group: "media-items",
    status: isActive ? "active" : "inactive",
    description: `Open ${title} (${typeLabel}) from ${item.source}`,
    onActivate: () => onSelect(item.url),
  });
  return (
    <SidebarContent.Item
      ref={ref}
      active={isActive}
      aria-current={isActive ? "true" : undefined}
      onClick={() => onSelect(item.url)}
      {...agentProps}
    >
      <SidebarContent.ItemIcon active={isActive}>
        {item.type.slice(0, 1).toUpperCase()}
      </SidebarContent.ItemIcon>
      <SidebarContent.ItemBody>
        <SidebarContent.ItemTitle className="truncate">
          {title}
        </SidebarContent.ItemTitle>
        <SidebarContent.ItemDescription>
          <span className="truncate">{item.source}</span>
          <span className="uppercase tracking-[0.16em]">{typeLabel}</span>
        </SidebarContent.ItemDescription>
      </SidebarContent.ItemBody>
    </SidebarContent.Item>
  );
});

export function MediaGalleryView({
  leftNav,
  contentHeader,
}: {
  leftNav?: ReactNode;
  contentHeader?: ReactNode;
}) {
  const t = useAppSelector((s) => s.t);
  const profileId = useAppSelector((s) => s.activeAgentProfile?.id);
  const [media, setMedia] = useState<MediaItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [actionError, setActionError] = useState("");
  const loadGeneration = useRef(0);
  const currentProfile = useRef(profileId);
  currentProfile.current = profileId;
  const [filter, setFilter] = useState<MediaType>("all");
  const [search, setSearch] = useState("");
  const [selectedMediaUrl, setSelectedMediaUrl] = useState<string | null>(null);
  const { ref: filterRef, agentProps: filterAgentProps } =
    useAgentElement<HTMLButtonElement>({
      id: "media-type-filter",
      role: "select",
      label: "Media type",
      group: "media-filters",
      options: [...MEDIA_TYPES],
      getValue: () => filter,
      onFill: (value) => {
        if (isMediaType(value)) setFilter(value);
      },
    });

  // The floating chat IS the search box for this view. Stable binding
  // (setSearch is a stable useState setter; placeholder changes only on locale).
  const searchPlaceholder = t("mediagalleryview.SearchMedia");
  const chatBinding = useMemo(
    () => ({ placeholder: searchPlaceholder, onQuery: setSearch }),
    [searchPlaceholder],
  );
  useRegisterViewChatBinding(chatBinding);

  const loadMedia = useCallback(async () => {
    const generation = ++loadGeneration.current;
    const authority = client.getAuthorityRevision();
    const isCurrent = () =>
      loadGeneration.current === generation &&
      client.getAuthorityRevision() === authority &&
      currentProfile.current === profileId;
    setLoading(true);
    setError("");
    try {
      // Discover tables
      const { tables: rawTables } = await client.getDatabaseTables();
      if (!isCurrent()) return;
      const failures: string[] = [];
      const tables = Array.isArray(rawTables) ? rawTables : [];
      const allMedia: MediaItem[] = [];

      // Scan tables likely to contain media: memories, messages, media, attachments, files
      const mediaTables = tables.filter((table) => {
        const n = table.name.toLowerCase();
        return (
          n.includes("memor") ||
          n.includes("message") ||
          n.includes("media") ||
          n.includes("attach") ||
          n.includes("file") ||
          n.includes("asset") ||
          n.includes("document")
        );
      });

      // If no likely tables are found, scan every table for media values.
      const tablesToScan = mediaTables.length > 0 ? mediaTables : tables;

      // Scan the candidate tables concurrently — they are independent queries,
      // and the sequential loop made the gallery wait on up to 10 round-trips.
      // Keep concurrency bounded while covering every candidate table. A
      // fixed first-ten slice silently hid media in later plugin tables.
      for (let offset = 0; offset < tablesToScan.length; offset += 10) {
        if (!isCurrent()) return;
        const scanResults = await Promise.all(
          tablesToScan.slice(offset, offset + 10).map(async (table) => {
            const tableName = table.name;
            const sort = mediaScanSortColumn(table);
            const items: MediaItem[] = [];
            const seen = new Set<string>();
            let rowOffset = 0;

            try {
              while (isCurrent()) {
                const result = await client.getDatabaseRows(tableName, {
                  offset: rowOffset,
                  limit: MEDIA_SCAN_PAGE_SIZE,
                  ...(sort ? { sort, order: "asc" as const } : {}),
                });
                if (!isCurrent()) return items;
                if (
                  !Array.isArray(result.rows) ||
                  !Number.isSafeInteger(result.total) ||
                  result.total < 0 ||
                  result.offset !== rowOffset
                ) {
                  throw new Error("Invalid database page. Retry the scan.");
                }
                const rows = result.rows;
                items.push(...extractMediaFromRows(rows, tableName, seen));
                rowOffset += rows.length;

                // An empty page cannot advance. Stop this table and keep the
                // rows already read so the gallery does not spin.
                if (rows.length === 0 && rowOffset < result.total) {
                  throw new Error(
                    "The table changed or returned an incomplete page. Retry the scan.",
                  );
                }
                if (rows.length === 0 || rowOffset >= result.total) break;
              }
            } catch {
              // Retain readable media and announce the incomplete scan without
              // exposing SQL or transport diagnostics from the failed request.
              failures.push(tableName);
            }

            return items;
          }),
        );
        for (const items of scanResults) allMedia.push(...items);
      }

      // Sort by date descending
      allMedia.sort((a, b) => {
        if (!a.createdAt && !b.createdAt) return 0;
        if (!a.createdAt) return 1;
        if (!b.createdAt) return -1;
        return b.createdAt.localeCompare(a.createdAt);
      });

      if (!isCurrent()) return;
      setMedia(allMedia);
      if (failures.length > 0) {
        setError(
          t("mediagalleryview.PartialLoadFailed", {
            defaultValue:
              "Some media could not be loaded from {{message}}. Retry the scan.",
            message: failures.join("; "),
          }),
        );
      }
    } catch (err) {
      if (!isCurrent()) return;
      setError(
        t("mediagalleryview.LoadFailed", {
          message: err instanceof Error ? err.message : "error",
          defaultValue: "Failed to load media: {{message}}",
        }),
      );
    }
    if (isCurrent()) {
      setLoading(false);
    }
  }, [t, profileId]);

  useLayoutEffect(() => {
    const refresh = () => {
      setMedia([]);
      setSelectedMediaUrl(null);
      setActionError("");
      void loadMedia();
    };
    const unsubscribe = client.onAuthorityChange(refresh);
    refresh();
    return () => {
      loadGeneration.current += 1;
      unsubscribe();
    };
  }, [loadMedia]);

  const filtered = useMemo(
    () =>
      media.filter((m) => {
        if (filter !== "all" && m.type !== filter) return false;
        if (
          search &&
          !m.filename.toLowerCase().includes(search.toLowerCase()) &&
          !m.url.toLowerCase().includes(search.toLowerCase())
        )
          return false;
        return true;
      }),
    [filter, media, search],
  );

  useEffect(() => {
    if (filtered.length === 0) {
      setSelectedMediaUrl(null);
      return;
    }
    if (
      !selectedMediaUrl ||
      !filtered.some((item) => item.url === selectedMediaUrl)
    ) {
      setSelectedMediaUrl(filtered[0].url);
    }
  }, [filtered, selectedMediaUrl]);

  const selectedItem =
    filtered.find((item) => item.url === selectedMediaUrl) ??
    filtered[0] ??
    null;

  const mediaItemFallbackTitle = t("mediagalleryview.MediaItem", {
    defaultValue: "Media item",
  });

  const shareSupported = useMemo(() => canShareFiles(), []);

  const handleDownloadSelected = useCallback(async () => {
    if (!selectedItem) return;
    const url = normalizeMediaUrl(selectedItem.url);
    const mime =
      selectedItem.type === "image"
        ? "image/png"
        : selectedItem.type === "video"
          ? "video/mp4"
          : "audio/mpeg";
    const filename = selectedItem.filename || filenameForMime(mime);
    setActionError("");
    try {
      await downloadAttachment(url, filename);
    } catch (err) {
      setActionError(
        t("mediagalleryview.DownloadFailed", {
          name: filename,
          message: err instanceof Error ? err.message : "error",
          defaultValue: "Could not download {{name}}: {{message}}",
        }),
      );
    }
  }, [selectedItem, t]);

  const handleShareSelected = useCallback(async () => {
    if (!selectedItem) return;
    const url = normalizeMediaUrl(selectedItem.url);
    const title = selectedItem.filename || mediaItemFallbackTitle;
    const shared = await shareAttachment(url, {
      title,
      filename: selectedItem.filename || undefined,
    });
    if (!shared) await handleDownloadSelected();
  }, [handleDownloadSelected, mediaItemFallbackTitle, selectedItem]);

  const mediaSidebar = (
    <AppPageSidebar testId="media-sidebar" collapsible contentIdentity="media">
      <SidebarPanel>
        <div className="[@media(orientation:landscape)_and_(max-height:520px)]:grid [@media(orientation:landscape)_and_(max-height:520px)]:grid-cols-2 [@media(orientation:landscape)_and_(max-height:520px)]:gap-4">
          <div className="space-y-3 pt-4">
            {leftNav}
            <PagePanel.SummaryCard>
              <div className="text-sm font-semibold text-txt">
                {filtered.length === 1
                  ? t("mediagalleryview.ItemCountOne", {
                      count: filtered.length,
                      defaultValue: "{{count}} item",
                    })
                  : t("mediagalleryview.ItemCountMany", {
                      count: filtered.length,
                      defaultValue: "{{count}} items",
                    })}
              </div>
              <div className="mt-3 flex flex-wrap gap-2 text-2xs font-semibold uppercase tracking-[0.14em] text-muted/75">
                <MetaPill>
                  {filter === "all"
                    ? t("mediagalleryview.AllMedia", {
                        defaultValue: "All media",
                      })
                    : mediaTypeLabel(t, filter)}
                </MetaPill>
              </div>
              <ChatSearchHint noun="media" query={search} className="mt-3" />
            </PagePanel.SummaryCard>
          </div>

          <div className="space-y-3 pt-4">
            <div className="space-y-1.5">
              <div
                id="media-type-filter-label"
                className="px-1 text-xs font-medium text-muted"
              >
                Media type
              </div>
              <Select
                value={filter}
                onValueChange={(value) => {
                  if (isMediaType(value)) setFilter(value);
                }}
              >
                <SelectTrigger
                  ref={filterRef}
                  className="w-full"
                  aria-labelledby="media-type-filter-label"
                  {...filterAgentProps}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {MEDIA_TYPES.map((chip) => (
                    <SelectItem key={chip} value={chip}>
                      {mediaTypeLabel(t, chip)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>

        <SidebarScrollRegion className="mt-3 space-y-1.5">
          {loading ? (
            <SidebarContent.EmptyState>
              {t("mediagalleryview.ScanningForMedia")}
            </SidebarContent.EmptyState>
          ) : filtered.length === 0 && error ? null : filtered.length === 0 ? (
            <SidebarContent.EmptyState>
              {t("mediagalleryview.NoMediaFound")}
            </SidebarContent.EmptyState>
          ) : (
            filtered.map((item, index) => (
              <MediaListItem
                // biome-ignore lint/suspicious/noArrayIndexKey: stable url plus index tiebreaker
                key={`${item.url}-${index}`}
                item={item}
                index={index}
                isActive={selectedItem?.url === item.url}
                typeLabel={mediaTypeLabel(t, item.type)}
                fallbackTitle={mediaItemFallbackTitle}
                onSelect={setSelectedMediaUrl}
              />
            ))
          )}
        </SidebarScrollRegion>
      </SidebarPanel>
    </AppPageSidebar>
  );

  return (
    <PageLayout
      sidebar={mediaSidebar}
      contentHeader={contentHeader}
      contentInnerClassName="w-full min-h-0"
    >
      <div className="flex min-h-0 flex-1 flex-col w-full" aria-busy={loading}>
        {actionError ? (
          <div
            role="alert"
            className="mb-4 rounded-sm border border-danger/35 bg-danger/10 px-4 py-3 text-sm text-danger"
          >
            {actionError}
          </div>
        ) : null}
        {error ? (
          <div
            role="alert"
            className="mb-4 rounded-sm border border-danger/35 bg-danger/10 px-4 py-3 text-sm text-danger"
          >
            {error}
            <button
              type="button"
              className="ml-3 underline"
              onClick={() => void loadMedia()}
            >
              {t("common.retry", { defaultValue: "Retry" })}
            </button>
          </div>
        ) : null}
        {loading ? (
          <PagePanel.Loading
            heading={t("mediagalleryview.ScanningForMedia")}
            className="flex-1"
          />
        ) : !selectedItem && error ? null : !selectedItem ? (
          <PagePanel.Empty
            variant="surface"
            className="min-h-[18rem] px-5 py-10"
            title={t("mediagalleryview.NoMediaFound")}
            description={
              media.length === 0
                ? t("mediagalleryview.NoMediaDetectedDescription", {
                    defaultValue:
                      "No images, videos, or audio files were detected in the database.",
                  })
                : t("mediagalleryview.NoFilterMatchesDescription", {
                    defaultValue: "No items match the current filter.",
                  })
            }
          />
        ) : (
          <div className="w-full">
            <PagePanel variant="surface" as="section" className="px-6 py-5">
              <div className="flex flex-wrap items-center gap-3">
                <h2 className="text-2xl font-semibold text-txt">
                  {selectedItem.filename ||
                    t("mediagalleryview.MediaItem", {
                      defaultValue: "Media item",
                    })}
                </h2>
                <span className="text-xs-tight font-semibold uppercase tracking-[0.16em] text-accent">
                  {mediaTypeLabel(t, selectedItem.type)}
                </span>
              </div>
              <div className="mt-2 text-sm text-muted">
                {t("common.source", {
                  defaultValue: "Source:",
                })}{" "}
                {selectedItem.source}
                {selectedItem.createdAt ? ` · ${selectedItem.createdAt}` : ""}
              </div>
              <div className="mt-4 flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  data-testid="media-download"
                  onClick={() => void handleDownloadSelected()}
                >
                  <Download className="mr-1.5 size-4" aria-hidden />
                  {t("mediagalleryview.Download", {
                    defaultValue: "Download",
                  })}
                </Button>
                {shareSupported ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    data-testid="media-share"
                    onClick={() => void handleShareSelected()}
                  >
                    <Share2 className="mr-1.5  size-4" aria-hidden />
                    {t("mediagalleryview.Share", {
                      defaultValue: "Share",
                    })}
                  </Button>
                ) : null}
              </div>
            </PagePanel>

            <PagePanel
              variant="inset"
              className="mt-4 flex min-h-[22rem] flex-1 items-center justify-center p-6"
            >
              {selectedItem.type === "image" ? (
                <img
                  src={normalizeMediaUrl(selectedItem.url)}
                  alt={selectedItem.filename}
                  width={512}
                  height={512}
                  className="max-h-[32rem] w-auto max-w-full rounded-sm object-contain"
                />
              ) : selectedItem.type === "video" ? (
                <video
                  src={normalizeMediaUrl(selectedItem.url)}
                  controls
                  className="max-h-[32rem] max-w-full rounded-sm"
                >
                  <track kind="captions" />
                </video>
              ) : (
                <div className="flex w-full max-w-xl flex-col items-center gap-5 px-8 py-10 text-center">
                  <div className="text-lg font-semibold text-txt">
                    {t("mediagalleryview.AudioPreview", {
                      defaultValue: "Audio Preview",
                    })}
                  </div>
                  <audio
                    src={normalizeMediaUrl(selectedItem.url)}
                    controls
                    className="w-full"
                  >
                    <track kind="captions" />
                  </audio>
                </div>
              )}
            </PagePanel>

            {/* Flat — no card/border. Whitespace separates the details block. */}
            <div className="mt-6 px-6 pb-6 text-sm text-muted">
              <div className="text-2xs font-semibold uppercase tracking-[0.16em] text-muted/60">
                {t("mediagalleryview.MediaDetails", {
                  defaultValue: "Media Details",
                })}
              </div>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <div>
                  <div className="text-xs-tight uppercase tracking-[0.16em] text-muted/60">
                    {t("common.type", { defaultValue: "Type" })}
                  </div>
                  <div className="mt-1 text-sm text-txt">
                    {mediaTypeLabel(t, selectedItem.type)}
                  </div>
                </div>
                <div>
                  <div className="text-xs-tight uppercase tracking-[0.16em] text-muted/60">
                    {t("logsview.Source", {
                      defaultValue: "Source",
                    })}
                  </div>
                  <div className="mt-1 text-sm text-txt">
                    {selectedItem.source}
                  </div>
                </div>
                <div className="sm:col-span-2">
                  <div className="text-xs-tight uppercase tracking-[0.16em] text-muted/60">
                    URL
                  </div>
                  <div className="mt-1 break-all text-sm text-txt">
                    {selectedItem.url}
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </PageLayout>
  );
}
