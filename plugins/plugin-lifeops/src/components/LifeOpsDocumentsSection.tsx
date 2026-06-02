import type { DocumentRecord, DocumentScope } from "@elizaos/ui";
import {
  Button,
  client,
  Input,
  PagePanel,
  Textarea,
  useApp,
} from "@elizaos/ui";
import { useAgentElement } from "@elizaos/ui/agent-surface";
import {
  Bot,
  CalendarClock,
  FileText,
  Globe2,
  Loader2,
  Pencil,
  Plus,
  Save,
  Shield,
  Trash2,
  User,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

function DocumentEditButton({
  doc,
  onEdit,
}: {
  doc: DocumentRecord;
  onEdit: (doc: DocumentRecord) => void;
}) {
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: `documents-edit-${doc.id}`,
    role: "button",
    label: `Edit ${doc.filename}`,
    group: "lifeops-documents",
    description: `Edit the document ${doc.filename}`,
  });
  return (
    <Button
      ref={ref}
      type="button"
      size="sm"
      variant="outline"
      aria-label={`Edit ${doc.filename}`}
      title="Edit"
      onClick={() => onEdit(doc)}
      {...agentProps}
    >
      <Pencil className="h-3.5 w-3.5" aria-hidden />
    </Button>
  );
}

function DocumentDeleteButton({
  doc,
  deleting,
  onDelete,
}: {
  doc: DocumentRecord;
  deleting: boolean;
  onDelete: (id: string) => void;
}) {
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: `documents-delete-${doc.id}`,
    role: "button",
    label: `Delete ${doc.filename}`,
    group: "lifeops-documents",
    description: `Delete the document ${doc.filename}`,
  });
  return (
    <Button
      ref={ref}
      type="button"
      size="sm"
      variant="outline"
      aria-label={`Delete ${doc.filename}`}
      title={deleting ? "Deleting" : "Delete"}
      onClick={() => onDelete(doc.id)}
      disabled={deleting}
      {...agentProps}
    >
      {deleting ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
      ) : (
        <Trash2 className="h-3.5 w-3.5" aria-hidden />
      )}
    </Button>
  );
}

function DocumentComposer({
  draftTitle,
  draftContent,
  saving,
  onChangeTitle,
  onChangeContent,
  onCreate,
}: {
  draftTitle: string;
  draftContent: string;
  saving: boolean;
  onChangeTitle: (value: string) => void;
  onChangeContent: (value: string) => void;
  onCreate: () => void;
}) {
  const title = useAgentElement<HTMLInputElement>({
    id: "documents-draft-title",
    role: "text-input",
    label: "New document title",
    group: "lifeops-documents",
    description: "Optional title for the new owner-private note",
    getValue: () => draftTitle,
    onFill: onChangeTitle,
  });
  const content = useAgentElement<HTMLTextAreaElement>({
    id: "documents-draft-content",
    role: "textarea",
    label: "New document content",
    group: "lifeops-documents",
    description: "Body of the new owner-private note",
    getValue: () => draftContent,
    onFill: onChangeContent,
  });
  const save = useAgentElement<HTMLButtonElement>({
    id: "documents-save-new",
    role: "button",
    label: "Save document",
    group: "lifeops-documents",
    description: "Save the new owner-private note",
    onActivate: onCreate,
  });
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-border/35 bg-card/50 p-3">
      <Input
        ref={title.ref}
        type="text"
        placeholder="Title (optional)"
        value={draftTitle}
        onChange={(event) => onChangeTitle(event.target.value)}
        disabled={saving}
        className="h-9 text-sm"
        {...title.agentProps}
      />
      <Textarea
        ref={content.ref}
        placeholder="What should the agent remember privately?"
        value={draftContent}
        onChange={(event) => onChangeContent(event.target.value)}
        disabled={saving}
        className="min-h-28 resize-y text-sm"
        {...content.agentProps}
      />
      <div className="flex justify-end gap-2">
        <Button
          ref={save.ref}
          type="button"
          size="sm"
          aria-label={saving ? "Saving document" : "Save document"}
          title={saving ? "Saving" : "Save"}
          onClick={onCreate}
          disabled={saving || draftContent.trim().length === 0}
          {...save.agentProps}
        >
          {saving ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
          ) : (
            <Save className="h-3.5 w-3.5" aria-hidden />
          )}
        </Button>
      </div>
    </div>
  );
}

