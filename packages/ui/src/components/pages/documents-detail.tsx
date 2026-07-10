/**
 * Document detail viewer for the Documents/Knowledge page: loads one document
 * by id, shows its metadata and source/scope badges, renders its fragments, and
 * supports inline text editing with save. Pure formatting helpers live in
 * documents-detail.helpers; this file owns the fetch/edit/save lifecycle.
 */

import type { Transcript } from "@elizaos/shared/transcripts";
import {
  BadgeCheck,
  Bot,
  CalendarDays,
  Download,
  FileText,
  Globe2,
  Lock,
  Maximize2,
  Minimize2,
  Pencil,
  Save,
  Share2,
  Shield,
  User,
} from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { client } from "../../api/client";
import type {
  DocumentDetail,
  DocumentFragmentRecord,
} from "../../api/client-types-chat";
import { useAppSelector } from "../../state";
import { formatByteSize, resolveAppAssetUrl } from "../../utils";
import { safeAttachmentUrl } from "../../utils/attachment-url";
import {
  canShareFiles,
  downloadAttachment,
  filenameForMime,
  shareAttachment,
} from "../../utils/download-share";
import { PagePanel } from "../composites/page-panel";
import { TranscriptPlayer } from "../transcripts/TranscriptPlayer";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { getDocumentTypeLabel } from "./documents-detail.helpers";
import { knowledgeReaderKind } from "./knowledge-media-format";

