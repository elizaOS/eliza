/**
 * Read-only display of one owner-chosen Google calendar on a phone or browser,
 * through the Eliza Cloud managed Google Calendar read routes.
 *
 * Nothing here writes a local calendar or grants agent access. Every read is
 * bound to the exact Cloud owner, credential, session and Google connection:
 * a change of any of them, or of the owner's explicit calendar choice, aborts
 * the read after each await. A calendar is offered only while the connection
 * holds Calendar read access and Google grants at least reader access, and its
 * metadata must be the same before and after the feed read, so a changed
 * access role or time zone shows nothing rather than a mixed snapshot.
 * Cancelled events are omitted and all-day events keep their civil dates.
 *
 * Browser-safe: no Node built-ins and only erasable TypeScript.
 */

/** Calendar read access a Google connection must hold. */
export const GOOGLE_CALENDAR_READ_CAPABILITY = "google.calendar.read";

/** A Google calendar as the Cloud calendar list reports it. */
export interface GoogleCalendarSummary {
  calendarId: string;
  summary: string;
  description: string | null;
  primary: boolean;
  accessRole: string;
  backgroundColor: string | null;
  foregroundColor: string | null;
  timeZone: string | null;
  selected: boolean;
}

/** One event of the Cloud calendar feed. */
export interface GoogleCalendarEvent {
  externalId: string;
  calendarId: string;
  title: string;
  description: string;
  location: string;
  status: string;
  startAt: string;
  endAt: string;
  isAllDay: boolean;
  timezone: string | null;
  htmlLink: string | null;
  conferenceLink: string | null;
  organizer: Record<string, unknown> | null;
  attendees: Array<{
    email: string | null;
    displayName: string | null;
    responseStatus: string | null;
    self: boolean;
    organizer: boolean;
    optional: boolean;
  }>;
  metadata: Record<string, unknown>;
}

/** A complete feed: Cloud exhausts provider pages, so there is no client cursor. */
export interface GoogleCalendarFeed {
  calendarId: string;
  events: GoogleCalendarEvent[];
  syncedAt: string;
}

export interface GoogleCalendarRange {
  timeMin: string;
  timeMax: string;
  timeZone: string;
}

/** The Google connection as the Cloud account list reports it. */
export interface GoogleCalendarAccount {
  connectionId: string | null;
  connected: boolean;
  grantedCapabilities: string[];
  label: string;
}

/** Identifiers only; credentials stay in the host's Cloud client. */
export interface GoogleCalendarBinding {
  environment: "production" | "staging";
  userId: string;
  organizationId: string;
  credentialId: string;
  sessionId: string;
  connectionId: string;
}

export interface GoogleCalendarClient {
  gmailAccounts(signal: AbortSignal): Promise<GoogleCalendarAccount[]>;
  googleCalendars(
    grantId: string,
    signal: AbortSignal,
  ): Promise<GoogleCalendarSummary[]>;
  googleCalendarFeed(
    grantId: string,
    calendarId: string,
    range: GoogleCalendarRange,
    signal: AbortSignal,
  ): Promise<GoogleCalendarFeed>;
}

export interface GoogleCalendarSource {
  id: string;
  name: string;
  account: string;
  connectionId: string;
  providerCalendarId: string;
  timeZone: string | null;
  primary: boolean;
  source: "google";
  readOnly: true;
}

/**
 * One read-only event. `begin`/`end` are instants; an all-day event's are its
 * civil dates at UTC midnight (exclusive end) with `timeZone` "UTC".
 * `revision` is a display snapshot, never a write precondition.
 */
export interface GoogleCalendarReadEvent {
  id: string;
  calendarId: string;
  providerEventId: string;
  title: string;
  body: string;
  location: string;
  begin: number;
  end: number;
  allDay: boolean;
  timeZone: string;
  revision: string;
  source: "google";
  readOnly: true;
}

