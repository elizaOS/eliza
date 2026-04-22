import { Button, PagePanel } from "@elizaos/ui";
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
  KnowledgeDocument,
  KnowledgeSearchResult,
} from "../../api/client-types-chat";
import { useApp } from "../../state/useApp";
import { confirmDesktopAction } from "../../utils/desktop-dialogs";
import { formatByteSize } from "../../utils/format";
import {
  isKnowledgeImageFile,
  MAX_KNOWLEDGE_IMAGE_PROCESSING_BYTES,
  maybeCompressKnowledgeUploadImage,
} from "../../utils/knowledge-upload-image";
import { ConfirmDeleteControl } from "../shared/confirm-delete-control";
import { DocumentViewer } from "./knowledge-detail";
import {
  BULK_UPLOAD_TARGET_BYTES,
  getKnowledgeUploadFilename,
  isSupportedKnowledgeFile,
  KNOWLEDGE_UPLOAD_ACCEPT,
  type KnowledgeUploadFile,
  type KnowledgeUploadOptions,
  LARGE_FILE_WARNING_BYTES,
  MAX_BULK_REQUEST_DOCUMENTS,
  MAX_UPLOAD_REQUEST_BYTES,
  shouldReadKnowledgeFileAsText,
  UploadZone,
} from "./knowledge-upload";

// Re-export public API used by tests and other modules
export {
  getKnowledgeUploadFilename,
  type KnowledgeUploadFile,
  shouldReadKnowledgeFileAsText,
} from "./knowledge-upload";

/* ── Search Result Item ─────────────────────────────────────────────── */

function SearchResultListItem({
  result,
  active,
  onSelect,
}: {
  result: KnowledgeSearchResult;
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
        <div className="truncate text-sm font-semibold text-txt">
          {result.documentTitle ||
            t("knowledgeview.UnknownDocument", {
              defaultValue: "Unknown Document",
            })}
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
  doc: KnowledgeDocument;
  active: boolean;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  deleting: boolean;
}) {
  const { t } = useApp();
  return (
    <div
      className={`group relative flex w-full transition-colors ${
        active ? "bg-transparent" : "bg-transparent hover:bg-white/[0.03]"
      }`}
    >
      <button
        type="button"
        onClick={() => onSelect(doc.id)}
        aria-label={t("knowledgeview.OpenDocument", {
          defaultValue: "Open {{filename}}",
          filename: doc.filename,
        })}
        aria-current={active ? "page" : undefined}
        title={doc.filename}
        className="flex min-w-0 flex-1 items-center gap-3 px-3.5 py-3 text-left"
      >
        <span
          className={`h-2.5 w-2.5 shrink-0 rounded-full ${
            active ? "bg-accent" : "bg-border"
          }`}
        />
        <div className="truncate text-sm font-semibold leading-snug text-txt">
          {doc.filename}
        </div>
      </button>
      <span className="absolute right-2 top-2 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
        <ConfirmDeleteControl
          triggerClassName="h-7 rounded-lg border border-transparent px-2 text-2xs font-bold !bg-transparent text-danger/70 transition-all hover:!bg-danger/12 hover:border-danger/25 hover:text-danger"
          confirmClassName="h-7 rounded-lg border border-danger/25 bg-danger/14 px-2 text-2xs font-bold text-danger transition-all hover:bg-danger/20"
          cancelClassName="h-7 rounded-lg border border-border/35 px-2 text-2xs font-bold text-muted-strong transition-all hover:border-border-strong hover:text-txt"
          disabled={deleting}
          busyLabel="..."
          onConfirm={() => onDelete(doc.id)}
        />
      </span>
    </div>
  );
}

/* ── Main KnowledgeView Component ───────────────────────────────────── */

