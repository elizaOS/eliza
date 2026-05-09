import { type User } from "@/db/repositories";
import {
  isStewardPlatformConfigured,
  provisionStewardPlatformUser,
} from "@/lib/services/steward-platform-users";
import { usersService } from "@/lib/services/users";
import { logger } from "@/lib/utils/logger";

type StewardMappingUser = Pick<
  User,
  "id" | "email" | "email_verified" | "name" | "steward_user_id" | "is_anonymous"
>;

export interface EnsureStewardUserMappingOptions {
  required?: boolean;
}

export interface StewardUserBackfillOptions {
  batchSize?: number;
  maxUsers?: number;
  dryRun?: boolean;
}

export interface StewardUserBackfillSummary {
  scanned: number;
  provisioned: number;
  failed: number;
  dryRun: boolean;
}

export async function ensureStewardUserMappingForUser(
  user: StewardMappingUser,
  options: EnsureStewardUserMappingOptions = {},
): Promise<string | null> {
  if (user.steward_user_id) {
    return user.steward_user_id;
  }

  if (user.is_anonymous || !user.email) {
    return null;
  }

  if (!isStewardPlatformConfigured()) {
    if (options.required) {
      throw new Error("STEWARD_PLATFORM_KEYS is not configured");
    }

    logger.warn(
      "[StewardUserMigration] Skipping Steward user sync because platform auth is unset",
      {
        userId: user.id,
      },
    );
    return null;
  }

  const provisioned = await provisionStewardPlatformUser({
    email: user.email,
    emailVerified: !!user.email_verified,
    name: user.name,
  });

  await usersService.update(user.id, {
    steward_user_id: provisioned.userId,
    updated_at: new Date(),
  });
  await usersService.upsertStewardIdentity(user.id, provisioned.userId);

  logger.info("[StewardUserMigration] Stored Steward user mapping", {
    userId: user.id,
    stewardUserId: provisioned.userId,
    isNew: provisioned.isNew,
  });

  return provisioned.userId;
}

export async function backfillStewardUserMappings(
  options: StewardUserBackfillOptions = {},
): Promise<StewardUserBackfillSummary> {
  const dryRun = options.dryRun ?? false;

  logger.warn(
    "[StewardUserMigration] Pending Steward provisioning backfill is retired after steward_user_id became mandatory",
  );

  return {
    scanned: 0,
    provisioned: 0,
    failed: 0,
    dryRun,
  };
}
