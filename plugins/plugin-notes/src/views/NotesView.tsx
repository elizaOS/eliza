/**
 * Notes view for direct and agent-driven CRUD. It renders a compact glass
 * composer beside a responsive note wall and always reflects the authoritative
 * server snapshot returned by the Notes interaction route.
 */

import { useAgentElement } from "@elizaos/ui/agent-surface";
import { Check, Pencil, Plus, RotateCcw, Trash2, X } from "lucide-react";
import {
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import type { StickyColor, StickyNote as StickyNoteModel } from "../types.js";
import { useNotesState } from "./useNotesState.js";
import {
  AgentAction,
  AgentInput,
  AgentTextarea,
  COLOR_MATERIALS,
  ColorPicker,
  GLASS_PANEL_STYLE,
  handleRenderedMutationFailure,
  LABEL_STYLE,
  SECONDARY_TEXT_STYLE,
  VIEW_ROOT_STYLE,
  ViewState,
} from "./viewPrimitives.js";

function formatUpdatedAt(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "Updated";
  const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60_000));
  if (minutes < 1) return "Updated now";
  if (minutes < 60) return `Updated ${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Updated ${hours}h ago`;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
  }).format(new Date(timestamp));
}

function NoteCard({
  note,
  editing,
  disabled,
  onEdit,
  onDelete,
}: {
  note: StickyNoteModel;
  editing: boolean;
  disabled: boolean;
  onEdit: (note: StickyNoteModel) => void;
  onDelete: (note: StickyNoteModel) => void;
}) {
  const card = useAgentElement<HTMLElement>({
    id: `notes-card-${note.id}`,
    label: `Note ${note.title}`,
    role: "card",
    group: "notes-list",
    description: note.body || "Empty note body",
    status: editing ? "editing" : note.color,
  });
  const material = COLOR_MATERIALS[note.color];

  return (
    <article
      ref={card.ref}
      {...card.agentProps}
      style={{
        ...GLASS_PANEL_STYLE,
        minHeight: 178,
        padding: 16,
        display: "flex",
        flexDirection: "column",
        gap: 11,
        background: `linear-gradient(145deg, ${material.fill}, color-mix(in srgb, var(--card, #111) 78%, transparent))`,
        boxShadow: editing
          ? "inset 0 0 0 2px var(--accent, #ff6a1f), 0 18px 48px rgba(0,0,0,.20)"
          : GLASS_PANEL_STYLE.boxShadow,
        transition: "transform 180ms ease, opacity 180ms ease",
      }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <h2
            style={{
              margin: 0,
              fontSize: 15,
              lineHeight: 1.35,
              fontWeight: 720,
              overflowWrap: "anywhere",
            }}
          >
            {note.title}
          </h2>
          <p style={{ ...SECONDARY_TEXT_STYLE, marginTop: 3, fontSize: 11 }}>
            {formatUpdatedAt(note.updatedAt)}
          </p>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 2 }}>
          <AgentAction
            agentId={`notes-edit-${note.id}`}
            agentLabel={`Edit note ${note.title}`}
            agentGroup="notes-list"
            agentStatus={editing ? "active" : "idle"}
            variant="quiet"
            compact
            disabled={disabled}
            onClick={() => onEdit(note)}
            title="Edit note"
          >
            <Pencil size={15} aria-hidden />
          </AgentAction>
          <AgentAction
            agentId={`notes-delete-${note.id}`}
            agentLabel={`Delete note ${note.title}`}
            agentGroup="notes-list"
            variant="quiet"
            compact
            disabled={disabled}
            onClick={() => onDelete(note)}
            title="Delete note"
          >
            <Trash2 size={15} aria-hidden />
          </AgentAction>
        </div>
      </div>
      <p
        style={{
          margin: 0,
          flex: 1,
          color: "var(--muted-strong, rgba(255,255,255,.78))",
          fontSize: 14,
          lineHeight: 1.5,
          whiteSpace: "pre-wrap",
          overflowWrap: "anywhere",
        }}
      >
        {note.body || "No details"}
      </p>
      <span
        aria-hidden
        style={{
          width: 28,
          height: 3,
          borderRadius: 999,
          background: material.dot,
          opacity: 0.78,
        }}
      />
    </article>
  );
}

