import type { IAgentRuntime } from "@elizaos/core";
import { HABIT_STARTER_RECORDS } from "../../../plugins/app-lifeops/src/default-packs/habit-starters.ts";
import {
  persistConfiguredOwnerName,
  updateLifeOpsOwnerProfile,
} from "../../../plugins/app-lifeops/src/lifeops/owner-profile.ts";
import { LifeOpsService } from "../../../plugins/app-lifeops/src/lifeops/service.ts";
import { ensureLifeOpsSchema } from "./seed-grants.ts";

// `seed-routines.ts` was removed during the default-packs migration. The
// HABIT_STARTER_RECORDS array now plays the role of the old templates: each
// record is a `ScheduledTaskSeed` that the LifeOps service can persist via
// createDefinition. Map by `metadata.recordKey` so existing callers that
// reference template keys (`brush_teeth`, `invisalign`, ...) still resolve.

const TEST_USER_PROFILE_NAME = "Eliza Test Owner";

const TEST_USER_PROFILE_PATCH = {
  name: TEST_USER_PROFILE_NAME,
  relationshipStatus: "single",
  partnerName: "n/a",
  orientation: "n/a",
  gender: "n/a",
  age: "n/a",
  location: "Test City, CA",
  travelBookingPreferences: "carry-on only; aisle seat; moderate hotels",
  morningCheckinTime: "08:00",
  nightCheckinTime: "21:30",
} as const;

export const TEST_USER_PROFILE_ROUTINE_KEYS = [
  "brush_teeth",
  "invisalign",
  "stretch",
  "vitamins",
  "workout",
] as const;

const ROUTINE_SEED_METADATA_PREFIX = "load-test-user-profile";
const TEST_USER_PROFILE_TIMEZONE = "America/Los_Angeles";

function routineSeedKey(templateKey: string): string {
  return `${ROUTINE_SEED_METADATA_PREFIX}:${templateKey}`;
}

async function seedTestUserProfileRoutines(
  service: LifeOpsService,
): Promise<void> {
  const definitions = await service.listDefinitions();
  const existingSeedKeys = new Set(
    definitions
      .map((entry) => entry.definition.metadata?.seedKey)
      .filter((seedKey): seedKey is string => typeof seedKey === "string"),
  );

  // Map TEST_USER_PROFILE_ROUTINE_KEYS to the new HABIT_STARTER_RECORDS by
  // metadata.recordKey. The records are already full ScheduledTaskSeed
  // objects, so we override `timezone` and tag with the test `seedKey`
  // before persisting.
  for (const key of TEST_USER_PROFILE_ROUTINE_KEYS) {
    const seedKey = routineSeedKey(key);
    if (existingSeedKeys.has(seedKey)) {
      continue;
    }

    const record = HABIT_STARTER_RECORDS.find(
      (candidate) => candidate.metadata?.recordKey === key,
    );
    if (!record) {
      throw new Error(
        `[mock-runtime] no habit-starter record found for key: ${key}`,
      );
    }

    await service.createDefinition({
      ...record,
      timezone: TEST_USER_PROFILE_TIMEZONE,
      source: "seed",
      metadata: { ...record.metadata, seedKey },
    });
  }
}

export async function seedTestUserProfile(
  runtime: IAgentRuntime,
): Promise<void> {
  await ensureLifeOpsSchema(runtime);

  const profile = await updateLifeOpsOwnerProfile(
    runtime,
    TEST_USER_PROFILE_PATCH,
  );
  if (!profile) {
    throw new Error("[mock-runtime] failed to seed test user profile");
  }

  await persistConfiguredOwnerName(profile.name);

  const service = new LifeOpsService(runtime);
  await seedTestUserProfileRoutines(service);
}
