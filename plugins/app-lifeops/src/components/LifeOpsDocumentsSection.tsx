import { client, useApp } from "@elizaos/ui";
import type {
  DocumentRecord,
  DocumentScope,
} from "@elizaos/ui";
import { Button, Input, PagePanel, Textarea } from "@elizaos/ui";
import {
  Bot,
  CalendarClock,
  FileText,
  Globe2,
  Pencil,
  Plus,
  Save,
  Shield,
  Trash2,
  User,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

const OWNER_PRIVATE: DocumentScope = "owner-private";

const SCOPE_LABELS: Record<DocumentScope, string> = {
  global: "Global",
  "owner-private": "Owner",
  "user-private": "User",
  "agent-private": "Agent",
};

const SCOPE_ICONS: Record<
  DocumentScope,
  React.ComponentType<{ className?: string; "aria-hidden"?: boolean }>
> = {
  global: Globe2,
  "owner-private": Shield,
  "user-private": User,
  "agent-private": Bot,
};

function formatTimestamp(value: number | undefined): string {
  if (typeof value !== "number") return "";
  const ts = value < 1_000_000_000_000 ? value * 1000 : value;
  const date = new Date(ts);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
      });
}

export function LifeOpsDocumentsSection() {
  const { setActionNotice } = useApp();
  const [documents, setDocuments] = useState<DocumentRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [composing, setComposing] = useState(false);
  const [draftTitle, setDraftTitle] = useState("");
  const [draftContent, setDraftContent] = useState("");
  const [saving, setSaving] = useState(false);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingDraft, setEditingDraft] = useState("");
  const [editingSaving, setEditingSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const loadDocuments = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await client.listDocuments({
        scope: OWNER_PRIVATE,
        limit: 200,
      });
      setDocuments(response.documents);
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : "Failed to load documents.",
      );
      setDocuments([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadDocuments();
  }, [loadDocuments]);

  const handleCreate = useCallback(async () => {
    const text = draftContent.trim();
    if (!text) return;
    setSaving(true);
    try {
      const titleRaw = draftTitle.trim();
      const filenameStem =
        titleRaw
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "")
          .slice(0, 80) || "owner-note";
      const result = await client.uploadDocument({
        content: text,
        filename: `${filenameStem}.txt`,
        contentType: "text/plain",
        scope: OWNER_PRIVATE,
        metadata: {
          source: "lifeops",
          title: titleRaw || undefined,
          textBacked: true,
        },
      });
      setActionNotice(
        `Saved owner-private document (${result.fragmentCount} fragment(s)).`,
        "success",
        3000,
      );
      setDraftTitle("");
      setDraftContent("");
      setComposing(false);
      await loadDocuments();
    } catch (createError) {
      setActionNotice(
        createError instanceof Error
          ? createError.message
          : "Failed to save document.",
        "error",
        5000,
      );
    } finally {
      setSaving(false);
    }
  }, [draftContent, draftTitle, loadDocuments, setActionNotice]);

  const handleDelete = useCallback(
    async (documentId: string) => {
      setDeletingId(documentId);
      try {
        await client.deleteDocument(documentId);
        setActionNotice("Deleted document.", "success", 2500);
        await loadDocuments();
      } catch (deleteError) {
        setActionNotice(
          deleteError instanceof Error
            ? deleteError.message
            : "Failed to delete document.",
          "error",
          5000,
        );
      } finally {
        setDeletingId(null);
      }
    },
    [loadDocuments, setActionNotice],
  );

  const handleStartEdit = useCallback(async (doc: DocumentRecord) => {
    setEditingId(doc.id);
    setEditingDraft("");
    try {
      const detail = await client.getDocument(doc.id);
      setEditingDraft(detail.document.content?.text ?? "");
    } catch {
      setEditingDraft("");
    }
  }, []);

  const handleSaveEdit = useCallback(async () => {
    if (!editingId) return;
    const text = editingDraft.trim();
    if (!text) return;
    setEditingSaving(true);
    try {
      await client.updateDocument(editingId, { content: text });
      setActionNotice("Updated document.", "success", 2500);
      setEditingId(null);
      setEditingDraft("");
      await loadDocuments();
    } catch (saveError) {
      setActionNotice(
        saveError instanceof Error
          ? saveError.message
          : "Failed to update document.",
        "error",
        5000,
      );
    } finally {
      setEditingSaving(false);
    }
  }, [editingDraft, editingId, loadDocuments, setActionNotice]);

  const sortedDocuments = useMemo(
    () => [...documents].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0)),
    [documents],
  );

  return (
    <PagePanel
      as="section"
      variant="surface"
      className="flex flex-col gap-3 px-4 py-4"
      aria-label="Owner-private documents"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm font-semibold text-txt">
          <Shield className="h-4 w-4 text-accent" aria-hidden />
          Owner-private documents
          <span className="rounded-full border border-border/30 bg-bg-muted/20 px-2 py-0.5 text-2xs text-muted">
            {documents.length}
          </span>
        </div>
        {composing ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              setComposing(false);
              setDraftTitle("");
              setDraftContent("");
            }}
            disabled={saving}
          >
            Cancel
          </Button>
        ) : (
          <Button
            type="button"
            size="sm"
            onClick={() => setComposing(true)}
            disabled={loading}
          >
            <Plus className="mr-1.5 h-3.5 w-3.5" aria-hidden />
            New note
          </Button>
        )}
      </div>

      {composing ? (
        <div className="flex flex-col gap-2 rounded-xl border border-border/35 bg-card/50 p-3">
          <Input
            type="text"
            placeholder="Title (optional)"
            value={draftTitle}
            onChange={(event) => setDraftTitle(event.target.value)}
            disabled={saving}
            className="h-9 text-sm"
          />
          <Textarea
            placeholder="What should the agent remember privately?"
            value={draftContent}
            onChange={(event) => setDraftContent(event.target.value)}
            disabled={saving}
            className="min-h-28 resize-y text-sm"
          />
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              size="sm"
              onClick={() => void handleCreate()}
              disabled={saving || draftContent.trim().length === 0}
            >
              <Save className="mr-1.5 h-3.5 w-3.5" aria-hidden />
              {saving ? "Saving..." : "Save"}
            </Button>
          </div>
        </div>
      ) : null}

      {loading ? (
        <div className="rounded-xl border border-border/30 bg-card/30 px-3 py-6 text-center text-sm text-muted">
          Loading documents...
        </div>
      ) : error ? (
        <div className="rounded-xl border border-danger/25 bg-danger/8 px-3 py-4 text-sm text-danger">
          {error}
        </div>
      ) : sortedDocuments.length === 0 ? (
        <div className="rounded-xl border border-border/30 bg-card/30 px-3 py-6 text-center text-sm text-muted">
          No owner-private documents yet. Use "New note" to add one.
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {sortedDocuments.map((doc) => {
            const ScopeIcon = SCOPE_ICONS[doc.scope ?? "owner-private"];
            const scopeLabel = SCOPE_LABELS[doc.scope ?? "owner-private"];
            const isEditing = editingId === doc.id;
            const createdLabel = formatTimestamp(doc.createdAt);
            return (
              <li
                key={doc.id}
                className="rounded-xl border border-border/30 bg-card/40 px-3 py-3"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <FileText
                    className="h-4 w-4 shrink-0 text-muted"
                    aria-hidden
                  />
                  <span className="min-w-0 flex-1 truncate text-sm font-semibold text-txt">
                    {doc.filename}
                  </span>
                  <span className="inline-flex items-center gap-1 rounded-full border border-border/35 bg-bg-muted/20 px-2 py-0.5 text-2xs text-muted">
                    <ScopeIcon className="h-3 w-3" aria-hidden />
                    {scopeLabel}
                  </span>
                  {createdLabel ? (
                    <span className="inline-flex items-center gap-1 text-2xs text-muted">
                      <CalendarClock className="h-3 w-3" />
                      {createdLabel}
                    </span>
                  ) : null}
                </div>

                {isEditing ? (
                  <div className="mt-2 flex flex-col gap-2">
                    <Textarea
                      value={editingDraft}
                      onChange={(event) => setEditingDraft(event.target.value)}
                      disabled={editingSaving}
                      className="min-h-28 resize-y text-sm"
                    />
                    <div className="flex justify-end gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setEditingId(null);
                          setEditingDraft("");
                        }}
                        disabled={editingSaving}
                      >
                        Cancel
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        onClick={() => void handleSaveEdit()}
                        disabled={
                          editingSaving || editingDraft.trim().length === 0
                        }
                      >
                        <Save className="mr-1.5 h-3.5 w-3.5" aria-hidden />
                        {editingSaving ? "Saving..." : "Save"}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="mt-1 flex items-center gap-1.5">
                    {doc.canEditText ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => void handleStartEdit(doc)}
                      >
                        <Pencil className="mr-1.5 h-3.5 w-3.5" aria-hidden />
                        Edit
                      </Button>
                    ) : null}
                    {doc.canDelete ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => void handleDelete(doc.id)}
                        disabled={deletingId === doc.id}
                      >
                        <Trash2 className="mr-1.5 h-3.5 w-3.5" aria-hidden />
                        {deletingId === doc.id ? "Deleting..." : "Delete"}
                      </Button>
                    ) : null}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </PagePanel>
  );
}
