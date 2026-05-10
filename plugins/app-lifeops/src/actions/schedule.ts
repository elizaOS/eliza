import type {
  Action,
  ActionExample,
  ActionResult,
  HandlerOptions,
  IAgentRuntime,
  Memory,
} from "@elizaos/core";
import { getCircadianInsightContract } from "@elizaos/plugin-health";
import { hasLifeOpsAccess } from "../lifeops/access.js";
import { resolveDefaultTimeZone } from "../lifeops/defaults.js";
import { toActionData } from "../lifeops/google/format-helpers.js";
import type { LifeOpsScheduleInspection } from "../lifeops/schedule-insight.js";
import { LifeOpsService } from "../lifeops/service.js";

type ScheduleSubaction = "summary" | "inspect";

type OwnerScheduleParameters = {
  subaction?: ScheduleSubaction | string;
  timezone?: string;
};

function messageText(message: Memory): string {
  return (message?.content?.text ?? "").toString().toLowerCase();
}

function coerceSubaction(value: unknown, text: string): ScheduleSubaction {
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "inspect") {
      return "inspect";
    }
    if (normalized === "summary") {
      return "summary";
    }
  }
  return /\b(?:why|explain|inspect|evidence|how do you know)\b/i.test(text)
    ? "inspect"
    : "summary";
}

function formatScheduleSummary(inspection: LifeOpsScheduleInspection): string {
  const { insight } = inspection;
  const bedtimeRelative =
    insight.relativeTime.minutesUntilBedtimeTarget !== null
      ? `in ${insight.relativeTime.minutesUntilBedtimeTarget} minutes`
      : insight.relativeTime.minutesSinceBedtimeTarget !== null
        ? `${insight.relativeTime.minutesSinceBedtimeTarget} minutes ago`
        : "still calibrating";
  const isAsleepState =
    insight.circadianState === "sleeping" ||
    insight.circadianState === "napping";
  const lines = [
    `Circadian state: ${insight.circadianState} (${Math.round(insight.stateConfidence * 100)}% confidence)${
      insight.uncertaintyReason ? ` — ${insight.uncertaintyReason}` : ""
    }.`,
    insight.relativeTime.minutesSinceWake !== null
      ? `Relative time: woke ${insight.relativeTime.minutesSinceWake} minutes ago; bedtime target ${
          insight.relativeTime.bedtimeTargetAt ?? "unknown"
        } ${bedtimeRelative}.`
      : insight.relativeTime.minutesUntilBedtimeTarget !== null
        ? `Relative time: bedtime target ${
            insight.relativeTime.bedtimeTargetAt ?? "unknown"
          } in ${insight.relativeTime.minutesUntilBedtimeTarget} minutes.`
        : insight.relativeTime.minutesSinceBedtimeTarget !== null
          ? `Relative time: bedtime target ${
              insight.relativeTime.bedtimeTargetAt ?? "unknown"
            } was ${insight.relativeTime.minutesSinceBedtimeTarget} minutes ago.`
          : "Relative time: still calibrating wake and bedtime anchors.",
    isAsleepState
      ? insight.currentSleepStartedAt
        ? `Likely asleep since ${insight.currentSleepStartedAt} (${Math.round(insight.sleepConfidence * 100)}% confidence).`
        : `Likely asleep now (${Math.round(insight.sleepConfidence * 100)}% confidence).`
      : insight.lastSleepEndedAt
        ? `Last inferred wake: ${insight.lastSleepEndedAt}${insight.lastSleepDurationMinutes ? ` after ${insight.lastSleepDurationMinutes} minutes asleep` : ""}.`
        : `Sleep status: ${insight.sleepStatus}.`,
  ];
  if (insight.nextMealLabel && insight.nextMealWindowStartAt) {
    lines.push(
      `Next ${insight.nextMealLabel} window: ${insight.nextMealWindowStartAt} to ${insight.nextMealWindowEndAt ?? "unknown"} (${Math.round(insight.nextMealConfidence * 100)}% confidence).`,
    );
  } else if (insight.lastMealAt) {
    lines.push(`Last inferred meal: ${insight.lastMealAt}.`);
  } else {
    lines.push("Meal pattern is still calibrating.");
  }
  return lines.join("\n");
}

