/**
 * Live-model CONFLICT_DETECT over a triple overlap plus one declined invite. Four
 * real rows are seeded into the LifeOps calendar-event store and read back through
 * a repository-backed loader wired via the production `setConflictDetectLoader`
 * seam (all-day and owner-declined events excluded, as in production). Asserts the
 * real action result: scan 1 surfaces exactly the two genuine overlap pairs (A,B)
 * and (B,C) with checkedEvents=3, and after the owner reschedules the gym block a
 * re-scan leaves exactly one conflict (A,B).
 */
import type {
  CapturedAction,
  ScenarioContext,
  ScenarioTurnExecution,
} from "@elizaos/scenario-runner/schema";
import { scenario } from "@elizaos/scenario-runner/schema";
import {
  createCalendarFeedConflictLoader,
  setConflictDetectLoader,
} from "../../src/actions/conflict-detect.ts";

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const HOUR_MS = 60 * 60_000;
const BASE = new Date(Date.now() + 26 * HOUR_MS);

function at(offsetMinutes: number): string {
  return new Date(BASE.getTime() + offsetMinutes * 60_000).toISOString();
}

const EVENTS = {
  designReview: {
    externalId: "scenario-triple-overlap-design-review",
    title: "Design review",
    startAt: at(0),
    endAt: at(60),
    declined: false,
  },
  investorCall: {
    externalId: "scenario-triple-overlap-investor-call",
    title: "Investor call",
    startAt: at(30),
    endAt: at(90),
    declined: false,
  },
  gymBlock: {
    externalId: "scenario-triple-overlap-gym-block",
    title: "Gym block",
    startAt: at(75),
    endAt: at(120),
    declined: false,
  },
  vendorPitch: {
    externalId: "scenario-triple-overlap-vendor-pitch",
    title: "Vendor pitch",
    startAt: at(0),
    endAt: at(120),
    declined: true,
  },
} as const;

const GYM_RESCHEDULED_START = at(4 * 60);
const GYM_RESCHEDULED_END = at(5 * 60);

// ---------------------------------------------------------------------------
// Repository access (structural, same pattern as the lifeops workflow-event
// scenarios in packages/test/scenarios).
// ---------------------------------------------------------------------------

interface CalendarEventRecordLike {
  id: string;
  externalId: string;
  agentId: string;
  provider: string;
  side: string;
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
  organizer: unknown;
  attendees: Array<{
    email: string;
    displayName: string | null;
    responseStatus: string | null;
    self: boolean;
    organizer: boolean;
    optional: boolean;
  }>;
  metadata: JsonRecord;
  syncedAt: string;
  updatedAt: string;
}

interface RepositoryLike {
  upsertCalendarEvent: (
    event: CalendarEventRecordLike,
    side?: string,
  ) => Promise<void>;
  listCalendarEvents: (
    agentId: string,
    provider: string,
    timeMin?: string,
    timeMax?: string,
    side?: string,
  ) => Promise<CalendarEventRecordLike[]>;
  deleteCalendarEventByExternalId: (
    agentId: string,
    provider: string,
    calendarId: string | null | undefined,
    externalEventId: string,
    side?: string,
  ) => Promise<void>;
}

interface LifeOpsServiceLike {
  repository: RepositoryLike;
  agentId: () => string;
}

interface RuntimeLike {
  getService?: (serviceType: string) => unknown;
}

let seededRepository: RepositoryLike | null = null;
let seededAgentId: string | null = null;

function buildEventRecord(spec: {
  externalId: string;
  title: string;
  startAt: string;
  endAt: string;
  declined: boolean;
}): CalendarEventRecordLike {
  if (!seededAgentId) throw new Error("agentId unavailable before seed");
  const nowIso = new Date().toISOString();
  return {
    id: `${seededAgentId}:google:owner:calendar:primary:${spec.externalId}`,
    externalId: spec.externalId,
    agentId: seededAgentId,
    provider: "google",
    side: "owner",
    calendarId: "primary",
    title: spec.title,
    description: "",
    location: "",
    status: spec.declined ? "declined" : "confirmed",
    startAt: spec.startAt,
    endAt: spec.endAt,
    isAllDay: false,
    timezone: "UTC",
    htmlLink: null,
    conferenceLink: null,
    organizer: null,
    attendees: [
      {
        email: "owner@example.com",
        displayName: "Owner",
        responseStatus: spec.declined ? "declined" : "accepted",
        self: true,
        organizer: false,
        optional: false,
      },
    ],
    metadata: { scenario: "calendar-triple-overlap" },
    syncedAt: nowIso,
    updatedAt: nowIso,
  };
}

function ownerDeclined(event: CalendarEventRecordLike): boolean {
  if (event.status === "declined" || event.status === "cancelled") return true;
  return event.attendees.some(
    (attendee) => attendee.self && attendee.responseStatus === "declined",
  );
}

