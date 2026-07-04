/**
 * Document detail viewer for the Documents/Knowledge page: loads one document
 * by id, shows its metadata and source/scope badges, renders its fragments, and
 * supports inline text editing with save. Pure formatting helpers live in
 * documents-detail.helpers; this file owns the fetch/edit/save lifecycle.
 */

import {
  BadgeCheck,
  Bot,
  CalendarDays,
  Download,
  FileText,
  Globe2,
  Headphones,
  Lock,
  Pencil,
  Save,
  Share2,
  Shield,
  User,
} from "lucide-react";
import { useEffect, useState } from "react";
import { client } from "../../api/client";
import type {
  DocumentDetail,
  DocumentFragmentRecord,
} from "../../api/client-types-chat";
import { navigateBrowserPath } from "../../app-navigate-view";
import { useAppSelector } from "../../state";
import {
  canShareFiles,
  downloadAttachment,
  filenameForMime,
  shareAttachment,
} from "../../utils/download-share";
import { formatByteSize } from "../../utils/format";
import { PagePanel } from "../composites/page-panel";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { getDocumentTypeLabel } from "./documents-detail.helpers";

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
  onUpdated,
}: {
  documentId: string | null;
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

  useEffect(() => {
    const id = documentId ?? "";
    void reloadToken; // re-run on manual refresh (kept in deps below)
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

  const previewText = doc?.content?.text?.trim();
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
                {doc.transcriptId ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    data-testid="document-open-transcript"
                    onClick={() => navigateBrowserPath("/apps/transcripts")}
                  >
                    <Headphones className="mr-1.5 h-4 w-4" aria-hidden />
                    {t("documentsview.ViewOriginalTranscript", {
                      defaultValue: "View original transcript",
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
    </PagePanel>
  );
}
