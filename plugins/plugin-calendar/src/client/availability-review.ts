/**
 * Reviewed foreground free/busy read on a phone or browser client.
 *
 * The owner picks the calendars, the device reads only those, the owner sees the
 * exact result, and the same read is repeated before sharing so a calendar that
 * changed during review is never reported. Free, cancelled and declined entries
 * are not busy; tentative entries count conservatively (the shared
 * `calendarAvailability` computation). An unavailable, stale or remote read with
 * unknown freshness is unknown, never free. Every failure shares nothing.
 *
 * Browser-safe: the host supplies the provider, the review UI and the clock.
 */
import {
  CALENDAR_AVAILABILITY_MAX_BUSY,
  CALENDAR_AVAILABILITY_MAX_CALENDARS,
  type CalendarAvailabilityEvent,
  type CalendarAvailabilityOperation,
  type CalendarAvailabilityResult,
  calendarAvailability,
  validateCalendarAvailabilityOperation,
} from "@elizaos/contracts";

/** One calendar the device can read. Names and accounts are shown to the owner only. */
export interface AvailabilitySource {
  id: string;
  name: string;
  account: string;
  sourceRevision: string;
}
/** The owner's choice: provider identity plus the revision they reviewed. Never shared. */
export interface AvailabilitySelection {
  id: string;
  revision: string;
}
/** Readable sources offered for one review; more than this fails closed rather than hiding calendars. */
export const AVAILABILITY_MAX_SOURCES = 64;

/**
 * Provider boundary for a free/busy read. `readAvailability` returns only
 * intervals and each event's availability; an implementation must not project
 * titles or any other event content. A ready source list echoes the time zone
 * it was checked against. A ready result must include freshness:'local': every
 * selected calendar is device-local and has no remote sync dependency. Remote
 * cached reads have unknown freshness and cannot return a ready result until a
 * verifiable remote freshness contract is added. Statuses: ready,
 * permission-required, changed, timezone-changed, too-many, unavailable,
 * freshness-unknown.
 */
export interface AvailabilityProvider {
  requestWorkflowReadAccess(): Promise<{ status: string }>;
  availabilitySources(input: {
    timeZone: string;
  }): Promise<{ status: string; timeZone?: unknown; calendars?: unknown }>;
  readAvailability(input: {
    calendars: AvailabilitySelection[];
    start: string;
    end: string;
    timeZone: string;
  }): Promise<{ status: string; events?: unknown; freshness?: unknown }>;
}

/** Foreground owner review. Both steps resolve only on an explicit choice. */
export interface AvailabilityReview {
  /** Returns the chosen source ids, or null when the owner cancels. Nothing is preselected. */
  chooseCalendars(
    sources: readonly AvailabilitySource[],
    operation: CalendarAvailabilityOperation,
    signal: AbortSignal,
    current: () => void,
  ): Promise<string[] | null>;
  /** Shows the exact result that would be shared. True only on explicit approval. */
  confirmResult(
    result: CalendarAvailabilityResult,
    chosen: readonly AvailabilitySource[],
    signal: AbortSignal,
    current: () => void,
  ): Promise<boolean>;
}

export type AvailabilityOutcome = {
  status: "succeeded" | "failed";
  summary: string;
  foregroundResult?: CalendarAvailabilityResult;
};

/** Attempts to list calendars, and the wait between them, while focus returns after a permission prompt. */
export const SOURCE_LIST_ATTEMPTS = 4,
  SOURCE_LIST_RETRY_MS = 300;

/** Resolves after the wait, or rejects as soon as the review is aborted. */
export function abortablePause(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(Error("Aborted"));
      return;
    }
    const done = () => {
        signal.removeEventListener("abort", stop);
        resolve();
      },
      timer = setTimeout(done, milliseconds);
    const stop = () => {
      clearTimeout(timer);
      reject(Error("Aborted"));
    };
    signal.addEventListener("abort", stop, { once: true });
  });
}

const NOTHING = " Nothing was shared.";
const failed = (summary: string): AvailabilityOutcome => ({
  status: "failed",
  summary: summary + NOTHING,
});
const ZONE_CHANGED =
  "This availability check used a different time zone. Ask again from this phone.";
