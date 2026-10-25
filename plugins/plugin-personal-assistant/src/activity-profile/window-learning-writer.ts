/**
 * Runtime binding for the ActivityProfile → OwnerFacts window learner
 * (issue #12186, D.2.1). The pure mapping + override logic lives in
 * `window-learning.ts`; this module reads the current owner facts, derives the
 * learned windows from a profile rhythm sample, applies the override /
 * idempotency policy, and writes the patch through `OwnerFactStore.update`
 * with `agent_inferred` provenance.
 *
 * Called from the proactive worker after it rebuilds/refreshes the
 * `ActivityProfile`, so a fresh rhythm estimate flows straight into the
 * flexible-scheduling primitives (`during_window`, wake/bedtime anchors).
 */

import type { IAgentRuntime } from "@elizaos/core";
import { logger } from "@elizaos/core";
import type { OwnerFactProvenance } from "../lifeops/owner/fact-store.js";
import { resolveOwnerFactStore } from "../lifeops/owner/fact-store.js";
import {
  deriveWindowsFromRhythm,
  type RhythmSample,
  resolveWindowPatch,
} from "./window-learning.js";

export interface LearnRhythmWindowsResult {
  /** Whether a patch was written. */
  wrote: boolean;
  /** The keys that were updated (subset of morningWindow/eveningWindow). */
  updated: Array<"morningWindow" | "eveningWindow">;
}

/**
 * Learn morning/evening windows from an observed rhythm sample and persist any
 * writable delta into `OwnerFacts`. User-owned windows are never clobbered and
 * matching windows are skipped (idempotent). `now` is injectable for tests.
 */
export async function learnRhythmWindows(
  runtime: IAgentRuntime,
  sample: RhythmSample,
  now: Date = new Date(),
): Promise<LearnRhythmWindowsResult> {
  const store = resolveOwnerFactStore(runtime);
  const current = await store.read();
  const learned = deriveWindowsFromRhythm(sample);
  const patch = resolveWindowPatch(current, learned);
  if (!patch) {
    return { wrote: false, updated: [] };
  }

  const provenance: OwnerFactProvenance = {
    source: "agent_inferred",
    recordedAt: now.toISOString(),
    note: "learned from observed wake/sleep rhythm (ActivityProfile)",
  };
  await store.update(patch, provenance);

  const updated: Array<"morningWindow" | "eveningWindow"> = [];
  if (patch.morningWindow) updated.push("morningWindow");
  if (patch.eveningWindow) updated.push("eveningWindow");

  logger.info(
    {
      src: "lifeops:activity-profile:window-learning",
      agentId: runtime.agentId,
      updated,
    },
    "[window-learning] wrote learned rhythm windows into owner facts",
  );

  return { wrote: true, updated };
}
