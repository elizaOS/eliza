import type { IAgentRuntime } from "@elizaos/core";
import {
  persistConfiguredOwnerName,
  updateLifeOpsOwnerProfile,
} from "../../../apps/app-lifeops/src/lifeops/owner-profile.ts";
import { ROUTINE_SEED_TEMPLATES } from "../../../apps/app-lifeops/src/lifeops/seed-routines.ts";
import { LifeOpsService } from "../../../apps/app-lifeops/src/lifeops/service.ts";
import { ensureLifeOpsSchema } from "./seed-grants.ts";

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

  for (const key of TEST_USER_PROFILE_ROUTINE_KEYS) {
    const seedKey = routineSeedKey(key);
    if (existingSeedKeys.has(seedKey)) {
      continue;
    }

    const template = ROUTINE_SEED_TEMPLATES.find(
      (candidate) => candidate.key === key,
    );
    if (!template) {
      throw new Error(`[mock-runtime] missing routine seed template: ${key}`);
    }

    await service.createDefinition({
      ...template.request,
      timezone: TEST_USER_PROFILE_TIMEZONE,
      source: "seed",
      metadata: { seedKey },
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