const DENIED = "Calendar access was not allowed, so no calendar was read.";

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("Invalid Calendar availability provider value");
  return value as Record<string, unknown>;
}
function label(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() && !value.includes("\0")
    ? value.trim().slice(0, 200)
    : fallback;
}

/** Sources as the provider reported them; any malformed or duplicate identity fails closed. */
export function parseAvailabilitySources(value: unknown): AvailabilitySource[] {
  if (!Array.isArray(value) || value.length > AVAILABILITY_MAX_SOURCES)
    throw Error("Too many readable calendars for one review");
  const seen = new Set<string>();
  return value.map((item) => {
    const row = record(item),
      id = row.id,
      revision = row.sourceRevision;
    if (
      typeof id !== "string" ||
      !id ||
      id.length > 128 ||
      id.includes("\0") ||
      seen.has(id) ||
      typeof revision !== "string" ||
      !/^[a-f0-9]{64}$/.test(revision)
    )
      throw Error("Invalid Calendar source identity");
    seen.add(id);
    return {
      id,
      name: label(row.name, "Unnamed calendar"),
      account: label(row.account, "This phone"),
      sourceRevision: revision,
    };
  });
}

/**
 * Provider rows for the shared computation. A row carrying anything besides its
 * interval, all-day flag and availability is rejected, so event content cannot
 * ride along.
 */
export function parseAvailabilityEvents(
  value: unknown,
): CalendarAvailabilityEvent[] {
  if (!Array.isArray(value) || value.length > CALENDAR_AVAILABILITY_MAX_BUSY)
    throw Error("Calendar availability exceeds the reviewed event bound");
  return value.map((item) => {
    const row = record(item),
      keys = Object.keys(row);
    if (
      keys.length !== 4 ||
      ["start", "end", "allDay", "availability"].some(
        (key) => !Object.hasOwn(row, key),
      )
    )
      throw Error("Unexpected Calendar availability provider fields");
    if (
      typeof row.start !== "string" ||
      typeof row.end !== "string" ||
      typeof row.allDay !== "boolean" ||
      (row.availability !== "busy" &&
        row.availability !== "free" &&
        row.availability !== "tentative")
    )
      throw Error("Invalid Calendar availability provider row");
    return {
      start: row.start,
      end: row.end,
      allDay: row.allDay,
      availability: row.availability,
    };
  });
}

function readFailure(status: string): AvailabilityOutcome {
  if (status === "freshness-unknown" || status === "stale")
    return failed(
      "Calendar freshness could not be verified, so your availability is unknown.",
    );
  if (status === "permission-required") return failed(DENIED);
  if (status === "changed")
    return failed(
      "A chosen calendar changed on this phone. Review the availability check again.",
    );
  if (status === "timezone-changed") return failed(ZONE_CHANGED);
  if (status === "too-many")
    return failed(
      `These calendars have more than ${CALENDAR_AVAILABILITY_MAX_BUSY} events in this window. Ask about a shorter time or choose fewer calendars.`,
    );
  return failed("Calendars could not be read right now.");
}

/** Owner-facing sentence for the journal and chat receipt. Carries no event content. */
export function describeAvailabilityResult(
  result: CalendarAvailabilityResult,
): string {
  const calendars = `${result.calendarCount} calendar${result.calendarCount === 1 ? "" : "s"} you chose`;
  const ignored = result.transparentIgnored
    ? ` ${result.transparentIgnored} event${result.transparentIgnored === 1 ? "" : "s"} marked free ${result.transparentIgnored === 1 ? "was" : "were"} ignored.`
    : "";
  return result.status === "free"
    ? `Shared that you are free in this window, from ${calendars}.${ignored} No event titles or details were shared.`
    : `Shared ${result.busy.length} busy time${result.busy.length === 1 ? "" : "s"} from ${calendars}.${ignored} No event titles or details were shared.`;
}

/**
 * Bounded foreground free/busy read. `current` throws when the session, screen
 * or device context is no longer the reviewed one.
 */
