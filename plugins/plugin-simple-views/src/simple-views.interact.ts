import {
  CALENDAR_CURSOR_KEY,
  CALENDAR_EVENTS_KEY,
  DEFAULT_EVENTS,
  DEFAULT_NOTES,
  makeId,
  normalizeDateKey,
  normalizeColor,
  NOTES_KEY,
  nowIso,
  readJson,
  readText,
  todayDateKey,
  type SimpleCalendarEvent,
  type StickyNote,
  writeJson,
  writeText,
} from "./storage.js";

function textParam(
  params: Record<string, unknown> | undefined,
  key: string,
): string {
  const value = params?.[key];
  return typeof value === "string" ? value.trim() : "";
}

function readNotes(): StickyNote[] {
  return readJson<StickyNote[]>(NOTES_KEY, DEFAULT_NOTES);
}

function readEvents(): SimpleCalendarEvent[] {
  return readJson<SimpleCalendarEvent[]>(CALENDAR_EVENTS_KEY, DEFAULT_EVENTS);
}

function summarizeNotes(notes: StickyNote[]): string {
  if (notes.length === 0) return "No sticky notes yet.";
  return notes.map((note) => `${note.title}: ${note.body}`).join("\n");
}

function normalizeLookup(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
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

function fallbackDateKey(): string {
  return normalizeDateKey(readText(CALENDAR_CURSOR_KEY, "")) ?? todayDateKey();
}

export async function interact(
  capability: string,
  params?: Record<string, unknown>,
): Promise<unknown> {
  if (capability === "get-notes") {
    const notes = readNotes();
    return { success: true, text: summarizeNotes(notes), notes };
  }

  if (capability === "create-note") {
    const notes = readNotes();
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
    writeJson(NOTES_KEY, [note, ...notes]);
    return {
      success: true,
      text: `Created sticky note "${note.title}".`,
      created: true,
      note,
    };
  }

  if (capability === "delete-note") {
    const target =
      textParam(params, "id") ||
      textParam(params, "title") ||
      textParam(params, "query") ||
      textParam(params, "name");
    if (!target)
      return {
        success: false,
        text: "Note id, title, or query is required.",
        deleted: false,
        reason: "target is required",
      };
    const before = readNotes();
    const resolved = resolveNoteDeleteTarget(before, target);
    if (!resolved) {
      return {
        success: false,
        text: `No sticky note found for "${target}".`,
        deleted: false,
        target,
      };
    }
    if ("ambiguous" in resolved) {
      return {
        success: false,
        text: `"${target}" matches multiple sticky notes: ${resolved.ambiguous
          .map((note) => note.title)
          .join(", ")}.`,
        deleted: false,
        target,
        candidates: resolved.ambiguous,
      };
    }
    const after = before.filter((note) => note.id !== resolved.id);
    writeJson(NOTES_KEY, after);
    const deleted = before.length !== after.length;
    return {
      success: deleted,
      text: deleted
        ? `Deleted sticky note "${resolved.title}".`
        : `No sticky note found for "${target}".`,
      deleted,
      id: resolved.id,
      note: resolved,
    };
  }

  if (capability === "clear-notes") {
    writeJson(NOTES_KEY, []);
    return { success: true, text: "Cleared all sticky notes.", cleared: true };
  }

  if (capability === "get-calendar-state") {
    const requestedDate = textParam(params, "date");
    const selectedDate = requestedDate
      ? normalizeDateKey(requestedDate)
      : fallbackDateKey();
    if (!selectedDate) {
      return {
        success: false,
        text: "Date must be YYYY-MM-DD.",
        reason: "date must be YYYY-MM-DD",
      };
    }
    const events = readEvents();
    return {
      success: true,
      text: summarizeEvents(events, selectedDate),
      selectedDate,
      events,
    };
  }

  if (capability === "select-calendar-date") {
    const date = normalizeDateKey(textParam(params, "date"));
    if (!date) {
      return {
        success: false,
        text: "Date must be YYYY-MM-DD.",
        selected: false,
        reason: "date must be YYYY-MM-DD",
      };
    }
    writeText(CALENDAR_CURSOR_KEY, date);
    return { success: true, text: `Selected ${date}.`, selected: true, date };
  }

  if (capability === "create-calendar-event") {
    const title = textParam(params, "title") || "Untitled event";
    const requestedDate = textParam(params, "date");
    const date = requestedDate
      ? normalizeDateKey(requestedDate)
      : fallbackDateKey();
    if (!date) {
      return {
        success: false,
        text: "Date must be YYYY-MM-DD.",
        created: false,
        reason: "date must be YYYY-MM-DD",
      };
    }
    const event: SimpleCalendarEvent = {
      id: makeId("event"),
      title,
      date,
      time: textParam(params, "time") || "09:00",
      notes: textParam(params, "notes"),
      color: normalizeColor(params?.color),
      createdAt: nowIso(),
    };
    writeJson(CALENDAR_EVENTS_KEY, [...readEvents(), event]);
    writeText(CALENDAR_CURSOR_KEY, date);
    return {
      success: true,
      text: `Created calendar event "${event.title}" for ${event.date} at ${event.time}.`,
      created: true,
      event,
    };
  }

  if (capability === "delete-calendar-event") {
    const id = textParam(params, "id");
    if (!id)
      return {
        success: false,
        text: "Event id is required.",
        deleted: false,
        reason: "id is required",
      };
    const before = readEvents();
    const after = before.filter((event) => event.id !== id);
    writeJson(CALENDAR_EVENTS_KEY, after);
    const deleted = before.length !== after.length;
    return {
      success: deleted,
      text: deleted
        ? `Deleted calendar event "${id}".`
        : `No calendar event found for "${id}".`,
      deleted,
      id,
    };
  }

  throw new Error(`Simple views do not support capability "${capability}".`);
}
