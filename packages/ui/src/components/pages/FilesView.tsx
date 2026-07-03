/**
 * FilesView (PR5, attachments v1) — first-class "Files" dashboard view.
 *
 * Lists every stored file (newest first) from `GET /api/files` and exposes
 * per-row CRUD affordances: Download (download-share helper), Share (gated by
 * `canShareFiles()`), and Delete (`DELETE /api/files/:filename` with optimistic
 * removal + confirm). Facet filters (All / Images / Audio / Video / Documents)
 * are derived from each file's `mimeType`.
 *
 * Data flows exclusively through the `client` singleton (`listFiles` /
 * `deleteFile`); the view computes nothing the server should own — it just
 * renders the DTO and routes user intents back through the client + helpers.
 */

import {
  AlertTriangle,
  Download,
  FileAudio,
  FileText,
  FileVideo,
  FolderOpen,
  ImageIcon,
  Loader2,
  Share2,
  Trash2,
} from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { useAgentElement } from "../../agent-surface";
import { client, type StoredFile } from "../../api";
import { useTranslation } from "../../state/TranslationContext.hooks";
import { useRegisterViewChatBinding } from "../../state/view-chat-binding";
import {
  formatByteSize,
  formatRelativeTime,
  resolveAppAssetUrl,
} from "../../utils";
import {
  canShareFiles,
  downloadAttachment,
  filenameForMime,
  shareAttachment,
} from "../../utils/download-share";
import { ChatEmptyStateWithRecommendations } from "../composites/chat";
import { PagePanel } from "../composites/page-panel";
import { Button } from "../ui/button";
import { ShellViewAgentSurface } from "../views/ShellViewAgentSurface";

/* ── mime → kind facets ───────────────────────────────────────────────── */

type FileKind = "image" | "audio" | "video" | "document";
type FileFacet = "all" | FileKind;

const FACETS: readonly FileFacet[] = [
  "all",
  "image",
  "audio",
  "video",
  "document",
];

/**
 * Map a MIME type to one of the facet kinds. Anything that isn't image/audio/
 * video falls back to "document" (the catch-all for PDFs, text, archives, …).
 */
function kindForMime(mimeType: string): FileKind {
  const mime = (mimeType || "").split(";")[0].trim().toLowerCase();
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  return "document";
}

function agentSafeId(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "file"
  );
}

function facetLabel(
  t: (key: string, vars?: Record<string, unknown>) => string,
  facet: FileFacet,
): string {
  switch (facet) {
    case "all":
      return t("filesview.facet.all", { defaultValue: "All" });
    case "image":
      return t("filesview.facet.images", { defaultValue: "Images" });
    case "audio":
      return t("filesview.facet.audio", { defaultValue: "Audio" });
    case "video":
      return t("filesview.facet.video", { defaultValue: "Video" });
    case "document":
      return t("filesview.facet.documents", { defaultValue: "Documents" });
  }
}

function KindIcon({ kind }: { kind: FileKind }) {
  const className = "h-6 w-6 text-muted";
  switch (kind) {
    case "image":
      return <ImageIcon className={className} aria-hidden />;
    case "audio":
      return <FileAudio className={className} aria-hidden />;
    case "video":
      return <FileVideo className={className} aria-hidden />;
    case "document":
      return <FileText className={className} aria-hidden />;
  }
}

function FileFacetButton({
  facet,
  label,
  count,
  active,
  onSelect,
}: {
  facet: FileFacet;
  label: string;
  count: number;
  active: boolean;
  onSelect: (facet: FileFacet) => void;
}) {
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: `file-facet-${facet}`,
    role: "toggle",
    label: `Show ${label} files`,
    group: "file-facets",
    status: active ? "active" : "inactive",
    description: "Filter the Files view by file type",
    onActivate: () => onSelect(facet),
  });

  return (
    <button
      ref={ref}
      {...agentProps}
      type="button"
      data-testid={`file-facet-${facet}`}
      aria-pressed={active}
      onClick={() => onSelect(facet)}
      className={`min-h-11 rounded-full px-3 py-2 text-xs-tight font-semibold transition-colors ${
        active
          ? "bg-accent/15 text-accent"
          : "text-muted hover:bg-surface hover:text-txt"
      }`}
    >
      {label}
      <span className="ml-1.5 text-muted/70">{count}</span>
    </button>
  );
}

