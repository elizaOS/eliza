import type { Action, ProviderDataRecord } from "@elizaos/core";
import { hasOwnerAccess } from "@elizaos/agent";
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
    "Run the morning check-in: assemble overdue todos, today's meetings, and yesterday's wins for the owner.",
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
};

export const runNightCheckinAction: Action = {
  name: "RUN_NIGHT_CHECKIN",
  similes: ["NIGHT_CHECKIN", "START_NIGHT_CHECKIN", "EVENING_CHECKIN"],
  description:
    "Run the night check-in: review today's meetings, completed wins, and any overdue todos for the owner.",
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
};
