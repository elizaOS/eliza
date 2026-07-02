/**
 * Default-pack catalog → scheduling-spine seed registration.
 *
 * This is the production caller for {@link getDefaultEnabledPacks}: PA `init`
 * compiles the default-enabled catalog packs into spine `ScheduledTaskInput`s
 * and registers them as ONE consumer `DefaultTaskPack` on
 * `@elizaos/plugin-scheduling`'s seed registry. The spine's boot seeder
 * (`seedRegisteredTaskPacks`) then materializes them exactly once per
 * idempotency key through the injected production runner.
 *
 * ## Reconciliation with the first-run defaults pack (upgrade story)
 *
 * The first-run pack (`src/lifeops/first-run/defaults.ts`) has been seeding
 * gm / gn / daily check-in / morning-brief (+ weekly-review, local-backup)
 * under `lifeops:first-run:default:*` idempotency keys since before the
 * catalog had a production caller. Those keys already exist on every upgraded
 * install, guarded by the first-run `SeededDefaultsStore` marker (which also
 * remembers user deletions so a deleted default is never resurrected).
 *
 * The catalog re-declares the SAME logical items under different keys
 * (`default-pack:daily-rhythm:gm`, `default-pack:morning-brief:assembler`,
 * plugin-health's keyless `wake-up` gm). Seeding those alongside the
 * first-run rows would double every morning message on both fresh and
 * upgraded installs — two GM rows with distinct keys are indistinguishable to
 * the runner's idempotency dedup.
 *
 * Resolution: the first-run pack REMAINS the owner of those logical slots and
 * keeps its existing keys/markers untouched (zero behavior change for the six
 * first-run records); catalog records whose logical identity is first-run-owned
 * are excluded here. Everything else in the default-enabled catalog — records
 * that have never seeded anywhere — flows through the spine registry.
 */

import type {
  DefaultTaskPack,
  ScheduledTaskInput as SpineScheduledTaskInput,
} from "@elizaos/plugin-scheduling";
import { registerDefaultTaskPack } from "@elizaos/plugin-scheduling";
import type { IAgentRuntime } from "@elizaos/core";
import type {
  ConnectorRegistryContract,
  ScheduledTaskSeed,
} from "./contract-types.js";
import { DAILY_RHYTHM_RECORD_IDS } from "./daily-rhythm.js";
import { getDefaultEnabledPacks } from "./index.js";
import { MORNING_BRIEF_RECORD_IDS } from "./morning-brief.js";
import type { DefaultPack } from "./registry-types.js";

/** Stable registry id for PA's consumer pack (last-wins on re-registration). */
export const PA_DEFAULT_PACK_CATALOG_ID =
  "personal-assistant:default-pack-catalog";

/**
 * Catalog record idempotency keys whose logical items are owned by the
 * first-run defaults pack (see module doc). These records never seed through
 * the spine registry — the first-run rows under `lifeops:first-run:default:*`
 * are the single instance of each logical slot.
 */
export const FIRST_RUN_OWNED_RECORD_KEYS: ReadonlySet<string> = new Set([
  DAILY_RHYTHM_RECORD_IDS.gm, // → lifeops:first-run:default:gm
  DAILY_RHYTHM_RECORD_IDS.gn, // → lifeops:first-run:default:gn
  DAILY_RHYTHM_RECORD_IDS.checkin, // → lifeops:first-run:default:checkin
  DAILY_RHYTHM_RECORD_IDS.checkinFollowup, // embedded in the checkin pipeline
  MORNING_BRIEF_RECORD_IDS.brief, // → lifeops:first-run:default:morning-brief
]);

/**
 * Packs whose entire record set duplicates a first-run-owned logical slot but
 * ships without idempotency keys, so key-level exclusion can't catch them.
 * plugin-health's `wake-up` pack is a keyless "good morning" check-in at
 * `wake.confirmed` — the same morning-greeting slot the first-run gm +
 * morning-brief rows already fill.
 */
export const FIRST_RUN_OWNED_PACK_KEYS: ReadonlySet<string> = new Set([
  "wake-up",
]);

/**
 * Convert one compiled catalog record into the spine's input shape.
 *
 * The two `ScheduledTask` contracts are frozen structural mirrors; this
 * mapper exists to (a) keep the boundary explicit, (b) normalize PA's
 * readonly context-request arrays to the spine's mutable ones, and (c) fail
 * loudly on the one non-mirrored field: PA pack pipelines may inline child
 * SEEDS, which the spine's `ScheduledTaskRef` (string | ScheduledTask) cannot
 * carry. No default-enabled, non-first-run-owned record ships a pipeline
 * today; the guard keeps that assumption honest for future pack authors
 * (covered by the schema test over `buildDefaultPackCatalogTasks`).
 */
