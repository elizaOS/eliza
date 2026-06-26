export type StickyColor = "yellow" | "green" | "rose" | "slate";

export interface StickyNote {
  id: string;
  title: string;
  body: string;
  color: StickyColor;
  createdAt: string;
  updatedAt: string;
}

export interface SimpleCalendarEvent {
  id: string;
  title: string;
  date: string;
  time: string;
  notes: string;
  color: StickyColor;
  createdAt: string;
}

export interface SimpleViewsSnapshot {
  notes: StickyNote[];
  events: SimpleCalendarEvent[];
  selectedDate: string;
}

export const SIMPLE_VIEWS_EVENT = "eliza:simple-views:update";
export const NOTES_KEY = "eliza.simpleViews.notes.v2";
export const CALENDAR_EVENTS_KEY = "eliza.simpleViews.calendar.events.v2";
export const CALENDAR_CURSOR_KEY = "eliza.simpleViews.calendar.cursor.v2";

const DEFAULT_NOTES: StickyNote[] = [];
const DEFAULT_EVENTS: SimpleCalendarEvent[] = [];
const DATE_KEY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const serverJsonStore = new Map<string, unknown>();
const serverTextStore = new Map<string, string>();

function browserStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage ?? null;
  } catch {
    return null;
  }
}

function emitSimpleViewsUpdate(key: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent(SIMPLE_VIEWS_EVENT, { detail: { key } }),
  );
}

function readJson<T>(
  key: string,
  fallback: T,
  isValid: (value: unknown) => value is T,
): T {
  const storage = browserStorage();
  if (!storage) {
    const value = serverJsonStore.get(key);
    return isValid(value) ? value : fallback;
  }

  try {
    const raw = storage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as unknown;
    return isValid(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function writeJson<T>(key: string, value: T): void {
  const storage = browserStorage();
  if (!storage) {
    serverJsonStore.set(key, value);
    return;
  }

  try {
    storage.setItem(key, JSON.stringify(value));
    emitSimpleViewsUpdate(key);
  } catch {
    // Storage can be unavailable or quota-limited; keep the UI alive.
  }
}

function readText(key: string, fallback: string): string {
  const storage = browserStorage();
  if (!storage) return serverTextStore.get(key) ?? fallback;

  try {
    return storage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

function writeText(key: string, value: string): void {
  const storage = browserStorage();
  if (!storage) {
    serverTextStore.set(key, value);
    return;
  }

  try {
    storage.setItem(key, value);
    emitSimpleViewsUpdate(key);
  } catch {
    // Storage can be unavailable or quota-limited; keep the UI alive.
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function normalizeColor(value: unknown): StickyColor {
  return value === "green" ||
    value === "rose" ||
    value === "pink" ||
    value === "slate"
    ? value === "pink"
      ? "rose"
      : value
    : "yellow";
}

function isStickyNote(value: unknown): value is StickyNote {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.title === "string" &&
    typeof value.body === "string" &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string" &&
    normalizeColor(value.color) === value.color
  );
}

function isCalendarEvent(value: unknown): value is SimpleCalendarEvent {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.title === "string" &&
    normalizeDateKey(value.date) === value.date &&
    typeof value.time === "string" &&
    typeof value.notes === "string" &&
    typeof value.createdAt === "string" &&
    normalizeColor(value.color) === value.color
  );
}

function isStickyNoteArray(value: unknown): value is StickyNote[] {
  return Array.isArray(value) && value.every(isStickyNote);
}

function isCalendarEventArray(value: unknown): value is SimpleCalendarEvent[] {
  return Array.isArray(value) && value.every(isCalendarEvent);
}

export function readNotes(): StickyNote[] {
  return readJson(NOTES_KEY, DEFAULT_NOTES, isStickyNoteArray);
}

export function writeNotes(notes: StickyNote[]): void {
  writeJson(NOTES_KEY, notes);
}

export function readEvents(): SimpleCalendarEvent[] {
  return readJson(CALENDAR_EVENTS_KEY, DEFAULT_EVENTS, isCalendarEventArray);
}

export function writeEvents(events: SimpleCalendarEvent[]): void {
  writeJson(CALENDAR_EVENTS_KEY, events);
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function makeId(prefix: string): string {
  const cryptoObject = globalThis.crypto;
  if (typeof cryptoObject?.randomUUID === "function") {
    return `${prefix}-${cryptoObject.randomUUID()}`;
  }
  return `${prefix}-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

export function todayDateKey(date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

export function normalizeDateKey(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = DATE_KEY_PATTERN.exec(value.trim());
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1000 || month < 1 || month > 12 || day < 1 || day > 31) {
    return null;
  }

  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return date.toISOString().slice(0, 10);
}

export function readSelectedDate(): string {
  return normalizeDateKey(readText(CALENDAR_CURSOR_KEY, "")) ?? todayDateKey();
}

export function writeSelectedDate(date: string): void {
  writeText(CALENDAR_CURSOR_KEY, date);
}

export function simpleViewsSnapshot(): SimpleViewsSnapshot {
  return {
    notes: readNotes(),
    events: readEvents(),
    selectedDate: readSelectedDate(),
  };
}

export function applySimpleViewsSnapshot(
  snapshot: SimpleViewsSnapshot,
  options: { preserveLocalDataOnEmpty?: boolean } = {},
): void {
  const hasLocalData = readNotes().length > 0 || readEvents().length > 0;
  if (
    options.preserveLocalDataOnEmpty &&
    hasLocalData &&
    snapshot.notes.length === 0 &&
    snapshot.events.length === 0
  ) {
    return;
  }

  writeNotes(snapshot.notes);
  writeEvents(snapshot.events);
  writeSelectedDate(snapshot.selectedDate);
}

export function isSimpleViewsSnapshot(
  value: unknown,
): value is SimpleViewsSnapshot {
  if (!isRecord(value)) return false;
  return (
    isStickyNoteArray(value.notes) &&
    isCalendarEventArray(value.events) &&
    normalizeDateKey(value.selectedDate) === value.selectedDate
  );
}
