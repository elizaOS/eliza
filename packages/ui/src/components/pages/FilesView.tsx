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
  ChevronDown,
  Download,
  FileAudio,
  FileText,
  FileVideo,
  FolderOpen,
  ImageIcon,
  Loader2,
  Lock,
  MoreHorizontal,
  Share2,
  Trash2,
} from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { useAgentElement } from "../../agent-surface";
import { client, type StoredFile } from "../../api";
import {
  FramedPage,
  FramedPageBody,
  FramedPageHeader,
  FramedPageNavigation,
} from "../../layouts/framed-page";
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
import { PagePanel } from "../composites/page-panel";
import { RoleGate } from "../RoleGate";
import { Button } from "../ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
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

function isFileFacet(value: string): value is FileFacet {
  return FACETS.some((facet) => facet === value);
}

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
  const className = "size-6 text-muted";
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
  const shareControl = useAgentElement<HTMLDivElement>({
    id: `file-share-${fileAgentId}`,
    role: "button",
    label: `Share ${file.fileName}`,
    group: "file-actions",
    description:
      "Share this stored file, falling back to download when native sharing is unavailable",
    onActivate: () => onShare(file),
  });
  const deleteControl = useAgentElement<HTMLDivElement>({
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
      className="grid min-h-20 grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-1 py-3 sm:px-3"
      data-testid="file-card"
      data-file-name={file.fileName}
      data-file-kind={kind}
    >
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <div className="flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-sm bg-surface/60">
          {kind === "image" ? (
            <img
              src={previewUrl}
              alt=""
              width={56}
              height={56}
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
          <div
            className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 text-xs-tight text-muted"
            title={absoluteDate}
          >
            <span>{kindLabel}</span>
            <span aria-hidden>·</span>
            <span>{sizeLabel}</span>
            <span aria-hidden>·</span>
            <span>{dateLabel}</span>
          </div>
        </div>
      </div>

      <div className="flex shrink-0 items-center justify-end gap-1">
        <Button
          ref={downloadControl.ref}
          {...downloadControl.agentProps}
          type="button"
          variant="outline"
          size="icon"
          data-testid="file-download"
          aria-label={t("filesview.downloadFile", {
            name: file.fileName,
            defaultValue: "Download {{name}}",
          })}
          onClick={() => onDownload(file)}
        >
          <Download className="size-4" aria-hidden />
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={t("filesview.moreActions", {
                name: file.fileName,
                defaultValue: "More actions for {{name}}",
              })}
              data-testid="file-actions"
            >
              <MoreHorizontal className="size-4" aria-hidden />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-44">
            <DropdownMenuLabel className="max-w-56 truncate">
              {file.fileName}
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            {shareSupported ? (
              <DropdownMenuItem
                ref={shareControl.ref}
                {...shareControl.agentProps}
                className="gap-2"
                data-testid="file-share"
                onSelect={() => onShare(file)}
              >
                <Share2 className="size-4" aria-hidden />
                {t("filesview.share", { defaultValue: "Share" })}
              </DropdownMenuItem>
            ) : null}
            {/* Store-wide destructive affordance: ADMIN+ only (#14781). */}
            <RoleGate minRole="ADMIN">
              <DropdownMenuItem
                ref={deleteControl.ref}
                {...deleteControl.agentProps}
                className="gap-2 text-danger focus:text-danger"
                data-testid="file-delete"
                disabled={deleting}
                onSelect={() => onDelete(file)}
              >
                {deleting ? (
                  <Loader2 className="size-4 animate-spin" aria-hidden />
                ) : (
                  <Trash2 className="size-4" aria-hidden />
                )}
                {t("filesview.delete", { defaultValue: "Delete" })}
              </DropdownMenuItem>
            </RoleGate>
          </DropdownMenuContent>
        </DropdownMenu>
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
  const [restricted, setRestricted] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [downloadError, setDownloadError] = useState("");
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
      const { files: list, restricted: restrictedFlag } =
        await client.listFiles();
      setFiles(Array.isArray(list) ? list : []);
      // Server-computed viewer-tier flag (#14781): restricted is a designed
      // state distinct from an owner's empty store; the view only displays it.
      setRestricted(restrictedFlag === true);
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

  const handleDownload = useCallback(
    async (file: StoredFile) => {
      const url = resolveAppAssetUrl(file.url);
      const filename = file.fileName || filenameForMime(file.mimeType);
      setDownloadError("");
      try {
        await downloadAttachment(url, filename);
      } catch (err) {
        setDownloadError(
          t("filesview.downloadFailed", {
            name: filename,
            message: err instanceof Error ? err.message : "error",
            defaultValue: "Could not download {{name}}: {{message}}",
          }),
        );
      }
    },
    [t],
  );
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

  const filterLabel = t("filesview.filterByType", {
    defaultValue: "Filter files by type",
  });
  const facetControl = useAgentElement<HTMLButtonElement>({
    id: "file-type-filter",
    role: "button",
    label: filterLabel,
    group: "file-filters",
    status: facetLabel(t, facet),
    description: "Choose which file type appears in the Files list",
  });
  const facetMenu = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          ref={facetControl.ref}
          {...facetControl.agentProps}
          type="button"
          variant="ghost"
          size="compact"
          aria-label={`${filterLabel}, ${facetLabel(t, facet)} selected, ${facetCounts[facet]} files`}
          data-testid="file-type-filter"
          className="gap-1.5"
        >
          {facetLabel(t, facet)}
          <span className="text-muted">{facetCounts[facet]}</span>
          <ChevronDown className="size-4 text-muted" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-48">
        <DropdownMenuLabel>{filterLabel}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuRadioGroup
          value={facet}
          onValueChange={(value) => {
            if (isFileFacet(value)) setFacet(value);
          }}
        >
          {FACETS.map((entry) => (
            <DropdownMenuRadioItem
              key={entry}
              value={entry}
              data-testid={`file-facet-${entry}`}
            >
              <span className="flex min-w-0 flex-1 items-center justify-between gap-4">
                <span>{facetLabel(t, entry)}</span>
                <span className="text-muted">{facetCounts[entry]}</span>
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  return (
    <FramedPage
      gutterOwner="page-frame"
      data-testid="files-view"
      aria-busy={loading}
    >
      <FramedPageHeader
        title={t("filesview.title", { defaultValue: "Files" })}
      />
      {!loading && !restricted && files.length > 0 ? (
        <FramedPageNavigation className="flex items-center justify-between gap-3">
          <span className="text-sm text-muted">Show</span>
          {facetMenu}
        </FramedPageNavigation>
      ) : null}
      <FramedPageBody scroll="page" className="device-layout gap-4 py-4">
        {downloadError ? (
          <div role="alert" className="text-sm text-danger">
            {downloadError}
          </div>
        ) : null}
        {error ? (
          <div
            role="alert"
            className="flex flex-wrap items-center gap-3 text-sm text-danger"
          >
            <AlertTriangle className="size-4 shrink-0" aria-hidden />
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
            <Loader2 className="size-4 animate-spin" aria-hidden />
            {t("filesview.loading", { defaultValue: "Loading files…" })}
          </div>
        ) : restricted ? (
          <div className="flex flex-1 flex-col" data-testid="files-restricted">
            <PagePanel.Empty
              className="flex-1"
              icon={<Lock className="size-6" aria-hidden />}
              title={t("filesview.restrictedTitle", {
                defaultValue: "Files are restricted",
              })}
              description={t("filesview.restrictedDescription", {
                defaultValue:
                  "Your role can't browse the file store. Shared items appear in their own views.",
              })}
            />
          </div>
        ) : files.length === 0 ? (
          <div
            className="flex flex-1 flex-col border-y border-border/50"
            data-testid="files-empty"
          >
            <PagePanel.Empty
              variant="workspace"
              className="flex-1 [@media(orientation:landscape)_and_(max-height:520px)]:py-4"
              icon={<FolderOpen className="size-6" aria-hidden />}
              title={t("filesview.emptyTitle", {
                defaultValue: "No files yet",
              })}
              description={t("filesview.emptyDescription", {
                defaultValue: "Files shared with Eliza will appear here.",
              })}
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
            className="flex flex-col divide-y divide-border/40 border-y border-border/50"
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
      </FramedPageBody>
    </FramedPage>
  );
}