export type GoogleCalendarFailure = {
  status: "not-connected" | "permission-required" | "unavailable";
  message: string;
};
export type GoogleCalendarSources =
  | GoogleCalendarFailure
  | { status: "ready"; calendars: GoogleCalendarSource[] };
export type GoogleCalendarRead =
  | GoogleCalendarFailure
  | { status: "selection-required"; message: string }
  | {
      status: "ready";
      calendar: GoogleCalendarSource;
      events: GoogleCalendarReadEvent[];
      syncedAt: string;
      truncated: false;
    };

/** How the host's Cloud errors map onto read outcomes. */
export type GoogleCalendarErrorKind =
  | "not-connected"
  | "permission-required"
  | "account-changed"
  | "unavailable";

export interface GoogleCalendarReaderOptions {
  classify(error: unknown): GoogleCalendarErrorKind;
}

class GoogleCalendarInvalidResponse extends Error {
  constructor() {
    super("Google Calendar returned an invalid response.");
    this.name = "GoogleCalendarInvalidResponse";
  }
}

const bindingKey = (binding: GoogleCalendarBinding) =>
  JSON.stringify([
    binding.environment,
    binding.userId,
    binding.organizationId,
    binding.credentialId,
    binding.sessionId,
    binding.connectionId,
  ]);
const sourceId = (binding: GoogleCalendarBinding, calendarId: string) =>
  `google:${encodeURIComponent(binding.connectionId)}:${encodeURIComponent(calendarId)}`;
const abortChanged = () =>
  new DOMException(
    "Google Calendar account, connection or selection changed.",
    "AbortError",
  );
const disconnected = (): GoogleCalendarFailure => ({
  status: "not-connected",
  message: "Connect Google Calendar to read its calendars.",
});
const permissionRequired = (): GoogleCalendarFailure => ({
  status: "permission-required",
  message: "Reconnect Google with Calendar read access to show its events.",
});
const unavailable = (): GoogleCalendarFailure => ({
  status: "unavailable",
  message:
    "Google Calendar could not be loaded. Retry before relying on this schedule.",
});
const readable = (calendar: GoogleCalendarSummary) =>
  ["reader", "writer", "owner"].includes(calendar.accessRole);
const sourceKey = (calendar: GoogleCalendarSummary) =>
  JSON.stringify([calendar.calendarId, calendar.accessRole, calendar.timeZone]);

function source(
  binding: GoogleCalendarBinding,
  account: GoogleCalendarAccount,
  calendar: GoogleCalendarSummary,
): GoogleCalendarSource {
  return {
    id: sourceId(binding, calendar.calendarId),
    name: calendar.summary || "Google Calendar",
    account: account.label,
    connectionId: binding.connectionId,
    providerCalendarId: calendar.calendarId,
    timeZone: calendar.timeZone,
    primary: calendar.primary,
    source: "google",
    readOnly: true,
  };
}