export function NotesView() {
  const { snapshot, loading, busy, error, refresh, mutate } =
    useNotesState();
  const notes = snapshot?.notes ?? [];
  const headerDetail = error
    ? snapshot
      ? `Sync unavailable · revision ${snapshot.revision}`
      : "Notes unavailable"
    : loading
      ? snapshot
        ? `Refreshing… · revision ${snapshot.revision}`
        : "Loading shared notes…"
      : snapshot
        ? `${notes.length} ${notes.length === 1 ? "note" : "notes"} · revision ${snapshot.revision}`
        : "Notes unavailable";
  const [editingId, setEditingId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [color, setColor] = useState<StickyColor>("yellow");
  const [confirmClear, setConfirmClear] = useState(false);

  const editingNote = useMemo(
    () => notes.find((note) => note.id === editingId) ?? null,
    [editingId, notes],
  );

  const resetComposer = useCallback(() => {
    setEditingId(null);
    setTitle("");
    setBody("");
    setColor("yellow");
  }, []);

  useEffect(() => {
    if (editingId && snapshot && !editingNote) resetComposer();
  }, [editingId, editingNote, resetComposer, snapshot]);

  const editNote = useCallback((note: StickyNoteModel) => {
    setEditingId(note.id);
    setTitle(note.title);
    setBody(note.body);
    setColor(note.color);
  }, []);

  const submit = useCallback(async () => {
    const normalizedTitle = title.trim();
    if (!normalizedTitle || busy) return;
    try {
      if (editingId) {
        await mutate("update-note", {
          id: editingId,
          title: normalizedTitle,
          body,
          color,
        });
      } else {
        await mutate("create-note", {
          title: normalizedTitle,
          body,
          color,
        });
      }
      resetComposer();
    } catch (cause) {
      // error-policy:J4 useNotesState records expected Error failures for this view's alert.
      handleRenderedMutationFailure(cause);
    }
  }, [body, busy, color, editingId, mutate, resetComposer, title]);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void submit();
  };

  const deleteNote = useCallback(
    async (note: StickyNoteModel) => {
      if (busy) return;
      try {
        await mutate("delete-note", { id: note.id });
        if (editingId === note.id) resetComposer();
      } catch (cause) {
        // error-policy:J4 useNotesState records expected Error failures for this view's alert.
        handleRenderedMutationFailure(cause);
      }
    },
    [busy, editingId, mutate, resetComposer],
  );

  const clearNotes = useCallback(async () => {
    if (!confirmClear) {
      setConfirmClear(true);
      return;
    }
    try {
      await mutate("clear-notes");
      resetComposer();
      setConfirmClear(false);
    } catch (cause) {
      // error-policy:J4 useNotesState records expected Error failures for this view's alert.
      handleRenderedMutationFailure(cause);
    }
  }, [confirmClear, mutate, resetComposer]);

  return (
    <main
      aria-busy={loading || busy}
      aria-label={`Notes. ${headerDetail}`}
      data-testid="simple-notes-view"
      style={VIEW_ROOT_STYLE}
    >
      <ViewState
        loading={loading && !snapshot}
        error={!snapshot ? error : null}
        empty={false}
        emptyTitle=""
        emptyBody=""
        onRetry={() => void refresh()}
      />

      {snapshot ? (
        <div
          style={{
            display: "grid",
            gridTemplateColumns:
              "repeat(auto-fit, minmax(min(100%, 310px), 1fr))",
            gap: 14,
            alignItems: "start",
          }}
        >
          <form
            onSubmit={handleSubmit}
            style={{
              ...GLASS_PANEL_STYLE,
              display: "grid",
              gap: 13,
              padding: 16,
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 10,
              }}
            >
              <div>
                <h2
                  style={{
                    margin: 0,
                    fontSize: 15,
                    lineHeight: 1.35,
                    fontWeight: 720,
                  }}
                >
                  {editingNote ? "Edit note" : "New note"}
                </h2>
                <p
                  style={{
                    ...SECONDARY_TEXT_STYLE,
                    marginTop: 3,
                    fontSize: 11,
                  }}
                >
                  {editingNote
                    ? "Changes save to the shared test state."
                    : "Create a note from here or through chat."}
                </p>
              </div>
              {editingNote ? (
                <AgentAction
                  agentId="notes-cancel-edit"
                  agentLabel="Cancel note edit"
                  agentGroup="notes-compose"
                  variant="quiet"
                  compact
                  disabled={busy}
                  onClick={resetComposer}
                  title="Cancel editing"
                >
                  <X size={16} aria-hidden />
                </AgentAction>
              ) : null}
            </div>

            <label htmlFor="notes-title" style={LABEL_STYLE}>
              Title
              <AgentInput
                agentId="notes-title"
                agentLabel="Note title"
                agentGroup="notes-compose"
                value={title}
                onValue={setTitle}
                maxLength={240}
                placeholder="What’s worth remembering?"
                disabled={busy}
              />
            </label>
            <label htmlFor="notes-body" style={LABEL_STYLE}>
              Details
              <AgentTextarea
                agentId="notes-body"
                agentLabel="Note details"
                agentGroup="notes-compose"
                value={body}
                onValue={setBody}
                maxLength={20_000}
                placeholder="Add a little context…"
                disabled={busy}
              />
            </label>
            <div style={{ ...LABEL_STYLE, gap: 8 }}>
              Color
              <ColorPicker
                value={color}
                onChange={setColor}
                group="notes-compose"
              />
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <AgentAction
                agentId="notes-save"
                agentLabel={editingNote ? "Save note changes" : "Create note"}
                agentGroup="notes-compose"
                agentStatus={
                  busy ? "loading" : editingNote ? "editing" : "ready"
                }
                variant="primary"
                disabled={busy || !title.trim()}
                onClick={() => void submit()}
                style={{ flex: 1 }}
              >
                {editingNote ? (
                  <Check size={16} aria-hidden />
                ) : (
                  <Plus size={16} aria-hidden />
                )}
                {busy ? "Saving…" : editingNote ? "Save changes" : "Add note"}
              </AgentAction>
              {(title || body) && !editingNote ? (
                <AgentAction
                  agentId="notes-reset-draft"
                  agentLabel="Reset note draft"
                  agentGroup="notes-compose"
                  compact
                  disabled={busy}
                  onClick={resetComposer}
                  title="Reset draft"
                >
                  <RotateCcw size={15} aria-hidden />
                </AgentAction>
              ) : null}
            </div>
            {error ? (
              <p
                role="alert"
                style={{
                  ...SECONDARY_TEXT_STYLE,
                  color: "var(--status-danger, #ff857a)",
                }}
              >
                {error}
              </p>
            ) : null}
          </form>

          <section aria-label="Notes" style={{ minWidth: 0 }}>
            {notes.length > 0 ? (
              <div
                style={{
                  display: "flex",
                  justifyContent: "flex-end",
                  marginBottom: 8,
                }}
              >
                <AgentAction
                  agentId="notes-clear"
                  agentLabel={
                    confirmClear ? "Confirm clear all notes" : "Clear all notes"
                  }
                  agentGroup="notes-list"
                  agentStatus={confirmClear ? "confirming" : "idle"}
                  variant="quiet"
                  disabled={busy}
                  onClick={() => void clearNotes()}
                >
                  <Trash2 size={15} aria-hidden />
                  {confirmClear ? "Confirm clear" : "Clear"}
                </AgentAction>
              </div>
            ) : null}
            {notes.length === 0 ? (
              <ViewState
                loading={false}
                error={null}
                empty
                emptyTitle="A quiet note wall"
                emptyBody="Add the first note here, or ask Eliza to create one and watch it appear."
                onRetry={() => void refresh()}
              />
            ) : (
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns:
                    "repeat(auto-fill, minmax(min(100%, 230px), 1fr))",
                  gap: 12,
                }}
              >
                {notes.map((note) => (
                  <NoteCard
                    key={note.id}
                    note={note}
                    editing={editingId === note.id}
                    disabled={busy}
                    onEdit={editNote}
                    onDelete={(candidate) => void deleteNote(candidate)}
                  />
                ))}
              </div>
            )}
          </section>
        </div>
      ) : null}
    </main>
  );
}

export default NotesView;