function FileShareButton({
  file,
  fileAgentId,
  t,
  onShare,
}: {
  file: StoredFile;
  fileAgentId: string;
  t: (key: string, vars?: Record<string, unknown>) => string;
  onShare: (file: StoredFile) => void;
}) {
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: `file-share-${fileAgentId}`,
    role: "button",
    label: `Share ${file.fileName}`,
    group: "file-actions",
    description:
      "Share this stored file, falling back to download when native sharing is unavailable",
    onActivate: () => onShare(file),
  });

  return (
    <Button
      ref={ref}
      {...agentProps}
      type="button"
      variant="outline"
      size="sm"
      data-testid="file-share"
      aria-label={t("filesview.shareFile", {
        name: file.fileName,
        defaultValue: "Share {{name}}",
      })}
      onClick={() => onShare(file)}
    >
      <Share2 className="mr-1.5 h-4 w-4" aria-hidden />
      {t("filesview.share", { defaultValue: "Share" })}
    </Button>
  );
}

/* ── per-file card ────────────────────────────────────────────────────── */

interface FileCardProps {
  file: StoredFile;
  kind: FileKind;
  kindLabel: string;
  shareSupported: boolean;
  deleting: boolean;
  t: (key: string, vars?: Record<string, unknown>) => string;
  onDownload: (file: StoredFile) => void;
  onShare: (file: StoredFile) => void;
  onDelete: (file: StoredFile) => void;
}

