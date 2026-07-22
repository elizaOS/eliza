/**
 * Shared domain contracts for managed Cloud Notes and Calendar
 * views. The backend store, authenticated routes, capability broker, and view
 * bundle all consume these shapes so persisted state has one owner and one
 * schema instead of parallel browser/server models.
 */

export const SIMPLE_VIEWS_SCHEMA_VERSION = 1 as const;

export const STICKY_COLORS = ["yellow", "green", "rose", "slate"] as const;

export type StickyColor = (typeof STICKY_COLORS)[number];

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
  updatedAt: string;
}

export interface SimpleViewsSnapshot {
  notes: StickyNote[];
  events: SimpleCalendarEvent[];
  selectedDate: string;
  revision: number;
}

export interface SimpleViewsDocument extends SimpleViewsSnapshot {
  schemaVersion: typeof SIMPLE_VIEWS_SCHEMA_VERSION;
  persistedAt: string;
}

export type SimpleViewsStorePhase =
  | "idle"
  | "loading"
  | "ready"
  | "error"
  | "stopped";

export interface SimpleViewsStoreStatus {
  phase: SimpleViewsStorePhase;
  filePath: string;
  revision?: number;
  error?: {
    code: string;
    message: string;
  };
}

export interface CreateNoteInput {
  title: string;
  body: string;
  color: StickyColor;
}

export interface UpdateNoteInput {
  title?: string;
  body?: string;
  color?: StickyColor;
}

export interface CreateCalendarEventInput {
  title: string;
  date: string;
  time: string;
  notes: string;
  color: StickyColor;
}

export interface UpdateCalendarEventInput {
  title?: string;
  date?: string;
  time?: string;
  notes?: string;
  color?: StickyColor;
}