function formatScheduleInspection(
  inspection: LifeOpsScheduleInspection,
): string {
  const { counts, insight } = inspection;
  const lines = [formatScheduleSummary(inspection)];
  lines.push("");
  lines.push(
    `Signals: ${counts.activitySignalCount} activity signals, ${counts.activityEventCount} app events, ${counts.screenTimeSessionCount} screen-time sessions, ${counts.mergedWindowCount} merged activity windows.`,
  );
  if (inspection.sleepEpisodes.length > 0) {
    lines.push("Sleep episodes:");
    for (const episode of inspection.sleepEpisodes.slice(-3)) {
      lines.push(
        `- ${episode.source} ${episode.startAt} → ${episode.endAt ?? "now"} (${episode.durationMinutes}m, ${Math.round(episode.confidence * 100)}%)`,
      );
    }
  }
  if (inspection.mealCandidates.length > 0) {
    lines.push("Meal candidates:");
    for (const meal of inspection.mealCandidates) {
      lines.push(
        `- ${meal.label} at ${meal.detectedAt} via ${meal.source} (${Math.round(meal.confidence * 100)}%)`,
      );
    }
  } else if (insight.nextMealLabel) {
    lines.push(
      `No completed meal candidates yet. Current best guess is ${insight.nextMealLabel}.`,
    );
  }
  return lines.join("\n");
}

function scheduleInspectionActionData(
  inspection: LifeOpsScheduleInspection,
): Record<string, unknown> {
  return {
    insight: inspection.insight,
    windows: inspection.windows,
    sleepEpisodes: inspection.sleepEpisodes,
    mealCandidates: inspection.mealCandidates,
    counts: inspection.counts,
  };
}

export const scheduleAction: Action = {
  name: "SCHEDULE",
  similes: ["SLEEP_INFERENCE", "MEAL_INFERENCE"],
  description:
    "Owner-only. Inspect LifeOps passive schedule inference from local activity, screen-time, and optional health signals. " +
    "Use this for questions like 'did I sleep?', 'when did I wake up?', 'what do you think my schedule is?', or 'why do you think I ate lunch?'. " +
    "Subactions: summary (default high-level answer) or inspect (show the evidence windows, sleep episodes, and meal candidates).",
  descriptionCompressed:
    "passive schedule inference activity+screen-time+health: summary | inspect(sleep meals evidence-windows)",
  contexts: ["calendar", "tasks", "health", "screen_time"],
  roleGate: { minRole: "OWNER" },
  validate: async (runtime, message) => hasLifeOpsAccess(runtime, message),
  parameters: [
    {
      name: "subaction",
      description: "Optional. summary or inspect.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "timezone",
      description: "Optional IANA timezone override.",
      required: false,
      schema: { type: "string" as const },
    },
  ],
  examples: [
    [
      {
        name: "{{name1}}",
        content: { text: "Did I sleep last night?" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Schedule phase: morning.\nLast inferred wake: 2026-04-19T07:30:00.000Z after 480 minutes asleep.",
          action: "SCHEDULE",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "Why do you think I had lunch?" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Schedule phase: afternoon.\n...\nMeal candidates:\n- lunch at 2026-04-19T13:05:00.000Z via activity_gap (78%)",
          action: "SCHEDULE",
        },
      },
    ],
  ] as ActionExample[][],
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state,
    options,
    callback,
  ): Promise<ActionResult> => {
    if (!(await hasLifeOpsAccess(runtime, message))) {
      const text = "Schedule inference is restricted to the owner.";
      await callback?.({ text });
      return { text, success: false, data: { error: "PERMISSION_DENIED" } };
    }

    const params = ((options as HandlerOptions | undefined)?.parameters ??
      {}) as OwnerScheduleParameters;
    const subaction = coerceSubaction(params.subaction, messageText(message));
    const timezone =
      typeof params.timezone === "string" && params.timezone.trim().length > 0
        ? params.timezone.trim()
        : resolveDefaultTimeZone();

    // W3-C drift D-4: consult the CircadianInsightContract registered by
    // plugin-health for high-level sleep / scheduling reads. The contract
    // is the typed seam between this action and plugin-health's circadian
    // domain; the detailed inspection view still goes through
    // LifeOpsService.inspectSchedule because the inspection record is
    // produced by app-lifeops's own scheduler tick.
    const circadianContract = getCircadianInsightContract(runtime);
    const sleepWindow = circadianContract
      ? await circadianContract.getCurrentSleepWindow({ timezone })
      : null;

    const service = new LifeOpsService(runtime);
    const inspection = await service.inspectSchedule({ timezone });
    const text =
      subaction === "inspect"
        ? formatScheduleInspection(inspection)
        : formatScheduleSummary(inspection);
    const data = toActionData({
      ...scheduleInspectionActionData(inspection),
      ...(sleepWindow
        ? { circadianContractView: sleepWindow }
        : { circadianContractView: null }),
    });
    await callback?.({
      text,
      data: data as any,
    });
    return {
      text,
      success: true,
      data: data as any,
    };
  },
};