export function KnowledgeView({
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
  onDocumentsChange?: (documents: KnowledgeDocument[]) => void;
  onSelectedDocumentIdChange?: (documentId: string | null) => void;
  selectedDocumentId?: string | null;
  showSelectorRail?: boolean;
} = {}) {
  const { t } = useApp();
  const { setActionNotice } = useApp();
  const setActionNoticeRef = useRef(setActionNotice);
  setActionNoticeRef.current = setActionNotice;
  const [searchQuery, setSearchQuery] = useState("");
  const [documents, setDocuments] = useState<KnowledgeDocument[]>([]);
  const [searchResults, setSearchResults] = useState<
    KnowledgeSearchResult[] | null
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
  const shouldShowSelectorRail = showSelectorRail ?? !embedded;

  const loadData = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const docsRes = await client.listKnowledgeDocuments({ limit: 100 });
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
            : t("knowledgeview.FailedToLoadKnowledgeData", {
                defaultValue: "Failed to load knowledge data",
              });
        setLoadError(msg);
        setActionNoticeRef.current(msg, "error");
      }
    } finally {
      setLoading(false);
    }
  }, [onDocumentsChange, t]);

  useEffect(() => {
    loadData().catch((err) => {
      console.error("[KnowledgeView] Failed to load data:", err);
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
        t("knowledgeview.ServiceDidNotBecomeAvailable", {
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

  const readKnowledgeFile = useCallback(
    async (file: KnowledgeUploadFile) => {
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
              t("knowledgeview.FailedToReadFile", {
                defaultValue: "Failed to read file",
              }),
            ),
          );
        };

        reader.onerror = () => reject(reader.error);

        if (shouldReadKnowledgeFileAsText(file)) {
          reader.readAsText(file);
        } else {
          reader.readAsArrayBuffer(file);
        }
      });
    },
    [t],
  );

  const buildKnowledgeUploadRequest = useCallback(
    async (file: KnowledgeUploadFile, options: KnowledgeUploadOptions) => {
      const optimizedImage = await maybeCompressKnowledgeUploadImage(file);
      const uploadFile = optimizedImage.file as KnowledgeUploadFile;
      if (
        isKnowledgeImageFile(uploadFile) &&
        uploadFile.size > MAX_KNOWLEDGE_IMAGE_PROCESSING_BYTES
      ) {
        throw new Error(
          t("knowledgeview.ImageCouldNotBeCompressed", {
            defaultValue:
              "Image could not be compressed below {{limit}} for processing.",
            limit: formatByteSize(MAX_KNOWLEDGE_IMAGE_PROCESSING_BYTES),
          }),
        );
      }

      const uploadFilename = getKnowledgeUploadFilename(uploadFile);
      const content = await readKnowledgeFile(uploadFile);

      const request = {
        content,
        filename: uploadFilename,
        contentType: uploadFile.type || "application/octet-stream",
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
          t("knowledgeview.UploadPayloadExceedsLimit", {
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
    [readKnowledgeFile, t],
  );

  const handleFilesUpload = useCallback(
    async (files: KnowledgeUploadFile[], options: KnowledgeUploadOptions) => {
      const unsupportedFiles = files.filter(
        (file) => !isSupportedKnowledgeFile(file),
      );
      const uploadQueue = files.filter(
        (file) => file.size > 0 && isSupportedKnowledgeFile(file),
      );
      if (uploadQueue.length === 0) {
        setActionNotice(
          unsupportedFiles.length > 0
            ? t("knowledgeview.NoSupportedNonEmptyFiles", {
                defaultValue: "No supported non-empty files were selected.",
              })
            : t("knowledgeview.NoNonEmptyFiles", {
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
                title: t("knowledgeview.UploadLargeFiles", {
                  defaultValue: "Upload Large Files",
                }),
                message: t("knowledgeview.LargeFilesDetected", {
                  defaultValue: "{{count}} large file(s) detected.",
                  count: largeFiles.length,
                }),
                detail: t("knowledgeview.UploadLargeFilesDetail", {
                  defaultValue:
                    "Uploading can take longer and may increase embedding or vision costs.",
                }),
                confirmLabel: t("onboarding.savedMyKeys", {
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
            : t("knowledgeview.UnknownUploadError", {
                defaultValue: "Unknown upload error",
              });
        const status = (err as Error & { status?: number })?.status;
        return status === 413 || /maximum size|payload is/i.test(message)
          ? t("knowledgeview.UploadTooLarge", {
              defaultValue: "Upload too large. Try splitting this file.",
            })
          : message;
      };

      setUploading(true);
      setUploadStatus({
        current: 0,
        total: uploadQueue.length,
        filename: t("knowledgeview.Preparing", {
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
            t("knowledgeview.Batch", { defaultValue: "batch" });
          setUploadStatus({
            current: successful + failures.length,
            total: uploadQueue.length,
            filename: t("knowledgeview.UploadingBatchStartingWith", {
              defaultValue: "Uploading batch starting with {{label}}",
              label: batchLabel,
            }),
          });

          try {
            const result = await client.uploadKnowledgeDocumentsBulk({
              documents: batchToUpload.map((item) => item.request),
            });

            for (const item of result.results) {
              const batchItem = batchToUpload[item.index];
              const filename =
                item.filename ||
                batchItem?.filename ||
                t("knowledgeview.Document", {
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
                    t("knowledgeview.UploadFailed", {
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
          const uploadFilename = getKnowledgeUploadFilename(file);
          setUploadStatus({
            current: index + 1,
            total: uploadQueue.length,
            filename: t("knowledgeview.PreparingFile", {
              defaultValue: "Preparing: {{filename}}",
              filename: uploadFilename,
            }),
          });

          try {
            const prepared = await buildKnowledgeUploadRequest(file, options);
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
          console.error("[KnowledgeView] Failed to refresh after upload:", err);
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
          const onlyFile = getKnowledgeUploadFilename(uploadQueue[0]);
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
    [buildKnowledgeUploadRequest, loadData, setActionNotice, t],
  );

  const handleUrlUpload = useCallback(
    async (url: string, options: KnowledgeUploadOptions) => {
      setUploading(true);
      try {
        const result = await client.uploadKnowledgeFromUrl(url, {
          includeImageDescriptions: options.includeImageDescriptions,
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
            : t("knowledgeview.UnknownImportError", {
                defaultValue: "Unknown import error",
              });
        setActionNotice(
          t("knowledgeview.FailedToImportFromUrl", {
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

  const handleExternalFileInputChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const files = event.target.files;
      if (files && files.length > 0 && !uploading) {
        void handleFilesUpload(Array.from(files) as KnowledgeUploadFile[], {
          includeImageDescriptions: true,
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
        const result = await client.searchKnowledge(query, {
          threshold: 0.3,
          limit: 20,
        });
        setSearchResults(result.results);
      } catch (err) {
        const message =
          err instanceof Error
            ? err.message
            : t("knowledgeview.UnknownSearchError", {
                defaultValue: "Unknown search error",
              });
        setActionNotice(
          t("knowledgeview.SearchFailed", {
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
    [setActionNotice, t],
  );

  const handleDelete = useCallback(
    async (documentId: string) => {
      setDeleting(documentId);

      try {
        const result = await client.deleteKnowledgeDocument(documentId);

        if (result.ok) {
          setActionNotice(
            t("knowledgeview.DeletedDocument", {
              defaultValue: "Deleted document ({{count}} fragments removed)",
              count: result.deletedFragments,
            }),
            "success",
            3000,
          );
          await loadData();
        } else {
          setActionNotice(
            t("knowledgeview.FailedToDeleteDocument", {
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
            : t("knowledgeview.UnknownDeleteError", {
                defaultValue: "Unknown delete error",
              });
        setActionNotice(
          t("knowledgeview.FailedToDeleteDocumentWithMessage", {
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

  /* ── Search input ──────────────────────────────────────────────── */

  const searchInput = (
    <div className="relative">
      <input
        type="text"
        placeholder={t("knowledge.ui.searchPlaceholder")}
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
      <svg
        className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted/50"
        fill="none"
        viewBox="0 0 24 24"
        strokeWidth={2}
        stroke="currentColor"
        aria-hidden="true"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z"
        />
      </svg>
      {(searchQuery || searching) && (
        <button
          type="button"
          onClick={() => {
            setSearchQuery("");
            setSearchResults(null);
          }}
          className="absolute right-2.5 top-1/2 -translate-y-1/2 text-xs font-medium text-muted hover:text-txt"
        >
          {searching ? (
            <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-accent border-t-transparent" />
          ) : (
            t("common.clear", { defaultValue: "Clear" })
          )}
        </button>
      )}
    </div>
  );

  const documentContent = (
    <div className="order-2 flex min-w-0 flex-1 lg:order-1">
      <DocumentViewer documentId={selectedDocId} />
    </div>
  );

  const selectorRail = (
    <div className="order-1 flex w-full shrink-0 flex-col gap-3 lg:order-2 lg:w-[22rem] xl:w-[24rem]">
      <PagePanel
        variant="inset"
        className="p-3 !rounded-none !border-0 !bg-transparent !shadow-none !ring-0"
      >
        <UploadZone
          fileInputId={fileInputId}
          onFilesUpload={handleFilesUpload}
          onUrlUpload={handleUrlUpload}
          uploading={uploading}
          uploadStatus={uploadStatus}
        />
      </PagePanel>

      <PagePanel
        variant="inset"
        className="flex min-h-[18rem] flex-1 flex-col overflow-hidden p-2.5 !rounded-none !border-0 !bg-transparent !shadow-none !ring-0"
      >
        {searchInput}

        <div className="custom-scrollbar mt-2 flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto px-0.5 py-0.5">
          {loading && !isShowingSearchResults && documents.length === 0 && (
            <PagePanel.Empty
              variant="inset"
              className="px-0 py-10 text-center text-sm font-medium !rounded-none !border-0 !bg-transparent !shadow-none !ring-0"
              title={t("knowledgeview.LoadingDocuments")}
            >
              {t("knowledgeview.LoadingDocuments")}
            </PagePanel.Empty>
          )}

          {!loading && !isShowingSearchResults && documents.length === 0 && (
            <PagePanel.Empty
              variant="inset"
              className="min-h-[12rem] px-0 py-8 !rounded-none !border-0 !bg-transparent !shadow-none !ring-0"
              description={t("knowledgeview.UploadFilesOrImpo")}
              title={t("knowledgeview.NoDocumentsYet")}
            />
          )}

          {!loading &&
            !isShowingSearchResults &&
            documents.length > 0 &&
            filteredDocuments.length === 0 && (
              <PagePanel.Empty
                variant="inset"
                className="min-h-[12rem] px-0 py-8 !rounded-none !border-0 !bg-transparent !shadow-none !ring-0"
                description={t("knowledgeview.SearchTips", {
                  defaultValue:
                    "Try a filename, topic, or phrase from the document body.",
                })}
                title={t("knowledgeview.NoMatchingDocuments", {
                  defaultValue: "No matching documents",
                })}
              />
            )}

          {isShowingSearchResults && visibleSearchResults.length === 0 && (
            <PagePanel.Empty
              variant="inset"
              className="min-h-[12rem] px-0 py-8 !rounded-none !border-0 !bg-transparent !shadow-none !ring-0"
              description={t("knowledgeview.SearchTips", {
                defaultValue:
                  "Try a filename, topic, or phrase from the document body.",
              })}
              title={t("knowledgeview.NoResultsFound")}
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

  return (
    <div
      className={`flex flex-1 min-h-0 flex-col gap-4 ${inModal ? "min-h-0" : ""}`}
      data-testid="knowledge-view"
    >
      {!shouldShowSelectorRail && fileInputId ? (
        <input
          id={fileInputId}
          type="file"
          className="hidden"
          multiple
          accept={KNOWLEDGE_UPLOAD_ACCEPT}
          onChange={handleExternalFileInputChange}
        />
      ) : null}

      {isServiceLoading && (
        <PagePanel
          variant="inset"
          className="flex items-center gap-2 px-0 py-3 text-sm text-muted-strong !rounded-none !border-0 !bg-transparent !shadow-none !ring-0"
        >
          <span className="h-4 w-4 animate-spin rounded-full border-2 border-accent border-t-transparent" />
          {t("knowledgeview.KnowledgeServiceIs")}
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

      <div className="flex min-h-0 flex-1 flex-col gap-4 lg:flex-row">
        {documentContent}
        {shouldShowSelectorRail ? selectorRail : null}
      </div>
    </div>
  );
}