function formatDocumentTimestamp(value?: number): string | null {
  if (!value) return null;
  const timestamp = value < 1_000_000_000_000 ? value * 1000 : value;
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/* ── Document Viewer ────────────────────────────────────────────────── */

export function DocumentViewer({
  documentId,
  initialSeekMs,
  onUpdated,
}: {
  documentId: string | null;
  /**
   * Entry offset (ms) for a transcript-backed record (#14806): a knowledge
   * search hit carries its fragment's startMs so opening the match seeks the
   * player to the matching audio instead of t=0.
   */
  initialSeekMs?: number | null;
  onUpdated?: () => void;
}) {
  const t = useAppSelector((s) => s.t);
  const setActionNotice = useAppSelector((s) => s.setActionNotice);
  const [doc, setDoc] = useState<DocumentDetail | null>(null);
  const [fragments, setFragments] = useState<DocumentFragmentRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draftText, setDraftText] = useState("");
  const [saving, setSaving] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const [fullscreen, setFullscreen] = useState(false);
  // The rich Transcript backing a transcript-mirror knowledge record (#8789):
  // loaded lazily so the reader can render the word-synced player. The knowledge
  // doc stays the searchable denormalized copy; TranscriptStore stays the truth.
  const [transcript, setTranscript] = useState<Transcript | null>(null);

  useEffect(() => {
    const id = documentId ?? "";
    void reloadToken; // re-run on manual refresh (kept in deps below)
    setFullscreen(false);
    setTranscript(null);
    if (!id) {
      setDoc(null);
      setFragments([]);
      setLoading(false);
      setError(null);
      setEditing(false);
      setDraftText("");
      return;
    }

    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);

      const [docRes, fragRes] = await Promise.all([
        client.getDocument(id),
        client.getDocumentFragments(id),
      ]);

      if (cancelled) return;

      // A well-formed detail response always carries `document`; if the backend
      // returns an empty/malformed body (or the doc was deleted between the list
      // and detail fetch), surface a clean message instead of letting a raw
      // "Cannot read properties of undefined (reading 'content')" TypeError
      // reach the user as the error text (#8876).
      if (!docRes?.document) {
        throw new Error(
          t("documentsview.DocumentUnavailable", {
            defaultValue: "This document is no longer available.",
          }),
        );
      }

      setDoc(docRes.document);
      setFragments(fragRes?.fragments ?? []);
      setDraftText(docRes.document.content?.text ?? "");
      setEditing(false);
      setLoading(false);
    }

    load().catch((err) => {
      if (!cancelled) {
        setError(
          err instanceof Error
            ? err.message
            : t("documentsview.FailedToLoadDocument", {
                defaultValue: "Failed to load document",
              }),
        );
        setLoading(false);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [documentId, reloadToken, t]);

  // Load the rich transcript once we know the record mirrors one. Kept out of
  // the main effect so a document without a transcript never pays for it.
  const transcriptId = doc?.transcriptId;
  useEffect(() => {
    if (!transcriptId) {
      setTranscript(null);
      return;
    }
    let cancelled = false;
    client
      .getTranscript(transcriptId)
      .then((res) => {
        if (!cancelled) setTranscript(res.transcript);
      })
      .catch(() => {
        // error-policy:J4 — the transcript store may not hold this record (or
        // the plugin is absent). The reader degrades to plain audio + the
        // searchable text copy below; no error state for a missing enrichment.
        if (!cancelled) setTranscript(null);
      });
    return () => {
      cancelled = true;
    };
  }, [transcriptId]);

  const previewText = doc?.content?.text?.trim();
  const readerKind = doc
    ? knowledgeReaderKind({
        contentType: doc.contentType,
        transcriptId: doc.transcriptId,
      })
    : "text";
  const documentCreatedLabel = formatDocumentTimestamp(doc?.createdAt);
  const scopeLabel =
    doc?.scope === "owner-private"
      ? t("documentsview.ScopeOwner", { defaultValue: "Owner" })
      : doc?.scope === "user-private"
        ? t("documentsview.ScopeUser", { defaultValue: "User" })
        : doc?.scope === "agent-private"
          ? t("documentsview.ScopeAgent", { defaultValue: "Agent" })
          : t("documentsview.ScopeGlobal", { defaultValue: "Global" });
  const ScopeIcon =
    doc?.scope === "owner-private"
      ? Shield
      : doc?.scope === "user-private"
        ? User
        : doc?.scope === "agent-private"
          ? Bot
          : Globe2;

  // The original served file (when the backend exposes a fetchable URL for the
  // document, e.g. uploaded binaries / mirrored transcript audio). v1 gates the
  // download/share affordances on this URL existing.
  const servedFileUrl = doc?.url || doc?.transcriptAudioUrl || null;
  // Resolve to an app-absolute URL and pass it through the attachment-URL
  // allowlist before ever handing it to an <img>/<audio>/<video>/<iframe> src
  // (reuse the one guard; do not add a second, #8876).
  const mediaUrl = servedFileUrl
    ? safeAttachmentUrl(resolveAppAssetUrl(servedFileUrl))
    : "";
  const shareSupported = canShareFiles();

  const handleDownloadFile = async () => {
    if (!servedFileUrl || !doc) return;
    const filename = doc.filename || filenameForMime(doc.contentType);
    try {
      await downloadAttachment(servedFileUrl, filename);
    } catch {
      setActionNotice(
        t("documentsview.FailedToDownload", {
          defaultValue: "Failed to download file",
        }),
        "error",
        4000,
      );
    }
  };

  const handleShareFile = async () => {
    if (!servedFileUrl || !doc) return;
    const shared = await shareAttachment(servedFileUrl, {
      title: doc.filename,
      filename: doc.filename || undefined,
    });
    if (!shared) await handleDownloadFile();
  };

  const handleSave = async () => {
    if (!documentId || !doc) return;
    setSaving(true);
    try {
      const result = await client.updateDocument(documentId, {
        content: draftText,
      });
      setActionNotice(
        t("documentsview.DocumentUpdated", {
          defaultValue: "Updated knowledge document ({{count}} fragments)",
          count: result.fragmentCount,
        }),
        "success",
        3000,
      );
      setEditing(false);
      setReloadToken((current) => current + 1);
      onUpdated?.();
    } catch (saveError) {
      setActionNotice(
        saveError instanceof Error
          ? saveError.message
          : t("documentsview.FailedToUpdateDocument", {
              defaultValue: "Failed to update knowledge document",
            }),
        "error",
        5000,
      );
    } finally {
      setSaving(false);
    }
  };

  // Per-mimeType reader block over the original served bytes (#13594). A
  // transcript-backed record renders the word-synced player; plain media
  // renders by kind; a text/pdf record has no inline media block (its prose /
  // paged text renders below). Full-screen wraps the same block in an overlay.
  let mediaBlock: ReactNode = null;
  if (doc) {
    if (readerKind === "transcript") {
      mediaBlock = transcript ? (
        <PagePanel variant="inset" className="p-4">
          <TranscriptPlayer
            transcript={transcript}
            audioUrl={mediaUrl || undefined}
            initialSeekMs={
              typeof initialSeekMs === "number" ? initialSeekMs : undefined
            }
          />
        </PagePanel>
      ) : mediaUrl ? (
        // biome-ignore lint/a11y/useMediaCaption: the searchable text copy below is the caption.
        <audio
          data-testid="reader-audio"
          controls
          // A media-fragment `#t=` carries the search-hit entry offset for the
          // plain-audio fallback (no rich transcript record to seek through).
          src={
            typeof initialSeekMs === "number" && initialSeekMs > 0
              ? `${mediaUrl}#t=${(initialSeekMs / 1000).toFixed(3)}`
              : mediaUrl
          }
          className="w-full"
        />
      ) : null;
    } else if (readerKind === "image" && mediaUrl) {
      mediaBlock = (
        <button
          type="button"
          data-testid="reader-image"
          onClick={() => setFullscreen(true)}
          className="mx-auto block max-h-[28rem] cursor-zoom-in overflow-hidden rounded-sm"
        >
          <img
            src={mediaUrl}
            alt={doc.filename}
            className="max-h-[28rem] w-auto object-contain"
          />
        </button>
      );
    } else if (readerKind === "audio" && mediaUrl) {
      mediaBlock = (
        // biome-ignore lint/a11y/useMediaCaption: user-uploaded audio carries no caption track.
        <audio
          data-testid="reader-audio"
          controls
          src={mediaUrl}
          className="w-full"
        />
      );
    } else if (readerKind === "video" && mediaUrl) {
      mediaBlock = (
        // biome-ignore lint/a11y/useMediaCaption: user-uploaded video carries no caption track.
        <video
          data-testid="reader-video"
          controls
          src={mediaUrl}
          className="max-h-[28rem] w-full rounded-sm bg-black"
        />
      );
    } else if (readerKind === "pdf" && mediaUrl) {
      mediaBlock = (
        <iframe
          data-testid="reader-pdf"
          src={mediaUrl}
          title={doc.filename}
          className="h-[32rem] w-full rounded-sm border border-border/40 bg-white"
        />
      );
    }
  }

  return (
    /* Flat — no card/border. The shell owns the page's horizontal padding. */
    <PagePanel className="flex flex-col overflow-hidden">
      <div className="custom-scrollbar flex min-h-0 flex-1 flex-col overflow-y-auto px-4 py-4">
        {loading && (
          <div className="py-10 text-center font-bold tracking-wide text-muted animate-pulse">
            <span className="mr-3 inline-block h-4 w-4 animate-spin rounded-full border-2 border-accent border-t-transparent align-middle" />
            {t("appsview.Loading")}
          </div>
        )}

        {error && <PagePanel.Notice tone="danger">{error}</PagePanel.Notice>}

        {!loading && !error && !doc && (
          <PagePanel.Empty
            variant="inset"
            className="px-0 py-12"
            description={t("documentsview.NoDocumentSelectedDesc", {
              defaultValue:
                "Select a document from the list to view its fragments and metadata.",
            })}
            title={t("documentsview.NoDocumentSelected", {
              defaultValue: "No document selected",
            })}
          />
        )}

        {!loading && !error && doc && (
          <div className="mx-auto flex w-full max-w-4xl flex-col gap-4">
            <div className="px-1">
              <div className="flex min-w-0 items-start gap-3">
                <FileText
                  className="mt-1.5 h-5 w-5 shrink-0 text-muted-strong"
                  aria-hidden
                />
                <div className="min-w-0 flex-1">
                  <h2 className="break-words text-lg font-semibold text-txt">
                    {doc.filename}
                  </h2>
                  <div className="mt-2 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted">
                    <span className="inline-flex items-center gap-1">
                      <ScopeIcon className="h-3 w-3" aria-hidden />
                      {scopeLabel}
                    </span>
                    <span aria-hidden>·</span>
                    <span>{doc.provenance.label}</span>
                    <span aria-hidden>·</span>
                    <span>{formatByteSize(doc.fileSize)}</span>
                    <span aria-hidden>·</span>
                    <span>
                      {doc.fragmentCount === 1
                        ? "1 fragment"
                        : `${doc.fragmentCount} fragments`}
                    </span>
                    <span aria-hidden>·</span>
                    <span>{getDocumentTypeLabel(doc.contentType)}</span>
                    {doc.canEditText ? (
                      <>
                        <span aria-hidden>·</span>
                        <span className="inline-flex items-center gap-1 text-status-success">
                          <BadgeCheck className="h-3 w-3" aria-hidden />
                          {t("documentsview.Editable", {
                            defaultValue: "Editable",
                          })}
                        </span>
                      </>
                    ) : null}
                    {!doc.canDelete ? (
                      <>
                        <span aria-hidden>·</span>
                        <span className="inline-flex items-center gap-1">
                          <Lock className="h-3 w-3" aria-hidden />
                          {t("documentsview.Locked", {
                            defaultValue: "Locked",
                          })}
                        </span>
                      </>
                    ) : null}
                    {documentCreatedLabel ? (
                      <>
                        <span aria-hidden>·</span>
                        <span className="inline-flex items-center gap-1">
                          <CalendarDays className="h-3 w-3" aria-hidden />
                          {documentCreatedLabel}
                        </span>
                      </>
                    ) : null}
                    {doc.provenance.detail ? (
                      <>
                        <span aria-hidden>·</span>
                        <span className="min-w-0 max-w-full truncate">
                          {doc.provenance.detail}
                        </span>
                      </>
                    ) : null}
                  </div>
                </div>
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                {mediaUrl && readerKind !== "transcript" ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    data-testid="document-fullscreen"
                    aria-pressed={fullscreen}
                    onClick={() => setFullscreen((current) => !current)}
                  >
                    {fullscreen ? (
                      <Minimize2 className="mr-1.5 h-4 w-4" aria-hidden />
                    ) : (
                      <Maximize2 className="mr-1.5 h-4 w-4" aria-hidden />
                    )}
                    {fullscreen
                      ? t("documentsview.ExitFullScreen", {
                          defaultValue: "Exit full screen",
                        })
                      : t("documentsview.FullScreen", {
                          defaultValue: "Full screen",
                        })}
                  </Button>
                ) : null}
                {servedFileUrl ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    data-testid="document-download"
                    onClick={() => void handleDownloadFile()}
                  >
                    <Download className="mr-1.5 h-4 w-4" aria-hidden />
                    {t("documentsview.Download", {
                      defaultValue: "Download",
                    })}
                  </Button>
                ) : null}
                {servedFileUrl && shareSupported ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    data-testid="document-share"
                    onClick={() => void handleShareFile()}
                  >
                    <Share2 className="mr-1.5 h-4 w-4" aria-hidden />
                    {t("documentsview.Share", {
                      defaultValue: "Share",
                    })}
                  </Button>
                ) : null}
                {doc.canEditText ? (
                  <>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => setEditing((current) => !current)}
                      disabled={saving}
                    >
                      <Pencil className="mr-1.5 h-3.5 w-3.5" aria-hidden />
                      {editing ? "Cancel" : "Edit text"}
                    </Button>
                    {editing ? (
                      <Button
                        type="button"
                        size="sm"
                        onClick={() => void handleSave()}
                        disabled={saving || draftText.trim().length === 0}
                      >
                        <Save className="mr-1.5 h-3.5 w-3.5" aria-hidden />
                        {saving ? "Saving..." : "Save"}
                      </Button>
                    ) : null}
                  </>
                ) : doc.editabilityReason ? (
                  <div className="text-xs text-muted">
                    {doc.editabilityReason}
                  </div>
                ) : null}
              </div>
            </div>

            {mediaBlock ? (
              <div data-testid="reader-media">{mediaBlock}</div>
            ) : null}

            {/* The transcript player already renders the full body; a plain
                media record keeps the searchable text copy below for context. */}
            {readerKind === "transcript" && transcript ? null : (
              <PagePanel variant="inset" className="p-4">
                {editing ? (
                  <Textarea
                    value={draftText}
                    rows={16}
                    onChange={(event) => setDraftText(event.target.value)}
                    className="min-h-[20rem] resize-y rounded-sm border-border/40 bg-bg-muted/15 font-mono text-sm leading-relaxed"
                  />
                ) : previewText ? (
                  <pre className="custom-scrollbar max-h-[16rem] overflow-auto whitespace-pre-wrap break-words text-sm leading-relaxed text-txt/88">
                    {previewText.slice(0, 2000)}
                  </pre>
                ) : (
                  <div className="py-6 text-center text-xs text-muted">
                    {t("documentsview.NoPreview", {
                      defaultValue: "Full text preview is not available",
                    })}
                  </div>
                )}
              </PagePanel>
            )}

            <PagePanel variant="inset" className="p-4">
              <div>
                {fragments.map((fragment, index) => {
                  const createdLabel = formatDocumentTimestamp(
                    fragment.createdAt,
                  );
                  return (
                    <article
                      key={fragment.id}
                      className="grid gap-3 py-4 sm:grid-cols-[4rem_minmax(0,1fr)]"
                    >
                      <div className="flex h-8 w-8 items-center justify-center text-xs font-bold text-muted-strong">
                        {index + 1}
                      </div>

                      <div className="min-w-0">
                        <div className="mb-2 flex flex-wrap items-center gap-2 text-2xs text-muted">
                          {fragment.position !== undefined ? (
                            <span>
                              {t("documentsview.FragmentPosition", {
                                defaultValue: "position {{position}}",
                                position: fragment.position,
                              })}
                            </span>
                          ) : null}
                          {createdLabel ? (
                            <>
                              {fragment.position !== undefined ? (
                                <span>•</span>
                              ) : null}
                              <span>{createdLabel}</span>
                            </>
                          ) : null}
                          {(fragment.position !== undefined ||
                            createdLabel) && <span>•</span>}
                          <span>
                            {t("documentsview.CharacterCount", {
                              defaultValue: "{{count}} chars",
                              count: fragment.text.length,
                            })}
                          </span>
                        </div>
                        <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-txt/90">
                          {fragment.text}
                        </p>
                      </div>
                    </article>
                  );
                })}
                {fragments.length === 0 && (
                  <PagePanel.Empty
                    variant="inset"
                    className="min-h-[8rem] py-8"
                    title={t("documentsview.NoFragmentsFound")}
                  />
                )}
              </div>
            </PagePanel>
          </div>
        )}
      </div>

      {fullscreen && mediaBlock ? (
        // biome-ignore lint/a11y/noStaticElementInteractions: backdrop click-to-close; the "Exit full screen" button + Escape-equivalent Close button below are the keyboard paths.
        // biome-ignore lint/a11y/useKeyWithClickEvents: the semantic close button is the keyboard path; backdrop click is a pointer convenience.
        <div
          data-testid="reader-fullscreen"
          className="fixed inset-0 z-50 flex flex-col bg-black/90 p-4 sm:p-8"
          onClick={() => setFullscreen(false)}
        >
          <div className="flex justify-end">
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid="reader-fullscreen-close"
              onClick={(event) => {
                event.stopPropagation();
                setFullscreen(false);
              }}
            >
              <Minimize2 className="mr-1.5 h-4 w-4" aria-hidden />
              {t("documentsview.ExitFullScreen", {
                defaultValue: "Exit full screen",
              })}
            </Button>
          </div>
          {/* biome-ignore lint/a11y/noStaticElementInteractions: stops backdrop close when interacting with the media itself. */}
          {/* biome-ignore lint/a11y/useKeyWithClickEvents: this container only cancels backdrop pointer clicks; it is not an action target. */}
          <div
            className="flex min-h-0 flex-1 items-center justify-center"
            onClick={(event) => event.stopPropagation()}
          >
            {mediaBlock}
          </div>
        </div>
      ) : null}
    </PagePanel>
  );
}
