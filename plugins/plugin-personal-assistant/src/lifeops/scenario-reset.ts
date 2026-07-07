/**
 * Per-scenario reset of the shared LifeOps scheduling state, for the
 * scenario-runner corpus lane only.
 *
 * The scenario CLI instantiates PGLite once and reuses ONE runtime + DB across
 * every scenario in the corpus (recreating the native binding segfaults), so
 * "per-scenario isolation" is cooperative: each scenario must start from a
 * clean slate. Scheduling state is the sharp edge — a scenario that injects a
 * future `now` (persona packs tick days ahead) persists a `sleeping` circadian
 * state and leaves scheduled-task rows behind; a LATER scenario running at its
 * own earlier wall clock then reads that state as authoritative and suppresses
 * its reminders as "probable_sleep". Owner facts (timezone, windows, quiet
 * hours, active travel) leak the same way. Clearing both here makes each
 * scenario independent of run order without weakening any assertion.
 *
 * Production never crosses scenarios and never rewinds the clock, so this has
 * no production caller — the executor invokes it between scenarios.
 */

import type { IAgentRuntime } from "@elizaos/core";

import { resolveOwnerFactStore } from "./owner/fact-store.js";
import { LifeOpsRepository } from "./repository.js";

export async function resetLifeOpsScenarioState(
  runtime: IAgentRuntime,
): Promise<void> {
  await new LifeOpsRepository(runtime).resetSchedulingStateForScenario(
    runtime.agentId,
  );
  await resolveOwnerFactStore(runtime).clear();
}
