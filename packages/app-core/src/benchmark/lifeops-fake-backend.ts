/**
 * In-process fake LifeOps backend used by the LifeOpsBench HTTP routes.
 *
 * Loads a `LifeWorld` JSON snapshot (produced by the Python harness via
 * `LifeWorld.to_json()`), keeps the entity stores keyed by id in memory,
 * and exposes the small surface area that Wave 2A's hand-authored
 * scenarios actually exercise (calendar reschedule/cancel, mail
 * search/draft, reminder create/complete, chat send, note create).
 *
 * The schema is intentionally 1:1 with the Python `entities.py` shape so
 * a single canonical JSON document round-trips through both runtimes.
 *
 * Unsupported method invocations throw a `LifeOpsBackendUnsupportedError`
 * with the method name + a hint so callers can file a gap entry rather
 * than silently no-op. Wave 4C will close gaps as scenarios land.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

// --------------------------------------------------------------------------
// Entity types — names + fields mirror eliza_lifeops_bench/lifeworld/entities.py.
// We type each store as a plain `Record<string, EntityT>` so JSON in == JSON out
// without per-field re-validation. The Python writer is the source of truth.
// --------------------------------------------------------------------------

type EmailFolder = "inbox" | "sent" | "drafts" | "archive" | "trash" | "spam";
type EventStatus = "confirmed" | "tentative" | "cancelled";
type ReminderPriority = "none" | "low" | "medium" | "high";

export interface Contact {
  id: string;
  display_name: string;
  given_name: string;
  family_name: string;
  primary_email: string;
  phones: string[];
  company: string | null;
  role: string | null;
  relationship: "family" | "friend" | "work" | "acquaintance";
  importance: number;
  tags: string[];
  birthday: string | null;
}

export interface EmailMessage {
  id: string;
  thread_id: string;
  folder: EmailFolder;
  from_email: string;
  to_emails: string[];
  cc_emails: string[];
  subject: string;
  body_plain: string;
  sent_at: string;
  received_at: string | null;
  is_read: boolean;
  is_starred: boolean;
  labels: string[];
  attachments: string[];
}

export interface EmailThread {
  id: string;
  subject: string;
  message_ids: string[];
  participants: string[];
  last_activity_at: string;
}

export interface ChatMessage {
  id: string;
  channel: string;
  conversation_id: string;
  from_handle: string;
  to_handles: string[];
  text: string;
  sent_at: string;
  is_read: boolean;
  is_outgoing: boolean;
  attachments: string[];
}

export interface Conversation {
  id: string;
  channel: string;
  participants: string[];
  title: string | null;
  last_activity_at: string;
  is_group: boolean;
}

export interface CalendarEvent {
  id: string;
  calendar_id: string;
  title: string;
  description: string;
  location: string | null;
  start: string;
  end: string;
  all_day: boolean;
  attendees: string[];
  status: EventStatus;
  visibility: "default" | "public" | "private";
  recurrence_rule: string | null;
  source: "google" | "apple" | "outlook";
}

export interface Calendar {
  id: string;
  name: string;
  color: string;
  owner: string;
  source: "google" | "apple" | "outlook";
  is_primary: boolean;
}

export interface Reminder {
  id: string;
  list_id: string;
  title: string;
  notes: string;
  due_at: string | null;
  completed_at: string | null;
  priority: ReminderPriority;
  tags: string[];
}

export interface ReminderList {
  id: string;
  name: string;
  source: string;
}

export interface Note {
  id: string;
  title: string;
  body_markdown: string;
  tags: string[];
  created_at: string;
  updated_at: string;
  source: string;
}

export interface FinancialTransaction {
  id: string;
  account_id: string;
  amount_cents: number;
  currency: string;
  merchant: string;
  category: string;
  description: string;
  posted_at: string;
  is_pending: boolean;
}

export interface FinancialAccount {
  id: string;
  institution: string;
  account_type: "checking" | "savings" | "credit" | "investment";
  balance_cents: number;
  currency: string;
  last4: string;
}

export interface Subscription {
  id: string;
  name: string;
  monthly_cents: number;
  billing_day: number;
  next_charge_at: string;
  status: "active" | "paused" | "cancelled";
}

export interface HealthMetric {
  id: string;
  metric_type: string;
  value: number;
  recorded_at: string;
  source: string;
}

export interface LocationPoint {
  id: string;
  latitude: number;
  longitude: number;
  label: string | null;
  recorded_at: string;
}

// --------------------------------------------------------------------------
// Snapshot shape — must be byte-equivalent to LifeWorld.to_json() output.
// --------------------------------------------------------------------------

export interface LifeWorldStores {
  contact: Record<string, Contact>;
  email: Record<string, EmailMessage>;
  email_thread: Record<string, EmailThread>;
  chat_message: Record<string, ChatMessage>;
  conversation: Record<string, Conversation>;
  calendar_event: Record<string, CalendarEvent>;
  calendar: Record<string, Calendar>;
  reminder: Record<string, Reminder>;
  reminder_list: Record<string, ReminderList>;
  note: Record<string, Note>;
  transaction: Record<string, FinancialTransaction>;
  account: Record<string, FinancialAccount>;
  subscription: Record<string, Subscription>;
  health_metric: Record<string, HealthMetric>;
  location_point: Record<string, LocationPoint>;
}

export interface LifeWorldDocument {
  seed: number;
  now_iso: string;
  stores: LifeWorldStores;
}

const ENTITY_KINDS = [
  "contact",
  "email",
  "email_thread",
  "chat_message",
  "conversation",
  "calendar_event",
  "calendar",
  "reminder",
  "reminder_list",
  "note",
  "transaction",
  "account",
  "subscription",
  "health_metric",
  "location_point",
] as const satisfies ReadonlyArray<keyof LifeWorldStores>;

function emptyStores(): LifeWorldStores {
  return {
    contact: {},
    email: {},
    email_thread: {},
    chat_message: {},
    conversation: {},
    calendar_event: {},
    calendar: {},
    reminder: {},
    reminder_list: {},
    note: {},
    transaction: {},
    account: {},
    subscription: {},
    health_metric: {},
    location_point: {},
  };
}

// --------------------------------------------------------------------------
// Action invocation result and unsupported method error.
// --------------------------------------------------------------------------

export class LifeOpsBackendUnsupportedError extends Error {
  constructor(method: string, hint = "") {
    const suffix = hint ? `: ${hint}` : "";
    super(`Unsupported lifeops fake-backend method "${method}"${suffix}`);
    this.name = "LifeOpsBackendUnsupportedError";
  }
}

export interface ActionResult {
  ok: boolean;
  result: unknown;
}

// --------------------------------------------------------------------------
// Backend itself.
// --------------------------------------------------------------------------

export class LifeOpsFakeBackend {
  private nowIso: string;
  private readonly seed: number;
  private readonly stores: LifeWorldStores;

  /** Methods we explicitly support — see `applyAction()` for handler routing. */
  static readonly SUPPORTED_METHODS = new Set<string>([
    // Calendar
    "calendar.create_event",
    "calendar.move_event",
    "calendar.cancel_event",
    "calendar.list_events",
    // Mail
    "mail.search",
    "mail.create_draft",
    "mail.send",
    "mail.archive",
    "mail.mark_read",
    // Reminders
    "reminders.create",
    "reminders.complete",
    "reminders.list",
    // Chat / messages
    "messages.send",
    // Notes
    "notes.create",
    // Contacts (read-only)
    "contacts.search",
  ]);

  constructor(document: LifeWorldDocument) {
    this.seed = document.seed;
    this.nowIso = document.now_iso;
    this.stores = emptyStores();
    for (const kind of ENTITY_KINDS) {
      const incoming = document.stores[kind] ?? {};
      Object.assign(this.stores[kind], incoming);
    }
  }

  static fromJsonFile(path: string): LifeOpsFakeBackend {
    const raw = readFileSync(path, "utf8");
    const doc = JSON.parse(raw) as LifeWorldDocument;
    return new LifeOpsFakeBackend(doc);
  }

  // ----- world / clock --------------------------------------------------

  setNow(nowIso: string): void {
    this.nowIso = nowIso;
  }

  getNow(): string {
    return this.nowIso;
  }

  getSeed(): number {
    return this.seed;
  }

  // ----- snapshot / hashing --------------------------------------------

  /** Returns the canonical JSON representation, byte-equivalent to Python. */
  toJson(): string {
    const sortedStores: Record<string, Record<string, unknown>> = {};
    for (const kind of [...ENTITY_KINDS].sort()) {
      const store = this.stores[kind];
      const sortedKeys = Object.keys(store).sort();
      const sorted: Record<string, unknown> = {};
      for (const k of sortedKeys) {
        sorted[k] = store[k];
      }
      sortedStores[kind] = sorted;
    }
    return JSON.stringify({
      now_iso: this.nowIso,
      seed: this.seed,
      stores: sortedStores,
    });
  }

  stateHash(): string {
    return createHash("sha256").update(this.toJson()).digest("hex");
  }

  toDocument(): LifeWorldDocument {
    return JSON.parse(this.toJson()) as LifeWorldDocument;
  }

  // ----- action dispatch ------------------------------------------------

  applyAction(name: string, kwargs: Record<string, unknown>): ActionResult {
    switch (name) {
      // LifeOpsBench exposes Eliza-style umbrella/promoted names to planners.
      // Canonicalize those into the fake backend's lower-case method surface
      // before dispatch so tool results are useful on follow-up turns.
      case "CALENDAR":
        return this.applyCalendarUmbrella(kwargs);
      case "CALENDAR_CREATE_EVENT":
        return this.applyCalendarUmbrella({
          ...kwargs,
          subaction: kwargs.subaction ?? "create_event",
        });
      case "CALENDAR_UPDATE_EVENT":
        return this.applyCalendarUmbrella({
          ...kwargs,
          subaction: kwargs.subaction ?? "update_event",
        });
      case "CALENDAR_DELETE_EVENT":
        return this.applyCalendarUmbrella({
          ...kwargs,
          subaction: kwargs.subaction ?? "delete_event",
        });
      case "CALENDAR_SEARCH_EVENTS":
        return this.applyCalendarUmbrella({
          ...kwargs,
          subaction: kwargs.subaction ?? "search_events",
        });
      case "CALENDAR_CHECK_AVAILABILITY":
      case "CALENDAR_PROPOSE_TIMES":
      case "CALENDAR_NEXT_EVENT":
      case "CALENDAR_UPDATE_PREFERENCES":
        return this.applyCalendarUmbrella({
          ...kwargs,
          subaction: kwargs.subaction ?? "list_events",
        });

      // ---- calendar
      case "calendar.create_event":
        return { ok: true, result: this.createEvent(kwargs) };
      case "calendar.move_event":
        return { ok: true, result: this.moveEvent(kwargs) };
      case "calendar.cancel_event":
        return { ok: true, result: this.cancelEvent(kwargs) };
      case "calendar.list_events":
        return { ok: true, result: this.listEvents(kwargs) };

      // ---- mail
      case "mail.search":
        return { ok: true, result: this.searchEmails(kwargs) };
      case "mail.create_draft":
        return { ok: true, result: this.createDraft(kwargs) };
      case "mail.send":
        return { ok: true, result: this.sendEmail(kwargs) };
      case "mail.archive":
        return { ok: true, result: this.archiveEmail(kwargs) };
      case "mail.mark_read":
        return { ok: true, result: this.markRead(kwargs) };

      // ---- reminders
      case "reminders.create":
        return { ok: true, result: this.createReminder(kwargs) };
      case "reminders.complete":
        return { ok: true, result: this.completeReminder(kwargs) };
      case "reminders.list":
        return { ok: true, result: this.listReminders(kwargs) };

      // ---- messages
      case "messages.send":
        return { ok: true, result: this.sendMessage(kwargs) };

      // ---- notes
      case "notes.create":
        return { ok: true, result: this.createNote(kwargs) };

      // ---- contacts (read)
      case "contacts.search":
        return { ok: true, result: this.searchContacts(kwargs) };

      default:
        throw new LifeOpsBackendUnsupportedError(
          name,
          "extend LifeOpsFakeBackend.applyAction() before authoring scenarios that call this method",
        );
    }
  }

  // ----- calendar handlers ---------------------------------------------

  private applyCalendarUmbrella(kw: Record<string, unknown>): ActionResult {
    const subaction = pickString(kw, ["subaction", "action", "operation"], "");
    if (subaction === "create_event") {
      const start = pickString(
        kw,
        ["start", "start_time", "startAt"],
        this.nowIso,
      );
      const end =
        pickStringOrNull(kw, ["end", "end_time", "endAt"]) ??
        shiftIso(start, durationMinutes(kw, 30));
      const title = pickString(
        kw,
        ["title", "summary", "event_name"],
        "Untitled",
      );
      const existing = this.findCalendarEvent({ title, start });
      if (existing)
        return { ok: true, result: { ...existing, idempotent: true } };
      return {
        ok: true,
        result: this.createEvent({
          ...kw,
          title,
          start,
          end,
          calendarId: pickString(
            kw,
            ["calendarId", "calendar_id"],
            "cal_primary",
          ),
        }),
      };
    }

    if (subaction === "update_event") {
      const updates = isRecord(kw.updates) ? kw.updates : {};
      const merged = { ...kw, ...updates };
      const requestedId = pickStringOrNull(merged, [
        "eventId",
        "event_id",
        "id",
      ]);
      const event = this.findCalendarEvent({
        id: requestedId,
        title:
          pickStringOrNull(merged, ["title", "event_name", "query"]) ??
          (requestedId && !this.stores.calendar_event[requestedId]
            ? requestedId
            : null),
        dateHint:
          pickStringOrNull(merged, [
            "new_start",
            "newStart",
            "start",
            "date",
          ]) ?? this.nowIso,
      });
      if (!event) {
        return { ok: false, result: { missing: "calendar_event", kwargs: kw } };
      }
      const start = pickString(
        merged,
        ["new_start", "newStart", "start", "start_time"],
        event.start,
      );
      const end =
        pickStringOrNull(merged, ["new_end", "newEnd", "end", "end_time"]) ??
        shiftIso(
          start,
          durationMinutes(
            merged,
            durationBetweenMinutes(event.start, event.end),
          ),
        );
      return { ok: true, result: this.moveEvent({ id: event.id, start, end }) };
    }

    if (subaction === "delete_event") {
      const event = this.findCalendarEvent({
        id: pickStringOrNull(kw, ["eventId", "event_id", "id"]),
        title: pickStringOrNull(kw, ["title", "event_name", "query"]),
        dateHint: pickStringOrNull(kw, ["date", "start"]) ?? this.nowIso,
      });
      if (!event) {
        return { ok: false, result: { missing: "calendar_event", kwargs: kw } };
      }
      return { ok: true, result: this.cancelEvent({ id: event.id }) };
    }

    if (
      subaction === "search_events" ||
      subaction === "list_events" ||
      subaction === "check_availability" ||
      subaction === "propose_times" ||
      subaction === "next_event" ||
      subaction === "update_preferences"
    ) {
      return { ok: true, result: this.searchCalendarEvents(kw) };
    }

    throw new LifeOpsBackendUnsupportedError(
      `CALENDAR/${subaction || "<missing>"}`,
      "unknown calendar subaction",
    );
  }

  private searchCalendarEvents(kw: Record<string, unknown>): CalendarEvent[] {
    const query = (
      pickStringOrNull(kw, ["query", "q", "title", "event_name"]) ?? ""
    ).toLowerCase();
    const dateRaw = pickStringOrNull(kw, ["date"]);
    const timeRange = isRecord(kw.time_range) ? kw.time_range : {};
    const date =
      dateRaw === "today"
        ? this.nowIso.slice(0, 10)
        : dateRaw && /^\d{4}-\d{2}-\d{2}/.test(dateRaw)
          ? dateRaw.slice(0, 10)
          : null;
    const start =
      pickStringOrNull(kw, ["start", "from", "windowStart", "startDate"]) ??
      pickStringOrNull(timeRange, ["start", "from", "windowStart"]);
    const end =
      pickStringOrNull(kw, ["end", "to", "windowEnd", "endDate"]) ??
      pickStringOrNull(timeRange, ["end", "to", "windowEnd"]);
    return Object.values(this.stores.calendar_event)
      .filter((event) => {
        if (event.status === "cancelled") return false;
        if (query && !event.title.toLowerCase().includes(query)) return false;
        if (date && event.start.slice(0, 10) !== date) return false;
        if (start && event.end < start) return false;
        if (end && event.start > end) return false;
        return true;
      })
      .sort((a, b) => a.start.localeCompare(b.start));
  }

  private findCalendarEvent(args: {
    id?: string | null;
    title?: string | null;
    start?: string | null;
    dateHint?: string | null;
  }): CalendarEvent | null {
    if (args.id && this.stores.calendar_event[args.id]) {
      return this.stores.calendar_event[args.id];
    }
    const title = args.title?.trim().toLowerCase();
    const start = args.start?.trim();
    let matches = Object.values(this.stores.calendar_event).filter(
      (event) => event.status !== "cancelled",
    );
    if (title) {
      const exact = matches.filter(
        (event) => event.title.trim().toLowerCase() === title,
      );
      matches =
        exact.length > 0
          ? exact
          : matches.filter((event) => {
              const eventTitle = event.title.trim().toLowerCase();
              return eventTitle.includes(title) || title.includes(eventTitle);
            });
    }
    if (start) {
      const exact = matches.find((event) => event.start === start);
      if (exact) return exact;
    }
    if (matches.length === 0) return null;
    const hint =
      parseIso(args.dateHint ?? this.nowIso) ?? parseIso(this.nowIso);
    const hintDate = hint?.toISOString().slice(0, 10);
    return matches.sort((a, b) => {
      const aDate = a.start.slice(0, 10);
      const bDate = b.start.slice(0, 10);
      const sameDayDelta =
        (aDate === hintDate ? 0 : 1) - (bDate === hintDate ? 0 : 1);
      if (sameDayDelta !== 0) return sameDayDelta;
      const aDistance = timestampDistance(a.start, hint);
      const bDistance = timestampDistance(b.start, hint);
      if (aDistance !== bDistance) return aDistance - bDistance;
      const primaryDelta =
        (a.calendar_id === "cal_primary" ? 0 : 1) -
        (b.calendar_id === "cal_primary" ? 0 : 1);
      if (primaryDelta !== 0) return primaryDelta;
      return a.id.localeCompare(b.id);
    })[0];
  }

  private createEvent(kw: Record<string, unknown>): CalendarEvent {
    const calendarId = pickString(
      kw,
      ["calendar_id", "calendarId"],
      "cal_primary",
    );
    if (!this.stores.calendar[calendarId]) {
      throw new Error(`unknown calendar_id: ${calendarId}`);
    }
    const eventId = pickString(
      kw,
      ["event_id", "eventId", "id"],
      `event_${nextSeq(this.stores.calendar_event, "event_")}`,
    );
    const title = pickString(kw, ["title", "summary"], "");
    const start = pickString(
      kw,
      ["start", "start_iso", "starts_at"],
      this.nowIso,
    );
    const end = pickString(kw, ["end", "end_iso", "ends_at"], start);
    const cal = this.stores.calendar[calendarId];
    const event: CalendarEvent = {
      id: eventId,
      calendar_id: calendarId,
      title,
      description: pickString(kw, ["description", "notes"], ""),
      location: pickStringOrNull(kw, ["location"]),
      start,
      end,
      all_day: pickBool(kw, ["all_day", "allDay"], false),
      attendees: pickStringArray(kw, ["attendees"]),
      status: "confirmed",
      visibility: "default",
      recurrence_rule: pickStringOrNull(kw, ["recurrence_rule", "rrule"]),
      source: cal.source,
    };
    this.stores.calendar_event[eventId] = event;
    return event;
  }

  private moveEvent(kw: Record<string, unknown>): CalendarEvent {
    const eventId = pickString(kw, ["event_id", "eventId", "id"], "");
    const existing = this.stores.calendar_event[eventId];
    if (!existing) throw new Error(`unknown event_id: ${eventId}`);
    const start = pickString(kw, ["start", "new_start"], existing.start);
    const end = pickString(kw, ["end", "new_end"], existing.end);
    const updated: CalendarEvent = { ...existing, start, end };
    this.stores.calendar_event[eventId] = updated;
    return updated;
  }

  private cancelEvent(kw: Record<string, unknown>): CalendarEvent {
    const eventId = pickString(kw, ["event_id", "eventId", "id"], "");
    const existing = this.stores.calendar_event[eventId];
    if (!existing) throw new Error(`unknown event_id: ${eventId}`);
    const updated: CalendarEvent = { ...existing, status: "cancelled" };
    this.stores.calendar_event[eventId] = updated;
    return updated;
  }

  private listEvents(kw: Record<string, unknown>): CalendarEvent[] {
    const calendarId = pickStringOrNull(kw, ["calendar_id", "calendarId"]);
    const start = pickStringOrNull(kw, ["start", "start_iso", "from"]);
    const end = pickStringOrNull(kw, ["end", "end_iso", "to"]);
    const events = Object.values(this.stores.calendar_event);
    return events.filter((event) => {
      if (calendarId && event.calendar_id !== calendarId) return false;
      if (start && event.end < start) return false;
      if (end && event.start > end) return false;
      return true;
    });
  }

  // ----- mail handlers --------------------------------------------------

  private searchEmails(kw: Record<string, unknown>): EmailMessage[] {
    const query = pickString(kw, ["query", "q"], "").toLowerCase();
    const folder = pickStringOrNull(kw, ["folder", "in"]);
    const isUnread = /\bis:unread\b/.test(query);
    const fromMatch = query.match(/from:([^\s]+)/);
    const subjectMatch = query.match(/subject:([^\s]+)/);
    const fromFilter = fromMatch ? fromMatch[1].toLowerCase() : null;
    const subjectFilter = subjectMatch ? subjectMatch[1].toLowerCase() : null;
    const freeText = query
      .replace(/\b(is|from|subject|in|newer_than):[^\s]+/g, "")
      .trim();

    return Object.values(this.stores.email).filter((email) => {
      if (folder && email.folder !== folder) return false;
      if (isUnread && email.is_read) return false;
      if (fromFilter && !email.from_email.toLowerCase().includes(fromFilter)) {
        return false;
      }
      if (
        subjectFilter &&
        !email.subject.toLowerCase().includes(subjectFilter)
      ) {
        return false;
      }
      if (freeText) {
        const haystack =
          `${email.subject} ${email.body_plain} ${email.from_email}`.toLowerCase();
        if (!haystack.includes(freeText)) return false;
      }
      return true;
    });
  }

  private createDraft(kw: Record<string, unknown>): EmailMessage {
    const id = pickString(
      kw,
      ["message_id", "id"],
      `draft_${nextSeq(this.stores.email, "draft_")}`,
    );
    const threadId = pickString(kw, ["thread_id", "threadId"], `thread_${id}`);
    const draft: EmailMessage = {
      id,
      thread_id: threadId,
      folder: "drafts",
      from_email: pickString(kw, ["from", "from_email"], "owner@example.test"),
      to_emails: pickStringArray(kw, ["to", "to_emails"]),
      cc_emails: pickStringArray(kw, ["cc", "cc_emails"]),
      subject: pickString(kw, ["subject"], ""),
      body_plain: pickString(kw, ["body", "body_plain"], ""),
      sent_at: this.nowIso,
      received_at: null,
      is_read: true,
      is_starred: false,
      labels: pickStringArray(kw, ["labels"]),
      attachments: pickStringArray(kw, ["attachments"]),
    };
    this.stores.email[id] = draft;
    return draft;
  }

  private sendEmail(kw: Record<string, unknown>): EmailMessage {
    const draftId = pickStringOrNull(kw, ["draft_id", "message_id", "id"]);
    if (draftId && this.stores.email[draftId]) {
      const updated: EmailMessage = {
        ...this.stores.email[draftId],
        folder: "sent",
        sent_at: this.nowIso,
      };
      this.stores.email[draftId] = updated;
      return updated;
    }
    // No draft to send — create a new sent message.
    const id = pickString(
      kw,
      ["message_id", "id"],
      `sent_${nextSeq(this.stores.email, "sent_")}`,
    );
    const threadId = pickString(kw, ["thread_id", "threadId"], `thread_${id}`);
    const msg: EmailMessage = {
      id,
      thread_id: threadId,
      folder: "sent",
      from_email: pickString(kw, ["from", "from_email"], "owner@example.test"),
      to_emails: pickStringArray(kw, ["to", "to_emails"]),
      cc_emails: pickStringArray(kw, ["cc", "cc_emails"]),
      subject: pickString(kw, ["subject"], ""),
      body_plain: pickString(kw, ["body", "body_plain"], ""),
      sent_at: this.nowIso,
      received_at: null,
      is_read: true,
      is_starred: false,
      labels: pickStringArray(kw, ["labels"]),
      attachments: pickStringArray(kw, ["attachments"]),
    };
    this.stores.email[id] = msg;
    return msg;
  }

  private archiveEmail(kw: Record<string, unknown>): EmailMessage {
    const id = pickString(kw, ["message_id", "id"], "");
    const existing = this.stores.email[id];
    if (!existing) throw new Error(`unknown message_id: ${id}`);
    const updated: EmailMessage = { ...existing, folder: "archive" };
    this.stores.email[id] = updated;
    return updated;
  }

  private markRead(kw: Record<string, unknown>): EmailMessage {
    const id = pickString(kw, ["message_id", "id"], "");
    const existing = this.stores.email[id];
    if (!existing) throw new Error(`unknown message_id: ${id}`);
    const updated: EmailMessage = { ...existing, is_read: true };
    this.stores.email[id] = updated;
    return updated;
  }

  // ----- reminder handlers ---------------------------------------------

  private createReminder(kw: Record<string, unknown>): Reminder {
    const listId = pickString(
      kw,
      ["list_id", "listId"],
      Object.keys(this.stores.reminder_list)[0] ?? "list_default",
    );
    if (!this.stores.reminder_list[listId]) {
      this.stores.reminder_list[listId] = {
        id: listId,
        name: listId,
        source: "apple-reminders",
      };
    }
    const id = pickString(
      kw,
      ["reminder_id", "id"],
      `rem_${nextSeq(this.stores.reminder, "rem_")}`,
    );
    const reminder: Reminder = {
      id,
      list_id: listId,
      title: pickString(kw, ["title"], ""),
      notes: pickString(kw, ["notes"], ""),
      due_at: pickStringOrNull(kw, ["due_at", "dueAt", "due"]),
      completed_at: null,
      priority: pickString(kw, ["priority"], "none") as ReminderPriority,
      tags: pickStringArray(kw, ["tags"]),
    };
    this.stores.reminder[id] = reminder;
    return reminder;
  }

  private completeReminder(kw: Record<string, unknown>): Reminder {
    const id = pickString(kw, ["reminder_id", "id"], "");
    const existing = this.stores.reminder[id];
    if (!existing) throw new Error(`unknown reminder_id: ${id}`);
    const updated: Reminder = { ...existing, completed_at: this.nowIso };
    this.stores.reminder[id] = updated;
    return updated;
  }

  private listReminders(kw: Record<string, unknown>): Reminder[] {
    const listId = pickStringOrNull(kw, ["list_id", "listId"]);
    const includeCompleted = pickBool(
      kw,
      ["include_completed", "includeCompleted"],
      false,
    );
    return Object.values(this.stores.reminder).filter((reminder) => {
      if (listId && reminder.list_id !== listId) return false;
      if (!includeCompleted && reminder.completed_at !== null) return false;
      return true;
    });
  }

  // ----- chat handlers --------------------------------------------------

  private sendMessage(kw: Record<string, unknown>): ChatMessage {
    const conversationId = pickString(
      kw,
      ["conversation_id", "conversationId"],
      "",
    );
    const conv = this.stores.conversation[conversationId];
    if (!conv) throw new Error(`unknown conversation_id: ${conversationId}`);
    const id = pickString(
      kw,
      ["message_id", "id"],
      `msg_${nextSeq(this.stores.chat_message, "msg_")}`,
    );
    const msg: ChatMessage = {
      id,
      channel: conv.channel,
      conversation_id: conversationId,
      from_handle: pickString(kw, ["from_handle", "from"], "owner"),
      to_handles: pickStringArray(kw, ["to_handles", "to"]),
      text: pickString(kw, ["text", "body"], ""),
      sent_at: this.nowIso,
      is_read: true,
      is_outgoing: true,
      attachments: pickStringArray(kw, ["attachments"]),
    };
    this.stores.chat_message[id] = msg;
    this.stores.conversation[conversationId] = {
      ...conv,
      last_activity_at: this.nowIso,
    };
    return msg;
  }

  // ----- note handlers --------------------------------------------------

  private createNote(kw: Record<string, unknown>): Note {
    const id = pickString(
      kw,
      ["note_id", "id"],
      `note_${nextSeq(this.stores.note, "note_")}`,
    );
    const note: Note = {
      id,
      title: pickString(kw, ["title"], ""),
      body_markdown: pickString(kw, ["body", "body_markdown", "content"], ""),
      tags: pickStringArray(kw, ["tags"]),
      created_at: this.nowIso,
      updated_at: this.nowIso,
      source: pickString(kw, ["source"], "apple-notes"),
    };
    this.stores.note[id] = note;
    return note;
  }

  // ----- contact handlers ----------------------------------------------

  private searchContacts(kw: Record<string, unknown>): Contact[] {
    const q = pickString(kw, ["query", "q", "name"], "").toLowerCase();
    if (!q) return Object.values(this.stores.contact);
    return Object.values(this.stores.contact).filter((contact) => {
      const haystack =
        `${contact.display_name} ${contact.given_name} ${contact.family_name} ${contact.primary_email}`.toLowerCase();
      return haystack.includes(q);
    });
  }
}

