import {
  Button,
  Input,
  MetaPill,
  PageLayout,
  PagePanel,
  SidebarContent,
  SidebarPanel,
  SidebarScrollRegion,
} from "@elizaos/ui";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { client, type QueryResult } from "../../api";
import { useApp } from "../../state";
import type { TranslateFn } from "../../types";
import { resolveAppAssetUrl } from "../../utils";
import { AppPageSidebar } from "../shared/AppPageSidebar";

type MediaType = "all" | "image" | "video" | "audio";

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

const FILTER_CHIPS: readonly MediaType[] = ["all", "image", "video", "audio"];

/** Extract media URLs from arbitrary row data by scanning all string values. */
function extractMediaFromRows(
  rows: Record<string, unknown>[],
  tableName: string,
): MediaItem[] {
  const items: MediaItem[] = [];
  const seen = new Set<string>();

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

export function MediaGalleryView({
  leftNav,
  contentHeader,
}: {
  leftNav?: ReactNode;
  contentHeader?: ReactNode;
}) {
  const { t } = useApp();
  const [media, setMedia] = useState<MediaItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState<MediaType>("all");
  const [search, setSearch] = useState("");
  const [selectedMediaUrl, setSelectedMediaUrl] = useState<string | null>(null);

  const loadMedia = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      // Discover tables
      const { tables: rawTables } = await client.getDatabaseTables();
      const tables = Array.isArray(rawTables) ? rawTables : [];
      const allMedia: MediaItem[] = [];

      // Scan tables likely to contain media: memories, messages, media, attachments, files
      const mediaTableNames = tables
        .map((t) => t.name)
        .filter((name) => {
          const n = name.toLowerCase();
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

      // If no likely tables found, scan all tables with modest limits
      const tablesToScan =
        mediaTableNames.length > 0
          ? mediaTableNames
          : tables.map((t) => t.name);
      const scanLimit = mediaTableNames.length > 0 ? 500 : 100;

      for (const tableName of tablesToScan.slice(0, 10)) {
        try {
          const result: QueryResult = await client.executeDatabaseQuery(
            `SELECT * FROM "${tableName}" LIMIT ${scanLimit}`,
          );
          const rows = Array.isArray(result.rows) ? result.rows : [];
          const items = extractMediaFromRows(rows, tableName);
          allMedia.push(...items);
        } catch {
          // skip tables that fail
        }
      }

      // Sort by date descending
      allMedia.sort((a, b) => {
        if (!a.createdAt && !b.createdAt) return 0;
        if (!a.createdAt) return 1;
        if (!b.createdAt) return -1;
        return b.createdAt.localeCompare(a.createdAt);
      });

      setMedia(allMedia);
    } catch (err) {
      setError(
        t("mediagalleryview.LoadFailed", {
          message: err instanceof Error ? err.message : "error",
          defaultValue: "Failed to load media: {{message}}",
        }),
      );
    }
    setLoading(false);
  }, [t]);

  useEffect(() => {
    loadMedia();
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

  const mediaSidebar = (
    <AppPageSidebar testId="media-sidebar" collapsible contentIdentity="media">
      <SidebarPanel>
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
              {search ? (
                <span className="rounded-full border border-accent/25 bg-accent/8 px-2.5 py-1 text-accent">
                  {t("mediagalleryview.SearchActive", {
                    defaultValue: "Search active",
                  })}
                </span>
              ) : null}
            </div>
          </PagePanel.SummaryCard>
        </div>

        <div className="space-y-3 pt-4">
          <Input
            type="search"
            placeholder={t("mediagalleryview.SearchMedia")}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-10 rounded-xl border-border/40 bg-card/50 text-sm placeholder:text-muted/65 focus-visible:ring-accent/30"
          />

          <div className="grid grid-cols-2 gap-1.5">
            {FILTER_CHIPS.map((chip) => {
              const isActive = filter === chip;
              return (
                <Button
                  key={chip}
                  variant="ghost"
                  size="sm"
                  className={`h-auto min-h-[2.25rem] rounded-xl border px-3 py-2 text-left text-xs-tight font-semibold transition-colors ${
                    isActive
                      ? "border-accent/35 bg-accent/14 text-txt-strong"
                      : "border-border/45 bg-bg/35 text-muted hover:border-border/60 hover:bg-bg-hover hover:text-txt"
                  }`}
                  onClick={() => setFilter(chip)}
                >
                  {mediaTypeLabel(t, chip)}
                </Button>
              );
            })}
          </div>
        </div>

        <SidebarScrollRegion className="mt-3 space-y-1.5">
          {loading ? (
            <SidebarContent.EmptyState>
              {t("mediagalleryview.ScanningForMedia")}
            </SidebarContent.EmptyState>
          ) : filtered.length === 0 ? (
            <SidebarContent.EmptyState>
              {t("mediagalleryview.NoMediaFound")}
            </SidebarContent.EmptyState>
          ) : (
            filtered.map((item, index) => {
              const isActive = selectedItem?.url === item.url;
              return (
                <SidebarContent.Item
                  active={isActive}
                  // biome-ignore lint/suspicious/noArrayIndexKey: stable url plus index tiebreaker
                  key={`${item.url}-${index}`}
                  onClick={() => setSelectedMediaUrl(item.url)}
                >
                  <SidebarContent.ItemIcon active={isActive}>
                    {item.type.slice(0, 1).toUpperCase()}
                  </SidebarContent.ItemIcon>
                  <SidebarContent.ItemBody>
                    <SidebarContent.ItemTitle className="truncate">
                      {item.filename ||
                        t("mediagalleryview.MediaItem", {
                          defaultValue: "Media item",
                        })}
                    </SidebarContent.ItemTitle>
                    <SidebarContent.ItemDescription>
                      <span className="truncate">{item.source}</span>
                      <span className="rounded-full border border-border/45 px-2 py-0.5 uppercase tracking-[0.16em]">
                        {mediaTypeLabel(t, item.type)}
                      </span>
                    </SidebarContent.ItemDescription>
                  </SidebarContent.ItemBody>
                </SidebarContent.Item>
              );
            })
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
      <div className="flex min-h-0 flex-1 flex-col w-full">
        {error ? (
          <div className="mb-4 rounded-2xl border border-danger/35 bg-danger/10 px-4 py-3 text-sm text-danger">
            {error}
          </div>
        ) : loading ? (
          <div className="flex flex-1 items-center justify-center text-sm italic text-muted">
            {t("mediagalleryview.ScanningForMedia")}
          </div>
        ) : !selectedItem ? (
          <PagePanel.Empty
            variant="surface"
            className="min-h-[18rem] rounded-3xl px-5 py-10"
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
              <div className="text-2xs font-semibold uppercase tracking-[0.16em] text-muted/60">
                {t("mediagalleryview.Media", { defaultValue: "Media" })}
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-3">
                <h2 className="text-2xl font-semibold text-txt">
                  {selectedItem.filename ||
                    t("mediagalleryview.MediaItem", {
                      defaultValue: "Media item",
                    })}
                </h2>
                <span className="rounded-full border border-accent/30 bg-accent/12 px-3 py-1 text-xs-tight font-semibold uppercase tracking-[0.16em] text-accent-fg">
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
            </PagePanel>

            <PagePanel
              variant="inset"
              className="mt-4 flex min-h-[22rem] flex-1 items-center justify-center p-6"
            >
              {selectedItem.type === "image" ? (
                <img
                  src={normalizeMediaUrl(selectedItem.url)}
                  alt={selectedItem.filename}
                  className="max-h-[32rem] max-w-full rounded-2xl object-contain"
                />
              ) : selectedItem.type === "video" ? (
                <video
                  src={normalizeMediaUrl(selectedItem.url)}
                  controls
                  className="max-h-[32rem] max-w-full rounded-2xl"
                >
                  <track kind="captions" />
                </video>
              ) : (
                <div className="flex w-full max-w-xl flex-col items-center gap-5 rounded-3xl border border-border/35 bg-bg/35 px-8 py-10 text-center">
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

            <div className="mt-5 rounded-2xl border border-border/40 bg-card/45 px-5 py-4 text-sm text-muted">
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
