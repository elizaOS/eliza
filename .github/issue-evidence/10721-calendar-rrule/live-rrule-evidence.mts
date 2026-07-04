/**
 * LIVE-LLM evidence run for issue #11788 / #10721 (calendar RRULE semantics).
 *
 * Drives the PRODUCTION CALENDAR action handler end to end with a REAL model:
 * every planner/extraction prompt the handler builds is answered by the
 * `claude` CLI (claude-haiku, live inference — no mock, no proxy). The
 * CalendarService seam is spied so the resulting provider-bound requests
 * (recurrence lines, recurrenceScope, target event ids) are captured verbatim.
 *
 * Run:  bun plugins/plugin-calendar/live-rrule-evidence.mts
 * Output: JSON trajectory (prompt in / raw model out / service calls / reply)
 * on stdout — captured into .github/issue-evidence/10721-calendar-rrule/.
 */

import { execFileSync } from "node:child_process";
import type { IAgentRuntime, Memory } from "@elizaos/core";
import type { LifeOpsCalendarEvent } from "@elizaos/shared";
import type {
  CalendarActionDeps,
  CalendarModelCallArgs,
} from "./src/actions/deps.ts";
import { createCalendarActionRunner } from "./src/index.ts";

interface TrajectoryEntry {
  scenario: string;
  actionType: string;
  prompt: string;
  rawResponse: string;
}

const trajectory: TrajectoryEntry[] = [];
let currentScenario = "";

function callClaude(prompt: string): string {
  return execFileSync(
    "claude",
    ["-p", "--model", "haiku", "--output-format", "text", prompt],
    { encoding: "utf8", timeout: 120_000, maxBuffer: 4 * 1024 * 1024 },
  ).trim();
}

function parseJsonRecord(raw: string): Record<string, unknown> | null {
  const stripped = raw.replace(/```(?:json)?/gi, "").trim();
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(stripped.slice(start, end + 1));
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

const deps: CalendarActionDeps = {
  runTextModel: async (args: CalendarModelCallArgs) => {
    const raw = callClaude(args.prompt);
    trajectory.push({
      scenario: currentScenario,
      actionType: args.actionType,
      prompt: args.prompt,
      rawResponse: raw,
    });
    return raw;
  },
  runJsonModel: async (args: CalendarModelCallArgs) => {
    const raw = callClaude(args.prompt);
    trajectory.push({
      scenario: currentScenario,
      actionType: args.actionType,
      prompt: args.prompt,
      rawResponse: raw,
    });
    return { rawResponse: raw, parsed: parseJsonRecord(raw) as never };
  },
  recentConversationTexts: async () => [],
};

function event(args: {
  externalId: string;
  title: string;
  recurringEventId?: string;
  recurrence?: string[];
}): LifeOpsCalendarEvent {
  return {
    id: `agent-1:google:owner:calendar:primary:${args.externalId}`,
    externalId: args.externalId,
    agentId: "agent-1",
    provider: "google",
    side: "owner",
    calendarId: "primary",
    title: args.title,
    description: "",
    location: "",
    status: "confirmed",
    startAt: "2026-07-08T17:00:00.000Z",
    endAt: "2026-07-08T17:30:00.000Z",
    isAllDay: false,
    timezone: "America/New_York",
    htmlLink: null,
    conferenceLink: null,
    organizer: null,
    attendees: [],
    recurrence: args.recurrence ?? null,
    recurringEventId: args.recurringEventId ?? null,
    metadata: {
      ...(args.recurringEventId
        ? { recurringEventId: args.recurringEventId }
        : {}),
      ...(args.recurrence ? { recurrence: args.recurrence } : {}),
    },
    syncedAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    grantId: "connector-account:acct-a",
  };
}

const STANDUP = event({
  externalId: "standup_20260708T170000Z",
  title: "Team Standup",
  recurringEventId: "standup-master",
  recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=WE"],
});

const serviceCalls: Array<{
  scenario: string;
  method: string;
  request: unknown;
}> = [];

function stubService() {
  const record = (method: string) => (_url: URL, request: unknown) => {
    serviceCalls.push({ scenario: currentScenario, method, request });
    if (method === "createCalendarEvent") {
      return Promise.resolve(
        event({
          externalId: "created-master",
          title:
            ((request as Record<string, unknown>).title as string) ?? "Created",
          recurrence:
            ((request as Record<string, unknown>).recurrence as string[]) ??
            undefined,
        }),
      );
    }
    if (method === "updateCalendarEvent") {
      return Promise.resolve({ ...STANDUP, title: "Team Standup (updated)" });
    }
    return Promise.resolve(undefined);
  };
  return {
    getCalendarFeed: async () => ({
      calendarId: "all",
      events: [STANDUP],
      source: "cache" as const,
      timeMin: "2026-07-01T00:00:00.000Z",
      timeMax: "2026-07-31T00:00:00.000Z",
      syncedAt: null,
    }),
    createCalendarEvent: record("createCalendarEvent"),
    updateCalendarEvent: record("updateCalendarEvent"),
    deleteCalendarEvent: record("deleteCalendarEvent"),
  };
}

const service = stubService();
const runtime = {
  agentId: "agent-1",
  logger: {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
  },
  getService: (name: string) => (name === "calendar" ? service : null),
} as unknown as IAgentRuntime;

function message(text: string): Memory {
  return {
    id: "00000000-0000-0000-0000-000000000101",
    entityId: "00000000-0000-0000-0000-000000000102",
    roomId: "00000000-0000-0000-0000-000000000103",
    content: { text },
  } as unknown as Memory;
}

const action = createCalendarActionRunner(deps);

async function run(scenario: string, text: string) {
  currentScenario = scenario;
  const result = (await action.handler(
    runtime,
    message(text),
    undefined,
    { parameters: {} },
    undefined,
  )) as { success: boolean; text: string };
  return { scenario, userMessage: text, reply: result };
}

const results = [];
// 1. Live model must plan create_event AND extract the RRULE itself.
results.push(
  await run(
    "create-recurring",
    "book a 30 minute morning run on my calendar every monday at 7am eastern, starting monday july 6 2026",
  ),
);
// 2. Ambiguous mutation of a recurring occurrence must clarify, not mutate.
results.push(
  await run("update-ambiguous", "move my team standup to 10am"),
);
// 3. Explicit single-occurrence intent must patch only the instance.
results.push(
  await run(
    "update-instance",
    "move just this one team standup occurrence to 10am",
  ),
);
// 4. Explicit series intent must delete the whole series in one call.
results.push(
  await run("delete-series", "delete the whole series of my team standup"),
);

console.log(
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      model: "claude CLI (haiku, live)",
      results,
      serviceCalls,
      trajectory,
    },
    null,
    2,
  ),
);
