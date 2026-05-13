import {
  BadgeCheck,
  Bot,
  FileSearch,
  FileText,
  Globe2,
  Layers,
  Lock,
  Search,
  Shield,
  User,
  X,
} from "lucide-react";
import {
  type ChangeEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { client } from "../../api/client";
import type {
  DocumentRecord,
  DocumentScope,
  DocumentSearchResult,
} from "../../api/client-types-chat";
import { useApp } from "../../state/useApp";
import { confirmDesktopAction } from "../../utils/desktop-dialogs";
import {
  isDocumentImageFile,
  MAX_DOCUMENT_IMAGE_PROCESSING_BYTES,
  maybeCompressDocumentUploadImage,
} from "../../utils/documents-upload-image";
import { formatByteSize } from "../../utils/format";
import { PagePanel } from "../composites/page-panel";
import { ConfirmDeleteControl } from "../shared/confirm-delete-control";
import { Button } from "../ui/button";
import {
  DocumentViewer,
  getDocumentSummary,
  getDocumentTypeLabel,
} from "./documents-detail";
import {
  BULK_UPLOAD_TARGET_BYTES,
  DEFAULT_DOCUMENT_UPLOAD_SCOPE,
  DOCUMENT_UPLOAD_ACCEPT,
  type DocumentUploadFile,
  type DocumentUploadOptions,
  getDocumentUploadFilename,
  isSupportedDocumentFile,
  LARGE_FILE_WARNING_BYTES,
  MAX_BULK_REQUEST_DOCUMENTS,
  MAX_UPLOAD_REQUEST_BYTES,
  shouldReadDocumentFileAsText,
  UploadZone,
} from "./documents-upload";

// Re-export public API used by tests and other modules
export {
  type DocumentUploadFile,
  getDocumentUploadFilename,
  shouldReadDocumentFileAsText,
} from "./documents-upload";

type DocumentScopeFilter = "all" | DocumentScope;

const SCOPE_FILTER_OPTIONS: ReadonlyArray<{
  value: DocumentScopeFilter;
  labelKey: string;
  defaultLabel: string;
  Icon: typeof Globe2;
}> = [
  {
    value: "all",
    labelKey: "documentsview.ScopeAll",
    defaultLabel: "All",
    Icon: Layers,
  },
  {
    value: "global",
    labelKey: "documentsview.ScopeGlobal",
    defaultLabel: "Global",
    Icon: Globe2,
  },
  {
    value: "owner-private",
    labelKey: "documentsview.ScopeOwner",
    defaultLabel: "Owner",
    Icon: Shield,
  },
  {
    value: "user-private",
    labelKey: "documentsview.ScopeUser",
    defaultLabel: "User",
    Icon: User,
  },
  {
    value: "agent-private",
    labelKey: "documentsview.ScopeAgent",
    defaultLabel: "Agent",
    Icon: Bot,
  },
];

/* ── Search Result Item ─────────────────────────────────────────────── */

function SearchResultListItem({
  result,
  active,
  onSelect,
}: {
  result: DocumentSearchResult;
  active: boolean;
  onSelect: (documentId: string) => void;
}) {
  const { t } = useApp();

  return (
    <button
      onClick={() => onSelect(result.documentId || result.id)}
      type="button"
      aria-current={active ? "page" : undefined}
      className={`group flex w-full items-start px-0 py-3 text-left transition-colors ${
        active ? "bg-transparent" : "bg-transparent hover:bg-white/[0.03]"
      }`}
    >
      <span
        className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border text-2xs font-bold ${
          active
            ? "border-accent/25 bg-accent/10 text-accent-fg"
            : "border-border/15 bg-transparent text-muted-strong"
        }`}
      >
        {(result.similarity * 100).toFixed(0)}%
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <FileSearch className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden />
          <div className="truncate text-sm font-semibold text-txt">
            {result.documentTitle ||
              t("documentsview.UnknownDocument", {
                defaultValue: "Unknown Document",
              })}
          </div>
        </div>
        <div className="mt-1 line-clamp-2 text-xs text-muted">
          {result.text}
        </div>
      </div>
    </button>
  );
}

/* ── Document Card ──────────────────────────────────────────────────── */

function DocumentListItem({
  doc,
  active,
  onSelect,
  onDelete,
  deleting,
}: {
  doc: DocumentRecord;
  active: boolean;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  deleting: boolean;
}) {
  const { t } = useApp();
  const scopeLabel =
    doc.scope === "owner-private"
      ? t("documentsview.ScopeOwner", { defaultValue: "Owner" })
      : doc.scope === "user-private"
        ? t("documentsview.ScopeUser", { defaultValue: "User" })
        : doc.scope === "agent-private"
          ? t("documentsview.ScopeAgent", { defaultValue: "Agent" })
          : t("documentsview.ScopeGlobal", { defaultValue: "Global" });
  const ScopeIcon =
    doc.scope === "owner-private"
      ? Shield
      : doc.scope === "user-private"
        ? User
        : doc.scope === "agent-private"
          ? Bot
          : Globe2;
  return (
    <div
      className={`group relative flex w-full transition-colors ${
        active ? "bg-transparent" : "bg-transparent hover:bg-white/[0.03]"
      }`}
    >
      <button
        type="button"
        onClick={() => onSelect(doc.id)}
        aria-label={t("documentsview.OpenDocument", {
          defaultValue: "Open {{filename}}",
          filename: doc.filename,
        })}
        aria-current={active ? "page" : undefined}
        title={doc.filename}
        className="flex min-w-0 flex-1 items-center gap-3 px-3.5 py-3 text-left"
      >
        <span
          className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border ${
            active
              ? "border-accent/30 bg-accent/10 text-accent"
              : "border-border/30 bg-bg-muted/20 text-muted"
          }`}
        >
          <FileText className="h-4 w-4" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold leading-snug text-txt">
            {doc.filename}
          </div>
          <div className="mt-1 truncate text-xs text-muted">
            {getDocumentSummary(doc, t)}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-2xs text-muted/70">
            <span className="inline-flex items-center gap-1 rounded-full border border-accent/20 bg-accent/8 px-1.5 py-0.5 text-accent-fg">
              <ScopeIcon className="h-3 w-3" aria-hidden />
              {scopeLabel}
            </span>
            <span className="rounded-full border border-border/30 bg-bg-muted/20 px-1.5 py-0.5">
              {getDocumentTypeLabel(doc.contentType)}
            </span>
            {doc.canEditText ? (
              <span className="inline-flex items-center gap-1 rounded-full border border-status-success/25 bg-status-success-bg px-1.5 py-0.5 text-status-success">
                <BadgeCheck className="h-3 w-3" aria-hidden />
                {t("documentsview.Editable", { defaultValue: "editable" })}
              </span>
            ) : null}
            {!doc.canDelete ? (
              <span className="inline-flex items-center gap-1 rounded-full border border-border/30 bg-bg-muted/20 px-1.5 py-0.5">
                <Lock className="h-3 w-3" aria-hidden />
                {t("documentsview.Locked", { defaultValue: "locked" })}
              </span>
            ) : null}
          </div>
        </div>
      </button>
      <span className="absolute right-2 top-2 opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100 focus-within:opacity-100">
        <ConfirmDeleteControl
          triggerClassName="h-7 rounded-lg border border-transparent px-2 text-2xs font-bold !bg-transparent text-danger/70 transition-all hover:!bg-danger/12 hover:border-danger/25 hover:text-danger"
          confirmClassName="h-7 rounded-lg border border-danger/25 bg-danger/14 px-2 text-2xs font-bold text-danger transition-all hover:bg-danger/20"
          cancelClassName="h-7 rounded-lg border border-border/35 px-2 text-2xs font-bold text-muted-strong transition-all hover:border-border-strong hover:text-txt"
          disabled={deleting || !doc.canDelete}
          busyLabel="..."
          onConfirm={() => onDelete(doc.id)}
        />
      </span>
    </div>
  );
}

