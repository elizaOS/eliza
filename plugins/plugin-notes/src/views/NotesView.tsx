/**
 * Read-only Notes surface backed by the authoritative server snapshot.
 * Mutations stay in the planner-visible capability layer so chat is the single
 * place where people create, edit, delete, or clear notes.
 */

import { useAgentElement } from "@elizaos/ui/agent-surface";
import type { StickyNote as StickyNoteModel } from "../types.js";
import { useNotesState } from "./useNotesState.js";
import {
  COLOR_MATERIALS,
  GLASS_PANEL_STYLE,
  SECONDARY_TEXT_STYLE,
  VIEW_ROOT_STYLE,
  VIEW_SCROLL_STYLE,
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

function NoteCard({ note }: { note: StickyNoteModel }) {
  const card = useAgentElement<HTMLElement>({
    // The agent surface is also planner context. Sharing the domain id keeps a
    // follow-up such as “delete that note” addressable by the same identifier
    // the semantic capability accepts instead of leaking a presentation-only
    // DOM id into tool parameters.
    id: note.id,
    label: `Note ${note.title}`,
    role: "card",
    group: "notes-list",
    description: note.body || "Empty note body",
    status: note.color,
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
      }}
    >
      <div style={{ minWidth: 0 }}>
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
  const { snapshot, loading, error } = useNotesState();
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
  return (
    <main
      aria-busy={loading}
      aria-label={`Notes. ${headerDetail}`}
      data-testid="simple-notes-view"
      style={VIEW_ROOT_STYLE}
    >
      {snapshot ? (
        <div data-testid="simple-notes-scroll-region" style={VIEW_SCROLL_STYLE}>
          {error ? (
            <div
              role="alert"
              style={{
                ...GLASS_PANEL_STYLE,
                marginBottom: 12,
                padding: 14,
                color: "var(--status-danger, #ff857a)",
              }}
            >
              {error}
            </div>
          ) : null}
          <section aria-label="Notes" style={{ minWidth: 0 }}>
            {notes.length === 0 ? (
              <ViewState
                loading={false}
                error={null}
                empty
                emptyTitle="A quiet note wall"
                emptyBody="Ask Eliza in chat to create your first note."
              />
            ) : (
              <div
                style={{
                  display: "grid",
                  // A fixed track minimum avoids circular percentage sizing
                  // beside the landscape chat rail while preserving wrapping.
                  gridTemplateColumns: "repeat(auto-fill, minmax(230px, 1fr))",
                  gap: 12,
                }}
              >
                {notes.map((note) => (
                  <NoteCard key={note.id} note={note} />
                ))}
              </div>
            )}
          </section>
        </div>
      ) : (
        <div data-testid="simple-notes-scroll-region" style={VIEW_SCROLL_STYLE}>
          <ViewState
            loading={loading}
            error={error}
            empty={false}
            emptyTitle=""
            emptyBody=""
          />
        </div>
      )}
    </main>
  );
}

export default NotesView;