// --------------------------------------------------------------------------
// Helpers — coerce loosely-typed kwargs from JSON request bodies.
// --------------------------------------------------------------------------

function pickString(
  kw: Record<string, unknown>,
  keys: string[],
  fallback: string,
): string {
  for (const k of keys) {
    const v = kw[k];
    if (typeof v === "string") return v;
  }
  return fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function pickStringOrNull(
  kw: Record<string, unknown>,
  keys: string[],
): string | null {
  for (const k of keys) {
    const v = kw[k];
    if (typeof v === "string") return v;
    if (v === null) return null;
  }
  return null;
}

function pickBool(
  kw: Record<string, unknown>,
  keys: string[],
  fallback: boolean,
): boolean {
  for (const k of keys) {
    const v = kw[k];
    if (typeof v === "boolean") return v;
  }
  return fallback;
}

function pickStringArray(
  kw: Record<string, unknown>,
  keys: string[],
): string[] {
  for (const k of keys) {
    const v = kw[k];
    if (Array.isArray(v)) {
      return v.filter((x): x is string => typeof x === "string");
    }
  }
  return [];
}

function durationMinutes(
  kw: Record<string, unknown>,
  fallback: number,
): number {
  for (const key of ["duration_minutes", "durationMinutes", "duration"]) {
    const value = kw[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return Math.max(1, Math.round(value));
    }
    if (typeof value === "string") {
      const match = value
        .trim()
        .match(/^(\d+)\s*(m|min|minute|minutes|h|hr|hour|hours)?$/i);
      if (match) {
        const amount = Number(match[1]);
        const unit = match[2]?.toLowerCase() ?? "minutes";
        return Math.max(1, unit.startsWith("h") ? amount * 60 : amount);
      }
    }
  }
  const hours = kw.duration_hours ?? kw.durationHours;
  if (typeof hours === "number" && Number.isFinite(hours)) {
    return Math.max(1, Math.round(hours * 60));
  }
  return fallback;
}

function durationBetweenMinutes(start: string, end: string): number {
  const startDate = parseIso(start);
  const endDate = parseIso(end);
  if (!startDate || !endDate) return 60;
  return Math.max(
    1,
    Math.round((endDate.getTime() - startDate.getTime()) / 60_000),
  );
}

function shiftIso(start: string, minutes: number): string {
  const date = parseIso(start);
  if (!date) return start;
  return new Date(date.getTime() + minutes * 60_000)
    .toISOString()
    .replace(".000Z", "Z");
}

function parseIso(value: string): Date | null {
  const raw = value.trim();
  if (!raw) return null;
  const date = new Date(raw);
  return Number.isFinite(date.getTime()) ? date : null;
}

function timestampDistance(value: string, hint: Date | null): number {
  if (!hint) return Number.POSITIVE_INFINITY;
  const date = parseIso(value);
  if (!date) return Number.POSITIVE_INFINITY;
  return Math.abs(date.getTime() - hint.getTime());
}

function nextSeq(store: Record<string, unknown>, prefix: string): string {
  let n = Object.keys(store).length;
  while (`${prefix}${pad(n)}` in store) n += 1;
  return pad(n);
}

function pad(n: number): string {
  return String(n).padStart(5, "0");
}
