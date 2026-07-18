/**
 * The folded Knowledge multimedia hub (#13594): one surface over every ingested
 * knowledge record — documents, images, audio, video, and transcript mirrors —
 * instead of the old three views (Knowledge + Transcripts + Files). A top-bar
 * media-format facet control and a scope filter narrow a single-column list; a
 * row opens the record in a pushed reader sub-view (its own header, back → list)
 * that renders per-mimeType (prose / pdf / image / word-synced or plain audio /
 * video) via {@link DocumentViewer}.
 *
 * Reads/writes through the `client` documents API, seeds from `resource-cache`
 * for instant revisits, and binds the floating chat composer as its search box
 * via `useRegisterViewChatBinding`. Records flow in from the slice-1 ingest
 * pipeline (#13593) tagged by room/sender/role/media-format; there is no second
 * store (#8876) — format is derived from mime at read time. Rendered by
 * `KnowledgeView` (the `/documents` route) and, controlled, inside the character
 * hub. Upload compresses large images before sending.
 */
import {
  BadgeCheck,
  Bot,
  FileSearch,
  Globe2,
  Layers,
  Lock,
  Plus,
  Shield,
  User,
} from "lucide-react";
import {
  type ChangeEvent,
  type DragEvent,
  memo,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useAgentElement } from "../../agent-surface";
import { client } from "../../api/client";
import type {
  DocumentRecord,
  DocumentScope,
  DocumentSearchResult,
} from "../../api/client-types-chat";
import { isApiError } from "../../api/client-types-core";
import { getCached, setCached } from "../../hooks/resource-cache";
import { useAppSelector, useTranslation } from "../../state";
import { useRegisterViewChatBinding } from "../../state/view-chat-binding";
import { confirmDesktopAction } from "../../utils/desktop-dialogs";
import {
  isDocumentImageFile,
  MAX_DOCUMENT_IMAGE_PROCESSING_BYTES,
  maybeCompressDocumentUploadImage,
} from "../../utils/documents-upload-image";
import { formatByteSize } from "../../utils/format";
import { PagePanel } from "../composites/page-panel";
import { ConfirmDeleteControl } from "../shared/confirm-delete-control";
import { SectionTabStrip } from "../shared/SectionNav";
import { ViewHeader } from "../shared/ViewHeader";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { ListSkeleton } from "../ui/skeleton-layouts";
import { DocumentViewer } from "./documents-detail";
import {
  getDocumentSummary,
  getDocumentTypeLabel,
} from "./documents-detail.helpers";
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
} from "./documents-upload.helpers";
import {
  documentMatchesFacet,
  documentMediaFormat,
  KNOWLEDGE_FACETS,
  type KnowledgeFacet,
  knowledgeFacetCounts,
  knowledgeFacetIcon,
  knowledgeFacetLabel,
} from "./knowledge-media-format";

export type { DocumentUploadFile } from "./documents-upload.helpers";

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

const SearchResultListItem = memo(function SearchResultListItem({
  result,
  onSelect,
}: {
  result: DocumentSearchResult;
  onSelect: (documentId: string) => void;
}) {
  const { t } = useTranslation();
  const documentId = result.documentId || result.id;
  const title =
    result.documentTitle ||
    t("documentsview.UnknownDocument", {
      defaultValue: "Unknown Document",
    });
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: `result-${result.id}`,
    role: "list-item",
    label: title,
    group: "documents-results",
    description: `Open search result "${title}"`,
    onActivate: () => onSelect(documentId),
  });

  return (
    <Button
      ref={ref}
      {...agentProps}
      onClick={() => onSelect(documentId)}
      variant="ghost"
      className="group flex h-auto w-full items-start justify-start whitespace-normal rounded-none px-0 py-3 text-left font-normal transition-colors hover:bg-bg-hover"
    >
      <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center text-2xs font-bold text-muted-strong">
        {(result.similarity * 100).toFixed(0)}%
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <FileSearch className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden />
          <div className="truncate text-sm font-semibold text-txt">{title}</div>
        </div>
        <div className="mt-1 line-clamp-2 text-xs text-muted">
          {result.text}
        </div>
      </div>
    </Button>
  );
});