export async function executeCalendarAvailability(
  provider: AvailabilityProvider,
  value: CalendarAvailabilityOperation,
  contextTimeZone: string | undefined,
  signal: AbortSignal,
  current: () => void,
  review: AvailabilityReview,
  deviceTimeZone: () => string = () =>
    Intl.DateTimeFormat().resolvedOptions().timeZone,
  pause: (
    milliseconds: number,
    signal: AbortSignal,
  ) => Promise<void> = abortablePause,
): Promise<AvailabilityOutcome> {
  try {
    const operation = validateCalendarAvailabilityOperation(value);
    const stable = () => {
      signal.throwIfAborted();
      current();
    };
    // All-day events block the owner's local civil days, so every zone involved must agree.
    const sameZone = () =>
      contextTimeZone === operation.timeZone &&
      deviceTimeZone() === operation.timeZone;
    stable();
    if (!sameZone()) return failed(ZONE_CHANGED);
    const permission = await provider.requestWorkflowReadAccess();
    stable();
    if (permission.status !== "granted") return failed(DENIED);
    // The system permission prompt takes window focus, and the native read
    // requires it. Focus may return a moment after the prompt resolves, so an
    // unavailable list is asked for again a bounded number of times. Each
    // attempt re-checks the reviewed context; nothing is read.
    let listed = await provider.availabilitySources({
      timeZone: operation.timeZone,
    });
    stable();
    for (
      let attempt = 1;
      listed.status === "unavailable" && attempt < SOURCE_LIST_ATTEMPTS;
      attempt++
    ) {
      await pause(SOURCE_LIST_RETRY_MS, signal);
      stable();
      listed = await provider.availabilitySources({
        timeZone: operation.timeZone,
      });
      stable();
    }
    if (listed.status === "permission-required") return failed(DENIED);
    if (listed.status === "timezone-changed") return failed(ZONE_CHANGED);
    if (listed.status !== "ready")
      return failed("Calendars are unavailable right now.");
    if (listed.timeZone !== operation.timeZone || !sameZone())
      return failed(ZONE_CHANGED);
    const sources = parseAvailabilitySources(listed.calendars);
    if (!sources.length)
      return failed("No readable calendars were found on this phone.");
    const chosenIds = await review.chooseCalendars(
      sources,
      operation,
      signal,
      stable,
    );
    if (chosenIds === null)
      return failed("Availability check cancelled. No calendar was read.");
    stable();
    if (
      !Array.isArray(chosenIds) ||
      chosenIds.length < 1 ||
      chosenIds.length > CALENDAR_AVAILABILITY_MAX_CALENDARS ||
      new Set(chosenIds).size !== chosenIds.length
    )
      throw Error("Invalid calendar choice");
    const chosen = chosenIds.map((id) => {
      const source = sources.find((item) => item.id === id);
      if (!source) throw Error("A chosen calendar was not offered");
      return source;
    });
    const request = {
      calendars: chosen.map((source) => ({
        id: source.id,
        revision: source.sourceRevision,
      })),
      start: operation.start,
      end: operation.end,
      timeZone: operation.timeZone,
    };
    const read = async (): Promise<
      CalendarAvailabilityResult | AvailabilityOutcome
    > => {
      const answer = await provider.readAvailability(request);
      stable();
      if (answer.status !== "ready") return readFailure(answer.status);
      if (answer.freshness !== "local") return readFailure("freshness-unknown");
      if (!sameZone()) return failed(ZONE_CHANGED);
      return calendarAvailability(
        operation,
        chosen.length,
        parseAvailabilityEvents(answer.events),
      );
    };
    const reviewed = await read();
    if ("summary" in reviewed) return reviewed;
    if (!(await review.confirmResult(reviewed, chosen, signal, stable)))
      return failed("Availability check cancelled.");
    stable();
    // The shared answer is the one the owner saw: a calendar that changed since is reviewed again.
    const latest = await read();
    if ("summary" in latest) return latest;
    if (JSON.stringify(latest) !== JSON.stringify(reviewed))
      return failed(
        "Your calendar changed during this review. Review the availability check again.",
      );
    stable();
    return {
      status: "succeeded",
      summary: describeAvailabilityResult(reviewed),
      foregroundResult: reviewed,
    };
  } catch {
    // A read has no device effect, so any interruption is a plain failure, never an unknown outcome.
    return failed(
      signal.aborted
        ? "Availability check cancelled."
        : "The phone, calendars or connection changed before this availability check finished.",
    );
  }
}
