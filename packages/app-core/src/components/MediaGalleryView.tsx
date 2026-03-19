/**
 * Media Gallery — browse photos, videos, and audio stored in agent databases.
 *
 * Queries known tables for records containing media URLs (image/video/audio
 * file extensions or data URIs). All data flows through the generic database
 * APIs (getDatabaseTables, executeDatabaseQuery).
 */

import { Button, Input } from "@miladyai/ui";
import { useCallback, useEffect, useState } from "react";
import { client, type QueryResult } from "../api";
import { useApp } from "../state";
import { resolveAppAssetUrl } from "../utils";

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
    return segments[segments.length - 1] || "media";
  } catch {
    return "media";
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

const FILTER_CHIPS: { id: MediaType; label: string }[] = [
  { id: "all", label: "All" },
  { id: "image", label: "Images" },
  { id: "video", label: "Video" },
  { id: "audio", label: "Audio" },
];

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

export function MediaGalleryView() {
  const { t } = useApp();
  const [media, setMedia] = useState<MediaItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState<MediaType>("all");
  const [search, setSearch] = useState("");
  const [lightboxItem, setLightboxItem] = useState<MediaItem | null>(null);

  const loadMedia = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      // Discover tables
      const { tables } = await client.getDatabaseTables();
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
          const items = extractMediaFromRows(result.rows, tableName);
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
        `Failed to load media: ${err instanceof Error ? err.message : "error"}`,
      );
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    loadMedia();
  }, [loadMedia]);

  const filtered = media.filter((m) => {
    if (filter !== "all" && m.type !== filter) return false;
    if (
      search &&
      !m.filename.toLowerCase().includes(search.toLowerCase()) &&
      !m.url.toLowerCase().includes(search.toLowerCase())
    )
      return false;
    return true;
  });

  return (
    <div>
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <Input
          type="text"
          placeholder={t("mediagalleryview.SearchMedia")}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="px-2.5 py-1.5 h-8 text-xs w-[200px] shadow-sm bg-[var(--card)]"
        />
        <div className="flex gap-1">
          {FILTER_CHIPS.map((chip) => (
            <Button
              variant={filter === chip.id ? "default" : "outline"}
              size="sm"
              key={chip.id}
              className={`px-3 py-1 h-7 text-xs shadow-sm transition-colors ${
                filter === chip.id
                  ? ""
                  : "bg-transparent text-[var(--muted)] hover:text-[var(--txt)] border-[var(--border)]"
              }`}
              onClick={() => setFilter(chip.id)}
            >
              {chip.label}
            </Button>
          ))}
        </div>
        <span className="text-[11px] text-[var(--muted)] ml-auto">
          {filtered.length} {t("mediagalleryview.item")}
          {filtered.length !== 1 ? "s" : ""}
        </span>
      </div>

      {error && (
        <div className="p-2.5 border border-[var(--danger)] text-[var(--danger)] text-xs mb-3">
          {error}
        </div>
      )}

      {loading ? (
        <div className="text-center py-16 text-[var(--muted)] text-sm italic">
          {t("mediagalleryview.ScanningForMedia")}
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-16">
          <div className="text-[var(--muted)] text-sm mb-2">
            {t("mediagalleryview.NoMediaFound")}
          </div>
          <div className="text-[var(--muted)] text-xs">
            {media.length === 0
              ? "No images, videos, or audio files were detected in the database."
              : "No items match the current filter."}
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
          {filtered.map((item, i) => (
            <button
              type="button"
              // biome-ignore lint/suspicious/noArrayIndexKey: composite key with index as tiebreaker
              key={`${item.url}-${i}`}
              className="bg-[var(--card)] border border-[var(--border)] p-0 cursor-pointer text-left hover:border-[var(--accent)] transition-colors group"
              onClick={() => setLightboxItem(item)}
            >
              {/* Thumbnail area */}
              <div className="w-full aspect-square bg-[var(--bg)] flex items-center justify-center overflow-hidden">
                {item.type === "image" ? (
                  <img
                    src={normalizeMediaUrl(item.url)}
                    alt={item.filename}
                    className="w-full h-full object-cover"
                    loading="lazy"
                    onError={(e) => {
                      const image = e.target as HTMLImageElement;
                      image.style.display = "none";
                      if (image.parentElement) {
                        image.parentElement.innerHTML =
                          '<span style="font-size:24px">🖼</span>';
                      }
                    }}
                  />
                ) : item.type === "video" ? (
                  <span className="text-2xl opacity-50">🎬</span>
                ) : (
                  <span className="text-2xl opacity-50">🎵</span>
                )}
              </div>
              {/* Info */}
              <div className="p-2">
                <div className="text-[11px] text-[var(--txt)] truncate">
                  {item.filename}
                </div>
                <div className="flex items-center gap-1 mt-1">
                  <span
                    className={`text-[9px] px-1.5 py-0.5 uppercase font-bold ${
                      item.type === "image"
                        ? "bg-blue-500/20 text-blue-400"
                        : item.type === "video"
                          ? "bg-purple-500/20 text-purple-400"
                          : "bg-green-500/20 text-green-400"
                    }`}
                  >
                    {item.type}
                  </span>
                  <span className="text-[9px] text-[var(--muted)] truncate">
                    {item.source}
                  </span>
                </div>
              </div>
            </button>
          ))}
        </div>
      )}

      {/* Lightbox modal */}
      {lightboxItem && (
        <div
          className="fixed inset-0 bg-black/80 z-50 flex items-center justify-center p-8"
          onClick={(e) => {
            if (e.target === e.currentTarget) setLightboxItem(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape" || e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              setLightboxItem(null);
            }
          }}
          role="dialog"
          aria-modal="true"
        >
          <div className="bg-[var(--card)] border border-[var(--border)] max-w-[90vw] max-h-[90vh] overflow-auto">
            {/* Header */}
            <div className="flex items-center justify-between p-3 border-b border-[var(--border)]">
              <div className="text-xs text-[var(--txt)] font-medium truncate mr-4">
                {lightboxItem.filename}
              </div>
              <button
                type="button"
                className="text-[var(--muted)] hover:text-[var(--txt)] bg-transparent border-0 cursor-pointer text-lg px-2"
                onClick={() => setLightboxItem(null)}
              >
                ×
              </button>
            </div>
            {/* Content */}
            <div className="p-4 flex items-center justify-center min-h-[200px]">
              {lightboxItem.type === "image" ? (
                <img
                  src={normalizeMediaUrl(lightboxItem.url)}
                  alt={lightboxItem.filename}
                  className="max-w-full max-h-[70vh] object-contain"
                />
              ) : lightboxItem.type === "video" ? (
                <video
                  src={normalizeMediaUrl(lightboxItem.url)}
                  controls
                  className="max-w-full max-h-[70vh]"
                >
                  <track kind="captions" />
                </video>
              ) : (
                <audio
                  src={normalizeMediaUrl(lightboxItem.url)}
                  controls
                  className="w-full max-w-[400px]"
                >
                  <track kind="captions" />
                </audio>
              )}
            </div>
            {/* Footer info */}
            <div className="p-3 border-t border-[var(--border)] text-[11px] text-[var(--muted)] flex gap-4">
              <span>
                {t("mediagalleryview.Type")} {lightboxItem.type}
              </span>
              <span>
                {t("mediagalleryview.Source")} {lightboxItem.source}
              </span>
              {lightboxItem.createdAt && (
                <span>
                  {t("mediagalleryview.Date")} {lightboxItem.createdAt}
                </span>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
