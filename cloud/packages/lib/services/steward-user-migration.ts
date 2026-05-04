import { type User, usersRepository } from "@/db/repositories";
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
  const batchSize = Math.max(1, options.batchSize ?? 50);
  const maxUsers = options.maxUsers ?? Number.POSITIVE_INFINITY;
  const dryRun = options.dryRun ?? false;

  let scanned = 0;
  let provisioned = 0;
  let failed = 0;

  while (scanned < maxUsers) {
    const remaining = maxUsers - scanned;
    const users = await usersRepository.listPendingStewardProvisioning(
      Number.isFinite(remaining) ? Math.min(batchSize, remaining) : batchSize,
    );

    if (users.length === 0) {
      break;
    }

    for (const user of users) {
      scanned += 1;

      if (!user.email) {
        continue;
      }

      if (dryRun) {
        logger.info("[StewardUserMigration] Dry run candidate", {
          userId: user.id,
          email: user.email,
        });
        continue;
      }

      try {
        const stewardUserId = await ensureStewardUserMappingForUser(
          {
            ...user,
            is_anonymous: false,
          },
          { required: true },
        );

        if (stewardUserId) {
          provisioned += 1;
        }
      } catch (error) {
        failed += 1;
        logger.error("[StewardUserMigration] Failed to backfill Steward user mapping", {
          userId: user.id,
          email: user.email,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  return {
    scanned,
    provisioned,
    failed,
    dryRun,
  };
}