function DocumentEditDraft({
  editingDraft,
  editingSaving,
  onChangeDraft,
  onCancel,
  onSave,
}: {
  editingDraft: string;
  editingSaving: boolean;
  onChangeDraft: (value: string) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  const draft = useAgentElement<HTMLTextAreaElement>({
    id: "documents-edit-content",
    role: "textarea",
    label: "Edit document content",
    group: "lifeops-documents",
    description: "Edited body of the selected document",
    getValue: () => editingDraft,
    onFill: onChangeDraft,
  });
  const cancel = useAgentElement<HTMLButtonElement>({
    id: "documents-edit-cancel",
    role: "button",
    label: "Cancel document edit",
    group: "lifeops-documents",
    description: "Discard edits to the selected document",
    onActivate: onCancel,
  });
  const save = useAgentElement<HTMLButtonElement>({
    id: "documents-edit-save",
    role: "button",
    label: "Save document edit",
    group: "lifeops-documents",
    description: "Save edits to the selected document",
    onActivate: onSave,
  });
  return (
    <div className="mt-2 flex flex-col gap-2">
      <Textarea
        ref={draft.ref}
        value={editingDraft}
        onChange={(event) => onChangeDraft(event.target.value)}
        disabled={editingSaving}
        className="min-h-28 resize-y text-sm"
        {...draft.agentProps}
      />
      <div className="flex justify-end gap-2">
        <Button
          ref={cancel.ref}
          type="button"
          variant="outline"
          size="sm"
          aria-label="Cancel document edit"
          title="Cancel"
          onClick={onCancel}
          disabled={editingSaving}
          {...cancel.agentProps}
        >
          <X className="h-3.5 w-3.5" aria-hidden />
        </Button>
        <Button
          ref={save.ref}
          type="button"
          size="sm"
          aria-label={editingSaving ? "Saving document edit" : "Save document edit"}
          title={editingSaving ? "Saving" : "Save"}
          onClick={onSave}
          disabled={editingSaving || editingDraft.trim().length === 0}
          {...save.agentProps}
        >
          {editingSaving ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
          ) : (
            <Save className="h-3.5 w-3.5" aria-hidden />
          )}
        </Button>
      </div>
    </div>
  );
}

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
    () => [...documents].sort((a, b) => b.createdAt - a.createdAt),
    [documents],
  );

  const newNoteToggle = useAgentElement<HTMLButtonElement>({
    id: "documents-toggle-compose",
    role: "button",
    label: composing ? "Cancel new document" : "New document note",
    group: "lifeops-documents",
    status: composing ? "active" : "inactive",
    description: "Start or cancel composing a new owner-private note",
  });

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
            ref={newNoteToggle.ref}
            type="button"
            variant="outline"
            size="sm"
            aria-label="Cancel new document"
            title="Cancel"
            onClick={() => {
              setComposing(false);
              setDraftTitle("");
              setDraftContent("");
            }}
            disabled={saving}
            {...newNoteToggle.agentProps}
          >
            <X className="h-3.5 w-3.5" aria-hidden />
          </Button>
        ) : (
          <Button
            ref={newNoteToggle.ref}
            type="button"
            size="sm"
            aria-label="New document note"
            title="New note"
            onClick={() => setComposing(true)}
            disabled={loading}
            {...newNoteToggle.agentProps}
          >
            <Plus className="h-3.5 w-3.5" aria-hidden />
          </Button>
        )}
      </div>

      {composing ? (
        <DocumentComposer
          draftTitle={draftTitle}
          draftContent={draftContent}
          saving={saving}
          onChangeTitle={setDraftTitle}
          onChangeContent={setDraftContent}
          onCreate={() => void handleCreate()}
        />
      ) : null}

      {loading ? (
        <div className="flex min-h-24 items-center justify-center rounded-xl border border-border/30 bg-card/30 text-muted">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          <span className="sr-only">Loading documents</span>
        </div>
      ) : error ? (
        <div
          className="flex min-h-20 items-center justify-center rounded-xl border border-danger/25 bg-danger/8 text-danger"
          title={error}
        >
          <Shield className="h-4 w-4" aria-hidden />
          <span className="sr-only">{error}</span>
        </div>
      ) : sortedDocuments.length === 0 ? (
        <div className="flex min-h-24 items-center justify-center rounded-xl border border-border/30 bg-card/30 text-muted">
          <FileText className="h-5 w-5" aria-hidden />
          <span className="sr-only">No owner-private documents</span>
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
                  <DocumentEditDraft
                    editingDraft={editingDraft}
                    editingSaving={editingSaving}
                    onChangeDraft={setEditingDraft}
                    onCancel={() => {
                      setEditingId(null);
                      setEditingDraft("");
                    }}
                    onSave={() => void handleSaveEdit()}
                  />
                ) : (
                  <div className="mt-1 flex items-center gap-1.5">
                    {doc.canEditText ? (
                      <DocumentEditButton
                        doc={doc}
                        onEdit={(target) => void handleStartEdit(target)}
                      />
                    ) : null}
                    {doc.canDelete ? (
                      <DocumentDeleteButton
                        doc={doc}
                        deleting={deletingId === doc.id}
                        onDelete={(id) => void handleDelete(id)}
                      />
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