/** Maps one feed event to a read-only display event. Throws on invalid data. */
export function googleCalendarReadEvent(
  event: GoogleCalendarEvent,
  calendar: GoogleCalendarSource,
): GoogleCalendarReadEvent {
  let begin = Date.parse(event.startAt),
    end = Date.parse(event.endAt);
  if (!Number.isFinite(begin) || !Number.isFinite(end) || end <= begin)
    throw new GoogleCalendarInvalidResponse();
  const timeZone = event.timezone || calendar.timeZone;
  // Cloud normalizes Google's all-day dates to midnight instants in the
  // calendar zone; the display keeps their civil dates at UTC midnight,
  // including the exclusive end date. Each boundary converts independently: a
  // DST transition can make the span 23 or 25 hours without changing the
  // number of days it occupies.
  try {
    if (event.isAllDay) {
      if (!timeZone) throw new GoogleCalendarInvalidResponse();
      const format = new Intl.DateTimeFormat("en-US", {
        timeZone,
        calendar: "gregory",
        numberingSystem: "latn",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      });
      const civil = (instant: number) => {
        const parts = Object.fromEntries(
          format.formatToParts(instant).map((part) => [part.type, part.value]),
        );
        return Date.UTC(
          Number(parts.year),
          Number(parts.month) - 1,
          Number(parts.day),
        );
      };
      begin = civil(begin);
      end = civil(end);
      if (!Number.isFinite(begin) || !Number.isFinite(end) || end <= begin)
        throw new GoogleCalendarInvalidResponse();
    } else if (timeZone) new Intl.DateTimeFormat("en-US", { timeZone });
  } catch {
    throw new GoogleCalendarInvalidResponse();
  }
  return {
    id: `${calendar.id}:${encodeURIComponent(event.externalId)}`,
    calendarId: calendar.id,
    providerEventId: event.externalId,
    title: event.title || "Untitled event",
    body: event.description,
    location: event.location,
    begin,
    end,
    allDay: event.isAllDay,
    timeZone: event.isAllDay
      ? "UTC"
      : event.timezone || calendar.timeZone || "UTC",
    revision: JSON.stringify([
      event.externalId,
      event.startAt,
      event.endAt,
      event.status,
      event.title,
      event.description,
      event.location,
    ]),
    source: "google",
    readOnly: true,
  };
}

/**
 * Read-only Cloud reader. Hosts call `invalidate` on disconnect or unmount and
 * `selectSource` for the owner's explicit choice; `getBinding` is checked again
 * after every await so an account switch never shows another owner's events.
 */
export class GoogleCalendarReader {
  private epoch = 0;
  private selected: string | null = null;
  private selectionOwner: string | null = null;
  private offered = new Map<string, GoogleCalendarSummary>();
  // Explicit fields (no parameter properties) keep this module erasable.
  private readonly client: GoogleCalendarClient;
  private readonly getBinding: () => GoogleCalendarBinding | null;
  private readonly options: GoogleCalendarReaderOptions;

  constructor(
    client: GoogleCalendarClient,
    getBinding: () => GoogleCalendarBinding | null,
    options: GoogleCalendarReaderOptions,
  ) {
    this.client = client;
    this.getBinding = getBinding;
    this.options = options;
  }

  invalidate(): void {
    ++this.epoch;
    this.selected = null;
    this.selectionOwner = null;
    this.offered.clear();
  }

  selectSource(id: string | null): void {
    const binding = this.getBinding();
    if (
      id !== null &&
      (!binding ||
        this.selectionOwner !== bindingKey(binding) ||
        !this.offered.has(id))
    )
      throw new Error("Choose a currently listed Google calendar.");
    ++this.epoch;
    this.selected = id;
  }

  private ticket(signal: AbortSignal) {
    signal.throwIfAborted();
    const binding = this.getBinding();
    if (!binding || Object.values(binding).some((value) => !value)) return null;
    const key = bindingKey(binding),
      epoch = this.epoch;
    const current = () => {
      signal.throwIfAborted();
      const active = this.getBinding();
      if (this.epoch !== epoch || !active || bindingKey(active) !== key)
        throw abortChanged();
    };
    return { binding: { ...binding }, key, current };
  }

  private async account(
    binding: GoogleCalendarBinding,
    signal: AbortSignal,
    current: () => void,
  ): Promise<GoogleCalendarAccount | GoogleCalendarFailure> {
    const accounts = await this.client.gmailAccounts(signal);
    current();
    const account = accounts.find(
      (item) => item.connectionId === binding.connectionId,
    );
    if (!account?.connected) return disconnected();
    if (!account.grantedCapabilities.includes(GOOGLE_CALENDAR_READ_CAPABILITY))
      return permissionRequired();
    return account;
  }

  private failure(error: unknown): GoogleCalendarFailure {
    const kind = this.options.classify(error);
    if (kind === "account-changed") throw abortChanged();
    if (kind === "not-connected") return disconnected();
    if (kind === "permission-required") return permissionRequired();
    return unavailable();
  }

