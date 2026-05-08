import type {
  Action,
  ActionExample,
  ActionResult,
  ProviderDataRecord,
} from "@elizaos/core";
import { CheckinService } from "../lifeops/checkin/checkin-service.js";
import type { CheckinReport } from "../lifeops/checkin/types.js";
import { LifeOpsService } from "../lifeops/service.js";
import {
  resolveActionArgs,
  type SubactionsMap,
} from "./lib/resolve-action-args.js";

const ACTION_NAME = "CHECKIN";

type CheckinSubaction = "morning" | "night";

const SUBACTIONS: SubactionsMap<CheckinSubaction> = {
  morning: {
    description:
      "Run the morning check-in: assemble the owner's start-of-day operating picture.",
    descriptionCompressed:
      "morning checkin start-of-day operating picture todos meetings inbox socials github calendar followups wins",
    required: [],
  },
  night: {
    description:
      "Run the night check-in: review the owner's end-of-day picture for the day.",
    descriptionCompressed:
      "night checkin end-of-day picture wins outstanding socials github followups inbox calendar loose-ends tomorrow",
    required: [],
  },
};

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

export const checkinAction: Action & {
  suppressPostActionContinuation?: boolean;
} = {
  name: ACTION_NAME,
  similes: [
    "DAILY_BRIEF",
    "MORNING_BRIEF",
    "EVENING_BRIEF",
    "NIGHT_BRIEF",
    "DAY_RECAP",
    "DAILY_REVIEW",
    "START_MY_DAY",
    "END_OF_DAY",
    "WHATS_GOING_ON",
    "DAILY_DIGEST",
  ],
  tags: [
    "always-include",
    "morning check-in",
    "night check-in",
    "start of day",
    "end of day",
  ],
  description:
    "Owner-only. Daily check-in: morning (start-of-day operating picture: overdue todos, today's meetings, " +
    "priority inbox via cross-channel triage, X/socials, GitHub, calendar changes, follow-ups, contacted people, " +
    "yesterday's wins) or night (end-of-day picture: today's wins, completed sends, outstanding todos, " +
    "X/socials, GitHub, follow-ups, inbox/calendar loose ends for tomorrow).",
  descriptionCompressed:
    "daily checkin: morning(start-of-day overdue meetings priority-inbox socials github calendar followups wins) night(end-of-day wins outstanding loose-ends-tomorrow)",
  contexts: ["tasks", "calendar", "contacts", "messaging", "health", "memory"],
  roleGate: { minRole: "OWNER" },
  suppressPostActionContinuation: true,
  validate: async () => true,
  parameters: [
    {
      name: "subaction",
      description: "One of: morning, night.",
      required: false,
      schema: { type: "string" as const },
    },
  ],
  handler: async (runtime, message, state, options): Promise<ActionResult> => {
    const resolved = await resolveActionArgs<
      CheckinSubaction,
      Record<string, never>
    >({
      runtime,
      message,
      state,
      options,
      actionName: ACTION_NAME,
      subactions: SUBACTIONS,
    });
    if (!resolved.ok) {
      return {
        success: false,
        text: resolved.clarification,
        data: { actionName: ACTION_NAME, missing: resolved.missing },
      };
    }

    const service = new CheckinService(runtime, {
      sources: new LifeOpsService(runtime),
    });
    const roomId =
      typeof message.roomId === "string" ? message.roomId : undefined;
    const report =
      resolved.subaction === "morning"
        ? await service.runMorningCheckin({ roomId })
        : await service.runNightCheckin({ roomId });
    return {
      text: formatCheckinReportText(report),
      success: true,
      data: reportToActionData(report),
    };
  },
  examples: [
    [
      {
        name: "{{name1}}",
        content: { text: "Let's do my morning check-in." },
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
        content: { text: "How did today go?" },
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