async function seedFeedAndLoader(
  ctx: ScenarioContext,
): Promise<string | undefined> {
  const runtime = ctx.runtime as RuntimeLike;
  const service = runtime.getService?.("lifeops") as
    | LifeOpsServiceLike
    | null
    | undefined;
  if (!service?.repository) {
    return "LifeOps service is not registered on the runtime";
  }
  seededRepository = service.repository;
  seededAgentId = service.agentId();

  for (const spec of Object.values(EVENTS)) {
    await service.repository.upsertCalendarEvent(buildEventRecord(spec));
  }

  // Repository-backed loader through the production seam: real store rows,
  // owner-committed-feed contract (no all-day, no owner-declined invites).
  setConflictDetectLoader({
    loadFeed: async ({ range }) => {
      if (!seededRepository || !seededAgentId) {
        throw new Error("scenario calendar store unavailable");
      }
      const rows = await seededRepository.listCalendarEvents(
        seededAgentId,
        "google",
        range.start,
        range.end,
        "owner",
      );
      return rows
        .filter((event) => !event.isAllDay)
        .filter((event) => !ownerDeclined(event))
        .map((event) => ({
          id: event.externalId,
          title: event.title,
          startISO: event.startAt,
          endISO: event.endAt,
        }));
    },
  });
  return undefined;
}

