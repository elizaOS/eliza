/**
 * Calendar-owned `CONFLICT_DETECT` action and production feed adapter.
 *
 * The action resolves user-facing scan windows, loads real calendar data, and
 * delegates every availability decision to the deterministic calendar engine.
 * Host plugins may inject authorization and timezone resolution, but they do
 * not reimplement overlap, privacy, or source-health semantics.
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
import { hasRoleAccess } from "@elizaos/core";
import {
  type LifeOpsCalendarEvent,
  type LifeOpsCalendarFeed,
  type LifeOpsCalendarSourceHealth,
  SELF_ENTITY_ID,
} from "@elizaos/shared";
import { calendarAvailabilityKindFromMetadata } from "../internal/availability-metadata.js";
import { resolveDefaultTimeZone } from "../internal/constants.js";
import { CalendarServiceError } from "../internal/errors.js";
import { getZonedDateParts } from "../internal/time.js";
import {
  buildZonedCalendarRange,
  type CalendarAvailabilityAttendee,
  type CalendarAvailabilityCompleteness,
  type CalendarAvailabilityConflict,
  type CalendarAvailabilityEvaluation,
  type CalendarAvailabilityEvent,
  type CalendarAvailabilityPolicy,
  type CalendarAvailabilityProposal,
  type CalendarAvailabilityRange,
  type CalendarAvailabilitySource,
  type CalendarAvailabilitySourceStatus,
  type CalendarConflictSeverity,
  evaluateCalendarAvailability,
} from "../service/availability.js";

const ACTION_NAME = "CONFLICT_DETECT";
const INTERNAL_URL = new URL("http://127.0.0.1/");
const CALENDAR_SERVICE_TYPE = "calendar";

const SUBACTIONS = ["scan_today", "scan_week", "scan_event_proposal"] as const;
type ConflictDetectSubaction = (typeof SUBACTIONS)[number];

const SIMILE_NAMES = [
  "CONFLICT_DETECT",
  "FIND_CONFLICTS",
  "CHECK_CONFLICTS",
  "CALENDAR_CONFLICTS",
] as const;

const SIMILE_TO_SUBACTION: Readonly<Record<string, ConflictDetectSubaction>> = {
  FIND_CONFLICTS: "scan_today",
  CHECK_CONFLICTS: "scan_today",
  CALENDAR_CONFLICTS: "scan_today",
};

export type ConflictSeverity = CalendarConflictSeverity;

export interface ConflictDetectEvent extends CalendarAvailabilityEvent {
  readonly id: string;
  readonly title: string;
  readonly startISO: string;
  readonly endISO: string;
}

export type ConflictDetectProposal = CalendarAvailabilityProposal;
export type ConflictRange = CalendarAvailabilityRange;
export type ConflictDetectPair = CalendarAvailabilityConflict;

export interface ConflictDetectResult {
  readonly subaction: ConflictDetectSubaction;
  readonly range: ConflictRange;
  readonly conflicts: readonly ConflictDetectPair[];
  readonly summary: string;
  readonly checkedEvents: number;
  readonly ignoredEvents: number;
  readonly completeness: CalendarAvailabilityCompleteness;
  readonly definitive: boolean;
}

export interface ConflictDetectLoadBatch {
  readonly events: readonly ConflictDetectEvent[];
  readonly source: Omit<CalendarAvailabilitySource, "events">;
}

export interface ConflictDetectLoadSnapshot {
  readonly sources: readonly CalendarAvailabilitySource[];
}

export type ConflictDetectLoadResult =
  | readonly ConflictDetectEvent[]
  | ConflictDetectLoadBatch
  | ConflictDetectLoadSnapshot;

export interface ConflictDetectLoader {
  loadFeed: (args: {
    runtime: IAgentRuntime;
    range: ConflictRange;
  }) => Promise<ConflictDetectLoadResult>;
  loadFreeBusy?: (args: {
    runtime: IAgentRuntime;
    guestAvailabilityGrantIds: readonly string[];
    range: ConflictRange;
  }) => Promise<ConflictDetectLoadResult>;
}

export interface ConflictDetectActionDeps {
  readonly authorize?: (
    runtime: IAgentRuntime,
    message: Memory,
  ) => Promise<boolean>;
  readonly resolveTimeZone?: (runtime: IAgentRuntime) => Promise<string>;
  readonly now?: () => Date;
  readonly loader?: Partial<ConflictDetectLoader>;
}

export type ConflictDetectHostAdapter = Pick<
  ConflictDetectActionDeps,
  "authorize" | "resolveTimeZone" | "loader"
>;

const hostAdapters = new WeakMap<IAgentRuntime, ConflictDetectHostAdapter>();

/**
 * Bind host-owned authorization, timezone, and provider-loading semantics to
 * one runtime. The runtime-keyed registry lets an already-registered calendar
 * action gain the host adapter without cross-runtime state or plugin-order
 * dependence. Registrations merge, so a host can bind authorization at plugin
 * init while a harness later binds only the loader for the same runtime.
 */