const FileCard = memo(function FileCard({
  file,
  kind,
  kindLabel,
  shareSupported,
  deleting,
  t,
  onDownload,
  onShare,
  onDelete,
}: FileCardProps) {
  const previewUrl = resolveAppAssetUrl(file.url);
  const sizeLabel = formatByteSize(file.size);
  const dateLabel = formatRelativeTime(file.createdAt);
  const absoluteDate = new Date(file.createdAt).toISOString();
  const fileAgentId = agentSafeId(file.fileName || file.hash);
  const downloadControl = useAgentElement<HTMLButtonElement>({
    id: `file-download-${fileAgentId}`,
    role: "button",
    label: `Download ${file.fileName}`,
    group: "file-actions",
    description: "Download this stored file",
    onActivate: () => onDownload(file),
  });
  const deleteControl = useAgentElement<HTMLButtonElement>({
    id: `file-delete-${fileAgentId}`,
    role: "button",
    label: `Delete ${file.fileName}`,
    group: "file-actions",
    status: deleting ? "deleting" : "ready",
    description: "Delete this stored file after confirmation",
    onActivate: () => onDelete(file),
  });

  return (
    <li
      className="flex flex-col gap-3 p-3"
      data-testid="file-card"
      data-file-name={file.fileName}
      data-file-kind={kind}
    >
      <div className="flex items-start gap-3">
        <div className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-sm bg-surface/60">
          {kind === "image" ? (
            <img
              src={previewUrl}
              alt=""
              className="h-full w-full object-cover"
              loading="lazy"
            />
          ) : (
            <KindIcon kind={kind} />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div
            className="truncate text-sm font-semibold text-txt"
            title={file.fileName}
          >
            {file.fileName}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-2xs font-semibold uppercase tracking-[0.14em] text-muted/75">
            <span className="rounded-full px-2 py-0.5 text-accent">
              {kindLabel}
            </span>
            <span>{sizeLabel}</span>
          </div>
          <div className="mt-1 text-xs-tight text-muted" title={absoluteDate}>
            {dateLabel}
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          ref={downloadControl.ref}
          {...downloadControl.agentProps}
          type="button"
          variant="outline"
          size="sm"
          data-testid="file-download"
          aria-label={t("filesview.downloadFile", {
            name: file.fileName,
            defaultValue: "Download {{name}}",
          })}
          onClick={() => onDownload(file)}
        >
          <Download className="mr-1.5 h-4 w-4" aria-hidden />
          {t("filesview.download", { defaultValue: "Download" })}
        </Button>
        {shareSupported ? (
          <FileShareButton
            file={file}
            fileAgentId={fileAgentId}
            t={t}
            onShare={onShare}
          />
        ) : null}
        <Button
          ref={deleteControl.ref}
          {...deleteControl.agentProps}
          type="button"
          variant="surfaceDestructive"
          size="sm"
          className="ml-auto"
          data-testid="file-delete"
          disabled={deleting}
          aria-label={t("filesview.deleteFile", {
            name: file.fileName,
            defaultValue: "Delete {{name}}",
          })}
          onClick={() => onDelete(file)}
        >
          {deleting ? (
            <Loader2 className="mr-1.5 h-4 w-4 animate-spin" aria-hidden />
          ) : (
            <Trash2 className="mr-1.5 h-4 w-4" aria-hidden />
          )}
          {t("filesview.delete", { defaultValue: "Delete" })}
        </Button>
      </div>
    </li>
  );
});

/* ── main view ────────────────────────────────────────────────────────── */

export function FilesView() {
  return (
    <ShellViewAgentSurface viewId="files">
      <FilesViewBody />
    </ShellViewAgentSurface>
  );
}

function FilesViewBody() {
  const { t } = useTranslation();
  const [files, setFiles] = useState<StoredFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [facet, setFacet] = useState<FileFacet>("all");
  const [query, setQuery] = useState("");
  const [deletingName, setDeletingName] = useState<string | null>(null);

  const shareSupported = useMemo(() => canShareFiles(), []);

  // The active view drives the one floating chat composer as its filter box:
  // each keystroke flows in via onQuery, narrowing the grid by filename.
  const chatBinding = useMemo(
    () => ({
      placeholder: t("filesview.searchPlaceholder", {
        defaultValue: "Search files by name…",
      }),
      onQuery: setQuery,
    }),
    [t],
  );
  useRegisterViewChatBinding(chatBinding);

  const loadFiles = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const { files: list } = await client.listFiles();
      setFiles(Array.isArray(list) ? list : []);
    } catch (err) {
      setError(
        t("filesview.loadFailed", {
          message: err instanceof Error ? err.message : "error",
          defaultValue: "Failed to load files: {{message}}",
        }),
      );
    }
    setLoading(false);
  }, [t]);

  useEffect(() => {
    void loadFiles();
  }, [loadFiles]);

  const facetCounts = useMemo(() => {
    const counts: Record<FileFacet, number> = {
      all: files.length,
      image: 0,
      audio: 0,
      video: 0,
      document: 0,
    };
    for (const file of files) counts[kindForMime(file.mimeType)] += 1;
    return counts;
  }, [files]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return files.filter((f) => {
      if (facet !== "all" && kindForMime(f.mimeType) !== facet) return false;
      if (q && !f.fileName.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [facet, files, query]);

  const handleDownload = useCallback(async (file: StoredFile) => {
    const url = resolveAppAssetUrl(file.url);
    const filename = file.fileName || filenameForMime(file.mimeType);
    try {
      await downloadAttachment(url, filename);
    } catch {
      // Download failed for this transport — nothing more we can do client-side.
    }
  }, []);
  const retryControl = useAgentElement<HTMLButtonElement>({
    id: "files-retry-load",
    role: "button",
    label: "Retry loading files",
    group: "file-actions",
    description: "Reload the Files view after a load error",
    onActivate: () => void loadFiles(),
  });

  const handleShare = useCallback(
    async (file: StoredFile) => {
      const url = resolveAppAssetUrl(file.url);
      const shared = await shareAttachment(url, {
        title: file.fileName,
        filename: file.fileName || undefined,
      });
      if (!shared) await handleDownload(file);
    },
    [handleDownload],
  );

  const handleDelete = useCallback(
    async (file: StoredFile) => {
      if (
        typeof window !== "undefined" &&
        typeof window.confirm === "function"
      ) {
        const confirmed = window.confirm(
          t("filesview.deleteConfirm", {
            name: file.fileName,
            defaultValue: 'Delete "{{name}}"? This cannot be undone.',
          }),
        );
        if (!confirmed) return;
      }
      setDeletingName(file.fileName);
      // Optimistic removal — snapshot so we can restore on failure.
      const snapshot = files;
      setFiles((prev) => prev.filter((f) => f.fileName !== file.fileName));
      try {
        const { deleted } = await client.deleteFile(file.fileName);
        if (!deleted) {
          setFiles(snapshot);
          setError(
            t("filesview.deleteFailed", {
              name: file.fileName,
              defaultValue: "Failed to delete {{name}}.",
            }),
          );
        }
      } catch (err) {
        setFiles(snapshot);
        setError(
          t("filesview.deleteFailed", {
            name: file.fileName,
            message: err instanceof Error ? err.message : "error",
            defaultValue: "Failed to delete {{name}}.",
          }),
        );
      } finally {
        setDeletingName(null);
      }
    },
    [files, t],
  );

  const facetBar = (
    <div
      className="flex flex-wrap gap-2"
      role="toolbar"
      aria-label={t("filesview.filterByType", {
        defaultValue: "Filter files by type",
      })}
    >
      {FACETS.map((f) => {
        const active = facet === f;
        const label = facetLabel(t, f);
        return (
          <FileFacetButton
            key={f}
            facet={f}
            label={label}
            count={facetCounts[f]}
            active={active}
            onSelect={setFacet}
          />
        );
      })}
    </div>
  );

  return (
    <section
      className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-5 sm:px-6"
      data-testid="files-view"
      aria-label={t("filesview.title", { defaultValue: "Files" })}
      aria-busy={loading}
    >
      {facetBar}

      <div className="flex min-h-0 flex-1 flex-col gap-4">
        {error ? (
          <div
            role="alert"
            className="flex flex-wrap items-center gap-3 text-sm text-danger"
          >
            <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />
            <span>{error}</span>
            <Button
              ref={retryControl.ref}
              {...retryControl.agentProps}
              type="button"
              variant="default"
              size="sm"
              onClick={() => void loadFiles()}
            >
              {t("filesview.retry", { defaultValue: "Retry" })}
            </Button>
          </div>
        ) : null}

        {loading ? (
          <div
            className="flex flex-1 items-center justify-center gap-2 text-sm italic text-muted"
            data-testid="files-loading"
          >
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            {t("filesview.loading", { defaultValue: "Loading files…" })}
          </div>
        ) : files.length === 0 ? (
          <div className="flex flex-1 flex-col" data-testid="files-empty">
            <ChatEmptyStateWithRecommendations
              icon={FolderOpen}
              title={t("filesview.emptyTitle", {
                defaultValue: "No files yet",
              })}
              recommendations={[
                t("filesview.recGenerate", {
                  defaultValue: "Generate a file and save it to my files",
                }),
                t("filesview.recSaveChat", {
                  defaultValue: "Save our conversation as a text document",
                }),
                t("filesview.recSample", {
                  defaultValue: "Create a sample markdown note",
                }),
              ]}
            />
          </div>
        ) : filtered.length === 0 ? (
          <PagePanel.Empty
            variant="inset"
            data-testid="files-empty-filter"
            title={t("filesview.noMatchesTitle", {
              defaultValue: "No files match this filter",
            })}
            description={t("filesview.noMatchesDescription", {
              defaultValue: "Try a different type filter or search term.",
            })}
          />
        ) : (
          <ul
            className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3"
            data-testid="files-grid"
            aria-label={t("filesview.listLabel", { defaultValue: "Files" })}
          >
            {filtered.map((file) => (
              <FileCard
                key={`${file.hash}:${file.fileName}`}
                file={file}
                kind={kindForMime(file.mimeType)}
                kindLabel={facetLabel(t, kindForMime(file.mimeType))}
                shareSupported={shareSupported}
                deleting={deletingName === file.fileName}
                t={t}
                onDownload={(f) => void handleDownload(f)}
                onShare={(f) => void handleShare(f)}
                onDelete={(f) => void handleDelete(f)}
              />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
