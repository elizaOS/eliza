/**
 * Default pack: `morning-brief`.
 *
 * One assembler `ScheduledTask` triggered on `wake.confirmed`. Delegates the
 * assembly to the existing `CheckinService.runMorningCheckin` (per GAP §2.8 —
 * `lifeops/checkin/*` becomes the assembly logic invoked by the daily-check-in
 * `ScheduledTask`'s prompt).
 *
 * **Parity contract:** the message body produced from this pack must match
 * the `CheckinService.runMorningCheckin().summaryText` for the same inputs.
 * `test/default-pack-morning-brief.parity.test.ts` asserts this.
 *
 * Stub anchor resolution per IMPL §3.1 risk-and-tradeoff: `wake.confirmed`
 * resolves to `ownerFact.morningWindow.start` until plugin-health (W1-B)
 * ships the real anchor.
 *
 * Stub status: see `contract-stubs.ts` — `ScheduledTask` types are local
 * until W1-A's `src/lifeops/scheduled-task/types.ts` lands.
 */

import type { IAgentRuntime } from "@elizaos/core";
import {
  buildCheckinSummaryPrompt,
  CheckinService,
  type CheckinSourceService,
} from "../lifeops/checkin/checkin-service.js";
import type { CheckinKind, CheckinReport } from "../lifeops/checkin/types.js";
import type { ScheduledTaskSeed } from "./contract-stubs.js";
import type { DefaultPack } from "./registry-types.js";

export const MORNING_BRIEF_PACK_KEY = "morning-brief";

export const MORNING_BRIEF_RECORD_IDS = {
  brief: "default-pack:morning-brief:assembler",
} as const;

const morningBriefRecord: ScheduledTaskSeed = {
  kind: "recap",
  promptInstructions:
    "Assemble the owner's morning brief from LifeOps source data: overdue todos, today's meetings, yesterday's wins, tracked habits, inbox/calendar/contacts/promises. Rank for genuinely interesting, important, reply-needed, or schedule-changing items. Keep it concise. No invented facts; if a source is unavailable, say so in one clause. Use the existing morning-checkin assembler — do not regenerate the briefing structure.",
  contextRequest: {
    includeOwnerFacts: ["preferredName", "morningWindow", "timezone"],
  },
  trigger: {
    kind: "relative_to_anchor",
    anchorKey: "wake.confirmed",
    offsetMinutes: 0,
  },
  priority: "medium",
  respectsGlobalPause: true,
  source: "default_pack",
  createdBy: MORNING_BRIEF_PACK_KEY,
  ownerVisible: true,
  idempotencyKey: MORNING_BRIEF_RECORD_IDS.brief,
  metadata: {
    packKey: MORNING_BRIEF_PACK_KEY,
    recordKey: "morning-brief",
    // Parity contract: assembly delegates to CheckinService.runMorningCheckin.
    delegatesAssemblyTo: "lifeops:checkin:morning",
  },
};

export const morningBriefPack: DefaultPack = {
  key: MORNING_BRIEF_PACK_KEY,
  label: "Morning brief",
  description:
    "Assembled morning briefing on wake — overdue todos, meetings, wins, inbox, calendar, contacts, promises. Delegates assembly to the scheduled briefing service, so a fresh user gets the same content the planner would.",
  defaultEnabled: true,
  records: [morningBriefRecord],
  uiHints: {
    summaryOnDayOne:
      "One assembled briefing in the morning — same content as the existing `/morning check-in`.",
    expectedFireCountPerDay: 1,
  },
};

/**
 * Assembly helper used by the runner when this pack's `ScheduledTask` fires.
 * Returned shape is `{ promptText, report }` so the caller can decide whether
 * to render the prompt (stub anchor resolution scenario) or use `summaryText`
 * directly.
 *
 * The scheduled briefing assembler is shared with the interactive morning
 * briefing workflow; this is the parity contract.
 */
export async function assembleMorningBrief(
  runtime: IAgentRuntime,
  options: {
    timezone?: string;
    now?: Date;
    sources?: CheckinSourceService;
  } = {},
): Promise<{
  promptText: string;
  report: CheckinReport;
}> {
  const service = new CheckinService(runtime, { sources: options.sources });
  const report = await service.runMorningCheckin({
    timezone: options.timezone,
    now: options.now,
  });
  // Re-build the prompt text for parity assertion. CheckinService also
  // produces this internally inside `runCheckin`, but it isn't exposed; for
  // the parity test we recompute from the persisted report shape.
  const { summaryText: _summary, ...reportWithoutSummary } = report;
  const promptText = buildCheckinSummaryPrompt(reportWithoutSummary);
  return { promptText, report };
}

/** Exposed for tests: the prompt-builder produces deterministic text from a report. */
export function buildMorningBriefPromptFromReport(
  report: Omit<CheckinReport, "summaryText"> & {
    kind: Extract<CheckinKind, "morning">;
  },
): string {
  return buildCheckinSummaryPrompt(report);
}