export function registerConflictDetectHostAdapter(
  runtime: IAgentRuntime,
  adapter: ConflictDetectHostAdapter,
): void {
  hostAdapters.set(runtime, { ...hostAdapters.get(runtime), ...adapter });
}

interface CalendarConflictFeedService {
  getCalendarFeed(
    requestUrl: URL,
    request: { side: "owner"; timeMin: string; timeMax: string },
  ): Promise<LifeOpsCalendarFeed>;
}

interface CalendarConflictFreeBusyService {
  getCalendarFreeBusy(
    requestUrl: URL,
    request: {
      principalEntityId: string;
      guestAvailabilityGrantIds: readonly string[];
      timeMin: string;
      timeMax: string;
    },
  ): Promise<ConflictDetectLoadSnapshot>;
}

function isCalendarConflictFeedService(
  value: unknown,
): value is CalendarConflictFeedService {
  return (
    typeof value === "object" &&
    value !== null &&
    "getCalendarFeed" in value &&
    typeof value.getCalendarFeed === "function"
  );
}

function isCalendarConflictFreeBusyService(
  value: unknown,
): value is CalendarConflictFreeBusyService {
  return (
    typeof value === "object" &&
    value !== null &&
    "getCalendarFreeBusy" in value &&
    typeof value.getCalendarFreeBusy === "function"
  );
}

interface ConflictDetectActionParameters {
  subaction?: ConflictDetectSubaction | string;
  action?: ConflictDetectSubaction | string;
  op?: ConflictDetectSubaction | string;
  range?: "today" | "week" | ConflictRange | string;
  proposal?: ConflictDetectProposal;
  timeZone?: string;
  policy?: CalendarAvailabilityPolicy;
}

