/**
 * `CONFLICT_DETECT` umbrella action — proactive calendar conflict scanning.
 *
 * Subactions:
 *   - `scan_today`            — find overlaps on today's calendar
 *   - `scan_week`             — find overlaps in the next seven days
 *   - `scan_event_proposal`   — given a proposed start/end (and optionally
 *                               attendees), find direct conflicts against the
 *                               owner's calendar feed
 *
 * Reads the calendar feed via the injectable loader and compares event windows
 * for overlap. Attendee freebusy is only consulted if the loader injects it.
 *
 * Owner-or-admin gating: `hasLifeOpsAccess` covers OWNER; ADMIN is also valid
 * for read scans.
 */

import type {
  Action,
  ActionExample,
  ActionResult,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
} from "@elizaos/core";
import { logger } from "@elizaos/core";
import {
  CalendarService,
  CalendarServiceError,
} from "@elizaos/plugin-calendar";
import { hasLifeOpsAccess, INTERNAL_URL } from "../lifeops/access.js";

const ACTION_NAME = "CONFLICT_DETECT";

const SUBACTIONS = ["scan_today", "scan_week", "scan_event_proposal"] as const;

type Subaction = (typeof SUBACTIONS)[number];

const SIMILE_NAMES: readonly string[] = [
  "CONFLICT_DETECT",
  "FIND_CONFLICTS",
  "CHECK_CONFLICTS",
  "CALENDAR_CONFLICTS",
];

const SIMILE_TO_SUBACTION: Readonly<Record<string, Subaction>> = {
  FIND_CONFLICTS: "scan_today",
  CHECK_CONFLICTS: "scan_today",
  CALENDAR_CONFLICTS: "scan_today",
};

export type ConflictSeverity = "warning" | "hard";

export interface ConflictDetectEvent {
  readonly id: string;
  readonly title: string;
  readonly startISO: string;
  readonly endISO: string;
  readonly attendees?: readonly string[];
}

export interface ConflictDetectProposal {
  readonly startISO: string;
  readonly endISO: string;
  readonly attendees?: readonly string[];
}

export interface ConflictRange {
  readonly start: string;
  readonly end: string;
}

interface ConflictDetectActionParameters {
  subaction?: Subaction | string;
  action?: Subaction | string;
  op?: Subaction | string;
  range?: "today" | "week" | ConflictRange | string;
  proposal?: ConflictDetectProposal;
}

export interface ConflictDetectPair {
  readonly eventA: ConflictDetectEvent;
  readonly eventB: ConflictDetectEvent;
  readonly severity: ConflictSeverity;
  readonly suggestion?: string;
}

export interface ConflictDetectResult {
  readonly subaction: Subaction;
  readonly range: ConflictRange;
  readonly conflicts: readonly ConflictDetectPair[];
  readonly summary: string;
  readonly checkedEvents: number;
}

export interface ConflictDetectLoader {
  loadFeed: (args: {
    runtime: IAgentRuntime;
    range: ConflictRange;
  }) => Promise<readonly ConflictDetectEvent[]>;
  loadFreeBusy: (args: {
    runtime: IAgentRuntime;
    proposal: ConflictDetectProposal;
    range: ConflictRange;
  }) => Promise<readonly ConflictDetectEvent[]>;
}

/**
 * `loadFeed` has no default: scanning against an empty feed when no calendar
 * source is wired would report a confident "No conflicts detected" that is a
 * lie. When no feed loader is registered the handler fails honestly with
 * `CALENDAR_UNAVAILABLE`. Attendee free/busy stays an optional enrichment —
 * empty means "not injected" and proposal scans still run against the feed.
 */
interface LoaderState {
  loadFeed: ConflictDetectLoader["loadFeed"] | null;
  loadFreeBusy: ConflictDetectLoader["loadFreeBusy"];
}

function unwiredLoaderState(): LoaderState {
  return {
    loadFeed: null,
    loadFreeBusy: async () => [],
  };
}

let activeLoader: LoaderState = unwiredLoaderState();

export function setConflictDetectLoader(
  next: Partial<ConflictDetectLoader>,
): void {
  activeLoader = { ...activeLoader, ...next };
}

export function __resetConflictDetectLoaderForTests(): void {
  activeLoader = unwiredLoaderState();
}

