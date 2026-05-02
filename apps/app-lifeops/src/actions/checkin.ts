import { hasOwnerAccess } from "@elizaos/agent/security/access";
import type { Action, ActionExample, ProviderDataRecord } from "@elizaos/core";
import { CheckinService } from "../lifeops/checkin/checkin-service.js";
import type { CheckinReport } from "../lifeops/checkin/types.js";
import { LifeOpsService } from "../lifeops/service.js";

/**
 * Actions for the morning/night check-in engine. The actions expose explicit
 * chat and scenario-runner entry points; scheduler wiring lives in the LifeOps
 * runtime task worker.
 */

function reportToActionData(report: CheckinReport): ProviderDataRecord {
  return {
    reportId: report.reportId,
    kind: report.kind,
    generatedAt: report.generatedAt,
    escalationLevel: report.escalationLevel,
    overdueTodos: report.overdueTodos,
    todaysMeetings: report.todaysMeetings,
    yesterdaysWins: report.yesterdaysWins,
    habitSummaries: report.habitSummaries,
    habitEscalationLevel: report.habitEscalationLevel,
    briefingSections: report.briefingSections,
    summaryText: report.summaryText,
    collectorErrors: {
      overdueTodos: report.collectorErrors.overdueTodos,
      todaysMeetings: report.collectorErrors.todaysMeetings,
      yesterdaysWins: report.collectorErrors.yesterdaysWins,
    },
  };
}

/**
 * Deterministic human-readable summary of a CheckinReport. Callers that want
 * an LLM-rendered briefing should feed this plus the raw report into
 * `runtime.useModel(TEXT_LARGE, ...)` — this helper is the minimum truthful
 * text so the action no longer returns `text: ""` while its examples promise
 * a rich summary.
 *
 * When a collector's SQL query throws (e.g. a LifeOps table is not yet
 * provisioned), we MUST NOT claim "0 overdue todos" — that conflates
 * "nothing found" with "source unavailable". Those sections get an explicit
 * "(unavailable: <reason>)" marker instead.
 */
function formatCheckinReportText(report: CheckinReport): string {
  if (report.summaryText.trim().length > 0) {
    return report.summaryText;
  }
  const prefix =
    report.kind === "morning" ? "Morning check-in" : "Night check-in";
  const overdueErr = report.collectorErrors.overdueTodos;
  const meetingsErr = report.collectorErrors.todaysMeetings;
  const winsErr = report.collectorErrors.yesterdaysWins;

  const overdue = report.overdueTodos.length;
  const meetings = report.todaysMeetings.length;
  const wins = report.yesterdaysWins.length;

  const overduePart = overdueErr
    ? `overdue todos (unavailable: ${overdueErr})`
    : `${overdue} overdue todo${overdue === 1 ? "" : "s"}`;
  const meetingsLabel = report.kind === "morning" ? "today" : "logged today";
  const meetingsPart = meetingsErr
    ? `meetings ${meetingsLabel} (unavailable: ${meetingsErr})`
    : `${meetings} meeting${meetings === 1 ? "" : "s"} ${meetingsLabel}`;
  const winsLabel =
    report.kind === "morning" ? "from yesterday" : "to carry forward";
  const winsPart = winsErr
    ? `wins ${winsLabel} (unavailable: ${winsErr})`
    : `${wins} win${wins === 1 ? "" : "s"} ${winsLabel}`;
  const habitPart =
    report.habitSummaries.length === 0
      ? "0 tracked habits"
      : `${report.habitSummaries.length} tracked habit${report.habitSummaries.length === 1 ? "" : "s"}${report.habitEscalationLevel > 0 ? `, missed-streak escalation ${report.habitEscalationLevel}` : ""}`;
  const pausedHabit = report.habitSummaries.find((habit) => habit.isPaused);
  const pausedPart = pausedHabit
    ? pausedHabit.pauseUntil
      ? `, paused ${pausedHabit.title} until ${pausedHabit.pauseUntil}`
      : `, paused ${pausedHabit.title}`
    : "";

  return `${prefix}: ${[overduePart, meetingsPart, winsPart, habitPart + pausedPart].join(", ")}.`;
}