/* ── Knowledge Row ──────────────────────────────────────────────────── */

const KnowledgeListItem = memo(function KnowledgeListItem({
  doc,
  onSelect,
  onDelete,
  deleting,
}: {
  doc: DocumentRecord;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  deleting: boolean;
}) {
  const { t } = useTranslation();
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
  // Row leading icon follows the media format so the list reads as mixed media
  // at a glance (audio/video/image/transcript are distinct from a plain doc).
  const FormatIcon = knowledgeFacetIcon(documentMediaFormat(doc));
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: `document-${doc.id}`,
    role: "list-item",
    label: doc.filename,
    group: "documents-list",
    description: `Open "${doc.filename}"`,
    onActivate: () => onSelect(doc.id),
  });
  return (
    <div className="group relative flex w-full transition-colors hover:bg-bg-hover">
      <Button
        ref={ref}
        {...agentProps}
        onClick={() => onSelect(doc.id)}
        aria-label={t("documentsview.OpenDocument", {
          defaultValue: "Open {{filename}}",
          filename: doc.filename,
        })}
        title={doc.filename}
        variant="ghost"
        className="flex h-auto min-w-0 flex-1 items-center justify-start gap-3 whitespace-normal rounded-none px-3.5 py-3 text-left font-normal hover:bg-transparent"
      >
        <FormatIcon className="h-4 w-4 shrink-0 text-muted" aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold leading-snug text-txt">
            {doc.filename}
          </div>
          <div className="mt-1 truncate text-xs text-muted">
            {getDocumentSummary(doc, t)}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-2xs text-muted/70">
            <span className="inline-flex items-center gap-1">
              <ScopeIcon className="h-3 w-3" aria-hidden />
              {scopeLabel}
            </span>
            <span aria-hidden>·</span>
            <span>{getDocumentTypeLabel(doc.contentType)}</span>
            {doc.addedFrom ? (
              <>
                <span aria-hidden>·</span>
                <span className="truncate">{doc.addedFrom}</span>
              </>
            ) : null}
            {doc.canEditText ? (
              <>
                <span aria-hidden>·</span>
                <span className="inline-flex items-center gap-1 text-status-success">
                  <BadgeCheck className="h-3 w-3" aria-hidden />
                  {t("documentsview.Editable", { defaultValue: "editable" })}
                </span>
              </>
            ) : null}
            {!doc.canDelete ? (
              <>
                <span aria-hidden>·</span>
                <span className="inline-flex items-center gap-1">
                  <Lock className="h-3 w-3" aria-hidden />
                  {t("documentsview.Locked", { defaultValue: "locked" })}
                </span>
              </>
            ) : null}
          </div>
        </div>
      </Button>
      <span className="absolute right-2 top-2 opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100 ">
        <ConfirmDeleteControl
          triggerClassName="h-7 rounded-sm border border-transparent px-2 text-2xs font-bold !bg-transparent text-danger/70 transition-all hover:!bg-danger/12 hover:border-danger/25 hover:text-danger"
          confirmClassName="h-7 rounded-sm border border-danger/25 bg-danger/14 px-2 text-2xs font-bold text-danger transition-all hover:bg-danger/20"
          cancelClassName="h-7 rounded-sm border border-border/35 px-2 text-2xs font-bold text-muted-strong transition-all hover:border-border-strong hover:text-txt"
          disabled={deleting || !doc.canDelete}
          busyLabel="..."
          onConfirm={() => onDelete(doc.id)}
        />
      </span>
    </div>
  );
});

/* ── Main hub component ─────────────────────────────────────────────── */