/**
 * Production feed loader: reads the owner's live calendar feed from
 * `CalendarService` (the same source the CALENDAR umbrella reads) and maps it
 * onto conflict-scan windows. All-day events are excluded — they do not block
 * time, so pairing them against every timed event that day would fabricate
 * conflicts. Throws `CalendarServiceError` when the calendar service is not
 * registered; the handler translates that into an honest failure.
 */
export function createCalendarFeedConflictLoader(): Pick<
  ConflictDetectLoader,
  "loadFeed"
> {
  return {
    loadFeed: async ({ runtime, range }) => {
      const service = runtime.getService<CalendarService>(
        CalendarService.serviceType,
      );
      if (!service) {
        throw new CalendarServiceError(
          503,
          "Calendar service is not available.",
          "CALENDAR_SERVICE_UNAVAILABLE",
        );
      }
      const feed = await service.getCalendarFeed(INTERNAL_URL, {
        timeMin: range.start,
        timeMax: range.end,
      });
      return feed.events
        .filter((event) => !event.isAllDay)
        .map((event) => {
          const attendees = event.attendees
            .map((attendee) => attendee.email)
            .filter(
              (email): email is string =>
                typeof email === "string" && email.length > 0,
            );
          return {
            id: event.id,
            title: event.title,
            startISO: event.startAt,
            endISO: event.endAt,
            ...(attendees.length > 0 ? { attendees } : {}),
          };
        });
    },
  };
}

function getParams(
  options: HandlerOptions | undefined,
): ConflictDetectActionParameters {
  const raw = (options as HandlerOptions | undefined)?.parameters;
  if (raw && typeof raw === "object") {
    return raw as ConflictDetectActionParameters;
  }
  return {};
}

function normalizeSubaction(value: unknown): Subaction | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const upper = trimmed.toUpperCase();
  if (upper in SIMILE_TO_SUBACTION) {
    return SIMILE_TO_SUBACTION[upper] ?? null;
  }
  const lower = trimmed.toLowerCase();
  return (SUBACTIONS as readonly string[]).includes(lower)
    ? (lower as Subaction)
    : null;
}

function resolveSubaction(
  params: ConflictDetectActionParameters,
): Subaction | null {
  return (
    normalizeSubaction(params.subaction) ??
    normalizeSubaction(params.action) ??
    normalizeSubaction(params.op)
  );
}