export const runMorningCheckinAction: Action & {
  suppressPostActionContinuation?: boolean;
} = {
  name: "RUN_MORNING_CHECKIN",
  tags: ["always-include", "morning check-in", "start of day"],
  similes: [
    "MORNING_CHECKIN",
    "START_MORNING_CHECKIN",
    "MORNING_ROUTINE_CHECKIN",
    "MORNING_REVIEW",
    "MORNING_BRIEFING",
    "START_MY_DAY",
    "MORNING_BRIEF",
    "DAILY_BRIEF",
    "WHAT_MATTERS_TODAY",
    "TODAYS_PRIORITIES",
    "OPERATING_PICTURE",
    "COMMAND_CENTER",
  ],
  description:
    "Run the morning check-in: assemble the owner's start-of-day operating picture across overdue todos, today's meetings, " +
    "priority inbox items, X/socials, GitHub, calendar changes, promises/follow-ups, contacted people, and yesterday's wins. Use this for explicit start-of-day review requests like 'run my morning check-in', " +
    "'morning review', 'morning brief', 'start my day', 'what matters today', 'today's priorities', 'what's on my plate this morning', " +
    "'give me my operating picture', or 'show me the command center for today'. " +
    "When the owner asks for a morning brief or morning check-in, you must call this action rather than replying conversationally. " +
    "This is an umbrella action: do not split the request into separate inbox, calendar, blocker-status, or todo-status actions. " +
    "This action still owns the request when the output combines inbox, calendar, and task review in one morning briefing. " +
    "It is not an inbox-only digest, unread-only cross-channel summary, or generic reply workflow.",
  suppressPostActionContinuation: true,
  validate: async (runtime, message) => hasOwnerAccess(runtime, message),
  handler: async (runtime, message) => {
    if (!(await hasOwnerAccess(runtime, message))) {
      return {
        text: "",
        success: false,
        data: { error: "PERMISSION_DENIED" },
      };
    }
    const service = new CheckinService(runtime, {
      sources: new LifeOpsService(runtime),
    });
    const report = await service.runMorningCheckin({
      roomId: typeof message.roomId === "string" ? message.roomId : undefined,
    });
    return {
      text: formatCheckinReportText(report),
      success: true,
      data: reportToActionData(report),
    };
  },
  parameters: [],
  examples: [
    [
      {
        name: "{{name1}}",
        content: {
          text: "Let's do my morning check-in.",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Here's your morning review: 2 overdue todos, 3 meetings today, and yesterday you closed out the onboarding draft.",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "What's on my plate this morning?",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Morning check-in ready: 1 overdue todo, 2 meetings today, and yesterday's wins included the PR review.",
        },
      },
    ],
  ] as ActionExample[][],
};

export const runNightCheckinAction: Action & {
  suppressPostActionContinuation?: boolean;
} = {
  name: "RUN_NIGHT_CHECKIN",
  tags: ["always-include", "night check-in", "end of day"],
  similes: [
    "NIGHT_CHECKIN",
    "START_NIGHT_CHECKIN",
    "EVENING_CHECKIN",
    "EVENING_WRAP_UP",
    "END_OF_DAY_REVIEW",
    "HOW_DID_TODAY_GO",
    "NIGHT_BRIEF",
    "DAILY_WRAP_UP",
    "END_OF_DAY_BRIEF",
    "DAY_RECAP",
    "WHAT_HAPPENED_TODAY",
    "DAY_REVIEW",
  ],
  description:
    "Run the night check-in: review the owner's end-of-day picture across today's meetings, completed wins, outstanding todos, X/socials, GitHub, contacted people, promises/follow-ups, and any inbox or calendar loose ends that matter for tomorrow. " +
    "Use this for explicit end-of-day review requests like 'give me my night check-in', 'evening wrap-up', 'night brief', 'daily wrap-up', " +
    "'end of day review', 'end-of-day brief', 'day recap', 'what happened today', or 'how did today go?'. " +
    "When the owner asks for a night brief or night check-in, you must call this action rather than replying conversationally. " +
    "This is an umbrella action: do not split the request into separate inbox, calendar, blocker-status, or todo-status actions. " +
    "This action still owns the request when the output combines inbox, calendar, and task review in one nightly recap. " +
    "It is not an inbox-only digest, unread-only cross-channel summary, or generic reply workflow.",
  suppressPostActionContinuation: true,
  validate: async (runtime, message) => hasOwnerAccess(runtime, message),
  handler: async (runtime, message) => {
    if (!(await hasOwnerAccess(runtime, message))) {
      return {
        text: "",
        success: false,
        data: { error: "PERMISSION_DENIED" },
      };
    }
    const service = new CheckinService(runtime, {
      sources: new LifeOpsService(runtime),
    });
    const report = await service.runNightCheckin({
      roomId: typeof message.roomId === "string" ? message.roomId : undefined,
    });
    return {
      text: formatCheckinReportText(report),
      success: true,
      data: reportToActionData(report),
    };
  },
  parameters: [],
  examples: [
    [
      {
        name: "{{name1}}",
        content: {
          text: "Ready to wrap up for the day.",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Here's your night check-in: 3 meetings done, 2 wins captured, 1 todo still open for tomorrow.",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "How did today go?",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Night recap ready: you closed 2 meetings and shipped the release notes; 1 todo rolls over.",
        },
      },
    ],
  ] as ActionExample[][],
};
