import type { Action, ActionExample, ProviderDataRecord } from "@elizaos/core";
import { hasOwnerAccess } from "@elizaos/agent/security/access";
import { CheckinService } from "../lifeops/checkin/checkin-service.js";
import type { CheckinReport } from "../lifeops/checkin/types.js";

/**
 * Actions for T9f morning/night check-in engine (plan §6.23). These expose the
 * entry points used by the scenario runner. Automatic cron firing at the
 * user-configured morning/night times is a follow-up PR (T9f-followup-PR).
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
  };
}

export const runMorningCheckinAction: Action = {
  name: "RUN_MORNING_CHECKIN",
  similes: [
    "MORNING_CHECKIN",
    "START_MORNING_CHECKIN",
    "MORNING_ROUTINE_CHECKIN",
  ],
  description:
    "Run the morning check-in: assemble overdue todos, today's meetings, and yesterday's wins for the owner. Use this for a dedicated morning self-review/check-in, not for inbox daily briefs, unread cross-channel summaries, or reply workflows.",
  validate: async (runtime, message) => hasOwnerAccess(runtime, message),
  handler: async (runtime, message) => {
    if (!(await hasOwnerAccess(runtime, message))) {
      return {
        text: "",
        success: false,
        data: { error: "PERMISSION_DENIED" },
      };
    }
    const service = new CheckinService(runtime);
    const report = await service.runMorningCheckin({
      roomId:
        typeof message.roomId === "string" ? message.roomId : undefined,
    });
    return {
      text: "",
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

export const runNightCheckinAction: Action = {
  name: "RUN_NIGHT_CHECKIN",
  similes: ["NIGHT_CHECKIN", "START_NIGHT_CHECKIN", "EVENING_CHECKIN"],
  description:
    "Run the night check-in: review today's meetings, completed wins, and any overdue todos for the owner. Use this for a dedicated evening wrap-up, not for inbox daily briefs, unread cross-channel summaries, or reply workflows.",
  validate: async (runtime, message) => hasOwnerAccess(runtime, message),
  handler: async (runtime, message) => {
    if (!(await hasOwnerAccess(runtime, message))) {
      return {
        text: "",
        success: false,
        data: { error: "PERMISSION_DENIED" },
      };
    }
    const service = new CheckinService(runtime);
    const report = await service.runNightCheckin({
      roomId:
        typeof message.roomId === "string" ? message.roomId : undefined,
    });
    return {
      text: "",
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