function metadataString(
  metadata: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = metadata[key];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function attendeeFromCalendarEvent(
  attendee: LifeOpsCalendarEvent["attendees"][number],
): CalendarAvailabilityAttendee {
  return {
    email: attendee.email,
    responseStatus: attendee.responseStatus,
    self: attendee.self,
    organizer: attendee.organizer,
    optional: attendee.optional,
  };
}

function allDayDateForCalendarEvent(
  event: LifeOpsCalendarEvent,
  instant: string,
): string {
  if (event.provider !== "apple_calendar" || !event.timezone?.trim()) {
    return instant.slice(0, 10);
  }
  const local = getZonedDateParts(new Date(instant), event.timezone);
  return `${String(local.year).padStart(4, "0")}-${String(local.month).padStart(
    2,
    "0",
  )}-${String(local.day).padStart(2, "0")}`;
}

function calendarEventForAvailability(
  event: LifeOpsCalendarEvent,
): ConflictDetectEvent {
  return {
    id: event.id,
    title: event.title,
    startISO: event.startAt,
    endISO: event.endAt,
    ...(event.isAllDay
      ? {
          startDate: allDayDateForCalendarEvent(event, event.startAt),
          endDate: allDayDateForCalendarEvent(event, event.endAt),
        }
      : {}),
    timeZone: event.timezone,
    isAllDay: event.isAllDay,
    status: event.status,
    transparency: metadataString(event.metadata, "transparency"),
    kind: calendarAvailabilityKindFromMetadata(event.metadata) ?? "event",
    attendees: event.attendees.map(attendeeFromCalendarEvent),
  };
}

function feedSourceStatus(
  feed: Pick<LifeOpsCalendarFeed, "source" | "syncedAt">,
): CalendarAvailabilitySourceStatus {
  if (feed.source === "cache") {
    return feed.syncedAt ? "stale" : "disconnected";
  }
  return "fresh";
}

function calendarSourceId(source: LifeOpsCalendarSourceHealth): string {
  const key = source.key;
  return [
    "owner-calendar",
    key.provider,
    key.side,
    key.grantId,
    key.connectorAccountId,
    key.calendarId,
  ]
    .map((part) => encodeURIComponent(part))
    .join(":");
}

function eventMatchesCalendarSource(
  event: LifeOpsCalendarEvent,
  source: LifeOpsCalendarSourceHealth,
): boolean {
  const key = source.key;
  return (
    event.provider === key.provider &&
    event.side === key.side &&
    event.calendarId === key.calendarId &&
    (!event.grantId || event.grantId === key.grantId) &&
    (!event.connectorAccountId ||
      event.connectorAccountId === key.connectorAccountId)
  );
}

function feedSourcesForAvailability(
  feed: LifeOpsCalendarFeed,
): CalendarAvailabilitySource[] {
  const events = feed.events.map(calendarEventForAvailability);
  const health = (feed as Partial<Pick<LifeOpsCalendarFeed, "sources">>)
    .sources;

  // Structural feed doubles may omit per-source health; production feeds use
  // an explicit empty array when no calendar source can be named.
  if (!Array.isArray(health)) {
    return [
      {
        id: "owner-calendar-feed",
        status: feedSourceStatus(feed),
        visibility: "details",
        events,
      },
    ];
  }

  const assignments = health.map((source) => ({
    source,
    events: [] as ConflictDetectEvent[],
  }));
  const unattributed: ConflictDetectEvent[] = [];
  for (let eventIndex = 0; eventIndex < feed.events.length; eventIndex += 1) {
    const event = feed.events[eventIndex];
    const normalized = events[eventIndex];
    if (!event || !normalized) continue;
    const matching = assignments.filter(({ source }) =>
      eventMatchesCalendarSource(event, source),
    );
    if (matching.length === 1) {
      matching[0]?.events.push(normalized);
    } else {
      unattributed.push(normalized);
    }
  }

  const sources: CalendarAvailabilitySource[] = assignments.map(
    ({ source, events: sourceEvents }) => ({
      id: calendarSourceId(source),
      status: source.status,
      visibility: source.visibility,
      events: sourceEvents,
      ...(source.error ? { error: source.error.message } : {}),
    }),
  );
  if (unattributed.length > 0) {
    sources.push({
      id: "owner-calendar-unattributed",
      status: "stale",
      visibility: "details",
      events: unattributed,
      error:
        "Some cached events could not be attributed to exactly one connected calendar.",
    });
  }
  return sources;
}

/**
 * Production loader for the owner's merged feed. Per-source health remains
 * authoritative, so a fresh cache can remain complete while stale, failed, or
 * disconnected calendars keep the aggregate result visibly incomplete.
 */
export function createCalendarFeedConflictLoader(): Pick<
  ConflictDetectLoader,
  "loadFeed" | "loadFreeBusy"
> {
  return {
    loadFeed: async ({ runtime, range }) => {
      const service = runtime.getService(CALENDAR_SERVICE_TYPE);
      if (!isCalendarConflictFeedService(service)) {
        throw new CalendarServiceError(
          503,
          "Calendar service is not available.",
          "CALENDAR_SERVICE_UNAVAILABLE",
        );
      }
      const feed = await service.getCalendarFeed(INTERNAL_URL, {
        side: "owner",
        timeMin: range.start,
        timeMax: range.end,
      });
      return {
        sources: feedSourcesForAvailability(feed),
      };
    },
    loadFreeBusy: async ({ runtime, guestAvailabilityGrantIds, range }) => {
      const service = runtime.getService(CALENDAR_SERVICE_TYPE);
      if (!isCalendarConflictFreeBusyService(service)) {
        throw new CalendarServiceError(
          503,
          "Calendar service is not available.",
          "CALENDAR_SERVICE_UNAVAILABLE",
        );
      }
      return service.getCalendarFreeBusy(INTERNAL_URL, {
        principalEntityId: SELF_ENTITY_ID,
        guestAvailabilityGrantIds,
        timeMin: range.start,
        timeMax: range.end,
      });
    },
  };
}

function getParams(
  options: HandlerOptions | undefined,
): ConflictDetectActionParameters {
  const raw = options?.parameters;
  return raw && typeof raw === "object"
    ? (raw as ConflictDetectActionParameters)
    : {};
}

function normalizeSubaction(value: unknown): ConflictDetectSubaction | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const simile = SIMILE_TO_SUBACTION[trimmed.toUpperCase()];
  if (simile) return simile;
  const normalized = trimmed.toLowerCase();
  return (SUBACTIONS as readonly string[]).includes(normalized)
    ? (normalized as ConflictDetectSubaction)
    : null;
}

