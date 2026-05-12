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
    // Chat / messages — granular dotted form
    "messages.send",
    "messages.send_draft",
    "messages.draft_reply",
    "messages.manage",
    "messages.triage",
    "messages.search_inbox",
    "messages.list_channels",
    "messages.read_channel",
    "messages.read_with_contact",
    // MESSAGE umbrella (mail + chat dispatch on `operation` / `source`)
    "MESSAGE",
    // CALENDAR umbrella (promoted granular siblings translated below)
    "CALENDAR",
    // ENTITY umbrella (contacts / identity; P1-5)
    "ENTITY",
    // Notes
    "notes.create",
    // Contacts (read-only search + write create)
    "contacts.search",
    "contacts.create",
    // MONEY umbrella (finance / subscriptions; P2-7 + P2-8)
    "MONEY",
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
    // LifeOpsBench exposes Eliza-style umbrella/promoted names to planners
    // (`CALENDAR`, `CALENDAR_CREATE_EVENT`, `MESSAGE_TRIAGE`, ...).
    // Translate them to the fake backend's canonical lower-case dotted
    // surface (`calendar.create_event`, `messages.triage`) before dispatch
    // so tool results are useful on follow-up turns. This is the
    // executor-side analogue of the scorer's `_UMBRELLA_SUBACTIONS`
    // canonicalization (W4-A).
    const translation = umbrellaToLowercase(name, kwargs);
    const dispatchName = translation.name;
    const dispatchKwargs = translation.kwargs;

    switch (dispatchName) {
      // ---- calendar umbrella
      case "CALENDAR":
        return this.applyCalendarUmbrella(dispatchKwargs);

      // ---- calendar (granular dotted form)
      case "calendar.create_event":
        return { ok: true, result: this.createEvent(dispatchKwargs) };
      case "calendar.move_event":
        return { ok: true, result: this.moveEvent(dispatchKwargs) };
      case "calendar.cancel_event":
        return { ok: true, result: this.cancelEvent(dispatchKwargs) };
      case "calendar.list_events":
        return { ok: true, result: this.listEvents(dispatchKwargs) };

      // ---- mail
      case "mail.search":
        return { ok: true, result: this.searchEmails(dispatchKwargs) };
      case "mail.create_draft":
        return { ok: true, result: this.createDraft(dispatchKwargs) };
      case "mail.send":
        return { ok: true, result: this.sendEmail(dispatchKwargs) };
      case "mail.archive":
        return { ok: true, result: this.archiveEmail(dispatchKwargs) };
      case "mail.mark_read":
        return { ok: true, result: this.markRead(dispatchKwargs) };

      // ---- reminders
      case "reminders.create":
        return { ok: true, result: this.createReminder(dispatchKwargs) };
      case "reminders.complete":
        return { ok: true, result: this.completeReminder(dispatchKwargs) };
      case "reminders.list":
        return { ok: true, result: this.listReminders(dispatchKwargs) };

      // ---- messages (granular dotted form, routed through the umbrella
      // dispatcher so kwargs vocabulary stays consistent).
      case "messages.send":
        // Two ABIs collide here: the legacy seeded-conversation `sendMessage`
        // path (kwargs: conversation_id/from_handle/...) and the Python
        // umbrella `_send_chat_via_message` path (kwargs: source/target/
        // targetKind/message). We prefer the umbrella shape when a
        // `source` / `target` / `roomId` is provided, otherwise fall back
        // to the legacy conversation-id shape.
        if (
          isUmbrellaChatShape(dispatchKwargs) ||
          isUmbrellaMailShape(dispatchKwargs)
        ) {
          return this.applyMessageUmbrella({
            ...dispatchKwargs,
            operation: "send",
          });
        }
        return { ok: true, result: this.sendMessage(dispatchKwargs) };
      case "messages.send_draft":
      case "messages.draft_reply":
        return this.applyMessageUmbrella({
          ...dispatchKwargs,
          operation: "draft_reply",
        });
      case "messages.manage":
        return this.applyMessageUmbrella({
          ...dispatchKwargs,
          operation: "manage",
        });
      case "messages.triage":
      case "messages.search_inbox":
      case "messages.list_channels":
      case "messages.read_channel":
      case "messages.read_with_contact":
        return this.applyMessageUmbrella({
          ...dispatchKwargs,
          operation: dispatchName.slice("messages.".length),
        });

      // ---- MESSAGE umbrella (mail + chat). Mirrors Python `_u_message`
      // in eliza_lifeops_bench/runner.py — `operation` field selects the
      // subaction, `source` field disambiguates mail (gmail) vs chat
      // channels (imessage / whatsapp / slack / ...). Drift from the
      // Python kwargs shape is theme T8 in the bench synthesis plan;
      // keep field names identical.
      case "MESSAGE":
        return this.applyMessageUmbrella(dispatchKwargs);

      // ---- notes
      case "notes.create":
        return { ok: true, result: this.createNote(dispatchKwargs) };

      // ---- ENTITY umbrella (contacts / identity)
      // P1-5: ENTITY(subaction=create|add|create_contact) → contacts.create.
      // Other subactions (set_identity, log_interaction, list, read, merge)
      // are read-only no-ops matching the Python runner's behaviour.
      case "ENTITY":
        return this.applyEntityUmbrella(dispatchKwargs);

      // ---- contacts
      case "contacts.search":
        return { ok: true, result: this.searchContacts(dispatchKwargs) };
      case "contacts.create":
        return { ok: true, result: this.createContact(dispatchKwargs) };

      // ---- MONEY umbrella (finance / subscriptions; P2-7 + P2-8)
      case "MONEY":
        return this.applyMoneyUmbrella(dispatchKwargs);

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

  // ----- MESSAGE umbrella ----------------------------------------------
  //
  // Mirrors `_u_message` in eliza_lifeops_bench/runner.py. Operations:
  //   send         — gmail (mail) or chat channel
  //   draft_reply  — gmail draft, chat no-op
  //   manage       — archive/mark_read/trash/star on mail
  //   triage, search_inbox, list_channels, read_channel, read_with_contact
  //                — read-only no-ops (return ok:true, noop:true)
  //
  // Field names match Python kwargs exactly (recipient_id is NOT renamed
  // to `to`, threadId is preferred over thread_id when Python prefers it,
  // etc.). Drift between Python and TS handler shapes is theme T8 in the
  // synthesis plan; do not introduce a new drift here.
  private applyMessageUmbrella(kw: Record<string, unknown>): ActionResult {
    const op = pickString(kw, ["operation"], "");
    if (!op) {
      throw new Error("MESSAGE umbrella requires `operation`");
    }
    const source = pickString(kw, ["source"], "");

    if (op === "send") {
      if (source === "gmail") {
        return { ok: true, result: this.sendEmailViaMessage(kw) };
      }
      return { ok: true, result: this.sendChatViaMessage(kw, source) };
    }
    if (op === "draft_reply") {
      return { ok: true, result: this.draftReplyViaMessage(kw, source) };
    }
    if (op === "manage") {
      return { ok: true, result: this.manageEmailViaMessage(kw) };
    }
    // P0-4: read-side MESSAGE ops. Returning seed slices from LifeWorld
    // instead of `{noop: true}` lets the planner reason about real inbox
    // and conversation state on follow-up turns. State-hash stays
    // unchanged (these are reads, not writes) so scoring still mirrors
    // Python `_u_message`, but the assistant trace is no longer blind.
    if (op === "search_inbox") {
      return { ok: true, result: this.searchInboxViaMessage(kw, source) };
    }
    if (op === "triage") {
      return { ok: true, result: this.triageInboxViaMessage(kw, source) };
    }
    if (op === "list_channels") {
      return { ok: true, result: this.listChannelsViaMessage(source) };
    }
    if (op === "read_channel") {
      return { ok: true, result: this.readChannelViaMessage(kw, source) };
    }
    if (op === "read_with_contact") {
      return { ok: true, result: this.readWithContactViaMessage(kw, source) };
    }
    throw new LifeOpsBackendUnsupportedError(
      `MESSAGE/${op}`,
      "unknown MESSAGE operation",
    );
  }

  // ---- MESSAGE read-side helpers (P0-4) -------------------------------
  //
  // All return-only reads. They never mutate stores; they only project the
  // existing LifeWorld into a shape the planner can take an informed next
  // action on. Result envelopes intentionally echo `operation` + `source`
  // so the assistant can disambiguate which channel/branch produced the
  // payload across multi-turn conversations.

  private searchInboxViaMessage(
    kw: Record<string, unknown>,
    source: string,
  ): {
    operation: "search_inbox";
    source: string;
    query: string;
    matches: EmailMessage[];
  } {
    const query = pickString(kw, ["query", "q"], "");
    // gmail is the only mail source today; non-gmail sources have no inbox
    // store to project, but we still return the envelope so the planner
    // sees an empty-result signal rather than an unsupported-method error.
    const matches =
      source === "gmail" || source === ""
        ? this.searchEmails({ ...kw, query, folder: "inbox" })
        : [];
    return { operation: "search_inbox", source, query, matches };
  }

  private triageInboxViaMessage(
    kw: Record<string, unknown>,
    source: string,
  ): {
    operation: "triage";
    source: string;
    top: Array<{
      id: string;
      subject: string;
      from_email: string;
      received_at: string | null;
      is_read: boolean;
      priority: "high" | "normal";
    }>;
  } {
    const limit = pickNumber(kw, ["limit", "max", "topN"], 5);
    // Triage = rank unread inbox by recency, then mark "high" priority if
    // sender domain matches a marker (boss/work/team/etc.) or subject hits
    // the urgency lexicon. No mutation; this is just a ranked projection.
    const HIGH_PRIORITY = /\b(urgent|asap|important|critical|deadline)\b/i;
    const HIGH_SENDER = /(boss|exec|ceo|director|legal|hr|payroll|security)/i;
    const ranked = Object.values(this.stores.email)
      .filter((email) => email.folder === "inbox")
      .sort((a, b) => (b.received_at ?? "").localeCompare(a.received_at ?? ""))
      .slice(0, Math.max(1, limit))
      .map((email) => ({
        id: email.id,
        subject: email.subject,
        from_email: email.from_email,
        received_at: email.received_at,
        is_read: email.is_read,
        priority:
          HIGH_PRIORITY.test(email.subject) ||
          HIGH_PRIORITY.test(email.body_plain) ||
          HIGH_SENDER.test(email.from_email)
            ? ("high" as const)
            : ("normal" as const),
      }));
    return { operation: "triage", source, top: ranked };
  }

  private listChannelsViaMessage(source: string): {
    operation: "list_channels";
    source: string;
    channels: Array<{
      id: string;
      channel: string;
      title: string | null;
      participants: string[];
      last_activity_at: string;
      is_group: boolean;
    }>;
  } {
    const channels = Object.values(this.stores.conversation)
      .filter((conv) => !source || conv.channel === source)
      .map((conv) => ({
        id: conv.id,
        channel: conv.channel,
        title: conv.title,
        participants: [...conv.participants],
        last_activity_at: conv.last_activity_at,
        is_group: conv.is_group,
      }))
      .sort((a, b) => b.last_activity_at.localeCompare(a.last_activity_at));
    return { operation: "list_channels", source, channels };
  }

  private readChannelViaMessage(
    kw: Record<string, unknown>,
    source: string,
  ): {
    operation: "read_channel";
    source: string;
    channel: string | null;
    messages: ChatMessage[];
  } {
    const channel = pickStringOrNull(kw, [
      "channel",
      "channel_id",
      "channelId",
      "conversation_id",
      "conversationId",
      "roomId",
    ]);
    const limit = pickNumber(kw, ["limit", "max"], 25);
    const messages = Object.values(this.stores.chat_message)
      .filter((msg) => {
        if (channel && msg.conversation_id !== channel) return false;
        if (source && msg.channel !== source) return false;
        return true;
      })
      .sort((a, b) => b.sent_at.localeCompare(a.sent_at))
      .slice(0, Math.max(1, limit));
    return { operation: "read_channel", source, channel, messages };
  }

  private readWithContactViaMessage(
    kw: Record<string, unknown>,
    source: string,
  ): {
    operation: "read_with_contact";
    source: string;
    contact: string | null;
    messages: ChatMessage[];
  } {
    const contact = pickStringOrNull(kw, [
      "contact",
      "target",
      "handle",
      "with",
    ]);
    if (!contact) {
      return {
        operation: "read_with_contact",
        source,
        contact: null,
        messages: [],
      };
    }
    const needle = contact.toLowerCase();
    // Find conversations whose participants include the contact, or whose
    // title matches by display name. Then return that conversation's chat
    // history (capped). The Python runner is a no-op here, but giving the
    // planner real history changes the next-turn write decision.
    const matchingConvIds = new Set<string>();
    for (const conv of Object.values(this.stores.conversation)) {
      if (source && conv.channel !== source) continue;
      const titleMatch = conv.title?.toLowerCase().includes(needle) ?? false;
      const participantMatch = conv.participants.some((p) =>
        p.toLowerCase().includes(needle),
      );
      if (titleMatch || participantMatch) {
        matchingConvIds.add(conv.id);
      }
    }
    const limit = pickNumber(kw, ["limit", "max"], 25);
    const messages = Object.values(this.stores.chat_message)
      .filter((msg) => {
        if (!matchingConvIds.has(msg.conversation_id)) return false;
        if (source && msg.channel !== source) return false;
        return true;
      })
      .sort((a, b) => b.sent_at.localeCompare(a.sent_at))
      .slice(0, Math.max(1, limit));
    return { operation: "read_with_contact", source, contact, messages };
  }

  private sendEmailViaMessage(kw: Record<string, unknown>): EmailMessage {
    const toEmails = pickStringArray(kw, ["to_emails", "to"]);
    if (toEmails.length === 0) {
      throw new Error("MESSAGE/send (gmail) requires to_emails");
    }
    const subject = pickString(kw, ["subject"], "");
    const body = pickString(kw, ["body", "body_plain"], "");
    const fromEmail = pickString(kw, ["from_email"], "me@example.test");
    const threadId =
      pickStringOrNull(kw, ["threadId", "thread_id"]) ??
      syntheticId("thread_auto", { to: [...toEmails].sort(), s: subject });
    const messageId =
      pickStringOrNull(kw, ["messageId", "message_id"]) ??
      syntheticId("email_auto", { th: threadId, b: body, s: subject });
    const msg: EmailMessage = {
      id: messageId,
      thread_id: threadId,
      folder: "sent",
      from_email: fromEmail,
      to_emails: [...toEmails],
      cc_emails: pickStringArray(kw, ["cc_emails", "cc"]),
      subject,
      body_plain: body,
      sent_at: this.nowIso,
      received_at: null,
      is_read: true,
      is_starred: false,
      labels: pickStringArray(kw, ["labels"]),
      attachments: pickStringArray(kw, ["attachments"]),
    };
    this.stores.email[messageId] = msg;
    const existingThread = this.stores.email_thread[threadId];
    if (!existingThread) {
      const participants = Array.from(
        new Set([fromEmail, ...toEmails, ...msg.cc_emails]),
      ).sort();
      this.stores.email_thread[threadId] = {
        id: threadId,
        subject,
        message_ids: [messageId],
        participants,
        last_activity_at: this.nowIso,
      };
    } else {
      this.stores.email_thread[threadId] = {
        ...existingThread,
        message_ids: [...existingThread.message_ids, messageId],
        last_activity_at: this.nowIso,
      };
    }
    return msg;
  }

  private sendChatViaMessage(
    kw: Record<string, unknown>,
    source: string,
  ): ChatMessage {
    const targetKind = pickString(kw, ["targetKind"], "contact");
    const text = pickString(kw, ["message", "text"], "");
    if (!text) {
      throw new Error("MESSAGE/send (chat) requires message/text");
    }
    const channel = source || "imessage";

    if (targetKind === "group") {
      const roomId = pickString(kw, ["roomId"], "");
      if (!roomId) {
        throw new Error("MESSAGE/send (group) requires roomId");
      }
      this.ensureSyntheticConversation({
        conversationId: roomId,
        channel,
        participants: ["+15550000000", "+15551111111"],
        title: roomId,
        isGroup: true,
      });
      const messageId = syntheticId("chat_auto", {
        r: roomId,
        t: text,
        src: channel,
      });
      return this.appendChatMessage({
        messageId,
        conversationId: roomId,
        fromHandle: "+15550000000",
        toHandles: ["+15551111111"],
        text,
      });
    }

    const target = pickString(kw, ["target", "contact"], "");
    if (!target) {
      throw new Error("MESSAGE/send (contact) requires target");
    }
    const convId = syntheticId("conv_auto", { src: channel, to: target });
    this.ensureSyntheticConversation({
      conversationId: convId,
      channel,
      participants: ["+15550000000", target],
      title: target,
      isGroup: false,
    });
    const messageId = syntheticId("chat_auto", { c: convId, t: text });
    return this.appendChatMessage({
      messageId,
      conversationId: convId,
      fromHandle: "+15550000000",
      toHandles: [target],
      text,
    });
  }

  private draftReplyViaMessage(
    kw: Record<string, unknown>,
    source: string,
  ):
    | EmailMessage
    | { operation: string; source: string; ok: true; noop: true } {
    if (source !== "gmail") {
      return { operation: "draft_reply", source, ok: true, noop: true };
    }
    const parentId = pickString(kw, ["messageId"], "");
    if (!parentId) {
      throw new Error("MESSAGE/draft_reply requires messageId");
    }
    const parent = this.stores.email[parentId];
    const threadId =
      parent?.thread_id ?? syntheticId("thread_auto", { p: parentId });
    const body = pickString(kw, ["body"], "");
    const subject = parent
      ? `Re: ${parent.subject}`
      : pickString(kw, ["subject"], "Re:");
    const fromEmail = pickString(kw, ["from_email"], "me@example.test");
    const toEmails = parent?.from_email
      ? [parent.from_email]
      : pickStringArray(kw, ["to_emails"]);
    if (toEmails.length === 0) {
      throw new Error(
        `MESSAGE/draft_reply needs a parent email or to_emails (parent=${parentId})`,
      );
    }
    const draftId = syntheticId("email_draft", { p: parentId, b: body });
    const draft: EmailMessage = {
      id: draftId,
      thread_id: threadId,
      folder: "drafts",
      from_email: fromEmail,
      to_emails: [...toEmails],
      cc_emails: [],
      subject,
      body_plain: body,
      sent_at: this.nowIso,
      received_at: null,
      is_read: true,
      is_starred: false,
      labels: [],
      attachments: [],
    };
    this.stores.email[draftId] = draft;
    return draft;
  }

  private manageEmailViaMessage(kw: Record<string, unknown>): {
    id?: string;
    folder?: EmailFolder;
    is_read?: boolean;
    is_starred?: boolean;
    thread_id?: string;
    archived_ids?: string[];
  } {
    const manageOp = pickString(kw, ["manageOperation"], "");
    if (!manageOp) {
      throw new Error("MESSAGE/manage requires manageOperation");
    }
    const msgId = pickStringOrNull(kw, ["messageId"]);
    const threadId = pickStringOrNull(kw, ["threadId"]);

    if (manageOp === "archive") {
      if (msgId !== null) {
        const archived = this.archiveEmail({ message_id: msgId });
        return { id: archived.id, folder: archived.folder };
      }
      if (threadId !== null) {
        const archivedIds: string[] = [];
        for (const [eid, em] of Object.entries(this.stores.email)) {
          if (em.thread_id === threadId && em.folder !== "archive") {
            this.stores.email[eid] = { ...em, folder: "archive" };
            archivedIds.push(eid);
          }
        }
        return { thread_id: threadId, archived_ids: archivedIds };
      }
      throw new Error("MESSAGE/manage(archive) needs messageId or threadId");
    }
    if (manageOp === "mark_read") {
      if (msgId === null) {
        throw new Error("MESSAGE/manage(mark_read) needs messageId");
      }
      const updated = this.markRead({ message_id: msgId });
      return { id: updated.id, is_read: updated.is_read };
    }
    if (manageOp === "trash") {
      if (msgId === null) {
        throw new Error("MESSAGE/manage(trash) needs messageId");
      }
      const existing = this.stores.email[msgId];
      if (!existing) throw new Error(`unknown message_id: ${msgId}`);
      const updated: EmailMessage = { ...existing, folder: "trash" };
      this.stores.email[msgId] = updated;
      return { id: updated.id, folder: updated.folder };
    }
    if (manageOp === "star") {
      if (msgId === null) {
        throw new Error("MESSAGE/manage(star) needs messageId");
      }
      const existing = this.stores.email[msgId];
      if (!existing) throw new Error(`unknown message_id: ${msgId}`);
      const starred = pickBool(kw, ["starred"], true);
      const updated: EmailMessage = { ...existing, is_starred: starred };
      this.stores.email[msgId] = updated;
      return { id: updated.id, is_starred: updated.is_starred };
    }
    throw new LifeOpsBackendUnsupportedError(
      `MESSAGE/manage/${manageOp}`,
      "unknown manageOperation",
    );
  }

  private ensureSyntheticConversation(args: {
    conversationId: string;
    channel: string;
    participants: string[];
    title: string | null;
    isGroup: boolean;
  }): Conversation {
    const existing = this.stores.conversation[args.conversationId];
    if (existing) return existing;
    const conv: Conversation = {
      id: args.conversationId,
      channel: args.channel,
      participants: [...args.participants],
      title: args.title,
      last_activity_at: this.nowIso,
      is_group: args.isGroup,
    };
    this.stores.conversation[args.conversationId] = conv;
    return conv;
  }

  private appendChatMessage(args: {
    messageId: string;
    conversationId: string;
    fromHandle: string;
    toHandles: string[];
    text: string;
  }): ChatMessage {
    const conv = this.stores.conversation[args.conversationId];
    if (!conv) {
      throw new Error(`unknown conversation_id: ${args.conversationId}`);
    }
    const msg: ChatMessage = {
      id: args.messageId,
      channel: conv.channel,
      conversation_id: args.conversationId,
      from_handle: args.fromHandle,
      to_handles: [...args.toHandles],
      text: args.text,
      sent_at: this.nowIso,
      is_read: true,
      is_outgoing: true,
      attachments: [],
    };
    this.stores.chat_message[args.messageId] = msg;
    this.stores.conversation[args.conversationId] = {
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

  /**
   * ENTITY umbrella dispatcher (P1-5).
   * create/add/create_contact → createContact (write).
   * All other subactions (set_identity, log_interaction, list, read, merge)
   * are read-only no-ops in the bench runner, so we match that behaviour here.
   */
  private applyEntityUmbrella(kw: Record<string, unknown>): ActionResult {
    const subaction = pickString(kw, ["subaction", "action", "operation"], "");
    if (
      subaction === "create" ||
      subaction === "add" ||
      subaction === "create_contact"
    ) {
      return { ok: true, result: this.createContact(kw) };
    }
    // All other ENTITY subactions (set_identity, log_interaction, list/read,
    // merge) are read-only no-ops — no LifeWorld mutation, no state-hash
    // change. Match the Python runner's _u_entity behaviour.
    return { ok: true, result: { subaction, ok: true, noop: true } };
  }

  private createContact(kw: Record<string, unknown>): Contact {
    const display = pickString(
      kw,
      ["name", "display_name", "displayName"],
      "Unknown",
    );
    const parts = display.trim().split(/\s+/);
    const given = parts[0] ?? display;
    const family = parts.slice(1).join(" ");
    const email =
      pickString(kw, ["email", "primary_email", "handle"], "") ||
      "unknown@example.test";
    const id =
      pickString(kw, ["entityId", "entity_id", "id"], "") ||
      `contact_${nextSeq(this.stores.contact, "contact_")}`;
    const contact: Contact = {
      id,
      display_name: display,
      given_name: given,
      family_name: family,
      primary_email: email,
      phones: pickStringArray(kw, ["phones"]),
      company: pickStringOrNull(kw, ["company"]),
      role: pickStringOrNull(kw, ["role"]),
      relationship: pickString(
        kw,
        ["relationship"],
        "acquaintance",
      ) as Contact["relationship"],
      importance: 0,
      tags: pickStringArray(kw, ["tags"]),
      birthday: pickStringOrNull(kw, ["birthday"]),
    };
    this.stores.contact[id] = contact;
    return contact;
  }

  private searchContacts(kw: Record<string, unknown>): Contact[] {
    const q = pickString(kw, ["query", "q", "name"], "").toLowerCase();
    if (!q) return Object.values(this.stores.contact);
    return Object.values(this.stores.contact).filter((contact) => {
      const haystack =
        `${contact.display_name} ${contact.given_name} ${contact.family_name} ${contact.primary_email}`.toLowerCase();
      return haystack.includes(q);
    });
  }

  // ----- MONEY umbrella (P2-7 + P2-8) ------------------------------------

  /**
   * MONEY umbrella dispatcher.
   *
   * list_transactions: apply category / date-range / merchantContains filters
   *   so scenarios that pass these params get a real filtered result instead of
   *   a no-op that masks incorrect agent calls (P2-7).
   *
   * subscription_cancel: remove the subscription from the store so state_hash
   *   changes and the scenario can score cleanly (P2-8).
   *
   * All other MONEY verbs (dashboard, list_sources, spending_summary, etc.) are
   *   read-only no-ops — state hash stays unchanged.
   */
  private applyMoneyUmbrella(kw: Record<string, unknown>): ActionResult {
    const subaction = pickString(
      kw,
      ["subaction", "action", "operation"],
      "dashboard",
    );

    if (subaction === "list_transactions") {
      return { ok: true, result: this.listTransactions(kw) };
    }

    if (subaction === "subscription_cancel" || subaction === "cancel_subscription") {
      return { ok: true, result: this.cancelSubscription(kw) };
    }

    // All other MONEY subactions are read-only; return relevant data where cheap.
    if (subaction === "subscription_audit" || subaction === "subscription_status" || subaction === "list_sources") {
      const subs = Object.values(this.stores.subscription);
      return { ok: true, result: { subaction, subscriptions: subs } };
    }

    // dashboard / spending_summary / recurring_charges — read-only no-ops.
    return { ok: true, result: { subaction, ok: true, noop: true } };
  }

  private listTransactions(kw: Record<string, unknown>): {
    subaction: "list_transactions";
    transactions: FinancialTransaction[];
    count: number;
  } {
    const category = pickString(kw, ["category"], "").toLowerCase();
    const startDate = pickStringOrNull(kw, ["start_date", "startDate"]);
    const endDate = pickStringOrNull(kw, ["end_date", "endDate"]);
    const merchantContains = pickString(
      kw,
      ["merchantContains", "merchant"],
      "",
    ).toLowerCase();
    const onlyDebits = pickBool(kw, ["onlyDebits", "only_debits"], false);

    // Resolve windowDays into a startDate when no explicit startDate is given.
    const windowDays = pickNumber(kw, ["windowDays", "window_days"], 0);
    let effectiveStart = startDate;
    if (windowDays > 0 && effectiveStart === null) {
      const now = parseIso(this.nowIso);
      if (now) {
        const start = new Date(now.getTime() - windowDays * 86_400_000);
        effectiveStart = start.toISOString();
      }
    }

    const txns = Object.values(this.stores.transaction).filter((txn) => {
      if (category && txn.category.toLowerCase() !== category) return false;
      if (merchantContains && !txn.merchant.toLowerCase().includes(merchantContains)) return false;
      if (onlyDebits && txn.amount_cents >= 0) return false;
      if (effectiveStart && txn.posted_at < effectiveStart) return false;
      if (endDate && txn.posted_at > endDate) return false;
      return true;
    });

    txns.sort((a, b) => b.posted_at.localeCompare(a.posted_at));

    return { subaction: "list_transactions", transactions: txns, count: txns.length };
  }

  private cancelSubscription(kw: Record<string, unknown>): {
    ok: boolean;
    cancelled?: string;
    remaining?: number;
    reason?: string;
  } {
    if (!pickBool(kw, ["confirmed"], false)) {
      return { ok: true, reason: "unconfirmed" };
    }

    const serviceSlug = pickString(kw, ["serviceSlug", "service_slug"], "").toLowerCase();
    const serviceName = pickString(kw, ["serviceName", "service_name", "name"], "").toLowerCase();
    const subscriptionId = pickStringOrNull(kw, ["subscription_id", "subscriptionId", "id"]);

    // Find by id first, then slug, then exact name, then fuzzy name.
    let targetId: string | null = null;

    if (subscriptionId && this.stores.subscription[subscriptionId]) {
      targetId = subscriptionId;
    }

    if (targetId === null) {
      for (const [sid, sub] of Object.entries(this.stores.subscription)) {
        const subName = sub.name.toLowerCase();
        const subSlug = subName.replace(/\s+/g, "-").replace(/\+/g, "-plus");
        if (serviceSlug && subSlug === serviceSlug) { targetId = sid; break; }
        if (serviceName && subName === serviceName) { targetId = sid; break; }
      }
    }

    if (targetId === null) {
      // Fuzzy match on name as a last resort.
      for (const [sid, sub] of Object.entries(this.stores.subscription)) {
        const subName = sub.name.toLowerCase();
        if (serviceName && (subName.includes(serviceName) || serviceName.includes(subName))) {
          targetId = sid;
          break;
        }
      }
    }

    if (targetId === null) {
      return { ok: false, reason: `no subscription matched name='${serviceName}' slug='${serviceSlug}'` };
    }

    const sub = this.stores.subscription[targetId];
    const cancelled: Subscription = { ...sub, status: "cancelled" };
    this.stores.subscription[targetId] = cancelled;

    const remaining = Object.values(this.stores.subscription).filter(
      (s) => s.status === "active",
    ).length;

    return { ok: true, cancelled: cancelled.name, remaining };
  }
}

// --------------------------------------------------------------------------
// Umbrella translation (executor-side analogue of the scorer's
// `_UMBRELLA_SUBACTIONS` canonicalization — see W4-A scorer fixes).
//
// The committed P0-4/P0-5 dispatch refs `umbrellaToLowercase` /
// `isUmbrellaChatShape` / `isUmbrellaMailShape` but never defined them.
// This block closes that gap so the executor actually translates
// `CALENDAR_CREATE_EVENT` / `MESSAGE_TRIAGE` into the bare umbrella
// dispatch surface before the switch fires. Kept module-local because
// `lifeops-bench-handler.ts` already exposes the HTTP-boundary variant
// `translateUmbrellaAction`; layering two narrow helpers is simpler than
// a god-helper.
// --------------------------------------------------------------------------

const UMBRELLA_DISCRIMINATOR_KEYS: Record<string, string> = {
  CALENDAR: "subaction",
  MESSAGE: "operation",
  ENTITY: "subaction",
};

function umbrellaToLowercase(
  name: string,
  kwargs: Record<string, unknown>,
): { name: string; kwargs: Record<string, unknown> } {
  // Bare umbrella: dispatch handles subaction routing directly.
  if (UMBRELLA_DISCRIMINATOR_KEYS[name] !== undefined) {
    return { name, kwargs };
  }
  // Lower-case dotted form already matches the switch's case labels.
  if (name.includes(".") && name === name.toLowerCase()) {
    return { name, kwargs };
  }
  // Promoted granular `<UMBRELLA>_<SUB>` → bare umbrella + injected
  // discriminator. Split on the first underscore so `CALENDAR_CREATE_EVENT`
  // → `CALENDAR` + `create_event`.
  const splitIdx = name.indexOf("_");
  if (splitIdx > 0) {
    const head = name.slice(0, splitIdx);
    const discriminatorKey = UMBRELLA_DISCRIMINATOR_KEYS[head];
    if (discriminatorKey !== undefined) {
      const tail = name.slice(splitIdx + 1).toLowerCase();
      const merged: Record<string, unknown> = { ...kwargs };
      // Preserve an explicit discriminator the planner already set; only
      // inject when the field is missing or empty so we never silently
      // override caller intent (AGENTS.md commandment #8).
      const current = merged[discriminatorKey];
      if (current === undefined || current === null || current === "") {
        merged[discriminatorKey] = tail;
      }
      return { name: head, kwargs: merged };
    }
  }
  // Unknown head — leave unchanged so the switch's default branch raises
  // `LifeOpsBackendUnsupportedError` with a clear, actionable hint.
  return { name, kwargs };
}

function isUmbrellaChatShape(kw: Record<string, unknown>): boolean {
  return (
    typeof kw.target === "string" ||
    typeof kw.targetKind === "string" ||
    typeof kw.roomId === "string" ||
    (typeof kw.source === "string" && kw.source !== "" && kw.source !== "gmail")
  );
}

function isUmbrellaMailShape(kw: Record<string, unknown>): boolean {
  return kw.source === "gmail" || Array.isArray(kw.to_emails);
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

function pickNumber(
  kw: Record<string, unknown>,
  keys: string[],
  fallback: number,
): number {
  for (const k of keys) {
    const v = kw[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string") {
      const n = Number(v);
      if (Number.isFinite(n)) return n;
    }
  }
  return fallback;
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

/**
 * Stable deterministic id derived from a payload. Mirrors `_synthetic_id`
 * in eliza_lifeops_bench/runner.py: canonical-JSON, sha256, first 12 hex
 * chars. Two replays of the same MESSAGE action produce the same id, which
 * is what makes state-hash matching possible for the eliza adapter.
 */
function syntheticId(prefix: string, payload: Record<string, unknown>): string {
  const canonical = canonicalJson(payload);
  const digest = createHash("sha256")
    .update(canonical)
    .digest("hex")
    .slice(0, 12);
  return `${prefix}_${digest}`;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJson(v)).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts = keys.map(
    (k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`,
  );
  return `{${parts.join(",")}}`;
}

function nextSeq(store: Record<string, unknown>, prefix: string): string {
  let n = Object.keys(store).length;
  while (`${prefix}${pad(n)}` in store) n += 1;
  return pad(n);
}

function pad(n: number): string {
  return String(n).padStart(5, "0");
}
