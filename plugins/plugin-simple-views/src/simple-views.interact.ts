import {
  makeId,
  normalizeColor,
  normalizeDateKey,
  nowIso,
  readEvents,
  readNotes,
  readSelectedDate,
  type SimpleCalendarEvent,
  type SimpleViewsSnapshot,
  type StickyNote,
  simpleViewsSnapshot,
  todayDateKey,
  writeEvents,
  writeNotes,
  writeSelectedDate,
} from "./storage.js";

export interface SimpleViewsInteractResult {
  success: boolean;
  text: string;
  state: SimpleViewsSnapshot;
  [key: string]: unknown;
}

type SimpleViewsInteractFields = {
  success: boolean;
  text: string;
} & Record<string, unknown>;

function textParam(
  params: Record<string, unknown> | undefined,
  key: string,
): string {
  const value = params?.[key];
  return typeof value === "string" ? value.trim() : "";
}

function normalizeLookup(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function summarizeNotes(notes: StickyNote[]): string {
  if (notes.length === 0) return "No sticky notes yet.";
  return notes.map((note) => `${note.title}: ${note.body}`).join("\n");
}

function summarizeEvents(events: SimpleCalendarEvent[], date?: string): string {
  const filtered = date
    ? events.filter((event) => event.date === date)
    : events;
  if (filtered.length === 0) {
    return date ? `No calendar events for ${date}.` : "No calendar events yet.";
  }
  return filtered
    .map(
      (event) =>
        `${event.date} ${event.time} - ${event.title}${event.notes ? `: ${event.notes}` : ""}`,
    )
    .join("\n");
}

function resolveNoteDeleteTarget(
  notes: StickyNote[],
  target: string,
): StickyNote | { ambiguous: StickyNote[] } | null {
  const normalized = normalizeLookup(target);
  if (!normalized) return null;

  const exact = notes.filter(
    (note) =>
      normalizeLookup(note.id) === normalized ||
      normalizeLookup(note.title) === normalized,
  );
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return { ambiguous: exact };

  const titleMatches = notes.filter((note) =>
    normalizeLookup(note.title).includes(normalized),
  );
  if (titleMatches.length === 1) return titleMatches[0];
  if (titleMatches.length > 1) return { ambiguous: titleMatches };

  const bodyMatches = notes.filter((note) =>
    normalizeLookup(note.body).includes(normalized),
  );
  if (bodyMatches.length === 1) return bodyMatches[0];
  if (bodyMatches.length > 1) return { ambiguous: bodyMatches };

  return null;
}

function result(fields: SimpleViewsInteractFields): SimpleViewsInteractResult {
  return { ...fields, state: simpleViewsSnapshot() };
}

export async function interact(
  capability: string,
  params?: Record<string, unknown>,
): Promise<SimpleViewsInteractResult> {
  if (capability === "get-notes") {
    const notes = readNotes();
    return result({
      success: true,
      text: summarizeNotes(notes),
      notes,
    });
  }

  if (capability === "create-note") {
    const now = nowIso();
    const note: StickyNote = {
      id: makeId("note"),
      title: textParam(params, "title") || "Untitled",
      body:
        textParam(params, "body") || textParam(params, "content") || "New note",
      color: normalizeColor(params?.color),
      createdAt: now,
      updatedAt: now,
    };
    writeNotes([note, ...readNotes()]);
    return result({
      success: true,
      text: `Created sticky note "${note.title}".`,
      created: true,
      note,
    });
  }

  if (capability === "delete-note") {
    const target =
      textParam(params, "id") ||
      textParam(params, "title") ||
      textParam(params, "query") ||
      textParam(params, "name");
    if (!target) {
      return result({
        success: false,
        text: "Note id, title, or query is required.",
        deleted: false,
        reason: "target is required",
      });
    }

    const before = readNotes();
    const resolved = resolveNoteDeleteTarget(before, target);
    if (!resolved) {
      return result({
        success: false,
        text: `No sticky note found for "${target}".`,
        deleted: false,
        target,
      });
    }
    if ("ambiguous" in resolved) {
      return result({
        success: false,
        text: `"${target}" matches multiple sticky notes: ${resolved.ambiguous
          .map((note) => note.title)
          .join(", ")}.`,
        deleted: false,
        target,
        candidates: resolved.ambiguous,
      });
    }

    writeNotes(before.filter((note) => note.id !== resolved.id));
    return result({
      success: true,
      text: `Deleted sticky note "${resolved.title}".`,
      deleted: true,
      id: resolved.id,
      note: resolved,
    });
  }

  if (capability === "clear-notes") {
    writeNotes([]);
    return result({
      success: true,
      text: "Cleared all sticky notes.",
      cleared: true,
    });
  }

  if (capability === "get-calendar-state") {
    const requestedDate = textParam(params, "date");
    const selectedDate = requestedDate
      ? normalizeDateKey(requestedDate)
      : readSelectedDate();
    if (!selectedDate) {
      return result({
        success: false,
        text: "Date must be YYYY-MM-DD.",
        reason: "date must be YYYY-MM-DD",
      });
    }
    const events = readEvents();
    return result({
      success: true,
      text: summarizeEvents(events, selectedDate),
      selectedDate,
      events,
    });
  }

  if (capability === "select-calendar-date") {
    const date = normalizeDateKey(textParam(params, "date"));
    if (!date) {
      return result({
        success: false,
        text: "Date must be YYYY-MM-DD.",
        selected: false,
        reason: "date must be YYYY-MM-DD",
      });
    }
    writeSelectedDate(date);
    return result({
      success: true,
      text: `Selected ${date}.`,
      selected: true,
      date,
    });
  }

  if (capability === "create-calendar-event") {
    const requestedDate = textParam(params, "date");
    const date = requestedDate
      ? normalizeDateKey(requestedDate)
      : readSelectedDate() || todayDateKey();
    if (!date) {
      return result({
        success: false,
        text: "Date must be YYYY-MM-DD.",
        created: false,
        reason: "date must be YYYY-MM-DD",
      });
    }

    const event: SimpleCalendarEvent = {
      id: makeId("event"),
      title: textParam(params, "title") || "Untitled event",
      date,
      time: textParam(params, "time") || "09:00",
      notes: textParam(params, "notes"),
      color: normalizeColor(params?.color),
      createdAt: nowIso(),
    };
    writeEvents([...readEvents(), event]);
    writeSelectedDate(date);
    return result({
      success: true,
      text: `Created calendar event "${event.title}" for ${event.date} at ${event.time}.`,
      created: true,
      event,
    });
  }

  if (capability === "delete-calendar-event") {
    const id = textParam(params, "id");
    if (!id) {
      return result({
        success: false,
        text: "Event id is required.",
        deleted: false,
        reason: "id is required",
      });
    }

    const before = readEvents();
    const event = before.find((candidate) => candidate.id === id);
    if (!event) {
      return result({
        success: false,
        text: `No calendar event found for "${id}".`,
        deleted: false,
        id,
      });
    }

    writeEvents(before.filter((candidate) => candidate.id !== id));
    return result({
      success: true,
      text: `Deleted calendar event "${event.title}".`,
      deleted: true,
      id,
      event,
    });
  }

  throw new Error(`Simple views do not support capability "${capability}".`);
}
