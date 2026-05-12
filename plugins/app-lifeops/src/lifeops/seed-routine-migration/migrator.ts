/**
 * One-shot migrator from legacy `LifeOpsDefinition` rows
 * (carrying the `metadata.seedKey === "load-test-user-profile:<key>"`
 * marker that the deleted `applySeedRoutines` API used to write) to the
 * new `default-packs/habit-starters.ts` `ScheduledTask` records.
 *
 * Behaviour:
 *
 *   - **Dry-run by default.** Reads the legacy definitions for the
 *     supplied agent id, resolves the corresponding habit-starter
 *     `ScheduledTaskSeed` for each row, and emits a structured JSON
 *     manual-review report. **No writes are issued.**
 *
 *   - **`--apply` writes.** When `apply: true` is passed (CLI:
 *     `--apply`), the migrator schedules the matching
 *     `ScheduledTaskSeed` records via the supplied
 *     `ScheduledTaskRunner` (using the legacy seed key as
 *     `idempotencyKey`) and marks the legacy `LifeOpsDefinition` row's
 *     `metadata.migratedToScheduledTaskId` so a subsequent dry-run
 *     reports the row as already migrated.
 *
 *   - **Architecture rule:** strong types, no `any`, no `unknown` in
 *     the public surface. Failures throw — no swallowed errors, no
 *     fallback values that mask broken data.
 *
 * Driver script: `plugins/app-lifeops/scripts/migrate-seed-routines.mjs`.
 */

import {
  HABIT_STARTER_KEYS,
  HABIT_STARTER_RECORDS,
} from "../../default-packs/habit-starters.js";
import type { ScheduledTaskSeed } from "../../default-packs/contract-stubs.js";
import type { LifeOpsTaskDefinition } from "../../contracts/index.js";

/**
 * The legacy seed-key prefix written by the now-deleted
 * `applySeedRoutines` mixin method. Definitions whose
 * `metadata.seedKey` starts with this prefix are migrator candidates.
 */
export const LEGACY_SEED_KEY_PREFIX = "load-test-user-profile";

export interface SeedRoutineMigrationCandidate {
  /** Legacy `LifeOpsTaskDefinition.id`. */
  definitionId: string;
  /** Definition title (for human review). */
  title: string;
  /** Stable habit-starter key (e.g. `brush_teeth`). */
  habitStarterKey: string;
  /** The new `ScheduledTaskSeed` we would schedule on `--apply`. */
  scheduledTaskSeed: ScheduledTaskSeed;
  /** Idempotency key — equals the original legacy seed key. */
  idempotencyKey: string;
  /** True if the row has already been migrated in a prior `--apply` run. */
  alreadyMigrated: boolean;
}

export interface SeedRoutineMigrationDiff {
  agentId: string;
  generatedAt: string;
  candidates: SeedRoutineMigrationCandidate[];
  legacyDefinitionsWithoutMatch: Array<{
    definitionId: string;
    title: string;
    seedKey: string;
  }>;
}

export interface SeedRoutineMigrationApplyResult {
  agentId: string;
  appliedAt: string;
  scheduled: Array<{
    definitionId: string;
    idempotencyKey: string;
    habitStarterKey: string;
    scheduledTaskId: string;
  }>;
  skipped: Array<{
    definitionId: string;
    reason: "already_migrated" | "no_matching_habit_starter";
  }>;
}

/**
 * Read-only handle into the legacy `LifeOpsDefinition` table that the
 * migrator needs. Production callers pass `LifeOpsRepository`; tests
 * pass a thin in-memory fake.
 */
export interface LegacyDefinitionReader {
  listDefinitions(agentId: string): Promise<LifeOpsTaskDefinition[]>;
  updateDefinitionMetadata(
    definition: LifeOpsTaskDefinition,
    metadata: Record<string, unknown>,
  ): Promise<void>;
}

/**
 * Subset of the `ScheduledTaskRunner` surface the migrator needs during
 * `--apply`.
 */
export interface ScheduledTaskScheduleSink {
  schedule(seed: ScheduledTaskSeed): Promise<{ taskId: string }>;
}

const HABIT_STARTER_BY_KEY: ReadonlyMap<string, ScheduledTaskSeed> = new Map(
  Object.entries(HABIT_STARTER_KEYS).map(([_, key]) => {
    const record = HABIT_STARTER_RECORDS.find(
      (r) => (r.metadata?.recordKey as string | undefined) === key,
    );
    if (!record) {
      throw new Error(
        `[seed-routine-migrator] Internal: no habit starter for key ${key}`,
      );
    }
    return [key, record] as const;
  }),
);

function readSeedKey(metadata: Record<string, unknown>): string | null {
  const seedKey = metadata.seedKey;
  return typeof seedKey === "string" && seedKey.length > 0 ? seedKey : null;
}

function readMigratedTaskId(metadata: Record<string, unknown>): string | null {
  const taskId = metadata.migratedToScheduledTaskId;
  return typeof taskId === "string" && taskId.length > 0 ? taskId : null;
}

