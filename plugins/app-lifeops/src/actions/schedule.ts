import type {
  ActionResult,
  HandlerCallback,
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

/**
 * Handler function for the passive schedule inference subactions
 * (`summary`, `inspect`).
 *
 * Folded out of the legacy `SCHEDULE` action surface — Audit F. The umbrella
 * in `./owner-surfaces.ts` (OWNER_ROUTINES `schedule_summary` /
 * `schedule_inspect` verbs) is the only caller; no `SCHEDULE`-named action
 * is registered.
 */
export async function runScheduleHandler(
  runtime: IAgentRuntime,
  message: Memory,
  _state: unknown,
  options: HandlerOptions | undefined,
  callback?: HandlerCallback,
): Promise<ActionResult> {
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

  // Consult the CircadianInsightContract registered by plugin-health for
  // high-level sleep / scheduling reads. The contract is the typed seam
  // between this action and plugin-health's circadian domain; the detailed
  // inspection view still goes through LifeOpsService.inspectSchedule because
  // the inspection record is produced by app-lifeops's own scheduler tick.
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
}
