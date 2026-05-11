/**
 * `CONFLICT_DETECT` umbrella action — proactive calendar conflict scanning.
 *
 * PRD: `prd-lifeops-executive-assistant.md` §Calendar And Scheduling. Today
 * the agent only detects conflicts reactively (during create_event); the
 * scenario matrix calls for the agent to proactively scan today's calendar /
 * the week ahead, and to evaluate a proposed event against an attendee set.
 *
 * Subactions:
 *   - `scan_today`            — find overlaps on today's calendar
 *   - `scan_week`             — find overlaps in the next seven days
 *   - `scan_event_proposal`   — given a proposed start/end (and optionally
 *                               attendees), find direct conflicts against the
 *                               owner's calendar feed
 *
 * Behavior: reads the calendar feed via the injectable loader (Wave-2 wires
 * `CALENDAR.feed`) and compares event windows for overlap. Attendee freebusy
 * is NOT consulted unless the loader injects it — the Wave-1 scaffold falls
 * back to feed-vs-feed comparison when freebusy is unavailable.
 *
 * Owner-or-admin gating: `hasLifeOpsAccess` covers OWNER; ADMIN is also valid
 * for read scans of the owner's calendar in the Wave-2 dispatch surface.
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
import { hasLifeOpsAccess } from "../lifeops/access.js";

const ACTION_NAME = "CONFLICT_DETECT";

const SUBACTIONS = [
  "scan_today",
  "scan_week",
  "scan_event_proposal",
] as const;

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

/**
 * Loader hook. Wave-2 wires this to `CALENDAR.feed`. Wave-1 returns an empty
 * feed by default so tests can inject scenario data.
 *
 * TODO Wave-2: also expose a freebusy loader for attendee conflict checks —
 * for now `scan_event_proposal` only considers the owner's own feed.
 */
export interface ConflictDetectLoader {
  loadFeed: (args: {
    runtime: IAgentRuntime;
    range: ConflictRange;
  }) => Promise<readonly ConflictDetectEvent[]>;
}

const defaultLoader: ConflictDetectLoader = {
  loadFeed: async () => [],
};

let activeLoader: ConflictDetectLoader = defaultLoader;

export function setConflictDetectLoader(
  next: Partial<ConflictDetectLoader>,
): void {
  activeLoader = { ...activeLoader, ...next };
}

export function __resetConflictDetectLoaderForTests(): void {
  activeLoader = defaultLoader;
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
}): readonly ConflictDetectPair[] {
  const proposalEvent: ConflictDetectEvent = {
    id: "proposal",
    title: "Proposed event",
    startISO: args.proposal.startISO,
    endISO: args.proposal.endISO,
    ...(args.proposal.attendees ? { attendees: args.proposal.attendees } : {}),
  };
  const conflicts: ConflictDetectPair[] = [];
  for (const candidate of args.feed) {
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
    { name: "{{name1}}", content: { text: "Any conflicts on my calendar today?" } },
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
    "Proactively scan the owner's calendar for overlapping events, or evaluate a proposed event window against the owner's feed. Subactions: scan_today, scan_week, scan_event_proposal.",
  descriptionCompressed:
    "calendar conflicts: scan_today|scan_week|scan_event_proposal; severity warning|hard based on attendee overlap",
  routingHint:
    'calendar conflict-scan intent ("any conflicts today", "does this slot work", "scan my week for overlaps") -> CONFLICT_DETECT; reactive conflict-on-create stays on CALENDAR.create_event',
  contexts: ["calendar", "scheduling", "conflicts"],
  roleGate: { minRole: "OWNER" },
  suppressPostActionContinuation: true,
  validate: async (runtime, message) => hasLifeOpsAccess(runtime, message),
  parameters: [
    {
      name: "subaction",
      description:
        "Which scan to run: scan_today | scan_week | scan_event_proposal.",
      schema: { type: "string" as const, enum: [...SUBACTIONS] },
    },
    {
      name: "range",
      description:
        "Either 'today' | 'week' or an explicit { start, end } ISO window. Defaults to subaction's natural range.",
      schema: { type: "object" as const, additionalProperties: true },
    },
    {
      name: "proposal",
      description:
        "scan_event_proposal only: { startISO, endISO, attendees? } describing the candidate event.",
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

    if (subaction === "scan_event_proposal") {
      const proposal = params.proposal;
      if (
        !proposal ||
        typeof proposal.startISO !== "string" ||
        typeof proposal.endISO !== "string"
      ) {
        return {
          success: false,
          text: "I need a proposal with startISO and endISO to evaluate.",
          data: { subaction, error: "MISSING_PROPOSAL" },
        };
      }
      const feed = await activeLoader.loadFeed({ runtime, range });
      const conflicts = detectProposalConflicts({ proposal, feed });
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
    }

    const feed = await activeLoader.loadFeed({ runtime, range });
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