  async listSources(signal: AbortSignal): Promise<GoogleCalendarSources> {
    const ticket = this.ticket(signal);
    if (!ticket) {
      this.invalidate();
      return disconnected();
    }
    const { binding, key, current } = ticket;
    try {
      const account = await this.account(binding, signal, current);
      if ("status" in account) {
        this.invalidate();
        return account;
      }
      const calendars = (
        await this.client.googleCalendars(binding.connectionId, signal)
      ).filter(readable);
      current();
      const latest = await this.account(binding, signal, current);
      if ("status" in latest) {
        this.invalidate();
        return latest;
      }
      const offered = new Map(
        calendars.map((calendar) => [
          sourceId(binding, calendar.calendarId),
          calendar,
        ]),
      );
      if (
        this.selectionOwner !== key ||
        (this.selected && !offered.has(this.selected))
      ) {
        ++this.epoch;
        this.selected = null;
      }
      this.selectionOwner = key;
      this.offered = offered;
      return {
        status: "ready",
        calendars: calendars.map((calendar) =>
          source(binding, latest, calendar),
        ),
      };
    } catch (error) {
      current();
      return this.failure(error);
    }
  }

  async read(
    range: GoogleCalendarRange,
    signal: AbortSignal,
  ): Promise<GoogleCalendarRead> {
    const ticket = this.ticket(signal);
    if (!ticket) {
      this.invalidate();
      return disconnected();
    }
    const { binding, key, current } = ticket;
    const selected = this.selected,
      chosen =
        selected && this.selectionOwner === key
          ? this.offered.get(selected)
          : undefined;
    if (!chosen)
      return {
        status: "selection-required",
        message: "Choose a Google calendar to show its events.",
      };
    const start = Date.parse(range.timeMin),
      end = Date.parse(range.timeMax);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start)
      throw new TypeError("Choose a valid Calendar range.");
    new Intl.DateTimeFormat("en", { timeZone: range.timeZone });
    const window = { ...range };
    try {
      const account = await this.account(binding, signal, current);
      if ("status" in account) {
        this.invalidate();
        return account;
      }
      const before = (
        await this.client.googleCalendars(binding.connectionId, signal)
      ).find(
        (calendar) =>
          calendar.calendarId === chosen.calendarId && readable(calendar),
      );
      current();
      if (!before || sourceKey(before) !== sourceKey(chosen)) {
        this.invalidate();
        return permissionRequired();
      }
      const feed = await this.client.googleCalendarFeed(
        binding.connectionId,
        chosen.calendarId,
        window,
        signal,
      );
      current();
      const latest = await this.account(binding, signal, current);
      if ("status" in latest) {
        this.invalidate();
        return latest;
      }
      const after = (
        await this.client.googleCalendars(binding.connectionId, signal)
      ).find(
        (calendar) =>
          calendar.calendarId === chosen.calendarId && readable(calendar),
      );
      current();
      if (!after || sourceKey(after) !== sourceKey(before)) {
        this.invalidate();
        return permissionRequired();
      }
      if (
        feed.calendarId !== chosen.calendarId ||
        !Number.isFinite(Date.parse(feed.syncedAt))
      )
        throw new GoogleCalendarInvalidResponse();
      const calendar = source(binding, latest, after),
        seen = new Set<string>();
      const events = feed.events
        .filter((event) => event.status !== "cancelled")
        .map((event) => {
          if (
            event.calendarId !== chosen.calendarId ||
            seen.has(event.externalId)
          )
            throw new GoogleCalendarInvalidResponse();
          seen.add(event.externalId);
          return googleCalendarReadEvent(event, calendar);
        })
        .filter((event) => event.begin < end && event.end > start)
        .sort((a, b) => a.begin - b.begin || a.id.localeCompare(b.id));
      return {
        status: "ready",
        calendar,
        events,
        syncedAt: feed.syncedAt,
        truncated: false,
      };
    } catch (error) {
      current();
      return this.failure(error);
    }
  }
}