function legacySeedKeyToHabitStarterKey(seedKey: string): string | null {
  // Legacy format: "load-test-user-profile:<habitKey>"
  if (!seedKey.startsWith(`${LEGACY_SEED_KEY_PREFIX}:`)) {
    return null;
  }
  return seedKey.slice(LEGACY_SEED_KEY_PREFIX.length + 1);
}

/**
 * Build the migration diff (dry-run output). Performs no writes.
 */
export async function buildSeedRoutineMigrationDiff(args: {
  agentId: string;
  reader: LegacyDefinitionReader;
  now?: Date;
}): Promise<SeedRoutineMigrationDiff> {
  const generatedAt = (args.now ?? new Date()).toISOString();
  const definitions = await args.reader.listDefinitions(args.agentId);

  const candidates: SeedRoutineMigrationCandidate[] = [];
  const legacyDefinitionsWithoutMatch: SeedRoutineMigrationDiff["legacyDefinitionsWithoutMatch"] =
    [];

  for (const definition of definitions) {
    const seedKey = readSeedKey(definition.metadata);
    if (!seedKey || !seedKey.startsWith(`${LEGACY_SEED_KEY_PREFIX}:`)) {
      continue;
    }
    const habitKey = legacySeedKeyToHabitStarterKey(seedKey);
    if (habitKey === null) {
      legacyDefinitionsWithoutMatch.push({
        definitionId: definition.id,
        title: definition.title,
        seedKey,
      });
      continue;
    }
    const scheduledTaskSeed = HABIT_STARTER_BY_KEY.get(habitKey);
    if (!scheduledTaskSeed) {
      legacyDefinitionsWithoutMatch.push({
        definitionId: definition.id,
        title: definition.title,
        seedKey,
      });
      continue;
    }
    candidates.push({
      definitionId: definition.id,
      title: definition.title,
      habitStarterKey: habitKey,
      scheduledTaskSeed,
      idempotencyKey: seedKey,
      alreadyMigrated: readMigratedTaskId(definition.metadata) !== null,
    });
  }

  return {
    agentId: args.agentId,
    generatedAt,
    candidates,
    legacyDefinitionsWithoutMatch,
  };
}

/**
 * Apply the migration: schedule each candidate `ScheduledTaskSeed` via
 * the runner sink, and stamp `metadata.migratedToScheduledTaskId` on
 * the legacy definition so the row is skipped on subsequent runs.
 */
export async function applySeedRoutineMigration(args: {
  agentId: string;
  reader: LegacyDefinitionReader;
  sink: ScheduledTaskScheduleSink;
  now?: Date;
  /** Source of legacy definitions whose metadata may need stamping. */
  definitionsById?: ReadonlyMap<string, LifeOpsTaskDefinition>;
}): Promise<SeedRoutineMigrationApplyResult> {
  const appliedAt = (args.now ?? new Date()).toISOString();
  const diff = await buildSeedRoutineMigrationDiff({
    agentId: args.agentId,
    reader: args.reader,
    now: args.now,
  });

  const scheduled: SeedRoutineMigrationApplyResult["scheduled"] = [];
  const skipped: SeedRoutineMigrationApplyResult["skipped"] = [];

  // Build a fresh definitions-by-id index unless the caller already
  // computed it.
  const definitionsById =
    args.definitionsById ??
    new Map(
      (await args.reader.listDefinitions(args.agentId)).map(
        (d) => [d.id, d] as const,
      ),
    );

  for (const candidate of diff.candidates) {
    if (candidate.alreadyMigrated) {
      skipped.push({
        definitionId: candidate.definitionId,
        reason: "already_migrated",
      });
      continue;
    }
    const seedWithIdempotency: ScheduledTaskSeed = {
      ...candidate.scheduledTaskSeed,
      idempotencyKey: candidate.idempotencyKey,
      metadata: {
        ...(candidate.scheduledTaskSeed.metadata ?? {}),
        migratedFromLegacyDefinitionId: candidate.definitionId,
        migratedFromSeedKey: candidate.idempotencyKey,
      },
    };
    const result = await args.sink.schedule(seedWithIdempotency);
    scheduled.push({
      definitionId: candidate.definitionId,
      idempotencyKey: candidate.idempotencyKey,
      habitStarterKey: candidate.habitStarterKey,
      scheduledTaskId: result.taskId,
    });

    const definition = definitionsById.get(candidate.definitionId);
    if (definition) {
      await args.reader.updateDefinitionMetadata(definition, {
        ...definition.metadata,
        migratedToScheduledTaskId: result.taskId,
        migratedAt: appliedAt,
      });
    }
  }

  for (const orphan of diff.legacyDefinitionsWithoutMatch) {
    skipped.push({
      definitionId: orphan.definitionId,
      reason: "no_matching_habit_starter",
    });
  }

  return {
    agentId: args.agentId,
    appliedAt,
    scheduled,
    skipped,
  };
}