function resolveSubaction(
  params: ConflictDetectActionParameters,
): ConflictDetectSubaction | null {
  return (
    normalizeSubaction(params.subaction) ??
    normalizeSubaction(params.action) ??
    normalizeSubaction(params.op)
  );
}

function hasExplicitOffset(value: string): boolean {
  const timeSeparator = value.indexOf("T");
  if (timeSeparator < 0 || timeSeparator >= value.length - 1) return false;
  if (value.endsWith("Z") || value.endsWith("z")) {
    return value.length - 1 > timeSeparator + 1;
  }
  const compactStart = value.length - 5;
  const colonStart = value.length - 6;
  const offsetStart = value[colonStart + 3] === ":" ? colonStart : compactStart;
  if (offsetStart <= timeSeparator + 1) return false;
  const sign = value[offsetStart];
  if (sign !== "+" && sign !== "-") return false;
  const digits =
    offsetStart === colonStart
      ? `${value.slice(offsetStart + 1, offsetStart + 3)}${value.slice(offsetStart + 4)}`
      : value.slice(offsetStart + 1);
  return (
    digits.length === 4 &&
    [...digits].every((digit) => digit >= "0" && digit <= "9")
  );
}

function validInstantRange(range: ConflictRange): boolean {
  if (!hasExplicitOffset(range.start) || !hasExplicitOffset(range.end)) {
    return false;
  }
  const start = Date.parse(range.start);
  const end = Date.parse(range.end);
  return Number.isFinite(start) && Number.isFinite(end) && end > start;
}

function validProposal(
  proposal: ConflictDetectProposal,
): proposal is ConflictDetectProposal {
  const grantIds = proposal.guestAvailabilityGrantIds;
  return (
    validInstantRange({
      start: proposal.startISO,
      end: proposal.endISO,
    }) &&
    (grantIds === undefined ||
      (Array.isArray(grantIds) &&
        grantIds.every(
          (grantId) => typeof grantId === "string" && grantId.trim().length > 0,
        )))
  );
}

function rangeContainsProposal(
  range: ConflictRange,
  proposal: ConflictDetectProposal,
): boolean {
  return (
    Date.parse(range.start) <= Date.parse(proposal.startISO) &&
    Date.parse(range.end) >= Date.parse(proposal.endISO)
  );
}

function resolveRange(args: {
  params: ConflictDetectActionParameters;
  subaction: ConflictDetectSubaction;
  proposal: ConflictDetectProposal | null;
  timeZone: string;
  now: Date;
}): ConflictRange | null {
  const raw = args.params.range;
  if (typeof raw === "object" && raw && "start" in raw && "end" in raw) {
    const range = raw as ConflictRange;
    return typeof range.start === "string" &&
      typeof range.end === "string" &&
      validInstantRange(range)
      ? range
      : null;
  }

  if (!raw && args.subaction === "scan_event_proposal" && args.proposal) {
    return {
      start: args.proposal.startISO,
      end: args.proposal.endISO,
    };
  }

  const named =
    typeof raw === "string"
      ? raw.trim().toLowerCase()
      : args.subaction === "scan_week"
        ? "week"
        : "today";
  if (named !== "today" && named !== "week") return null;
  return buildZonedCalendarRange({
    now: args.now,
    timeZone: args.timeZone,
    days: named === "week" ? 7 : 1,
  });
}

