/**
 * Runtime binding for the sleep-regularity → `scheduleStyle`/`chronotype`
 * owner-fact learner (issue #12284, WI-5). The classification rules live in
 * `schedule-style.ts` as pure functions; this module loads the persisted
 * sleep episodes, derives the classes, applies the user-override / idempotency
 * policy, and writes any delta through `OwnerFactStore.update` with
 * `agent_inferred` provenance — making the owner's schedule shape queryable
 * outside the legacy schedule-insight path.
 *
 * Called from the activity-profile proactive worker tick (the existing
 * periodic path — never a second scheduler). Safe at tick cadence: the write
 * is idempotent, so an unchanged classification produces zero writes.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { logger } from "@elizaos/core";
import type { SleepRegularityEpisodeLike } from "@elizaos/plugin-health";
import { listHistoricalSleepEpisodes } from "@elizaos/plugin-health";
import { resolveDefaultTimeZone } from "../defaults.js";
import { LifeOpsRepository } from "../repository.js";
import type {
  OwnerChronotype,
  OwnerFactProvenance,
  OwnerScheduleStyle,
} from "./fact-store.js";
import { resolveOwnerFactStore } from "./fact-store.js";
import {
  buildScheduleStyleSample,
  deriveChronotype,
  deriveScheduleStyle,
  resolveScheduleStylePatch,
} from "./schedule-style.js";

/** Look-back window feeding the classification (matches the SRI default). */
const SCHEDULE_STYLE_WINDOW_DAYS = 28;

export interface LearnScheduleStyleResult {
  /** Whether a patch was written. */
  wrote: boolean;
  /** The keys that were updated (subset of scheduleStyle/chronotype). */
  updated: Array<"scheduleStyle" | "chronotype">;
  /** Derived classification this pass (null = insufficient evidence). */
  scheduleStyle: OwnerScheduleStyle | null;
  chronotype: OwnerChronotype | null;
}

/**
 * Derive and persist the schedule-style facts from an explicit episode set.
 * Split from {@link learnScheduleStyleFacts} so tests can drive the full
 * writer path without a database. `now` is injectable for tests.
 */
export async function learnScheduleStyleFromEpisodes(
  runtime: IAgentRuntime,
  args: {
    episodes: readonly SleepRegularityEpisodeLike[];
    timezone: string;
  },
  now: Date = new Date(),
): Promise<LearnScheduleStyleResult> {
  const sample = buildScheduleStyleSample({
    episodes: args.episodes,
    timezone: args.timezone,
    nowMs: now.getTime(),
  });
  const scheduleStyle = deriveScheduleStyle(sample);
  // A rotating sleeper's circular-mean mid-sleep mixes shift blocks into a
  // meaningless average, so chronotype is only derived for the other styles.
  const chronotype =
    scheduleStyle !== null && scheduleStyle !== "rotating"
      ? deriveChronotype(sample.baseline)
      : null;

  const store = resolveOwnerFactStore(runtime);
  const current = await store.read();
  const patch = resolveScheduleStylePatch(current, {
    scheduleStyle,
    chronotype,
  });
  if (!patch) {
    return { wrote: false, updated: [], scheduleStyle, chronotype };
  }

  const provenance: OwnerFactProvenance = {
    source: "agent_inferred",
    recordedAt: now.toISOString(),
    note: "learned from observed sleep regularity (schedule insight)",
  };
  await store.update(patch, provenance);

  const updated: Array<"scheduleStyle" | "chronotype"> = [];
  if (patch.scheduleStyle) updated.push("scheduleStyle");
  if (patch.chronotype) updated.push("chronotype");

  logger.info(
    {
      src: "lifeops:owner:schedule-style",
      agentId: runtime.agentId,
      updated,
      scheduleStyle,
      chronotype,
      regularityClass: sample.regularity.regularityClass,
      sampleCount: sample.regularity.sampleCount,
    },
    "[schedule-style] wrote learned schedule classification into owner facts",
  );

  return { wrote: true, updated, scheduleStyle, chronotype };
}

/**
 * Production entry point: loads the persisted sleep-episode history for the
 * classification window and delegates to the episode-driven writer. The
 * timezone is the owner's stored fact (falling back to the host default) so
 * wake minutes land in the owner's local clock.
 */
export async function learnScheduleStyleFacts(
  runtime: IAgentRuntime,
  now: Date = new Date(),
): Promise<LearnScheduleStyleResult> {
  const store = resolveOwnerFactStore(runtime);
  const facts = await store.read();
  const timezone = facts.timezone?.value ?? resolveDefaultTimeZone();
  const repository = new LifeOpsRepository(runtime);
  const episodes = await listHistoricalSleepEpisodes({
    repository,
    agentId: runtime.agentId,
    nowMs: now.getTime(),
    windowDays: SCHEDULE_STYLE_WINDOW_DAYS,
  });
  return learnScheduleStyleFromEpisodes(runtime, { episodes, timezone }, now);
}
