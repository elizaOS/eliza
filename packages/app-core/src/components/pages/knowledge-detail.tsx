import { Button, PagePanel, Textarea } from "@elizaos/ui";
import { useEffect, useState } from "react";
import { client } from "../../api/client";
import type {
  KnowledgeDocument,
  KnowledgeDocumentDetail,
  KnowledgeFragment,
} from "../../api/client-types-chat";
import { useApp } from "../../state/useApp";
import { formatByteSize } from "../../utils/format";

export function getKnowledgeTypeLabel(contentType?: string): string {
  return contentType?.split("/").pop()?.toUpperCase() || "DOC";
}

export function getKnowledgeSourceLabel(
  source: string | undefined,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  if (source === "youtube") {
    return t("knowledgeview.YouTube", { defaultValue: "YouTube" });
  }
  if (source === "url") {
    return t("knowledgeview.FromUrl", { defaultValue: "From URL" });
  }
  return t("knowledgeview.Upload", { defaultValue: "Upload" });
}

export function getKnowledgeDocumentSummary(
  doc: KnowledgeDocument,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  const fragmentLabel =
    doc.fragmentCount === 1
      ? t("knowledgeview.FragmentCountOne", {
          defaultValue: "1 fragment",
        })
      : t("knowledgeview.FragmentCountMany", {
          defaultValue: "{{count}} fragments",
          count: doc.fragmentCount,
        });
  return `${getKnowledgeSourceLabel(doc.source, t)} • ${fragmentLabel} • ${formatByteSize(doc.fileSize)}`;
}

/* ── Document Viewer ────────────────────────────────────────────────── */

export function DocumentViewer({
  documentId,
  onUpdated,
}: {
  documentId: string | null;
  onUpdated?: () => void;
}) {
  const { t, setActionNotice } = useApp();
  const [doc, setDoc] = useState<KnowledgeDocumentDetail | null>(null);
  const [fragments, setFragments] = useState<KnowledgeFragment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draftText, setDraftText] = useState("");
  const [saving, setSaving] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    const id = documentId ?? "";
    const refreshToken = reloadToken;
    void refreshToken;
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
        client.getKnowledgeDocument(id),
        client.getKnowledgeFragments(id),
      ]);

      if (cancelled) return;

      setDoc(docRes.document);
      setFragments(fragRes.fragments);
      setDraftText(docRes.document.content?.text ?? "");
      setEditing(false);
      setLoading(false);
    }

    load().catch((err) => {
      if (!cancelled) {
        setError(
          err instanceof Error
            ? err.message
            : t("knowledgeview.FailedToLoadDocument", {
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

  const handleSave = async () => {
    if (!documentId || !doc) return;
    setSaving(true);
    try {
      const result = await client.updateKnowledgeDocument(documentId, {
        content: draftText,
      });
      setActionNotice(
        t("knowledgeview.DocumentUpdated", {
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
          : t("knowledgeview.FailedToUpdateDocument", {
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
    <PagePanel className="flex flex-col overflow-hidden !rounded-none !border-0 !bg-transparent !shadow-none !ring-0">
      <div className="custom-scrollbar flex min-h-0 flex-1 flex-col overflow-y-auto px-4 py-4">
        {loading && (
          <div className="py-10 text-center font-bold tracking-wide text-muted animate-pulse">
            <span className="mr-3 inline-block h-4 w-4 animate-spin rounded-full border-2 border-accent border-t-transparent align-middle" />
            {t("databaseview.Loading")}
          </div>
        )}

        {error && (
          <div className="rounded-xl border border-danger/25 bg-danger/10 py-8 text-center text-sm font-medium text-danger">
            {error}
          </div>
        )}

        {!loading && !error && !doc && (
          <PagePanel.Empty
            variant="inset"
            className="px-0 py-12 !rounded-none !border-0 !bg-transparent !shadow-none !ring-0"
            description={t("knowledgeview.NoDocumentSelectedDesc", {
              defaultValue:
                "Select a document from the list to view its fragments and metadata.",
            })}
            title={t("knowledgeview.NoDocumentSelected", {
              defaultValue: "No document selected",
            })}
          />
        )}

        {!loading && !error && doc && (
          <div className="mx-auto flex w-full max-w-4xl flex-col gap-4">
            <div className="px-1">
              <h2 className="break-words text-lg font-semibold text-txt">
                {doc.filename}
              </h2>
              <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted">
                <span>{doc.provenance.label}</span>
                <span>•</span>
                <span>{formatByteSize(doc.fileSize)}</span>
                <span>•</span>
                <span>
                  {doc.fragmentCount === 1
                    ? "1 fragment"
                    : `${doc.fragmentCount} fragments`}
                </span>
                {doc.provenance.detail ? (
                  <>
                    <span>•</span>
                    <span className="truncate">{doc.provenance.detail}</span>
                  </>
                ) : null}
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                {doc.canEditText ? (
                  <>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="rounded-lg"
                      onClick={() => setEditing((current) => !current)}
                      disabled={saving}
                    >
                      {editing ? "Cancel" : "Edit text"}
                    </Button>
                    {editing ? (
                      <Button
                        type="button"
                        size="sm"
                        className="rounded-lg"
                        onClick={() => void handleSave()}
                        disabled={saving || draftText.trim().length === 0}
                      >
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

            <PagePanel
              variant="inset"
              className="p-4 !rounded-none !border-0 !bg-transparent !shadow-none !ring-0"
            >
              <div className="mb-3 text-xs font-semibold uppercase tracking-[0.12em] text-muted/70">
                {t("knowledgeview.Preview", { defaultValue: "Preview" })}
              </div>
              {editing ? (
                <Textarea
                  value={draftText}
                  rows={16}
                  onChange={(event) => setDraftText(event.target.value)}
                  className="min-h-[20rem] resize-y rounded-xl border-border/40 bg-bg-muted/15 font-mono text-sm leading-relaxed"
                />
              ) : previewText ? (
                <pre className="custom-scrollbar max-h-[16rem] overflow-auto whitespace-pre-wrap break-words text-sm leading-relaxed text-txt/88">
                  {previewText.slice(0, 2000)}
                </pre>
              ) : (
                <div className="py-6 text-center text-xs text-muted">
                  {t("knowledgeview.NoPreview", {
                    defaultValue: "Full text preview is not available",
                  })}
                </div>
              )}
            </PagePanel>

            <PagePanel
              variant="inset"
              className="p-4 !rounded-none !border-0 !bg-transparent !shadow-none !ring-0"
            >
              <div className="mb-3 text-xs font-semibold uppercase tracking-[0.12em] text-muted/70">
                {t("knowledgeview.FragmentsLabel", {
                  defaultValue: "Fragments",
                })}
              </div>
              <div className="space-y-3">
                {fragments.map((fragment) => (
                  <div key={fragment.id} className="py-3">
                    <p className="whitespace-pre-wrap text-sm leading-relaxed text-txt/90">
                      {fragment.text}
                    </p>
                  </div>
                ))}
                {fragments.length === 0 && (
                  <PagePanel.Empty
                    variant="inset"
                    className="min-h-[8rem] py-8 !rounded-none !border-0 !bg-transparent !shadow-none !ring-0"
                    title={t("knowledgeview.NoFragmentsFound")}
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
