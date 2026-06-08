export type StickyColor = "yellow" | "green" | "blue" | "pink";

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

export const SIMPLE_VIEWS_EVENT = "eliza:simple-views:update";
export const NOTES_KEY = "eliza.simpleViews.notes.v1";
export const CALENDAR_EVENTS_KEY = "eliza.simpleViews.calendar.events.v1";
export const CALENDAR_CURSOR_KEY = "eliza.simpleViews.calendar.cursor.v1";

export const DEFAULT_NOTES: StickyNote[] = [];

export const DEFAULT_EVENTS: SimpleCalendarEvent[] = [];

const DATE_KEY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

const serverJsonStore = new Map<string, unknown>();
const serverTextStore = new Map<string, string>();

function hasLocalStorage(): boolean {
  return (
    typeof window !== "undefined" && typeof window.localStorage !== "undefined"
  );
}

export function readJson<T>(key: string, fallback: T): T {
  if (!hasLocalStorage()) {
    return (serverJsonStore.get(key) as T | undefined) ?? fallback;
  }
  const raw = window.localStorage.getItem(key);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function writeJson<T>(key: string, value: T): void {
  if (!hasLocalStorage()) {
    serverJsonStore.set(key, value);
    return;
  }
  window.localStorage.setItem(key, JSON.stringify(value));
  emitSimpleViewsUpdate(key);
}

export function readText(key: string, fallback: string): string {
  if (!hasLocalStorage()) return serverTextStore.get(key) ?? fallback;
  return window.localStorage.getItem(key) ?? fallback;
}

export function writeText(key: string, value: string): void {
  if (!hasLocalStorage()) {
    serverTextStore.set(key, value);
    return;
  }
  window.localStorage.setItem(key, value);
  emitSimpleViewsUpdate(key);
}

export function emitSimpleViewsUpdate(key: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent(SIMPLE_VIEWS_EVENT, { detail: { key } }),
  );
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function makeId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

export function normalizeColor(value: unknown): StickyColor {
  return value === "green" || value === "blue" || value === "pink"
    ? value
    : "yellow";
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

export function simpleViewsSnapshot(): {
  notes: StickyNote[];
  events: SimpleCalendarEvent[];
  selectedDate: string;
} {
  return {
    notes: readJson<StickyNote[]>(NOTES_KEY, DEFAULT_NOTES),
    events: readJson<SimpleCalendarEvent[]>(
      CALENDAR_EVENTS_KEY,
      DEFAULT_EVENTS,
    ),
    selectedDate:
      normalizeDateKey(readText(CALENDAR_CURSOR_KEY, "")) ?? todayDateKey(),
  };
}