function startOfDayIso(now: Date): string {
  const d = new Date(now);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

function endOfDayIso(now: Date): string {
  const d = new Date(now);
  d.setUTCHours(23, 59, 59, 999);
  return d.toISOString();
}

function endOfWeekIso(now: Date): string {
  const d = new Date(now);
  d.setUTCDate(d.getUTCDate() + 7);
  d.setUTCHours(23, 59, 59, 999);
  return d.toISOString();
}

function resolveRange(
  params: ConflictDetectActionParameters,
  subaction: Subaction,
  now: Date = new Date(),
): ConflictRange | null {
  const raw = params.range;

  if (typeof raw === "object" && raw && "start" in raw && "end" in raw) {
    const candidate = raw as ConflictRange;
    if (
      typeof candidate.start === "string" &&
      typeof candidate.end === "string"
    ) {
      return candidate;
    }
    return null;
  }

  const named =
    typeof raw === "string"
      ? raw.trim().toLowerCase()
      : subaction === "scan_week"
        ? "week"
        : "today";

  if (named === "today") {
    return { start: startOfDayIso(now), end: endOfDayIso(now) };
  }
  if (named === "week") {
    return { start: startOfDayIso(now), end: endOfWeekIso(now) };
  }
  return null;
}

function overlaps(a: ConflictDetectEvent, b: ConflictDetectEvent): boolean {
  const aStart = Date.parse(a.startISO);
  const aEnd = Date.parse(a.endISO);
  const bStart = Date.parse(b.startISO);
  const bEnd = Date.parse(b.endISO);
  if (
    Number.isNaN(aStart) ||
    Number.isNaN(aEnd) ||
    Number.isNaN(bStart) ||
    Number.isNaN(bEnd)
  ) {
    return false;
  }
  return aStart < bEnd && bStart < aEnd;
}

function computeSeverity(
  a: ConflictDetectEvent,
  b: ConflictDetectEvent,
): ConflictSeverity {
  const aAttendees = new Set(a.attendees ?? []);
  const bAttendees = new Set(b.attendees ?? []);
  for (const attendee of aAttendees) {
    if (bAttendees.has(attendee)) {
      return "hard";
    }
  }
  return "warning";
}

function suggestionFor(
  a: ConflictDetectEvent,
  b: ConflictDetectEvent,
  severity: ConflictSeverity,
): string {
  if (severity === "hard") {
    return `Move "${b.title}" — it shares attendees with "${a.title}".`;
  }
  return `Buffer between "${a.title}" and "${b.title}" — they overlap without shared attendees.`;
}

function detectConflicts(
  events: readonly ConflictDetectEvent[],
): readonly ConflictDetectPair[] {
  const conflicts: ConflictDetectPair[] = [];
  for (let i = 0; i < events.length; i += 1) {
    for (let j = i + 1; j < events.length; j += 1) {
      const a = events[i];
      const b = events[j];
      if (!a || !b) continue;
      if (!overlaps(a, b)) continue;
      const severity = computeSeverity(a, b);
      conflicts.push({
        eventA: a,
        eventB: b,
        severity,
        suggestion: suggestionFor(a, b, severity),
      });
    }
  }
  return conflicts;
}

function detectProposalConflicts(args: {
  proposal: ConflictDetectProposal;
  feed: readonly ConflictDetectEvent[];
  freeBusy: readonly ConflictDetectEvent[];
}): readonly ConflictDetectPair[] {
  const proposalEvent: ConflictDetectEvent = {
    id: "proposal",
    title: "Proposed event",
    startISO: args.proposal.startISO,
    endISO: args.proposal.endISO,
    ...(args.proposal.attendees ? { attendees: args.proposal.attendees } : {}),
  };
  const conflicts: ConflictDetectPair[] = [];
  for (const candidate of [...args.feed, ...args.freeBusy]) {
    if (!overlaps(proposalEvent, candidate)) continue;
    const severity = computeSeverity(proposalEvent, candidate);
    conflicts.push({
      eventA: proposalEvent,
      eventB: candidate,
      severity,
      suggestion: suggestionFor(proposalEvent, candidate, severity),
    });
  }
  return conflicts;
}

function summarize(conflicts: readonly ConflictDetectPair[]): string {
  if (conflicts.length === 0) return "No conflicts detected.";
  const hard = conflicts.filter((c) => c.severity === "hard").length;
  const warn = conflicts.length - hard;
  if (hard > 0 && warn > 0) {
    return `${hard} hard conflict(s) and ${warn} warning(s) detected.`;
  }
  if (hard > 0) {
    return `${hard} hard conflict(s) detected.`;
  }
  return `${warn} warning(s) detected.`;
}

const examples: ActionExample[][] = [
  [
    {
      name: "{{name1}}",
      content: { text: "Any conflicts on my calendar today?" },
    },
    {
      name: "{{agentName}}",
      content: {
        text: "Scanned today's calendar for conflicts.",
        action: ACTION_NAME,
      },
    },
  ],
  [
    {
      name: "{{name1}}",
      content: { text: "Check this slot against my week before I send it." },
    },
    {
      name: "{{agentName}}",
      content: {
        text: "Checked the proposal against your calendar.",
        action: ACTION_NAME,
      },
    },
  ],
];

export const conflictDetectAction: Action & {
  suppressPostActionContinuation?: boolean;
} = {
  name: ACTION_NAME,
  similes: SIMILE_NAMES.slice(),
  tags: [
    "domain:calendar",
    "capability:read",
    "capability:scan",
    "surface:internal",
  ],
  description:
    "Scan owner calendar overlaps. Compare proposed window vs owner feed. Subactions: scan_today, scan_week, scan_event_proposal.",
  descriptionCompressed:
    "calendar conflicts: scan_today|scan_week|scan_event_proposal; severity warning|hard",
  routingHint:
    'calendar conflict-scan ("conflicts today", "does this slot work", "scan week overlaps") -> CONFLICT_DETECT; conflict-on-create -> CALENDAR.create_event',
  contexts: ["calendar", "scheduling", "conflicts"],
  roleGate: { minRole: "OWNER" },
  suppressPostActionContinuation: true,
  validate: async (runtime, message) => hasLifeOpsAccess(runtime, message),
  parameters: [
    {
      name: "action",
      description: "Conflict op: scan_today | scan_week | scan_event_proposal.",
      schema: { type: "string" as const, enum: [...SUBACTIONS] },
    },
    {
      name: "range",
      description:
        "'today' | 'week' or { start, end } ISO window. Default subaction range.",
      schema: { type: "object" as const, additionalProperties: true },
    },
    {
      name: "proposal",
      description:
        "scan_event_proposal candidate: { startISO, endISO, attendees? }.",
      schema: { type: "object" as const, additionalProperties: true },
    },
  ],
  examples,
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state,
    options,
    callback: HandlerCallback | undefined,
  ): Promise<ActionResult> => {
    if (!(await hasLifeOpsAccess(runtime, message))) {
      const text = "Conflict scans are restricted to the owner.";
      await callback?.({ text });
      return { text, success: false, data: { error: "PERMISSION_DENIED" } };
    }

    const params = getParams(options);
    const subaction = resolveSubaction(params);
    if (!subaction) {
      return {
        success: false,
        text: "Tell me which scan to run: scan_today, scan_week, or scan_event_proposal.",
        data: { error: "MISSING_SUBACTION" },
      };
    }

    const range = resolveRange(params, subaction);
    if (!range) {
      return {
        success: false,
        text: "I need a valid range (today | week | { start, end }) to scan.",
        data: { subaction, error: "INVALID_RANGE" },
      };
    }

    // Validate input before checking calendar availability: a malformed
    // request is the caller's error regardless of connected sources.
    let proposal: ConflictDetectProposal | null = null;
    if (subaction === "scan_event_proposal") {
      const candidate = params.proposal;
      if (
        !candidate ||
        typeof candidate.startISO !== "string" ||
        typeof candidate.endISO !== "string"
      ) {
        return {
          success: false,
          text: "I need a proposal with startISO and endISO to evaluate.",
          data: { subaction, error: "MISSING_PROPOSAL" },
        };
      }
      proposal = candidate;
    }

    const loadFeed = activeLoader.loadFeed;
    if (!loadFeed) {
      const text =
        "I can't scan for conflicts — no calendar source is connected.";
      await callback?.({ text, source: "action", action: ACTION_NAME });
      return {
        success: false,
        text,
        data: { subaction, error: "CALENDAR_UNAVAILABLE" },
      };
    }
    // Boundary translation: a failed calendar read must surface as an honest
    // "calendar unavailable" failure, never as a clean zero-conflict scan.
    const calendarUnavailable = async (error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error);
      logger.warn(`[CONFLICT_DETECT] ${subaction} feed load failed: ${detail}`);
      const text =
        "The calendar is unavailable right now, so I can't scan for conflicts.";
      await callback?.({ text, source: "action", action: ACTION_NAME });
      return {
        success: false,
        text,
        data: { subaction, error: "CALENDAR_UNAVAILABLE", detail },
      };
    };

    if (subaction === "scan_event_proposal" && proposal) {
      let feed: readonly ConflictDetectEvent[];
      let freeBusy: readonly ConflictDetectEvent[];
      try {
        [feed, freeBusy] = await Promise.all([
          loadFeed({ runtime, range }),
          activeLoader.loadFreeBusy({ runtime, proposal, range }),
        ]);
      } catch (error) {
        return calendarUnavailable(error);
      }
      const conflicts = detectProposalConflicts({ proposal, feed, freeBusy });
      const summary = summarize(conflicts);
      const checkedEvents = feed.length + freeBusy.length;
      logger.info(
        `[CONFLICT_DETECT] ${subaction} feed=${feed.length} freeBusy=${freeBusy.length} conflicts=${conflicts.length}`,
      );
      await callback?.({
        text: summary,
        source: "action",
        action: ACTION_NAME,
      });
      return {
        success: true,
        text: summary,
        data: {
          subaction,
          range,
          conflicts,
          summary,
          checkedEvents,
        },
      };
    }

    let feed: readonly ConflictDetectEvent[];
    try {
      feed = await loadFeed({ runtime, range });
    } catch (error) {
      return calendarUnavailable(error);
    }
    const conflicts = detectConflicts(feed);
    const summary = summarize(conflicts);
    logger.info(
      `[CONFLICT_DETECT] ${subaction} feed=${feed.length} conflicts=${conflicts.length}`,
    );
    await callback?.({
      text: summary,
      source: "action",
      action: ACTION_NAME,
    });
    return {
      success: true,
      text: summary,
      data: {
        subaction,
        range,
        conflicts,
        summary,
        checkedEvents: feed.length,
      },
    };
  },
};