export function DocumentsView({
  fileInputId,
  inModal,
  standalone = false,
  onDocumentsChange,
  onSelectedDocumentIdChange,
  selectedDocumentId,
}: {
  fileInputId?: string;
  inModal?: boolean;
  /** Own the top-level "Knowledge" header in list state (the `/documents`
   *  route). Off when the hub is embedded under another view's chrome. */
  standalone?: boolean;
  onDocumentsChange?: (documents: DocumentRecord[]) => void;
  onSelectedDocumentIdChange?: (documentId: string | null) => void;
  selectedDocumentId?: string | null;
} = {}) {
  const t = useAppSelector((s) => s.t);
  const setActionNotice = useAppSelector((s) => s.setActionNotice);
  const tRef = useRef(t);
  const setActionNoticeRef = useRef(setActionNotice);
  tRef.current = t;
  setActionNoticeRef.current = setActionNotice;
  const [searchQuery, setSearchQuery] = useState("");
  const [scopeFilter, setScopeFilter] = useState<DocumentScopeFilter>("all");
  const [facet, setFacet] = useState<KnowledgeFacet>("all");
  // The active view drives the one floating chat composer as its search box:
  // each keystroke flows in via onQuery, filtering documents in place.
  const handleSearchQuery = useCallback((value: string) => {
    setSearchQuery(value);
    // Clearing the draft drops out of any live search-results view.
    setSearchResults((prev) => (prev !== null ? null : prev));
  }, []);
  const searchBinding = useMemo(
    () => ({
      placeholder: t("documents.ui.searchPlaceholder"),
      onQuery: handleSearchQuery,
    }),
    [t, handleSearchQuery],
  );
  useRegisterViewChatBinding(searchBinding);
  // Seed from the shared cache so a revisit paints the last-known documents
  // instantly and revalidates silently, instead of flashing a spinner. Keyed by
  // scope AND facet (#13594): the server now draws the list per facet from the
  // whole store, so each facet's page is cached independently.
  const documentsCacheKey = `documents:list:${scopeFilter}:${facet}`;
  const cachedDocuments = getCached<DocumentRecord[]>(documentsCacheKey);
  const [documents, setDocuments] = useState<DocumentRecord[]>(
    cachedDocuments?.data ?? [],
  );
  // Whole-store per-facet counts for the segmented control (#13594). Fetched
  // server-side so a facet is never missing/miscounted once its records fall
  // outside the list page (the review blocker); seeded from the local slice as
  // a first-paint estimate, then overwritten by the server truth.
  const [serverFacetCounts, setServerFacetCounts] = useState<Record<
    KnowledgeFacet,
    number
  > | null>(
    getCached<Record<KnowledgeFacet, number>>(`documents:facets:${scopeFilter}`)
      ?.data ?? null,
  );
  // Mirror the latest server counts into a ref so loadData (a stable callback)
  // can tell "never had server counts" from "have stale server counts" without
  // re-binding on every count change.
  const serverFacetCountsRef = useRef(serverFacetCounts);
  serverFacetCountsRef.current = serverFacetCounts;
  // True when the segmented control is showing first-page-derived counts
  // because the whole-store count fetch failed and no server truth exists yet
  // (codex P2). Rendered as an approximate marker so the numbers aren't passed
  // off as authoritative.
  const [facetCountsApproximate, setFacetCountsApproximate] = useState(false);
  // Counts are scope-specific: on a scope change, drop the previous scope's
  // server counts and reseed from THAT scope's cache (or null) so a subsequent
  // count-fetch failure can never leave the control showing another scope's
  // stale counts as authoritative (codex P2). Skips the first render since the
  // initial state already seeded from the mount scope's cache.
  const previousScopeRef = useRef(scopeFilter);
  useEffect(() => {
    if (previousScopeRef.current === scopeFilter) return;
    previousScopeRef.current = scopeFilter;
    const cached = getCached<Record<KnowledgeFacet, number>>(
      `documents:facets:${scopeFilter}`,
    )?.data;
    setServerFacetCounts(cached ?? null);
    setFacetCountsApproximate(false);
  }, [scopeFilter]);
  const [searchResults, setSearchResults] = useState<
    DocumentSearchResult[] | null
  >(null);
  const [loading, setLoading] = useState(!cachedDocuments);
  const [uploading, setUploading] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [internalSelectedDocId, setInternalSelectedDocId] = useState<
    string | null
  >(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Set when GET /api/documents 404s — the documents plugin isn't mounted on
  // this surface (e.g. the mobile/Android agent). Degrade to a calm
  // "unavailable here" panel instead of a red error + Retry loop (J4).
  const [documentsUnavailable, setDocumentsUnavailable] = useState(false);
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

  const loadData = useCallback(
    async (options?: { silent?: boolean }) => {
      if (!options?.silent) setLoading(true);
      setLoadError(null);
      try {
        const scopeParam = scopeFilter !== "all" ? { scope: scopeFilter } : {};
        // Drive the list off the server facet so its rows come from the whole
        // store, not the client's first page (#13594 review blocker). The
        // facet-count fetch runs in parallel and describes the whole store
        // under the current scope, so counts stay correct across pages.
        const facetParam = facet !== "all" ? { knowledgeFacet: facet } : {};
        const [docsRes, facetsRes] = await Promise.all([
          client.listDocuments({
            limit: 100,
            ...scopeParam,
            ...facetParam,
          }),
          client.getDocumentFacetCounts(scopeParam).catch(() => null),
        ]);
        setDocuments(docsRes.documents);
        setCached(`documents:list:${scopeFilter}:${facet}`, docsRes.documents);
        if (facetsRes?.counts) {
          setServerFacetCounts(facetsRes.counts);
          setFacetCountsApproximate(false);
          setCached(`documents:facets:${scopeFilter}`, facetsRes.counts);
        } else {
          // The whole-store count fetch failed while the list succeeded
          // (codex P2). Rather than silently pass off first-page counts as the
          // truth, mark them approximate so the segmented control can flag it;
          // any prior server counts stay on screen (never reset to null).
          setFacetCountsApproximate(serverFacetCountsRef.current === null);
        }
        // Only surface the WHOLE list to an embedder's shared cache (e.g.
        // CharacterHubView). When a facet is active the rows are server-filtered
        // to that facet, so publishing them would overwrite the embedder's full
        // list with a partial one (codex P2). The `all` facet holds the whole
        // store, so the embedder stays whole across facet switches.
        if (facet === "all") {
          onDocumentsChange?.(docsRes.documents);
        }
        setIsServiceLoading(false);
        setDocumentsUnavailable(false);
        serviceRetryRef.current = 0;
      } catch (err) {
        // error-policy:J4 — a 404 means the documents plugin isn't mounted on
        // this surface (the mobile/Android agent omits it); degrade to a calm
        // "unavailable here" panel, not a red error + Retry loop.
        if (isApiError(err) && err.status === 404) {
          setIsServiceLoading(false);
          setDocumentsUnavailable(true);
          return;
        }
        const status = (err as { status?: number }).status;
        if (status === 503) {
          setIsServiceLoading(true);
        } else {
          setIsServiceLoading(false);
          const msg =
            err instanceof Error
              ? err.message
              : tRef.current("documentsview.FailedToLoadDocumentsData", {
                  defaultValue: "Failed to load Knowledge data",
                });
          setLoadError(msg);
          setActionNoticeRef.current(msg, "error");
        }
      } finally {
        setLoading(false);
      }
    },
    [onDocumentsChange, scopeFilter, facet],
  );

  useEffect(() => {
    // Revalidate silently when cached documents are already on screen.
    loadData({
      silent:
        getCached<DocumentRecord[]>(`documents:list:${scopeFilter}:${facet}`) !=
        null,
    }).catch(() => {
      setLoading(false);
    });
  }, [loadData, scopeFilter, facet]);
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

        for (const file of uploadQueue) {
          const uploadFilename = getDocumentUploadFilename(file);
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
        } catch {
          refreshFailed = true;
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
      }
    },
    [buildDocumentUploadRequest, loadData, setActionNotice, t],
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

  // Root-level file-drop intake (#10722): accepting file drops on the whole
  // view root is the hub's only drag-drop upload affordance — no CTA cluster,
  // just quiet intake. The keyboard-accessible path is the "Add" file input.
  const handleRootDragOver = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (event.dataTransfer?.types?.includes("Files")) {
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    }
  }, []);
  const handleRootDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      const files = event.dataTransfer?.files;
      if (!files || files.length === 0) return;
      // preventDefault BEFORE the uploading gate: dragover advertised
      // droppability, so bailing without it hands the drop to the browser
      // default — navigating the SPA to the local file.
      event.preventDefault();
      if (uploading) return;
      void handleFilesUpload(Array.from(files) as DocumentUploadFile[], {
        includeImageDescriptions: true,
        scope: DEFAULT_DOCUMENT_UPLOAD_SCOPE,
      });
    },
    [handleFilesUpload, uploading],
  );

  const handleSearch = useCallback(
    async (query: string) => {
      try {
        const result = await client.searchDocuments(query, {
          threshold: 0.3,
          limit: 20,
          ...(scopeFilter !== "all" ? { scope: scopeFilter } : {}),
          ...(facet !== "all" ? { knowledgeFacet: facet } : {}),
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
      }
    },
    [facet, scopeFilter, setActionNotice, t],
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
          if (selectedDocId === documentId) setSelectedDocId(null);
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
    [loadData, selectedDocId, setActionNotice, setSelectedDocId, t],
  );

  const isShowingSearchResults = searchResults !== null;
  const visibleSearchResults = searchResults ?? [];
  // The segmented control shows the whole-store counts the server returns; the
  // local slice is only a first-paint estimate until they arrive (#13594). When
  // a facet is active the list is already narrowed server-side, so the local
  // slice can't recount the other facets — the server counts are the truth.
  const localFacetCounts = useMemo(
    () => knowledgeFacetCounts(documents),
    [documents],
  );
  const facetCounts = serverFacetCounts ?? localFacetCounts;
  // Only the fall-through-to-local case is approximate; once server counts land
  // they're exact and the marker drops.
  const facetCountsAreApproximate =
    facetCountsApproximate && serverFacetCounts === null;
  // Facet + free-text narrowing over the plain list (semantic search results
  // are cross-format by relevance, so the facet control hides while they show).
  const filteredDocuments = useMemo(() => {
    // The facet is applied server-side now (#13594): `documents` already holds
    // the whole-store rows for the active facet, so only the instant free-text
    // narrowing runs here. `documentMatchesFacet` stays a cheap belt-and-braces
    // guard so a stale cached slice from another facet can't leak through on
    // first paint before the revalidation lands.
    const query = searchQuery.trim().toLowerCase();
    return documents.filter((doc) => {
      if (!documentMatchesFacet(doc, facet)) return false;
      if (!query) return true;
      return (
        doc.filename.toLowerCase().includes(query) ||
        doc.contentType?.toLowerCase().includes(query)
      );
    });
  }, [documents, facet, searchQuery]);

  // Reader-as-pushed-sub-view: a selected id replaces the list with the reader
  // rather than a side pane (#13594). Persisting a selection across an empty
  // list would strand the user in a reader for a deleted item, so clear it.
  useEffect(() => {
    if (
      selectedDocId &&
      documents.length > 0 &&
      !documents.some((doc) => doc.id === selectedDocId)
    ) {
      setSelectedDocId(null);
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

  const facetStrip = (
    <SectionTabStrip
      testId="knowledge-facets"
      ariaLabel={t("knowledgehub.facetsLabel", {
        defaultValue: "Filter knowledge by media type",
      })}
      activeId={facet}
      onSelect={(id) => setFacet(id as KnowledgeFacet)}
      entries={KNOWLEDGE_FACETS.map((value) => {
        const Icon = knowledgeFacetIcon(value);
        return {
          id: value,
          label: (
            <span
              className="inline-flex items-center gap-1.5"
              data-testid={`knowledge-facet-${value}`}
            >
              <Icon className="h-3.5 w-3.5" aria-hidden />
              {knowledgeFacetLabel(value, t)}
              <span
                className="text-muted/70"
                title={
                  facetCountsAreApproximate
                    ? t("knowledgehub.approxCountHint", {
                        defaultValue:
                          "Approximate — whole-store counts are unavailable.",
                      })
                    : undefined
                }
              >
                {facetCountsAreApproximate ? "~" : ""}
                {facetCounts[value]}
              </span>
            </span>
          ),
        };
      })}
    />
  );

  const scopeStrip = (
    <SectionTabStrip
      testId="knowledge-scope"
      ariaLabel={t("knowledgehub.scopeLabel", {
        defaultValue: "Filter knowledge by scope",
      })}
      activeId={scopeFilter}
      onSelect={(id) => setScopeFilter(id as DocumentScopeFilter)}
      className="py-1"
      entries={SCOPE_FILTER_OPTIONS.map(
        ({ value, labelKey, defaultLabel }) => ({
          id: value,
          label: t(labelKey, { defaultValue: defaultLabel }),
        }),
      )}
    />
  );

  const hiddenFileInput = fileInputId ? (
    <Input
      id={fileInputId}
      type="file"
      className="hidden"
      multiple
      accept={DOCUMENT_UPLOAD_ACCEPT}
      onChange={handleExternalFileInputChange}
    />
  ) : null;

  let listBody: ReactNode;
  if (isShowingSearchResults) {
    listBody =
      visibleSearchResults.length === 0 ? (
        <PagePanel.Empty
          variant="inset"
          className="min-h-[12rem] px-0 py-8"
          description={t("documentsview.SearchTips", {
            defaultValue:
              "Try a filename, topic, or phrase from the document body.",
          })}
          title={t("documentsview.NoResultsFound")}
        />
      ) : (
        visibleSearchResults.map((result) => (
          <SearchResultListItem
            key={result.id}
            result={result}
            onSelect={setSelectedDocId}
          />
        ))
      );
  } else if (loading && documents.length === 0) {
    listBody = <ListSkeleton rows={6} />;
  } else if (documents.length === 0 && facet !== "all") {
    // Facet-empty (#13594): the list is server-filtered to this facet, so an
    // empty page here means "no items of THIS media type" — not an empty
    // store. Showing the global "No knowledge yet" would be misleading when
    // other facets are populated, so render a per-facet no-matches state.
    listBody = (
      <PagePanel.Empty
        variant="inset"
        className="min-h-[12rem] px-0 py-10"
        title={t("knowledgehub.facetEmptyTitle", {
          defaultValue: "No {{facet}} here",
          facet: knowledgeFacetLabel(facet, t).toLowerCase(),
        })}
        description={t("knowledgehub.facetEmptyHint", {
          defaultValue:
            "Switch facets above, or drop a file / ask in chat to add one.",
        })}
      />
    );
  } else if (documents.length === 0) {
    // Calm designed-empty (#13594): no recommendation chips — the agent
    // proposes next steps in chat. Quiet drag-drop/paste + the "Add" input
    // remain the only intake.
    listBody = (
      <PagePanel.Empty
        variant="inset"
        className="min-h-[12rem] px-0 py-10"
        title={t("documentsview.NoDocumentsYet", {
          defaultValue: "No knowledge yet",
        })}
        description={t("knowledgehub.emptyHint", {
          defaultValue:
            "Drop a file here, or ask in chat to import a URL or save a note.",
        })}
      />
    );
  } else if (filteredDocuments.length === 0) {
    listBody = (
      <PagePanel.Empty
        variant="inset"
        className="min-h-[12rem] px-0 py-8"
        description={t("documentsview.SearchTips", {
          defaultValue:
            "Try a filename, topic, or phrase from the document body.",
        })}
        title={t("documentsview.NoMatchingDocuments", {
          defaultValue: "No matching items",
        })}
      />
    );
  } else {
    listBody = filteredDocuments.map((doc) => (
      <KnowledgeListItem
        key={doc.id}
        doc={doc}
        onSelect={setSelectedDocId}
        onDelete={handleDelete}
        deleting={deleting === doc.id}
      />
    ));
  }

  // The reader replaces the list entirely (pushed sub-view). Its own back
  // control returns to the list; the shell/character-hub header stays above.
  if (selectedDocId) {
    return (
      <div
        className={`flex min-h-0 flex-1 flex-col ${inModal ? "min-h-0" : ""}`}
        data-testid="documents-view"
      >
        <ViewHeader
          title={t("knowledgehub.readerTitle", { defaultValue: "Knowledge" })}
          onBack={() => setSelectedDocId(null)}
          backLabel={t("knowledgehub.backToList", {
            defaultValue: "Back to Knowledge",
          })}
          className="px-0"
        />
        <div className="flex min-h-0 flex-1 flex-col">
          <DocumentViewer
            documentId={selectedDocId}
            onUpdated={() => {
              void loadData();
            }}
          />
        </div>
      </div>
    );
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: file-drop target only; the keyboard-accessible upload path is the "Add" file input.
    <div
      className={`flex min-h-0 flex-1 flex-col gap-3 ${inModal ? "min-h-0" : ""}`}
      data-testid="documents-view"
      onDragOver={handleRootDragOver}
      onDrop={handleRootDrop}
    >
      {standalone ? (
        <ViewHeader
          title={t("knowledgehub.title", { defaultValue: "Knowledge" })}
          className="px-0"
        />
      ) : null}
      {hiddenFileInput}

      {isServiceLoading && (
        <PagePanel
          variant="inset"
          className="flex items-center gap-2 px-0 py-3 text-sm text-muted-strong"
        >
          <span className="h-4 w-4 animate-spin rounded-full border-2 border-accent border-t-transparent" />
          {t("documentsview.DocumentServiceIs", {
            defaultValue: "Knowledge service is initializing...",
          })}
        </PagePanel>
      )}

      {documentsUnavailable && !isServiceLoading && (
        <PagePanel.Notice tone="default">
          {t("documentsview.DocumentsUnavailableHere", {
            defaultValue:
              "Knowledge isn't available on this device. Manage documents from the desktop or web app.",
          })}
        </PagePanel.Notice>
      )}

      {loadError && !documentsUnavailable && !isServiceLoading && (
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

      {!documentsUnavailable && (
        <div className="flex shrink-0 flex-col gap-0.5">
          <div className="flex items-center justify-between gap-2">
            {isShowingSearchResults ? <span aria-hidden /> : facetStrip}
            {fileInputId ? (
              <label
                htmlFor={fileInputId}
                data-testid="knowledge-add"
                // Borderless accent action (#10710): text-accent on a faint
                // wash, darkens on hover — the sole, quiet intake affordance.
                className={`inline-flex h-8 shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-sm bg-accent/10 px-3 text-xs font-semibold text-accent transition hover:bg-accent/20 ${
                  uploading ? "pointer-events-none opacity-60" : ""
                }`}
              >
                <Plus className="h-3.5 w-3.5" aria-hidden />
                {uploading
                  ? t("documentsview.Uploading", { defaultValue: "Uploading" })
                  : t("common.add", { defaultValue: "Add" })}
              </label>
            ) : null}
          </div>
          {!isShowingSearchResults && scopeStrip}
        </div>
      )}

      <div className="custom-scrollbar flex min-h-0 flex-1 flex-col overflow-y-auto">
        {listBody}
      </div>
    </div>
  );
}