async function cleanupFeedAndLoader(): Promise<string | undefined> {
  // Restore the production CalendarService-backed loader and remove the
  // seeded rows so subsequent scenarios in a shared runtime see a clean store.
  setConflictDetectLoader(createCalendarFeedConflictLoader());
  if (seededRepository && seededAgentId) {
    for (const spec of Object.values(EVENTS)) {
      await seededRepository.deleteCalendarEventByExternalId(
        seededAgentId,
        "google",
        "primary",
        spec.externalId,
        "owner",
      );
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Assertions over the CONFLICT_DETECT action result payload
// ---------------------------------------------------------------------------

interface ConflictPairView {
  titleA: string;
  titleB: string;
}

function readScanPayload(action: CapturedAction):
  | {
      conflicts: ConflictPairView[];
      checkedEvents: number;
    }
  | string {
  if (action.result?.success !== true) {
    return `expected CONFLICT_DETECT success=true, saw ${JSON.stringify(action.result)}`;
  }
  const data = action.result?.data;
  if (!isRecord(data)) {
    return `expected CONFLICT_DETECT data object, saw ${JSON.stringify(data)}`;
  }
  const conflictsRaw = Array.isArray(data.conflicts) ? data.conflicts : [];
  const conflicts: ConflictPairView[] = [];
  for (const pair of conflictsRaw) {
    if (!isRecord(pair)) continue;
    const eventA = isRecord(pair.eventA) ? pair.eventA : null;
    const eventB = isRecord(pair.eventB) ? pair.eventB : null;
    conflicts.push({
      titleA: String(eventA?.title ?? "?"),
      titleB: String(eventB?.title ?? "?"),
    });
  }
  const checkedEvents =
    typeof data.checkedEvents === "number" ? data.checkedEvents : -1;
  return { conflicts, checkedEvents };
}

function conflictDetectAction(
  execution: ScenarioTurnExecution,
): CapturedAction | string {
  const action = execution.actionsCalled.find(
    (candidate) => candidate.actionName === "CONFLICT_DETECT",
  );
  return (
    action ??
    `expected a CONFLICT_DETECT action, saw ${
      execution.actionsCalled.map((entry) => entry.actionName).join(", ") ||
      "none"
    }`
  );
}

function pairMatches(
  pair: ConflictPairView,
  titleX: string,
  titleY: string,
): boolean {
  return (
    (pair.titleA === titleX && pair.titleB === titleY) ||
    (pair.titleA === titleY && pair.titleB === titleX)
  );
}

function assertScanPayload(
  action: CapturedAction,
  expectedPairs: Array<[string, string]>,
): string | undefined {
  const payload = readScanPayload(action);
  if (typeof payload === "string") return payload;
  if (payload.checkedEvents !== 3) {
    return `expected checkedEvents=3 (declined "Vendor pitch" excluded from the scanned feed), saw ${payload.checkedEvents}`;
  }
  const declinedMention = payload.conflicts.find(
    (pair) =>
      pair.titleA === EVENTS.vendorPitch.title ||
      pair.titleB === EVENTS.vendorPitch.title,
  );
  if (declinedMention) {
    return `declined "Vendor pitch" must not appear in any conflict pair, saw ${JSON.stringify(payload.conflicts)}`;
  }
  if (payload.conflicts.length !== expectedPairs.length) {
    return `expected exactly ${expectedPairs.length} conflict pair(s), saw ${JSON.stringify(payload.conflicts)}`;
  }
  for (const [titleX, titleY] of expectedPairs) {
    if (!payload.conflicts.some((pair) => pairMatches(pair, titleX, titleY))) {
      return `missing expected conflict pair (${titleX}, ${titleY}); saw ${JSON.stringify(payload.conflicts)}`;
    }
  }
  return undefined;
}

async function assertFirstScanThenReschedule(
  execution: ScenarioTurnExecution,
): Promise<string | undefined> {
  const action = conflictDetectAction(execution);
  if (typeof action === "string") return action;
  const failure = assertScanPayload(action, [
    [EVENTS.designReview.title, EVENTS.investorCall.title],
    [EVENTS.investorCall.title, EVENTS.gymBlock.title],
  ]);
  if (failure) return failure;

  // The owner now moves the gym block out of the clash. There is no
  // headless calendar-write path in the scenario runtime (event CRUD needs
  // a Google grant / Apple bridge — see calendar-conflict-resolve-outcome),
  // so the move lands the way a provider sync would: written into the real
  // calendar-event store the loader reads.
  if (!seededRepository) return "scenario calendar store unavailable";
  await seededRepository.upsertCalendarEvent(
    buildEventRecord({
      ...EVENTS.gymBlock,
      startAt: GYM_RESCHEDULED_START,
      endAt: GYM_RESCHEDULED_END,
    }),
  );
  return undefined;
}

function assertRescanShowsOneConflict(
  execution: ScenarioTurnExecution,
): string | undefined {
  const action = conflictDetectAction(execution);
  if (typeof action === "string") return action;
  return assertScanPayload(action, [
    [EVENTS.designReview.title, EVENTS.investorCall.title],
  ]);
}

function assertBothScansCaptured(ctx: ScenarioContext): string | undefined {
  const scans = (ctx.actionsCalled ?? []).filter(
    (action) => action.actionName === "CONFLICT_DETECT",
  );
  if (scans.length < 2) {
    return `expected two CONFLICT_DETECT scans, saw ${scans.length}`;
  }
  const first = scans[0];
  const last = scans[scans.length - 1];
  if (!first || !last) return "conflict scans missing";
  const firstFailure = assertScanPayload(first, [
    [EVENTS.designReview.title, EVENTS.investorCall.title],
    [EVENTS.investorCall.title, EVENTS.gymBlock.title],
  ]);
  if (firstFailure) return `first scan: ${firstFailure}`;
  const lastFailure = assertScanPayload(last, [
    [EVENTS.designReview.title, EVENTS.investorCall.title],
  ]);
  return lastFailure ? `re-scan: ${lastFailure}` : undefined;
}

export default scenario({
  lane: "live-only",
  id: "calendar-triple-overlap",
  title:
    "CONFLICT_DETECT surfaces both real overlaps, excludes the declined invite, and a reschedule leaves exactly one conflict",
  domain: "calendar",
  tags: ["lifeops", "calendar", "conflict", "outcome", "declined"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  seed: [
    {
      type: "custom",
      name: "seed 4 calendar rows (3 committed, 1 declined) + repository-backed conflict loader",
      apply: seedFeedAndLoader,
    },
  ],
  cleanup: [
    {
      type: "custom",
      name: "restore the production conflict loader and delete seeded rows",
      apply: cleanupFeedAndLoader,
    },
  ],
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "Calendar Triple Overlap",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "scan: both real overlaps surface, declined invite excluded",
      text: "Check my calendar for scheduling conflicts this week — do any of my meetings overlap?",
      plannerIncludesAny: ["CONFLICT_DETECT", "conflict", "overlap"],
      assertTurn: assertFirstScanThenReschedule,
    },
    {
      kind: "message",
      name: "re-scan after the gym block moved: exactly one conflict remains",
      text: "I moved the gym block to later in the day. Re-check my week for conflicts — what's still overlapping?",
      plannerIncludesAny: ["CONFLICT_DETECT", "conflict", "overlap"],
      assertTurn: assertRescanShowsOneConflict,
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "action payloads: 2 conflicts then 1, declined invite never paired, checkedEvents=3",
      predicate: assertBothScansCaptured,
    },
    {
      type: "judgeRubric",
      name: "conflict report names the clashing meetings and reflects the resolution",
      minimumScore: 0.6,
      rubric:
        "In the first answer the assistant reported that the design review overlaps the investor call AND that the investor call overlaps the gym block, without claiming the declined vendor pitch conflicts with anything. In the second answer, after the gym block moved, the assistant reported that only the design-review/investor-call overlap remains. Deduct for invented conflicts, for mentioning the vendor pitch as a conflict, or for failing to acknowledge the resolved gym-block clash.",
    },
  ],
});
