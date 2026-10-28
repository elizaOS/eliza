/**
 * Daily overview domain: the agenda, attention and brief cards a Home surface
 * shows from actual sources.
 *
 * Pure and dependency-free so every host (the Eliza app, branded mobile
 * builds, background workers) shares one presentation of the same states:
 * loading, ready, empty, stale, error, access off and not connected. Nothing
 * here reads a provider, starts a sync or runs a digest. Callers pass the last
 * completed reads and `now`; every time shown is when this app read the data
 * on this device, never a provider sync time.
 *
 * Brand-specific wording for the device ("this device", "this browser") and
 * locale formatting are inputs. A host binds its own clock format with
 * {@link createOverviewFormat} or by passing an {@link OverviewFormat}.
 */

/** Locale formatting used by every presenter. */
/**
 * Shorten display text to at most `max` characters, marking any cut with an
 * ellipsis so a shortened brief, label or message never reads as complete.
 */
export function overviewClip(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

export interface OverviewFormat {
  /** Time of day, for example "3:04 PM" or "15:04". */
  time(date: Date): string;
  /** Short date with weekday, for example "Wed, Oct 8". */
  shortDate(date: Date): string;
}

/** Intl formatting for a locale, with narrow no-break spaces normalized. */
export function createOverviewFormat(
  options: { locale?: string; hourCycle?: "h12" | "h23" } = {},
): OverviewFormat {
  const clean = (text: string) => text.replace(/[  ]/g, " ");
  const time = new Intl.DateTimeFormat(options.locale, {
    hour: "numeric",
    minute: "2-digit",
    ...(options.hourCycle ? { hourCycle: options.hourCycle } : {}),
  });
  const shortDate = new Intl.DateTimeFormat(options.locale, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
  return {
    time: (date) => clean(time.format(date)),
    shortDate: (date) => clean(shortDate.format(date)),
  };
}

let defaultFormat: OverviewFormat | null = null;
function resolveFormat(format: OverviewFormat | undefined): OverviewFormat {
  if (format) return format;
  defaultFormat ??= createOverviewFormat();
  return defaultFormat;
}

/** Epoch milliseconds of a positive numeric or parseable time, otherwise null. */
export function overviewInstant(value: unknown): number | null {
  const at =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Date.parse(value)
        : Number.NaN;
  return Number.isFinite(at) && at > 0 ? at : null;
}

/** "3:04 PM" today, otherwise "Wed, Oct 8 3:04 PM". */
export function overviewWhenLabel(
  at: number,
  now: number,
  format?: OverviewFormat,
): string {
  const f = resolveFormat(format);
  const date = new Date(at);
  return date.toDateString() === new Date(now).toDateString()
    ? f.time(date)
    : `${f.shortDate(date)} ${f.time(date)}`;
}

/**
 * A completed read is stale once the local day it was made on has ended: the
 * overview for today has not been read today. Null and future reads are not
 * stale (there is nothing to age, or the clock moved back).
 */
export function overviewReadIsStale(
  readAt: number | null | undefined,
  now: number,
): boolean {
  const at = overviewInstant(readAt);
  if (!at || at > now) return false;
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  return at < today.getTime();
}

const plural = (n: number, one: string, many: string) =>
  `${n} ${n === 1 ? one : many}`;

// ---------------------------------------------------------------------------
// Attention (mail)
// ---------------------------------------------------------------------------

/** What needs attention, as reported by the mail provider adapter. */
export interface OverviewAttentionSummary {
  state: "not-connected" | "loading" | "ready" | "stale" | "error";
  /** Unread messages; required when ready, last known value when stale. */
  unread?: number;
  /** Provider or account label, for example "Gmail" or "work@example.com". */
  source?: string;
  /** Epoch milliseconds or ISO time of the last successful read. */
  updatedAt?: number | string | null;
  /** Provider-supplied failure text for the error state. */
  message?: string;
}

export interface OverviewAttentionCard {
  /** `inbox` opens the mailbox; `connections` offers setup instead. */
  action: "inbox" | "connections";
  count: string;
  text: string;
  label: string;
}

export function presentOverviewAttention(
  summary: OverviewAttentionSummary | null | undefined,
  now: number,
  format?: OverviewFormat,
): OverviewAttentionCard {
  const when = (at: number) => overviewWhenLabel(at, now, format);
  const updated = overviewInstant(summary?.updatedAt);
  const source =
    typeof summary?.source === "string" && summary.source.trim()
      ? overviewClip(summary.source.trim(), 60)
      : "Inbox";
  const unread =
    Number.isSafeInteger(summary?.unread) && Number(summary?.unread) >= 0
      ? Number(summary?.unread)
      : null;
  switch (summary?.state) {
    case "ready":
      if (unread === null) break;
      return {
        action: "inbox",
        count: String(unread),
        text: `${unread ? "unread" : "Nothing unread"} · ${source}${updated ? ` · ${when(updated)}` : ""}`,
        // Stable accessible name; source and read time are in the visible text.
        label: `Open Inbox: ${plural(unread, "unread email", "unread emails")}`,
      };
    case "stale": {
      // With no completed read there is no last count to report.
      const last = updated ? unread : null;
      return {
        action: "inbox",
        count: last === null ? "—" : String(last),
        text: updated
          ? `Not updated since ${when(updated)}`
          : "Not updated recently",
        label: `Open Inbox: ${source} has not updated${updated ? ` since ${when(updated)}` : ""}${last === null ? "" : `; ${plural(last, "unread email", "unread emails")} when last read`}`,
      };
    }
    case "error": {
      const message =
        typeof summary.message === "string" && summary.message.trim()
          ? overviewClip(summary.message.trim(), 120)
          : `${source} could not be checked`;
      return {
        action: "inbox",
        count: "!",
        text: message,
        label: `Open Inbox to retry: ${message}`,
      };
    }
    case "loading":
      return {
        action: "inbox",
        count: "…",
        text: `Checking ${source}…`,
        label: `Open Inbox: checking ${source}`,
      };
  }
  return {
    action: "connections",
    count: "—",
    text: "Set up Gmail",
    label: "Set up Gmail in Connections to see what needs your attention",
  };
}

/**
 * Status line of a Home mail card. It describes only metadata the user
 * already loaded in the mailbox: which account, whether the loaded page was
 * complete, and when it was read.
 */
export function presentOverviewInboxStatus(
  input: {
    failure: boolean;
    pending: boolean;
    cached: { more: boolean; label: string; readAt: number | null } | null;
    connected: boolean;
    unchecked: boolean;
    now: number;
  },
  format?: OverviewFormat,
): string {
  const { failure, pending, cached, now } = input;
  const read =
    cached?.readAt && Number.isFinite(cached.readAt) && cached.readAt > 0
      ? overviewWhenLabel(cached.readAt, now, format)
      : "";
  if (failure) return `Open to retry${read ? ` · last updated ${read}` : ""}`;
  if (pending) return "Updating email…";
  if (cached)
    return [
      cached.more ? "Recent email" : cached.label,
      read ? `Updated ${read}` : "",
    ]
      .filter(Boolean)
      .join(" · ");
  return input.connected
    ? "Open to load email"
    : input.unchecked
      ? "Open to check email"
      : "";
}

/** States of a Home mail card; `idle` is connected with nothing loaded yet. */
export type OverviewInboxCardState =
  | "not-connected"
  | "idle"
  | "loading"
  | "ready"
  | "stale"
  | "error";

export interface OverviewInboxCardInput {
  now: number;
  /**
   * Metadata of the page the user last loaded in the mailbox for the current
   * account, or null. Only subjects and senders of unread messages; never a
   * body.
   */
  loaded: {
    unread: readonly { subject?: unknown; from?: unknown }[];
    /** The loaded pages did not see every message. */
    more: boolean;
    /** Account label. */
    label: string;
    /** When the first page of that read completed, epoch milliseconds. */
    readAt: number | null;
  } | null;
  /** The last read failed; `revoked` when its grant was revoked. */
  failure: "revoked" | "error" | null;
  /** A read is in flight or scheduled. */
  pending: boolean;
  /** An account can be read. */
  connected: boolean;
  /** No account: settled, not just unknown during startup. */
  disconnected: boolean;
  /** Accounts were not checked yet. */
  unchecked: boolean;
  /**
   * The provider adapter's summary when a page read earlier was dropped since
   * (for example an account change elsewhere); used only without a loaded page.
   */
  stale?: OverviewAttentionSummary | null;
}

/** Everything a Home mail card renders (see `OverviewAttentionCard`). */
export interface OverviewInboxCardModel {
  state: OverviewInboxCardState;
  /** "2 unread", "3+ unread", or empty. */
  count: string;
  /** At most two unread messages of the loaded page. */
  rows: { title: string; detail: string }[];
  /** Headline when no rows are shown. */
  title: string;
  /** Account and read time, loading, retry or staleness. */
  status: string;
  label: string;
  description: string;
}

/**
 * The Home mail card from the page the user loaded in the mailbox. It shows
 * only metadata the user already loaded there: the unread count, up to two
 * subjects and senders, the account and when it was read. Home never reads
 * mail to refresh it.
 */
export function presentOverviewInboxCard(
  input: OverviewInboxCardInput,
  format?: OverviewFormat,
): OverviewInboxCardModel {
  const { loaded, failure, pending, now } = input;
  const stale =
    !loaded &&
    !failure &&
    !pending &&
    input.stale?.state === "stale" &&
    overviewInstant(input.stale.updatedAt)
      ? presentOverviewAttention(input.stale, now, format)
      : null;
  if (stale)
    return {
      state: "stale",
      count: "",
      rows: [],
      title: "Inbox",
      status: stale.text,
      label: stale.label,
      description: stale.text,
    };
  const status = presentOverviewInboxStatus(
    {
      failure: !!failure,
      pending,
      cached: loaded
        ? { more: loaded.more, label: loaded.label, readAt: loaded.readAt }
        : null,
      connected: input.connected,
      unchecked: input.unchecked,
      now,
    },
    format,
  );
  const unread = loaded?.unread ?? [];
  const count = unread.length
    ? `${unread.length}${loaded?.more ? "+" : ""} unread`
    : "";
  const text = (value: unknown) => (typeof value === "string" ? value : "");
  return {
    state: failure
      ? "error"
      : pending
        ? "loading"
        : loaded
          ? "ready"
          : input.disconnected
            ? "not-connected"
            : "idle",
    count,
    rows: unread.slice(0, 2).map((message) => ({
      title: text(message.subject) || "(no subject)",
      detail: text(message.from),
    })),
    title: unread.length
      ? ""
      : failure === "revoked"
        ? "Reconnect email"
        : failure
          ? "Email unavailable"
          : pending
            ? "Loading email…"
            : loaded && !loaded.more
              ? "No unread email"
              : input.disconnected
                ? "Connect email"
                : "Inbox",
    status,
    label: count
      ? `Open Inbox: ${count} email${unread.length === 1 ? "" : "s"}`
      : input.disconnected
        ? "Connect email"
        : "Open Inbox",
    description: status,
  };
}

// ---------------------------------------------------------------------------
// Brief (latest retained digest)
// ---------------------------------------------------------------------------

/** Latest retained scheduled brief for the current account and agent. */
export interface OverviewBriefSummary {
  summary: string;
  ranAt: string | number;
  agent: string;
  status: string;
}

/**
 * How a retained digest result ended. The agent also records occurrences it
 * skipped (a missed time, an overlapping run, an expired or revoked source);
 * those are records, not runs.
 */
export function overviewBriefOutcome(
  status: unknown,
): "ran" | "failed" | "not-run" {
  const text = typeof status === "string" ? status : "";
  return /fail|error|cancel/i.test(text)
    ? "failed"
    : /^(missed|overlap|unavailable)$/i.test(text.trim())
      ? "not-run"
      : "ran";
}
const BRIEF_VERB = {
  ran: "Ran",
  failed: "Failed",
  "not-run": "Did not run",
} as const;

export interface OverviewBrief {
  title: string;
  time: string;
  source: string;
  label: string;
  has: boolean;
}

export function presentOverviewBrief(
  brief: OverviewBriefSummary | null | undefined,
  now: number,
  format?: OverviewFormat,
): OverviewBrief {
  const summary =
    typeof brief?.summary === "string"
      ? brief.summary.replace(/\s+/g, " ").trim()
      : "";
  const ran = overviewInstant(brief?.ranAt);
  if (!brief || !summary || !ran)
    return {
      title: "No brief yet",
      time: "Workflows",
      source: "",
      label: "Open workflows",
      has: false,
    };
  const agent =
    typeof brief.agent === "string" && brief.agent.trim()
      ? overviewClip(brief.agent.trim(), 40)
      : "Your agent";
  const verb = BRIEF_VERB[overviewBriefOutcome(brief.status)];
  const when = overviewWhenLabel(ran, now, format);
  const title = overviewClip(summary, 56);
  return {
    title,
    time: `${verb} ${when}`,
    source: agent,
    has: true,
    label: `Open workflows. Latest brief from ${agent}, ${verb.toLowerCase()} ${when}: ${overviewClip(summary, 280)}`,
  };
}

export type OverviewBriefCard =
  | { has: false; title: ""; status: ""; failed: false; label: "" }
  | {
      has: true;
      title: string;
      status: string;
      failed: boolean;
      label: string;
    };

/**
 * The Home brief card: the newest result retained for the current
 * connection. It is shown only when one exists and never stands for a fresh
 * run. A failed run says so; a record of a skipped occurrence says it did not
 * run.
 */
export function presentOverviewBriefCard(
  brief: OverviewBriefSummary | null | undefined,
  now: number,
  format?: OverviewFormat,
): OverviewBriefCard {
  const base = presentOverviewBrief(brief, now, format);
  if (!base.has || !brief)
    return { has: false, title: "", status: "", failed: false, label: "" };
  const summary = String(brief.summary).replace(/\s+/g, " ").trim();
  const outcome = overviewBriefOutcome(brief.status);
  const when = overviewWhenLabel(
    Number(overviewInstant(brief.ranAt)),
    now,
    format,
  );
  return {
    has: true,
    title: overviewClip(summary, 96),
    failed: outcome === "failed",
    status: `${base.source} · ${base.time}`,
    label: `Open scheduled digests. Latest brief from ${base.source}, ${BRIEF_VERB[outcome].toLowerCase()} ${when}: ${overviewClip(summary, 280)}`,
  };
}

// ---------------------------------------------------------------------------
// Agenda (calendar events and reminders)
// ---------------------------------------------------------------------------

/** Calendar adapter status strings mapped to card states. */
export type OverviewCalendarState =
  | "ready"
  | "loading"
  | "denied"
  | "error"
  | "unavailable"
  | "not-connected";

export function overviewCalendarState(status: unknown): OverviewCalendarState {
  const text = typeof status === "string" ? status : "";
  if (/denied/i.test(text)) return "denied";
  if (/could not be loaded|failed|unavailable\b/i.test(text)) return "error";
  if (/^Loading/i.test(text)) return "loading";
  // Whole words only, and a negated status ("Disconnected", "not connected",
  // "not yet connected", "isn't connected", "no longer connected") is never ready.
  if (
    /\b(connected|limited)\b/i.test(text) &&
    !/\b(?:not|never|isn['’]t|aren['’]t|wasn['’]t|no longer)\s+(?:yet\s+|been\s+)?connected\b/i.test(
      text,
    )
  )
    return "ready";
  if (/available in the Android app/i.test(text)) return "unavailable";
  return "not-connected";
}

/**
 * Title of the agenda card when it shows no item. `hidden`: the app calendar
 * is hidden in Calendar's display settings. A refused or unconnected device
 * calendar says so; a failed read and a calendar this build cannot reach are
 * both "unavailable".
 */
export function overviewAgendaEmptyTitle(
  source:
    | {
        loading?: boolean;
        ready?: boolean;
        error?: boolean;
        truncated?: boolean;
        native?: boolean;
        status?: unknown;
      }
    | null
    | undefined,
  hidden = false,
): string {
  if (!source || source.loading) return "Loading events…";
  if (source.ready)
    return hidden
      ? "No visible events"
      : source.truncated
        ? "Results limited"
        : "No upcoming events";
  if (source.error) return "Calendar unavailable";
  const state = overviewCalendarState(source.status);
  return state === "denied"
    ? "Calendar access is off"
    : state === "not-connected" && source.native
      ? "Connect your calendar"
      : "Calendar unavailable";
}

/** Read provenance of one agenda item. */
export interface OverviewAgendaProvenance {
  /** Which calendar, or that the item is a reminder, beside the date. */
  origin: string;
  /** Visible read line: retry or staleness; empty when fresh. */
  read: string;
  /** Full sentence for the card's accessible description. */
  description: string;
}

/**
 * Source and freshness of the agenda item. Times are when this app last read
 * the source on this device, never a provider sync claim. A reminder comes
 * from the reminder store, so it carries that store's read time and never the
 * calendar's. An overdue reminder is already named in the card header.
 *
 * `state: "stale"`: the last completed calendar read is from an earlier local
 * day ({@link overviewReadIsStale}); the item stays visible with the time of
 * that read so today's changes are not claimed.
 */
export function presentOverviewAgendaSource(
  input: {
    state: "ready" | "stale" | "loading" | "error" | "other";
    overdue: boolean;
    reminder?: boolean;
    reminderReadAt?: number | null;
    readAt: number | null;
    now: number;
    native: boolean;
    calendar?: string | null;
    truncated?: boolean;
  },
  format?: OverviewFormat,
): OverviewAgendaProvenance {
  const { state, overdue, readAt, now, native } = input;
  const when = (at: number) => overviewWhenLabel(at, now, format);
  const reminder = (): OverviewAgendaProvenance => {
    const at = overviewInstant(input.reminderReadAt);
    return {
      origin: overdue ? "" : "Reminder",
      read: "",
      description: `${overdue ? "Overdue reminder" : "Reminder"} saved on this ${native ? "device" : "browser"}${at ? `, read ${when(at)}` : ""}`,
    };
  };
  if (overdue) return reminder();
  // A failed calendar read stays visible above an upcoming reminder: events may be missing before it.
  if (state === "error")
    return {
      origin: "",
      read: "Open Calendar to retry",
      description: "Calendar could not be read. Open Calendar to retry.",
    };
  if (state === "stale" && readAt)
    return {
      origin: "",
      read: `Not updated since ${when(readAt)}`,
      description: `Calendar not updated since ${when(readAt)}; today's changes may be missing. Open Calendar to refresh.`,
    };
  if (input.reminder) return reminder();
  if (state !== "ready" || !readAt)
    return { origin: "", read: "", description: "" };
  const name =
    typeof input.calendar === "string" && input.calendar.trim()
      ? overviewClip(input.calendar.trim(), 60)
      : "";
  return {
    origin: name === "In this app" || name === "This app" ? "" : name,
    read: "",
    description: `${name ? `${name}. ` : ""}Read ${when(readAt)} from ${native ? "calendars on this device" : "the calendar saved in this app"}${input.truncated ? "; only the first 2,000 events were read" : ""}`,
  };
}

/**
 * The secondary line of the agenda card while an overdue reminder holds it:
 * the first item that is not overdue, so an overdue reminder never hides the
 * next event. `provenance` names where and when that item was read.
 */
export function presentOverviewAgendaNext(
  input: {
    title: string;
    begin: number;
    allDay: boolean;
    now: number;
    provenance: OverviewAgendaProvenance;
  },
  format?: OverviewFormat,
): { text: string; source: string; description: string } {
  const f = resolveFormat(format);
  const { begin, now, provenance } = input;
  const date = new Date(begin);
  const today = date.toDateString() === new Date(now).toDateString();
  const title = input.title.replace(/\s+/g, " ").trim() || "Untitled event";
  const time =
    begin <= now
      ? input.allDay
        ? "All day"
        : "Now"
      : input.allDay
        ? today
          ? "All day"
          : f.shortDate(date)
        : today
          ? f.time(date)
          : `${f.shortDate(date)} ${f.time(date)}`;
  return {
    text: `Next: ${title} ${time}`,
    source: [provenance.origin, provenance.read].filter(Boolean).join(" · "),
    description: `Next: ${title}, ${time}${provenance.description ? `. ${provenance.description}` : ""}`,
  };
}

/**
 * Name of the calendar an item was read from: the display source whose id is
 * the item's calendar id in the same completed read. Ids are compared exactly
 * as strings and a name is never borrowed from another calendar.
 */
export function overviewCalendarName(
  sources: unknown,
  calendarId: unknown,
): string | null {
  if (typeof calendarId !== "string" || !calendarId || !Array.isArray(sources))
    return null;
  const found = sources.find(
    (source) =>
      !!source &&
      typeof source === "object" &&
      (source as { id?: unknown }).id === calendarId,
  ) as { name?: unknown } | undefined;
  return typeof found?.name === "string" && found.name.trim()
    ? found.name.trim()
    : null;
}

/** Header of the agenda card: the item's day, or that reminders are overdue. */
export function overviewAgendaHeader(
  dateLabel: string,
  overdue: number,
): string {
  return overdue > 1
    ? `${overdue} overdue reminders`
    : overdue === 1
      ? "Overdue reminder"
      : dateLabel;
}

/** "Due 9:00 AM" today, otherwise "Due Mon, Oct 5 9:00 AM". */
export function overviewOverdueDueLabel(
  at: number,
  now: number,
  format?: OverviewFormat,
): string {
  return `Due ${overviewWhenLabel(at, now, format)}`;
}

export interface OverviewAgendaPresentation {
  title: string;
  begin: number;
  allDay: boolean;
  video: boolean;
  people: string[];
  overdue?: boolean;
}

export function presentOverviewCalendar(
  input: {
    state: OverviewCalendarState;
    agenda: OverviewAgendaPresentation | null;
    readAt: number | null;
    now: number;
    device: string;
  },
  format?: OverviewFormat,
): {
  title: string;
  time: string;
  source: string;
  video: boolean;
  people: string[];
  label: string;
} {
  const f = resolveFormat(format);
  const { state, agenda, readAt, now, device } = input;
  const source =
    state === "ready" && readAt
      ? `Read ${overviewWhenLabel(readAt, now, format)} from ${device}`
      : "";
  if (agenda) {
    const date = new Date(agenda.begin);
    const time = agenda.overdue
      ? "Overdue"
      : agenda.begin <= now
        ? agenda.allDay
          ? "All day"
          : "Now"
        : date.toDateString() === new Date(now).toDateString()
          ? agenda.allDay
            ? "All day"
            : f.time(date)
          : f.shortDate(date);
    // Accessible names stay stable; the visible time, state and source lines carry the rest.
    return {
      title: agenda.title,
      time,
      source,
      video: agenda.video,
      people: agenda.people,
      label: `Open calendar event: ${agenda.title}`,
    };
  }
  const empty = (title: string, time: string) => ({
    title,
    time,
    source,
    video: false,
    people: [] as string[],
    label: "Open your calendar",
  });
  switch (state) {
    case "denied":
      return empty("Calendar access is off", "Access denied");
    case "error":
      return empty("Calendar could not be read", "Tap to retry");
    case "loading":
      return empty("Reading your calendar…", "Calendar");
    case "ready":
      return empty("Nothing coming up", "Calendar");
    case "unavailable":
      return empty("Your calendar", "Calendar");
  }
  return empty("Connect your calendar", "Calendar");
}

/** At most three attendee initials, with a "+N" overflow, derived only from names. */
export function overviewAttendeeInitials(names: unknown[]): string[] {
  const initials = names
    .filter((name): name is string => typeof name === "string" && !!name.trim())
    .map((name) => {
      const parts = name
        .trim()
        .replace(/[<(].*$/, "")
        .trim()
        .split(/[\s@._-]+/)
        .filter(Boolean);
      return (
        (parts[0]?.[0] || "") +
        (parts.length > 1 ? parts[parts.length - 1][0] : "")
      ).toLocaleUpperCase();
    })
    .filter(Boolean);
  return initials.length > 3
    ? [...initials.slice(0, 2), `+${initials.length - 2}`]
    : initials;
}

/** One calendar event or reminder considered for the agenda card. */
export interface OverviewAgendaCandidate<T = unknown> {
  /** Host record, returned unchanged with the selection. */
  item: T;
  /** Start (event) or due time (reminder), epoch milliseconds. */
  begin: number;
  /** End, epoch milliseconds. Overdue reminders have no end. */
  end: number;
  allDay: boolean;
  /** A reminder past due and not handled. Stays on the card until handled. */
  overdue?: boolean;
}

export interface OverviewAgendaSelection<T = unknown> {
  /** The item the card shows: an overdue reminder first, then the soonest. */
  agenda: OverviewAgendaCandidate<T> | null;
  /** Under an overdue reminder, the next item that is not overdue. */
  following: OverviewAgendaCandidate<T> | null;
  /** Overdue reminders, for the card header. */
  overdue: number;
}

/**
 * Chooses the agenda card's item from completed reads. Ended items drop out
 * (an all-day item stays through its last day; a timed item through its end
 * minute). Overdue reminders come first, even before an event already in
 * progress, and the next item that is not overdue is kept so an overdue
 * reminder never hides it. Ties keep their input order.
 */
export function selectOverviewAgenda<T>(
  candidates: readonly OverviewAgendaCandidate<T>[],
  now: number,
): OverviewAgendaSelection<T> {
  const ordered = candidates
    .map((candidate, index) => ({ candidate, index }))
    .filter(
      ({ candidate: c }) =>
        Number.isFinite(c.begin) &&
        (c.overdue || Number.isFinite(c.end)) &&
        (c.overdue || (c.allDay ? c.end > now : c.end >= now)),
    )
    .sort(
      (a, b) =>
        Number(!!b.candidate.overdue) - Number(!!a.candidate.overdue) ||
        a.candidate.begin - b.candidate.begin ||
        a.index - b.index,
    )
    .map(({ candidate }) => candidate);
  const agenda = ordered[0] ?? null;
  return {
    agenda,
    following: agenda?.overdue
      ? (ordered.find((candidate) => !candidate.overdue) ?? null)
      : null,
    overdue: ordered.filter((candidate) => candidate.overdue).length,
  };
}

/** Status of an agent calendar feed controller (the LifeOps calendar contract). */
export type OverviewAgendaFeedStatus =
  | "disconnected"
  | "transition-required"
  | "legacy-recovery"
  | "loading"
  | "ready"
  | "partial"
  | "unavailable"
  | "error";

export interface OverviewAgendaFeedPresentation {
  /** Title when no item is shown; the item's own title otherwise. */
  title: string;
  /** Visible line beside the item time: the source when fresh, retry or staleness. */
  read: string;
  description: string;
  stale: boolean;
  state:
    | "loading"
    | "ready"
    | "empty"
    | "stale"
    | "error"
    | "not-connected"
    | "review";
}

/**
 * The agenda card when its source is an agent calendar feed: the agent's next
 * event, with the feed's completeness and the snapshot time it answered for.
 * `complete` with an item is fresh; `partial` (cached data beside a failed
 * source) or a snapshot from an earlier day is stale and keeps the item; an
 * unavailable or failed read offers retry. "No upcoming events" is claimed
 * only for a complete read.
 */
export function presentOverviewAgendaFeed(
  input: {
    status: OverviewAgendaFeedStatus;
    hasItem: boolean;
    feedState?: "complete" | "partial" | "unavailable" | null;
    /** Snapshot instant the agent answered for, epoch milliseconds. */
    asOf: number | null;
    error?: string | null;
    now: number;
    /** Source name, for example "Agent Calendar". */
    source: string;
    /** Title of a complete read with no upcoming item. */
    emptyLabel?: string;
  },
  format?: OverviewFormat,
): OverviewAgendaFeedPresentation {
  const source = input.source.trim() || "Calendar";
  const unverified = "Calendar has not been verified";
  const asOf = overviewInstant(input.asOf);
  const when = asOf ? overviewWhenLabel(asOf, input.now, format) : "";
  const error =
    typeof input.error === "string"
      ? overviewClip(input.error.trim(), 160)
      : "";
  switch (input.status) {
    case "loading":
      return {
        title: "Reading your calendar…",
        read: "",
        description: `Reading ${source}…`,
        stale: false,
        state: "loading",
      };
    case "disconnected":
      return {
        title: unverified,
        read: "",
        description: `Connect to view ${source}.`,
        stale: false,
        state: "not-connected",
      };
    case "transition-required":
    case "legacy-recovery":
      return {
        title: unverified,
        read: "",
        description:
          "Saved app calendar is retained separately; review the transition.",
        stale: false,
        state: "review",
      };
    case "error":
    case "unavailable":
      return {
        title: "Calendar unavailable",
        read: "Open Calendar to retry",
        description: `${error ? error.replace(/[.\s]+$/, "") : input.status === "unavailable" ? "No calendar source could be read" : `${source} could not be read`}. Open Calendar to retry.`,
        stale: false,
        state: "error",
      };
  }
  const partial =
    input.status === "partial" ||
    input.feedState === "partial" ||
    input.feedState === "unavailable";
  const stale = partial || overviewReadIsStale(asOf, input.now);
  if (stale)
    return {
      title: input.hasItem ? "" : unverified,
      read: input.hasItem
        ? when
          ? `Not updated since ${when}`
          : "Some calendars not updated"
        : "Open Calendar to retry",
      description: `${partial ? "Some calendar sources could not be read" : `${source} not updated since ${when}`}${input.hasItem && when && partial ? `; showing what was read as of ${when}` : ""}. Open Calendar to retry.`,
      stale: input.hasItem,
      state: input.hasItem ? "stale" : "error",
    };
  return {
    title: input.hasItem ? "" : input.emptyLabel || "No upcoming events",
    read: input.hasItem ? source : "",
    description: `${source}${when ? `. As of ${when}` : ""}`,
    stale: false,
    state: input.hasItem ? "ready" : "empty",
  };
}

/** One agenda item as the card shows it. Hosts map their own records to this. */
export interface OverviewAgendaCardItem {
  title: string;
  /**
   * Start (event) or due time (reminder), epoch milliseconds. An all-day item
   * starts at local midnight of its first day.
   */
  begin: number;
  /** End, epoch milliseconds; not finite for a reminder. */
  end: number;
  allDay: boolean;
  /** A reminder past due and not handled. */
  overdue?: boolean;
  /** The item has a meeting link. */
  video?: boolean;
  /** Attendee names; only their initials are shown. */
  people?: readonly unknown[];
}

export interface OverviewAgendaCardInput {
  now: number;
  /** The item the card shows (`selectOverviewAgenda().agenda`), or null. */
  item: OverviewAgendaCardItem | null;
  /**
   * Where and when the shown item was read ({@link presentOverviewAgendaSource},
   * or an agent feed's read line and description). Without an item it
   * describes the source: a retry line after a failed read, or nothing.
   */
  provenance: OverviewAgendaProvenance;
  /**
   * Under an overdue reminder, the next item that is not overdue, with its own
   * provenance, so an overdue reminder never hides it.
   */
  next?: {
    item: OverviewAgendaCardItem;
    provenance: OverviewAgendaProvenance;
  } | null;
  /** Overdue reminders, for the heading. */
  overdueCount?: number;
  /** The last completed read is from an earlier local day. */
  stale?: boolean;
  /** Title when no item is shown ({@link overviewAgendaEmptyTitle} or a feed title). */
  emptyTitle: string;
  /** What the card opens when it shows no item. Default "your calendar". */
  sourceName?: string;
}

/** Everything an agenda card renders (see `OverviewAgendaCard`). */
export interface OverviewAgendaCardModel {
  heading: string;
  origin: string;
  title: string;
  /** Time of the shown item: due time, "All day", or its time range. */
  footer: string;
  hasItem: boolean;
  /** The meta row holds the item time and/or a read line. */
  hasMeta: boolean;
  /** Read line: retry after a failed read, or staleness. */
  source: string;
  next: { text: string; source: string } | null;
  overdue: boolean;
  stale: boolean;
  /** Accessible name. */
  label: string;
  /** Accessible description: where and when the item was read, then the Next line. */
  description: string;
  /** The shown item's description alone. */
  itemDescription: string;
  video: boolean;
  /** Attendee initials. */
  people: string[];
  state: "item" | "overdue" | "stale" | "empty";
}

/**
 * The agenda card from a selected item and where it was read. A host selects
 * the item with {@link selectOverviewAgenda} and describes its provenance; this
 * produces the heading (the item's day, or the overdue count), the time line,
 * the accessible name and description, the Next line under an overdue reminder
 * and the attendee initials. Nothing is read here.
 */
export function presentOverviewAgendaCard(
  input: OverviewAgendaCardInput,
  format?: OverviewFormat,
): OverviewAgendaCardModel {
  const f = resolveFormat(format);
  const { item, provenance, now } = input;
  const overdue = !!item?.overdue;
  const dateLabel = f.shortDate(new Date(item ? item.begin : now));
  const overdueCount = Number(input.overdueCount);
  const heading = overviewAgendaHeader(
    dateLabel,
    !overdue
      ? 0
      : Number.isFinite(overdueCount) && overdueCount > 1
        ? Math.floor(overdueCount)
        : 1,
  );
  const span = (shown: OverviewAgendaCardItem) => {
    if (shown.allDay) return "All day";
    const begin = new Date(shown.begin);
    if (!(Number.isFinite(shown.end) && shown.end > shown.begin))
      return f.time(begin);
    const end = new Date(shown.end);
    return `${f.time(begin)} – ${
      end.toDateString() === begin.toDateString()
        ? f.time(end)
        : `${f.shortDate(end)}, ${f.time(end)}`
    }`;
  };
  const title = item
    ? typeof item.title === "string" && item.title
      ? item.title
      : "Untitled event"
    : "";
  const footer = !item
    ? ""
    : overdue
      ? overviewOverdueDueLabel(item.begin, now, format)
      : span(item);
  const next =
    overdue && input.next
      ? presentOverviewAgendaNext(
          {
            title:
              typeof input.next.item.title === "string"
                ? input.next.item.title
                : "",
            begin: input.next.item.begin,
            allDay: input.next.item.allDay,
            now,
            provenance: input.next.provenance,
          },
          format,
        )
      : null;
  const stale = !!input.stale && !overdue;
  return {
    heading,
    origin: provenance.origin,
    title: title || input.emptyTitle,
    footer,
    hasItem: !!item,
    hasMeta: !!item || !!provenance.read,
    source: provenance.read,
    next: next ? { text: next.text, source: next.source } : null,
    overdue,
    stale,
    label: !item
      ? `Open ${input.sourceName?.trim() || "your calendar"}`
      : overdue
        ? `Open overdue reminder: ${title}, ${footer}`
        : `Open calendar event: ${title}, ${dateLabel}, ${footer}`,
    description: [provenance.description, next?.description]
      .filter(Boolean)
      .join(". "),
    itemDescription: provenance.description,
    video: !!item?.video,
    people: item ? overviewAttendeeInitials([...(item.people ?? [])]) : [],
    state: !item ? "empty" : overdue ? "overdue" : stale ? "stale" : "item",
  };
}

// ---------------------------------------------------------------------------
// Workflow list freshness
// ---------------------------------------------------------------------------

/**
 * When a Home workflows card's rows were loaded from the agent (and, for the
 * unified list, this phone). Empty until a list has actually been loaded for
 * the current connection.
 */
export function presentOverviewWorkflowFreshness(
  input: {
    loadedAt: number | null | undefined;
    now: number;
    unified: boolean;
    agent?: boolean;
  },
  format?: OverviewFormat,
): { visible: string; description: string } {
  const at = overviewInstant(input.loadedAt);
  if (!at) return { visible: "", description: "" };
  const when = overviewWhenLabel(at, input.now, format);
  const source = !input.unified
    ? "Workflows from your agent"
    : input.agent === false
      ? "Reminders on this phone"
      : "Automations from your agent and reminders on this phone";
  return {
    visible: `Loaded ${when}`,
    description: `${source}, loaded ${when}`,
  };
}