/* ── Main DocumentsView Component ───────────────────────────────────── */

export function DocumentsView({
  fileInputId,
  inModal,
  embedded = false,
  onDocumentsChange,
  onSelectedDocumentIdChange,
  selectedDocumentId,
  showSelectorRail,
}: {
  fileInputId?: string;
  inModal?: boolean;
  embedded?: boolean;
  onDocumentsChange?: (documents: DocumentRecord[]) => void;
  onSelectedDocumentIdChange?: (documentId: string | null) => void;
  selectedDocumentId?: string | null;
  showSelectorRail?: boolean;
} = {}) {
  const { t } = useApp();
  const { setActionNotice } = useApp();
  const setActionNoticeRef = useRef(setActionNotice);
  setActionNoticeRef.current = setActionNotice;
  const [searchQuery, setSearchQuery] = useState("");
  const [scopeFilter, setScopeFilter] = useState<DocumentScopeFilter>("all");
  const [documents, setDocuments] = useState<DocumentRecord[]>([]);
  const [searchResults, setSearchResults] = useState<
    DocumentSearchResult[] | null
  >(null);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [uploadStatus, setUploadStatus] = useState<{
    current: number;
    total: number;
    filename: string;
  } | null>(null);
  const [searching, setSearching] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [internalSelectedDocId, setInternalSelectedDocId] = useState<
    string | null
  >(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isServiceLoading, setIsServiceLoading] = useState(false);
  const serviceRetryRef = useRef(0);
  const selectedDocId = selectedDocumentId ?? internalSelectedDocId;
  const setSelectedDocId = useCallback(
    (documentId: string | null) => {
      if (selectedDocumentId === undefined) {
        setInternalSelectedDocId(documentId);
      }
      onSelectedDocumentIdChange?.(documentId);
    },
    [onSelectedDocumentIdChange, selectedDocumentId],
  );
  const shouldRenderSelectorRail = showSelectorRail !== false;
  const useCompactSelectorRail = embedded;

  const loadData = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const docsRes = await client.listDocuments({
        limit: 100,
        ...(scopeFilter !== "all" ? { scope: scopeFilter } : {}),
      });
      setDocuments(docsRes.documents);
      onDocumentsChange?.(docsRes.documents);
      setIsServiceLoading(false);
      serviceRetryRef.current = 0;
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === 503) {
        setIsServiceLoading(true);
      } else {
        setIsServiceLoading(false);
        const msg =
          err instanceof Error
            ? err.message
            : t("documentsview.FailedToLoadDocumentsData", {
                defaultValue: "Failed to load Knowledge data",
              });
        setLoadError(msg);
        setActionNoticeRef.current(msg, "error");
      }
    } finally {
      setLoading(false);
    }
  }, [onDocumentsChange, scopeFilter, t]);

  useEffect(() => {
    loadData().catch((err) => {
      console.error("[DocumentsView] Failed to load data:", err);
      setLoading(false);
    });
  }, [loadData]);
  useEffect(() => {
    if (!isServiceLoading) {
      serviceRetryRef.current = 0;
      return;
    }
    const attempt = serviceRetryRef.current;
    if (attempt >= 5) {
      setIsServiceLoading(false);
      setLoadError(
        t("documentsview.ServiceDidNotBecomeAvailable", {
          defaultValue:
            "Knowledge service did not become available. Please reload the page.",
        }),
      );
      return;
    }
    const delayMs = 2000 * 1.5 ** attempt; // 2s, 3s, 4.5s, 6.75s, ~10s
    const timer = setTimeout(() => {
      serviceRetryRef.current = attempt + 1;
      loadData();
    }, delayMs);
    return () => clearTimeout(timer);
  }, [isServiceLoading, loadData, t]);

  const readDocumentFile = useCallback(
    async (file: DocumentUploadFile) => {
      const reader = new FileReader();
      return new Promise<string>((resolve, reject) => {
        reader.onload = () => {
          const result = reader.result;
          if (typeof result === "string") {
            resolve(result);
            return;
          }

          if (result instanceof ArrayBuffer) {
            const bytes = new Uint8Array(result);
            let binary = "";
            for (let i = 0; i < bytes.byteLength; i++) {
              binary += String.fromCharCode(bytes[i]);
            }
            resolve(btoa(binary));
            return;
          }

          reject(
            new Error(
              t("documentsview.FailedToReadFile", {
                defaultValue: "Failed to read file",
              }),
            ),
          );
        };

        reader.onerror = () => reject(reader.error);

        if (shouldReadDocumentFileAsText(file)) {
          reader.readAsText(file);
        } else {
          reader.readAsArrayBuffer(file);
        }
      });
    },
    [t],
  );

  const buildDocumentUploadRequest = useCallback(
    async (file: DocumentUploadFile, options: DocumentUploadOptions) => {
      const optimizedImage = await maybeCompressDocumentUploadImage(file);
      const uploadFile = optimizedImage.file as DocumentUploadFile;
      if (
        isDocumentImageFile(uploadFile) &&
        uploadFile.size > MAX_DOCUMENT_IMAGE_PROCESSING_BYTES
      ) {
        throw new Error(
          t("documentsview.ImageCouldNotBeCompressed", {
            defaultValue:
              "Image could not be compressed below {{limit}} for processing.",
            limit: formatByteSize(MAX_DOCUMENT_IMAGE_PROCESSING_BYTES),
          }),
        );
      }

      const uploadFilename = getDocumentUploadFilename(uploadFile);
      const content = await readDocumentFile(uploadFile);

      const request = {
        content,
        filename: uploadFilename,
        contentType: uploadFile.type || "application/octet-stream",
        scope: options.scope,
        metadata: {
          includeImageDescriptions: options.includeImageDescriptions,
          relativePath: uploadFile.webkitRelativePath || undefined,
        },
      };
      const requestBytes = new TextEncoder().encode(
        JSON.stringify(request),
      ).length;
      if (requestBytes > MAX_UPLOAD_REQUEST_BYTES) {
        throw new Error(
          t("documentsview.UploadPayloadExceedsLimit", {
            defaultValue:
              "Upload payload is {{size}}, which exceeds the current limit ({{limit}}).",
            size: formatByteSize(requestBytes),
            limit: formatByteSize(MAX_UPLOAD_REQUEST_BYTES),
          }),
        );
      }

      return {
        filename: uploadFilename,
        request,
        requestBytes,
      };
    },
    [readDocumentFile, t],
  );

  const handleFilesUpload = useCallback(
    async (files: DocumentUploadFile[], options: DocumentUploadOptions) => {
      const unsupportedFiles = files.filter(
        (file) => !isSupportedDocumentFile(file),
      );
      const uploadQueue = files.filter(
        (file) => file.size > 0 && isSupportedDocumentFile(file),
      );
      if (uploadQueue.length === 0) {
        setActionNotice(
          unsupportedFiles.length > 0
            ? t("documentsview.NoSupportedNonEmptyFiles", {
                defaultValue: "No supported non-empty files were selected.",
              })
            : t("documentsview.NoNonEmptyFiles", {
                defaultValue: "No non-empty files were selected.",
              }),
          "info",
          3000,
        );
        return;
      }

      const largeFiles = uploadQueue.filter(
        (file) => file.size >= LARGE_FILE_WARNING_BYTES,
      );
      if (largeFiles.length > 0) {
        const shouldContinue =
          typeof window === "undefined"
            ? true
            : await confirmDesktopAction({
                title: t("documentsview.UploadLargeFiles", {
                  defaultValue: "Upload Large Files",
                }),
                message: t("documentsview.LargeFilesDetected", {
                  defaultValue: "{{count}} large file(s) detected.",
                  count: largeFiles.length,
                }),
                detail: t("documentsview.UploadLargeFilesDetail", {
                  defaultValue:
                    "Uploading can take longer and may increase embedding or vision costs.",
                }),
                confirmLabel: t("common.continue", {
                  defaultValue: "Continue",
                }),
                cancelLabel: t("common.cancel", {
                  defaultValue: "Cancel",
                }),
                type: "warning",
              });
        if (!shouldContinue) return;
      }

      const failures: string[] = [];
      const warnings: string[] = [];
      let successful = 0;

      const normalizeUploadError = (err: unknown): string => {
        const message =
          err instanceof Error
            ? err.message
            : t("documentsview.UnknownUploadError", {
                defaultValue: "Unknown upload error",
              });
        const status = (err as Error & { status?: number })?.status;
        return status === 413 || /maximum size|payload is/i.test(message)
          ? t("documentsview.UploadTooLarge", {
              defaultValue: "Upload too large. Try splitting this file.",
            })
          : message;
      };

      setUploading(true);
      setUploadStatus({
        current: 0,
        total: uploadQueue.length,
        filename: t("documentsview.Preparing", {
          defaultValue: "Preparing...",
        }),
      });

      try {
        type PreparedUpload = {
          filename: string;
          request: {
            content: string;
            filename: string;
            contentType: string;
            scope: DocumentScope;
            metadata: {
              includeImageDescriptions: boolean;
              relativePath: string | undefined;
            };
          };
          requestBytes: number;
        };

        let currentBatch: PreparedUpload[] = [];
        let currentBatchBytes = 0;

        const flushBatch = async () => {
          if (currentBatch.length === 0) return;

          const batchToUpload = currentBatch;
          currentBatch = [];
          currentBatchBytes = 0;

          const batchLabel =
            batchToUpload[0]?.filename ||
            t("documentsview.Batch", { defaultValue: "batch" });
          setUploadStatus({
            current: successful + failures.length,
            total: uploadQueue.length,
            filename: t("documentsview.UploadingBatchStartingWith", {
              defaultValue: "Uploading batch starting with {{label}}",
              label: batchLabel,
            }),
          });

          try {
            const result = await client.uploadDocumentsBulk({
              documents: batchToUpload.map((item) => item.request),
            });

            for (const item of result.results) {
              const batchItem = batchToUpload[item.index];
              const filename =
                item.filename ||
                batchItem?.filename ||
                t("documentsview.Document", {
                  defaultValue: "document",
                });
              if (item.ok) {
                successful += 1;
                if (item.warnings?.[0]) {
                  warnings.push(`${filename}: ${item.warnings[0]}`);
                }
              } else {
                failures.push(
                  `${filename}: ${
                    item.error ||
                    t("documentsview.UploadFailed", {
                      defaultValue: "Upload failed",
                    })
                  }`,
                );
              }
            }
          } catch (err) {
            const message = normalizeUploadError(err);
            for (const batchItem of batchToUpload) {
              failures.push(`${batchItem.filename}: ${message}`);
            }
          }
        };

        for (const [index, file] of uploadQueue.entries()) {
          const uploadFilename = getDocumentUploadFilename(file);
          setUploadStatus({
            current: index + 1,
            total: uploadQueue.length,
            filename: t("documentsview.PreparingFile", {
              defaultValue: "Preparing: {{filename}}",
              filename: uploadFilename,
            }),
          });

          try {
            const prepared = await buildDocumentUploadRequest(file, options);
            if (
              currentBatch.length > 0 &&
              (currentBatchBytes + prepared.requestBytes >
                BULK_UPLOAD_TARGET_BYTES ||
                currentBatch.length >= MAX_BULK_REQUEST_DOCUMENTS)
            ) {
              await flushBatch();
            }
            currentBatch.push(prepared);
            currentBatchBytes += prepared.requestBytes;
          } catch (err) {
            failures.push(`${uploadFilename}: ${normalizeUploadError(err)}`);
          }
        }

        await flushBatch();

        let refreshFailed = false;
        try {
          await loadData();
        } catch (err) {
          refreshFailed = true;
          console.error("[DocumentsView] Failed to refresh after upload:", err);
        }

        const skippedSummary =
          unsupportedFiles.length > 0
            ? ` Skipped ${unsupportedFiles.length} unsupported file(s).`
            : "";
        const refreshSummary = refreshFailed
          ? " Uploaded, but failed to refresh document list."
          : "";

        if (
          uploadQueue.length === 1 &&
          successful === 1 &&
          failures.length === 0
        ) {
          const onlyFile = getDocumentUploadFilename(uploadQueue[0]);
          const baseMessage = `Uploaded "${onlyFile}"`;
          if (warnings.length > 0) {
            setActionNotice(`${baseMessage}. ${warnings[0]}`, "info", 6000);
          } else if (refreshFailed) {
            setActionNotice(
              `${baseMessage}. Uploaded, but failed to refresh document list.`,
              "info",
              6000,
            );
          } else {
            setActionNotice(baseMessage, "success", 3000);
          }
          return;
        }

        if (failures.length === 0) {
          setActionNotice(
            `Uploaded ${successful}/${uploadQueue.length} files.${warnings.length > 0 ? ` ${warnings[0]}` : ""}${skippedSummary}${refreshSummary}`,
            warnings.length > 0 || refreshFailed || unsupportedFiles.length > 0
              ? "info"
              : "success",
            7000,
          );
          return;
        }

        setActionNotice(
          `Uploaded ${successful}/${uploadQueue.length} files. ${failures.length} failed.${failures.length > 0 ? ` ${failures[0]}` : ""}${skippedSummary}${refreshSummary}`,
          successful > 0 ? "info" : "error",
          7000,
        );
      } finally {
        setUploading(false);
        setUploadStatus(null);
      }
    },
    [buildDocumentUploadRequest, loadData, setActionNotice, t],
  );

  const handleUrlUpload = useCallback(
    async (url: string, options: DocumentUploadOptions) => {
      setUploading(true);
      try {
        const result = await client.uploadDocumentFromUrl(url, {
          includeImageDescriptions: options.includeImageDescriptions,
          scope: options.scope,
        });

        const baseMessage = result.isYouTubeTranscript
          ? `Imported YouTube transcript (${result.fragmentCount} fragments)`
          : `Imported "${result.filename}" (${result.fragmentCount} fragments)`;
        if (result.warnings && result.warnings.length > 0) {
          setActionNotice(
            `${baseMessage}. ${result.warnings[0]}`,
            "info",
            6000,
          );
        } else {
          setActionNotice(baseMessage, "success", 3000);
        }
        loadData();
      } catch (err) {
        const message =
          err instanceof Error
            ? err.message
            : t("documentsview.UnknownImportError", {
                defaultValue: "Unknown import error",
              });
        setActionNotice(
          t("documentsview.FailedToImportFromUrl", {
            defaultValue: "Failed to import from URL: {{message}}",
            message,
          }),
          "error",
          5000,
        );
      } finally {
        setUploading(false);
      }
    },
    [loadData, setActionNotice, t],
  );

  const handleTextUpload = useCallback(
    async (
      text: string,
      title: string | undefined,
      options: DocumentUploadOptions,
    ) => {
      setUploading(true);
      try {
        const normalizedTitle = title?.trim();
        const filenameStem =
          normalizedTitle
            ?.toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "")
            .slice(0, 80) || "document-note";
        const filename = `${filenameStem}.txt`;
        const result = await client.uploadDocument({
          content: text,
          filename,
          contentType: "text/plain",
          scope: options.scope,
          metadata: {
            source: "upload",
            title: normalizedTitle,
            textBacked: true,
          },
        });
        setActionNotice(
          `Saved "${normalizedTitle || filename}" (${result.fragmentCount} fragments)`,
          "success",
          3000,
        );
        await loadData();
      } catch (err) {
        const message =
          err instanceof Error
            ? err.message
            : t("documentsview.UnknownUploadError", {
                defaultValue: "Unknown upload error",
              });
        setActionNotice(
          t("documentsview.UploadFailedWithMessage", {
            defaultValue: "Upload failed: {{message}}",
            message,
          }),
          "error",
          5000,
        );
      } finally {
        setUploading(false);
      }
    },
    [loadData, setActionNotice, t],
  );

  const handleExternalFileInputChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const files = event.target.files;
      if (files && files.length > 0 && !uploading) {
        void handleFilesUpload(Array.from(files) as DocumentUploadFile[], {
          includeImageDescriptions: true,
          scope: DEFAULT_DOCUMENT_UPLOAD_SCOPE,
        });
      }
      event.target.value = "";
    },
    [handleFilesUpload, uploading],
  );

  const handleSearch = useCallback(
    async (query: string) => {
      setSearching(true);
      try {
        const result = await client.searchDocuments(query, {
          threshold: 0.3,
          limit: 20,
          ...(scopeFilter !== "all" ? { scope: scopeFilter } : {}),
        });
        setSearchResults(result.results);
      } catch (err) {
        const message =
          err instanceof Error
            ? err.message
            : t("documentsview.UnknownSearchError", {
                defaultValue: "Unknown search error",
              });
        setActionNotice(
          t("documentsview.SearchFailed", {
            defaultValue: "Search failed: {{message}}",
            message,
          }),
          "error",
          4000,
        );
        setSearchResults([]);
      } finally {
        setSearching(false);
      }
    },
    [scopeFilter, setActionNotice, t],
  );

  const handleDelete = useCallback(
    async (documentId: string) => {
      setDeleting(documentId);

      try {
        const result = await client.deleteDocument(documentId);

        if (result.ok) {
          setActionNotice(
            t("documentsview.DeletedDocument", {
              defaultValue: "Deleted document ({{count}} fragments removed)",
              count: result.deletedFragments,
            }),
            "success",
            3000,
          );
          await loadData();
        } else {
          setActionNotice(
            t("documentsview.FailedToDeleteDocument", {
              defaultValue: "Failed to delete document",
            }),
            "error",
            4000,
          );
        }
      } catch (err) {
        const message =
          err instanceof Error
            ? err.message
            : t("documentsview.UnknownDeleteError", {
                defaultValue: "Unknown delete error",
              });
        setActionNotice(
          t("documentsview.FailedToDeleteDocumentWithMessage", {
            defaultValue: "Failed to delete document: {{message}}",
            message,
          }),
          "error",
          5000,
        );
      } finally {
        setDeleting(null);
      }
    },
    [loadData, setActionNotice, t],
  );

  const isShowingSearchResults = searchResults !== null;
  const visibleSearchResults = searchResults ?? [];
  const filteredDocuments = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query || isShowingSearchResults) {
      return documents;
    }
    return documents.filter(
      (doc) =>
        doc.filename.toLowerCase().includes(query) ||
        doc.contentType?.toLowerCase().includes(query),
    );
  }, [documents, isShowingSearchResults, searchQuery]);

  useEffect(() => {
    if (documents.length === 0) {
      if (selectedDocId !== null) {
        setSelectedDocId(null);
      }
      return;
    }

    const hasSelectedDocument = documents.some(
      (doc) => doc.id === selectedDocId,
    );
    if (!hasSelectedDocument) {
      setSelectedDocId(documents[0]?.id ?? null);
    }
  }, [documents, selectedDocId, setSelectedDocId]);

  useEffect(() => {
    const query = searchQuery.trim();
    if (!query) {
      if (searchResults !== null) {
        setSearchResults(null);
      }
      return;
    }

    const timer = window.setTimeout(() => {
      void handleSearch(query);
    }, 200);

    return () => window.clearTimeout(timer);
  }, [handleSearch, searchQuery, searchResults]);

  /* ── Scope filter chips ────────────────────────────────────────── */

  const scopeFilterStrip = (
    <div className="flex flex-wrap items-center gap-1">
      {SCOPE_FILTER_OPTIONS.map(({ value, labelKey, defaultLabel, Icon }) => {
        const active = scopeFilter === value;
        return (
          <button
            key={value}
            type="button"
            aria-pressed={active}
            onClick={() => setScopeFilter(value)}
            className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-2xs font-semibold transition-colors ${
              active
                ? "border-accent/45 bg-accent/12 text-accent-fg"
                : "border-border/30 bg-bg-muted/20 text-muted hover:border-border/55 hover:text-txt"
            }`}
          >
            <Icon className="h-3 w-3" aria-hidden />
            {t(labelKey, { defaultValue: defaultLabel })}
          </button>
        );
      })}
    </div>
  );

  /* ── Search input ──────────────────────────────────────────────── */

  const searchInput = (
    <div className="relative">
      <input
        type="text"
        placeholder={t("documents.ui.searchPlaceholder")}
        value={searchQuery}
        onChange={(e) => {
          setSearchQuery(e.target.value);
          if (isShowingSearchResults) {
            setSearchResults(null);
          }
        }}
        autoComplete="off"
        spellCheck={false}
        className="w-full rounded-lg border border-border/50 bg-bg px-3 py-2 pl-9 text-sm text-txt placeholder:text-muted/50 focus:border-accent/50 focus:outline-none focus:ring-1 focus:ring-accent/30"
      />
      <Search
        className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted/50"
        aria-hidden
      />
      {(searchQuery || searching) && (
        <button
          type="button"
          aria-label={t("common.clear", { defaultValue: "Clear" })}
          onClick={() => {
            setSearchQuery("");
            setSearchResults(null);
          }}
          className="absolute right-2.5 top-1/2 -translate-y-1/2 text-xs font-medium text-muted hover:text-txt"
        >
          {searching ? (
            <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-accent border-t-transparent" />
          ) : (
            <X className="h-3.5 w-3.5" aria-hidden />
          )}
        </button>
      )}
    </div>
  );

  const documentContent = (
    <div className="order-2 flex min-w-0 flex-1 lg:order-1">
      <DocumentViewer
        documentId={selectedDocId}
        onUpdated={() => {
          void loadData();
        }}
      />
    </div>
  );

  const selectorRail = (
    <div
      className={`order-1 flex w-full shrink-0 flex-col gap-3 lg:order-2 ${
        useCompactSelectorRail
          ? "lg:w-[18.5rem] xl:w-[20rem]"
          : "lg:w-[22rem] xl:w-[24rem]"
      }`}
    >
      <PagePanel
        variant="inset"
        className={`${useCompactSelectorRail ? "p-2" : "p-3"} !rounded-none !border-0 !bg-transparent !shadow-none !ring-0`}
      >
        <UploadZone
          fileInputId={fileInputId}
          onFilesUpload={handleFilesUpload}
          onTextUpload={handleTextUpload}
          onUrlUpload={handleUrlUpload}
          uploading={uploading}
          uploadStatus={uploadStatus}
        />
      </PagePanel>

      <PagePanel
        variant="inset"
        className={`flex flex-1 flex-col overflow-hidden p-2.5 !rounded-none !border-0 !bg-transparent !shadow-none !ring-0 ${
          useCompactSelectorRail ? "min-h-[14rem]" : "min-h-[18rem]"
        }`}
      >
        <div className="mb-2 flex items-center justify-between gap-3 px-1">
          <div className="min-w-0 text-xs font-semibold uppercase tracking-[0.12em] text-muted/70">
            {isShowingSearchResults
              ? t("documentsview.SearchResults", {
                  defaultValue: "Search results",
                })
              : t("documentsview.Documents", { defaultValue: "Documents" })}
          </div>
          <div className="shrink-0 text-2xs text-muted">
            {documents.length === 1
              ? t("documentsview.DocumentCountOne", {
                  defaultValue: "1 doc",
                })
              : t("documentsview.DocumentCountMany", {
                  defaultValue: "{{count}} docs",
                  count: documents.length,
                })}
          </div>
        </div>
        {searchInput}
        <div className="mt-2">{scopeFilterStrip}</div>

        <div className="custom-scrollbar mt-2 flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto px-0.5 py-0.5">
          {loading && !isShowingSearchResults && documents.length === 0 && (
            <PagePanel.Empty
              variant="inset"
              className="px-0 py-10 text-center text-sm font-medium !rounded-none !border-0 !bg-transparent !shadow-none !ring-0"
              title={t("documentsview.LoadingDocuments")}
            >
              {t("documentsview.LoadingDocuments")}
            </PagePanel.Empty>
          )}

          {!loading && !isShowingSearchResults && documents.length === 0 && (
            <PagePanel.Empty
              variant="inset"
              className="min-h-[12rem] px-0 py-8 !rounded-none !border-0 !bg-transparent !shadow-none !ring-0"
              description={t("documentsview.UploadFilesOrImpo")}
              title={t("documentsview.NoDocumentsYet")}
            />
          )}

          {!loading &&
            !isShowingSearchResults &&
            documents.length > 0 &&
            filteredDocuments.length === 0 && (
              <PagePanel.Empty
                variant="inset"
                className="min-h-[12rem] px-0 py-8 !rounded-none !border-0 !bg-transparent !shadow-none !ring-0"
                description={t("documentsview.SearchTips", {
                  defaultValue:
                    "Try a filename, topic, or phrase from the document body.",
                })}
                title={t("documentsview.NoMatchingDocuments", {
                  defaultValue: "No matching documents",
                })}
              />
            )}

          {isShowingSearchResults && visibleSearchResults.length === 0 && (
            <PagePanel.Empty
              variant="inset"
              className="min-h-[12rem] px-0 py-8 !rounded-none !border-0 !bg-transparent !shadow-none !ring-0"
              description={t("documentsview.SearchTips", {
                defaultValue:
                  "Try a filename, topic, or phrase from the document body.",
              })}
              title={t("documentsview.NoResultsFound")}
            />
          )}

          {isShowingSearchResults
            ? visibleSearchResults.map((result) => (
                <SearchResultListItem
                  key={result.id}
                  result={result}
                  active={selectedDocId === (result.documentId || result.id)}
                  onSelect={setSelectedDocId}
                />
              ))
            : filteredDocuments.map((doc) => (
                <DocumentListItem
                  key={doc.id}
                  doc={doc}
                  active={selectedDocId === doc.id}
                  onSelect={setSelectedDocId}
                  onDelete={handleDelete}
                  deleting={deleting === doc.id}
                />
              ))}
        </div>
      </PagePanel>
    </div>
  );

  const compactDocumentStrip = !shouldRenderSelectorRail ? (
    <PagePanel
      variant="inset"
      className="flex shrink-0 flex-col gap-2 px-0 py-0 !rounded-none !border-0 !bg-transparent !shadow-none !ring-0"
    >
      <div className="flex flex-col gap-2 md:flex-row md:items-center">
        <div className="min-w-0 flex-1">{searchInput}</div>
        {fileInputId ? (
          <label
            htmlFor={fileInputId}
            className={`inline-flex h-9 shrink-0 cursor-pointer items-center justify-center gap-2 rounded-lg border border-accent/35 bg-accent/10 px-3 text-xs font-semibold text-accent-fg transition hover:bg-accent/16 ${
              uploading ? "pointer-events-none opacity-60" : ""
            }`}
          >
            <FileText className="h-3.5 w-3.5" aria-hidden />
            {uploading
              ? t("documentsview.Uploading", { defaultValue: "Uploading" })
              : t("documentsview.AddKnowledge", {
                  defaultValue: "Add Knowledge",
                })}
          </label>
        ) : null}
      </div>
      <div>{scopeFilterStrip}</div>
      <div className="custom-scrollbar flex gap-2 overflow-x-auto pb-1">
        {isShowingSearchResults
          ? visibleSearchResults.map((result) => {
              const id = result.documentId || result.id;
              const active = selectedDocId === id;
              return (
                <button
                  key={result.id}
                  type="button"
                  onClick={() => setSelectedDocId(id)}
                  className={`inline-flex max-w-[16rem] shrink-0 items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-semibold transition ${
                    active
                      ? "border-accent/45 bg-accent/12 text-accent-fg"
                      : "border-border/30 bg-bg-muted/20 text-muted hover:text-txt"
                  }`}
                >
                  <FileSearch className="h-3.5 w-3.5" aria-hidden />
                  <span className="truncate">
                    {result.documentTitle ||
                      t("documentsview.UnknownDocument", {
                        defaultValue: "Unknown Document",
                      })}
                  </span>
                </button>
              );
            })
          : filteredDocuments.map((doc) => {
              const active = selectedDocId === doc.id;
              return (
                <button
                  key={doc.id}
                  type="button"
                  onClick={() => setSelectedDocId(doc.id)}
                  className={`inline-flex max-w-[16rem] shrink-0 items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-semibold transition ${
                    active
                      ? "border-accent/45 bg-accent/12 text-accent-fg"
                      : "border-border/30 bg-bg-muted/20 text-muted hover:text-txt"
                  }`}
                >
                  <FileText className="h-3.5 w-3.5" aria-hidden />
                  <span className="truncate">{doc.filename}</span>
                </button>
              );
            })}
      </div>
    </PagePanel>
  ) : null;

  return (
    <div
      className={`flex flex-1 min-h-0 flex-col gap-4 ${inModal ? "min-h-0" : ""}`}
      data-testid="documents-view"
    >
      {!shouldRenderSelectorRail && fileInputId ? (
        <input
          id={fileInputId}
          type="file"
          className="hidden"
          multiple
          accept={DOCUMENT_UPLOAD_ACCEPT}
          onChange={handleExternalFileInputChange}
        />
      ) : null}

      {isServiceLoading && (
        <PagePanel
          variant="inset"
          className="flex items-center gap-2 px-0 py-3 text-sm text-muted-strong !rounded-none !border-0 !bg-transparent !shadow-none !ring-0"
        >
          <span className="h-4 w-4 animate-spin rounded-full border-2 border-accent border-t-transparent" />
          {t("documentsview.DocumentServiceIs")}
        </PagePanel>
      )}

      {loadError && !isServiceLoading && (
        <PagePanel.Notice
          tone="danger"
          actions={
            <Button
              variant="outline"
              size="sm"
              className="border-danger/30 px-3 text-xs text-danger hover:bg-danger/16"
              onClick={() => loadData()}
            >
              {t("common.retry")}
            </Button>
          }
        >
          {loadError}
        </PagePanel.Notice>
      )}

      {compactDocumentStrip}

      <div className="flex min-h-0 flex-1 flex-col gap-4 lg:flex-row">
        {documentContent}
        {shouldRenderSelectorRail ? selectorRail : null}
      </div>
    </div>
  );
}
