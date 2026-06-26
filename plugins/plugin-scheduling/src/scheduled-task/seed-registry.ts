/**
 * Generic default-task seed registry + boot seeder.
 *
 * A consumer plugin registers one or more "task packs" (arrays of
 * `ScheduledTaskInput`) via {@link registerDefaultTaskPack}. The boot seeder
 * {@link seedRegisteredTaskPacks} materializes them through the runner exactly
 * once per idempotency key on this device — a default the user later deletes is
 * never resurrected. `@elizaos/plugin-scheduling` ships ZERO packs; the seed
 * mechanism is the generic primitive, the packs are the consumer's domain
 * content.
 *
 * The seed-once marker is stored in the runtime cache so it survives restarts.
 */

import { type IAgentRuntime, logger } from "@elizaos/core";
import type { ScheduledTaskRunnerHandle } from "./runner.js";
import type { ScheduledTask, ScheduledTaskInput } from "./types.js";

const SEED_MARKER_CACHE_KEY = "eliza:scheduling:seeded-defaults:v1";

export interface DefaultTaskPack {
  /** Stable id for diagnostics / dedup of pack registrations. */
  id: string;
  /** The task inputs to seed. Each SHOULD carry an `idempotencyKey`. */
  tasks: ScheduledTaskInput[];
}

type PackCarrier = {
  __scheduledTaskDefaultPacks?: Map<string, DefaultTaskPack>;
};

function packMap(runtime: IAgentRuntime): Map<string, DefaultTaskPack> {
  const carrier = runtime as unknown as PackCarrier;
  if (!carrier.__scheduledTaskDefaultPacks) {
    carrier.__scheduledTaskDefaultPacks = new Map();
  }
  return carrier.__scheduledTaskDefaultPacks;
}

/**
 * Register a default-task pack. Re-registering the same `pack.id` replaces the
 * prior registration (last-wins) so a consumer can refresh its pack as facts
 * change without accumulating duplicates.
 */
export function registerDefaultTaskPack(
  runtime: IAgentRuntime,
  pack: DefaultTaskPack,
): void {
  packMap(runtime).set(pack.id, pack);
}

export function getDefaultTaskPacks(
  runtime: IAgentRuntime,
): readonly DefaultTaskPack[] {
  return Array.from(packMap(runtime).values());
}

async function readSeededMarkers(
  runtime: IAgentRuntime,
): Promise<Record<string, string>> {
  const stored = await runtime.getCache<Record<string, string>>(
    SEED_MARKER_CACHE_KEY,
  );
  return stored && typeof stored === "object" ? { ...stored } : {};
}

/**
 * Idempotent, boot-safe seeder. For every registered pack item: if its
 * idempotency key has NEVER been seeded on this device, the task is created and
 * the key is recorded; if the key was already seeded once, the item is skipped.
 * Pack items without an idempotency key are always scheduled (the consumer owns
 * that choice).
 */
export async function seedRegisteredTaskPacks(
  runtime: IAgentRuntime,
  runner: ScheduledTaskRunnerHandle,
): Promise<{ seeded: ScheduledTask[]; skipped: string[] }> {
  const packs = getDefaultTaskPacks(runtime);
  const seeded: ScheduledTask[] = [];
  const skipped: string[] = [];
  if (packs.length === 0) return { seeded, skipped };

  const markers = await readSeededMarkers(runtime);
  const seededAtIso = new Date().toISOString();
  let dirty = false;

  for (const pack of packs) {
    for (const input of pack.tasks) {
      const key = input.idempotencyKey;
      if (key && markers[key]) {
        skipped.push(key);
        continue;
      }
      const task = await runner.schedule(input);
      seeded.push(task);
      if (key) {
        markers[key] = seededAtIso;
        dirty = true;
      }
    }
  }

  if (dirty) {
    await runtime.setCache(SEED_MARKER_CACHE_KEY, markers);
  }
  if (seeded.length > 0) {
    logger.info(
      {
        src: "scheduling:seed-registry",
        agentId: runtime.agentId,
        seeded: seeded.length,
        skipped: skipped.length,
      },
      `[scheduling] Seeded ${seeded.length} default-pack task(s) on boot (${skipped.length} already-seeded, left untouched).`,
    );
  }
  return { seeded, skipped };
}