function normalizeLoadResult(
  result: ConflictDetectLoadResult,
  fallback: Omit<CalendarAvailabilitySource, "events">,
): CalendarAvailabilitySource[] {
  if (Array.isArray(result)) {
    return [{ ...fallback, events: result }];
  }
  if ("sources" in result) {
    return [...result.sources];
  }
  const batch = result as ConflictDetectLoadBatch;
  return [{ ...batch.source, events: batch.events }];
}

function privateBusySources(
  sources: readonly CalendarAvailabilitySource[],
): CalendarAvailabilitySource[] {
  return sources.map((source, index) => ({
    ...source,
    id: `guest-freebusy-${index + 1}`,
    visibility: "busy_only",
  }));
}

function requestedGuestGrantIds(proposal: ConflictDetectProposal): string[] {
  return [
    ...new Set(
      (proposal.guestAvailabilityGrantIds ?? [])
        .filter((grantId): grantId is string => typeof grantId === "string")
        .map((grantId) => grantId.trim())
        .filter(Boolean),
    ),
  ];
}

function requestedAttendeeCount(proposal: ConflictDetectProposal): number {
  return new Set(
    (proposal.attendees ?? [])
      .filter((attendee): attendee is string => typeof attendee === "string")
      .map((attendee) => attendee.trim().toLowerCase())
      .filter(Boolean),
  ).size;
}

async function defaultAuthorize(
  runtime: IAgentRuntime,
  message: Memory,
): Promise<boolean> {
  return hasRoleAccess(runtime, message, "OWNER");
}

async function defaultTimeZone(_runtime: IAgentRuntime): Promise<string> {
  return resolveDefaultTimeZone();
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
        text: "Checked the proposal against the connected calendars.",
        action: ACTION_NAME,
      },
    },
  ],
];

function unavailableResult(args: {
  subaction: ConflictDetectSubaction;
  text: string;
  detail?: string;
}): ActionResult {
  return {
    success: false,
    text: args.text,
    data: {
      subaction: args.subaction,
      error: "CALENDAR_UNAVAILABLE",
      ...(args.detail ? { detail: args.detail } : {}),
    },
  };
}

/**
 * Build a conflict action with host-specific authorization/timezone adapters.
 * The default instance uses the core OWNER role gate and host timezone.
 */