export function toSpineTaskInput(
  record: ScheduledTaskSeed,
  fallbackKey: string,
): SpineScheduledTaskInput {
  if (record.pipeline) {
    throw new Error(
      `[default-packs] catalog record "${record.idempotencyKey ?? fallbackKey}" carries an inline pipeline; ` +
        "spine seeding cannot inline child seeds — schedule the children as their own records or keep the pack first-run-owned.",
    );
  }
  return {
    kind: record.kind,
    promptInstructions: record.promptInstructions,
    ...(record.contextRequest
      ? {
          contextRequest: {
            ...(record.contextRequest.includeOwnerFacts
              ? {
                  includeOwnerFacts: [
                    ...record.contextRequest.includeOwnerFacts,
                  ],
                }
              : {}),
            ...(record.contextRequest.includeEntities
              ? {
                  includeEntities: {
                    entityIds: [
                      ...record.contextRequest.includeEntities.entityIds,
                    ],
                    ...(record.contextRequest.includeEntities.fields
                      ? {
                          fields: [
                            ...record.contextRequest.includeEntities.fields,
                          ],
                        }
                      : {}),
                  },
                }
              : {}),
            ...(record.contextRequest.includeRelationships
              ? {
                  includeRelationships:
                    record.contextRequest.includeRelationships,
                }
              : {}),
            ...(record.contextRequest.includeRecentTaskStates
              ? {
                  includeRecentTaskStates:
                    record.contextRequest.includeRecentTaskStates,
                }
              : {}),
            ...(record.contextRequest.includeEventPayload !== undefined
              ? {
                  includeEventPayload:
                    record.contextRequest.includeEventPayload,
                }
              : {}),
          },
        }
      : {}),
    trigger: record.trigger,
    priority: record.priority,
    ...(record.shouldFire ? { shouldFire: record.shouldFire } : {}),
    ...(record.completionCheck
      ? { completionCheck: record.completionCheck }
      : {}),
    ...(record.escalation ? { escalation: record.escalation } : {}),
    ...(record.output ? { output: record.output } : {}),
    ...(record.subject ? { subject: record.subject } : {}),
    // Seed-once + runner dedup both key off this; a keyless record would
    // re-seed on every boot, so the derived fallback is mandatory.
    idempotencyKey: record.idempotencyKey ?? fallbackKey,
    respectsGlobalPause: record.respectsGlobalPause,
    source: record.source,
    createdBy: record.createdBy,
    ownerVisible: record.ownerVisible,
    ...(record.metadata ? { metadata: record.metadata } : {}),
  };
}

function isFirstRunOwned(pack: DefaultPack, record: ScheduledTaskSeed): boolean {
  if (FIRST_RUN_OWNED_PACK_KEYS.has(pack.key)) return true;
  return (
    typeof record.idempotencyKey === "string" &&
    FIRST_RUN_OWNED_RECORD_KEYS.has(record.idempotencyKey)
  );
}

/**
 * Flatten the default-enabled catalog into spine task inputs, applying the
 * first-run reconciliation. Pure over the static catalog — deterministic, so
 * the schema test gates any authoring mistake (duplicate keys, inline
 * pipelines) before it can reach a boot path.
 */
export function buildDefaultPackCatalogTasks(
  options: { connectorRegistry?: ConnectorRegistryContract | null } = {},
): SpineScheduledTaskInput[] {
  const tasks: SpineScheduledTaskInput[] = [];
  const seenKeys = new Set<string>();
  for (const pack of getDefaultEnabledPacks(options)) {
    pack.records.forEach((record, index) => {
      if (isFirstRunOwned(pack, record)) return;
      const input = toSpineTaskInput(
        record,
        `default-pack:${pack.key}:record-${index}`,
      );
      const key = input.idempotencyKey;
      if (key && seenKeys.has(key)) {
        throw new Error(
          `[default-packs] duplicate idempotencyKey "${key}" across default-enabled packs`,
        );
      }
      if (key) seenKeys.add(key);
      tasks.push(input);
    });
  }
  return tasks;
}

/**
 * Register the catalog as PA's consumer pack on the spine seed registry.
 * Called from PA `init`; the spine seeds after `runtime.initPromise` resolves,
 * so registration here is always ordered before the seed pass. Capability-gated
 * packs (`inbox-triage-starter`) are filtered out until a connector registry
 * with the required capabilities is provided.
 */
export function registerDefaultPackCatalog(
  runtime: IAgentRuntime,
  options: { connectorRegistry?: ConnectorRegistryContract | null } = {},
): DefaultTaskPack {
  const pack: DefaultTaskPack = {
    id: PA_DEFAULT_PACK_CATALOG_ID,
    tasks: buildDefaultPackCatalogTasks(options),
  };
  registerDefaultTaskPack(runtime, pack);
  return pack;
}