export function createConflictDetectAction(
  deps: ConflictDetectActionDeps = {},
): Action & { suppressPostActionContinuation?: boolean } {
  const authorize = (runtime: IAgentRuntime, message: Memory) =>
    (
      deps.authorize ??
      hostAdapters.get(runtime)?.authorize ??
      defaultAuthorize
    )(runtime, message);
  const resolveTimeZone = (runtime: IAgentRuntime) =>
    (
      deps.resolveTimeZone ??
      hostAdapters.get(runtime)?.resolveTimeZone ??
      defaultTimeZone
    )(runtime);
  const productionLoader = createCalendarFeedConflictLoader();

  return {
    name: ACTION_NAME,
    similes: [...SIMILE_NAMES],
    tags: [
      "domain:calendar",
      "capability:read",
      "capability:scan",
      "surface:internal",
    ],
    description:
      "Scan connected calendar overlaps and evaluate proposed windows without exposing private guest details. Subactions: scan_today, scan_week, scan_event_proposal.",
    descriptionCompressed:
      "calendar conflicts: scan_today|scan_week|scan_event_proposal; complete|partial|unavailable",
    routingHint:
      'calendar conflict-scan ("conflicts today", "does this slot work", "scan week overlaps") -> CONFLICT_DETECT; event mutation -> CALENDAR',
    contexts: ["calendar", "scheduling", "conflicts"],
    roleGate: { minRole: "OWNER" },
    suppressPostActionContinuation: true,
    validate: authorize,
    parameters: [
      {
        name: "action",
        description:
          "Conflict op: scan_today | scan_week | scan_event_proposal.",
        schema: { type: "string" as const, enum: [...SUBACTIONS] },
      },
      {
        name: "range",
        description:
          "'today' | 'week' or { start, end } RFC 3339 window with explicit offsets.",
        schema: {
          // anyOf, not oneOf: strict-mode provider grammars reject oneOf, and
          // a sibling `type` would contradict the string branch.
          anyOf: [
            { type: "string" as const, enum: ["today", "week"] },
            { type: "object" as const, additionalProperties: true },
          ],
        },
      },
      {
        name: "proposal",
        description:
          "scan_event_proposal candidate: { startISO, endISO, attendees?, guestAvailabilityGrantIds? }. Attendees only match already-visible events; external free/busy requires opaque host-issued grant ids.",
        schema: { type: "object" as const, additionalProperties: true },
      },
      {
        name: "timeZone",
        description: "IANA timezone used to resolve today/week boundaries.",
        schema: { type: "string" as const },
      },
      {
        name: "policy",
        description:
          "Optional deterministic policy overrides for tentative and all-day blockers.",
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
      if (!(await authorize(runtime, message))) {
        const text = "Conflict scans are restricted to the owner.";
        await callback?.({ text });
        return {
          text,
          success: false,
          data: { error: "PERMISSION_DENIED" },
        };
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
        if (!validProposal(candidate)) {
          return {
            success: false,
            text: "The proposal needs a valid start and end with explicit timezone offsets.",
            data: { subaction, error: "INVALID_PROPOSAL" },
          };
        }
        proposal = candidate;
      }

      let timeZone: string;
      try {
        timeZone =
          typeof params.timeZone === "string" && params.timeZone.trim()
            ? params.timeZone.trim()
            : await resolveTimeZone(runtime);
      } catch (error) {
        // error-policy:J1 action boundary translates timezone-source failure.
        const detail = error instanceof Error ? error.message : String(error);
        runtime.logger.warn(
          { src: "action:conflict-detect", subaction, detail },
          "Conflict scan timezone resolution failed",
        );
        const result = unavailableResult({
          subaction,
          text: "The calendar timezone is unavailable, so I can't scan for conflicts.",
          detail,
        });
        await callback?.({
          text: String(result.text),
          source: "action",
          action: ACTION_NAME,
        });
        return result;
      }

      let range: ConflictRange | null;
      try {
        range = resolveRange({
          params,
          subaction,
          proposal,
          timeZone,
          now: deps.now?.() ?? new Date(),
        });
      } catch (error) {
        // error-policy:J1 action boundary translates invalid timezone/range.
        const detail = error instanceof Error ? error.message : String(error);
        return {
          success: false,
          text: "I need a valid IANA timezone and calendar range to scan.",
          data: { subaction, error: "INVALID_RANGE", detail },
        };
      }
      if (!range) {
        return {
          success: false,
          text: "I need a valid range (today | week | { start, end }) to scan.",
          data: { subaction, error: "INVALID_RANGE" },
        };
      }
      if (proposal && !rangeContainsProposal(range, proposal)) {
        return {
          success: false,
          text: "The proposal must fall entirely inside the calendar range being scanned.",
          data: { subaction, error: "PROPOSAL_OUTSIDE_RANGE" },
        };
      }

      // Loader tiers mirror authorize/resolveTimeZone: explicit per-instance
      // deps, then the runtime-keyed host adapter (the only rebinding path for
      // an already-registered action), then the real CalendarService loader.
      const hostLoader = hostAdapters.get(runtime)?.loader;
      const loadFeed =
        deps.loader?.loadFeed ??
        hostLoader?.loadFeed ??
        productionLoader.loadFeed;
      let feedSources: CalendarAvailabilitySource[];
      try {
        const result = await loadFeed({ runtime, range });
        feedSources = normalizeLoadResult(result, {
          id: "owner-calendar-feed",
          status: "fresh",
          visibility: "details",
        });
      } catch (error) {
        // error-policy:J1 action boundary translates provider read failure.
        const detail = error instanceof Error ? error.message : String(error);
        runtime.logger.warn(
          { src: "action:conflict-detect", subaction, detail },
          "Conflict scan calendar feed load failed",
        );
        const result = unavailableResult({
          subaction,
          text: "The calendar is unavailable right now, so I can't scan for conflicts.",
          detail,
        });
        await callback?.({
          text: String(result.text),
          source: "action",
          action: ACTION_NAME,
        });
        return result;
      }

      const sources: CalendarAvailabilitySource[] = [...feedSources];
      const requestedGrantIds = proposal
        ? requestedGuestGrantIds(proposal)
        : [];
      const requestedGuestGrants = requestedGrantIds.length;
      const requestedAttendees = proposal
        ? requestedAttendeeCount(proposal)
        : 0;
      const requestedGuestAvailability =
        subaction === "scan_event_proposal" &&
        (requestedGuestGrants > 0 || requestedAttendees > 0);
      if (requestedGuestAvailability && proposal) {
        if (requestedGuestGrants === 0) {
          sources.push({
            id: "guest-freebusy-authorization",
            status: "disconnected",
            visibility: "busy_only",
            events: [],
            error:
              "Guest free/busy requires a current host-issued availability grant.",
          });
        }
        const loadFreeBusy =
          requestedGuestGrants > 0
            ? (deps.loader?.loadFreeBusy ??
              hostLoader?.loadFreeBusy ??
              productionLoader.loadFreeBusy)
            : undefined;
        if (requestedGuestGrants > 0 && !loadFreeBusy) {
          sources.push({
            id: "guest-freebusy",
            status: "disconnected",
            visibility: "busy_only",
            events: [],
            error: "Guest free/busy provider is not connected.",
          });
        } else if (loadFreeBusy) {
          try {
            const result = await loadFreeBusy({
              runtime,
              guestAvailabilityGrantIds: requestedGrantIds,
              range: {
                start: proposal.startISO,
                end: proposal.endISO,
              },
            });
            const guestSources = privateBusySources(
              normalizeLoadResult(result, {
                id: "guest-freebusy",
                status: "fresh",
                visibility: "busy_only",
              }),
            );
            sources.push(...guestSources);
            if (guestSources.length < requestedGuestGrants) {
              sources.push({
                id: "guest-freebusy-incomplete",
                status: "disconnected",
                visibility: "busy_only",
                events: [],
                error: "Guest availability coverage is incomplete.",
              });
            }
          } catch (error) {
            // error-policy:J4 the partial result remains visibly incomplete.
            const detail =
              error instanceof Error ? error.message : String(error);
            runtime.logger.warn(
              {
                src: "action:conflict-detect",
                subaction,
                errorType: error instanceof Error ? error.name : "UnknownError",
              },
              "Conflict scan guest free/busy load failed",
            );
            sources.push({
              id: "guest-freebusy",
              status: "error",
              visibility: "busy_only",
              events: [],
              error: detail,
            });
          }
        }
      }

      let evaluation: CalendarAvailabilityEvaluation;
      try {
        evaluation = evaluateCalendarAvailability({
          range,
          timeZone,
          sources,
          ...(proposal ? { proposal } : {}),
          ...(params.policy ? { policy: params.policy } : {}),
        });
      } catch (error) {
        // error-policy:J1 invalid provider data is a visible scan failure.
        const detail = error instanceof Error ? error.message : String(error);
        runtime.logger.warn(
          { src: "action:conflict-detect", subaction, detail },
          "Conflict scan rejected invalid availability data",
        );
        const text =
          "The calendar returned invalid timing data, so I can't give a reliable conflict scan.";
        await callback?.({ text, source: "action", action: ACTION_NAME });
        return {
          success: false,
          text,
          data: { subaction, error: "CALENDAR_INVALID_DATA", detail },
        };
      }

      runtime.logger.info(
        {
          src: "action:conflict-detect",
          subaction,
          checkedEvents: evaluation.checkedEvents,
          conflicts: evaluation.conflicts.length,
          completeness: evaluation.completeness,
        },
        "Calendar conflict scan completed",
      );
      await callback?.({
        text: evaluation.summary,
        source: "action",
        action: ACTION_NAME,
      });
      return {
        success: evaluation.completeness !== "unavailable",
        text: evaluation.summary,
        data: {
          subaction,
          ...evaluation,
          ...(evaluation.completeness === "partial"
            ? { warning: "CALENDAR_INCOMPLETE" }
            : {}),
          ...(evaluation.completeness === "unavailable"
            ? { error: "CALENDAR_UNAVAILABLE" }
            : {}),
        },
      };
    },
  };
}

export const conflictDetectAction = createConflictDetectAction();

export default conflictDetectAction;
