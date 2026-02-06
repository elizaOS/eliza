#!/usr/bin/env bun
/**
 * Cleanup Eliza App User Data
 *
 * Removes user, organization, and related data for testing phone/telegram auth.
 * Useful when you need a fresh start for testing login flows.
 *
 * Usage:
 *   bun run scripts/cleanup-eliza-app-user.ts +14155552671
 *   bun run scripts/cleanup-eliza-app-user.ts --telegram 123456789
 *   bun run scripts/cleanup-eliza-app-user.ts --all-test-users
 */

import { config } from "dotenv";
import { resolve } from "path";

config({ path: resolve(process.cwd(), ".env") });
config({ path: resolve(process.cwd(), ".env.local"), override: true });

import { db } from "@/db/client";
import { users } from "@/db/schemas/users";
import { organizations } from "@/db/schemas/organizations";
import { eq, or, isNotNull } from "drizzle-orm";
import { Redis } from "@upstash/redis";

const SESSION_KEY_PREFIX = "eliza-app:session:";

function normalizePhoneNumber(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.length === 10) {
    return `+1${digits}`;
  }
  if (digits.length === 11 && digits.startsWith("1")) {
    return `+${digits}`;
  }
  if (!phone.startsWith("+")) {
    return `+${digits}`;
  }
  return phone;
}

async function clearRedisKeys(patterns: string[]) {
  const restUrl = process.env.KV_REST_API_URL;
  const restToken = process.env.KV_REST_API_TOKEN;

  if (!restUrl || !restToken) {
    console.log("  ⚠ No Redis configured (KV_REST_API_URL/TOKEN), skipping cache cleanup");
    return;
  }

  const redis = new Redis({ url: restUrl, token: restToken });

  for (const pattern of patterns) {
    // For exact keys (no wildcard), just delete directly
    if (!pattern.includes("*")) {
      try {
        const result = await redis.del(pattern);
        if (result > 0) {
          console.log(`  ✓ Deleted Redis key: ${pattern}`);
        }
      } catch {
        // Key doesn't exist, that's fine
      }
      continue;
    }

    // For patterns with wildcards, use SCAN
    let cursor: string | number = 0;
    let deleted = 0;
    do {
      const result: [string | number, string[]] = await redis.scan(cursor, { match: pattern, count: 100 });
      cursor = typeof result[0] === "string" ? parseInt(result[0], 10) : result[0];
      const keys = result[1];
      if (keys.length > 0) {
        await redis.del(...keys);
        deleted += keys.length;
      }
    } while (cursor !== 0);

    if (deleted > 0) {
      console.log(`  ✓ Deleted ${deleted} Redis keys matching "${pattern}"`);
    }
  }
}

async function cleanupByPhone(phoneNumber: string) {
  const normalized = normalizePhoneNumber(phoneNumber);
  console.log(`\n🧹 Cleaning up user with phone: ${normalized}\n`);

  // Find user
  const user = await db.query.users.findFirst({
    where: eq(users.phone_number, normalized),
    with: { organization: true },
  });

  if (!user) {
    console.log(`  ℹ No user found with phone ${normalized}`);
  } else {
    console.log(`  Found user: ${user.id} (${user.name || "unnamed"})`);
    console.log(`  Organization: ${user.organization?.id} (${user.organization?.name || "unnamed"})`);

    // Delete organization (cascades to user, api_keys, etc.)
    if (user.organization_id) {
      await db.delete(organizations).where(eq(organizations.id, user.organization_id));
      console.log(`  ✓ Deleted organization and all related data`);
    } else {
      // No org, just delete user
      await db.delete(users).where(eq(users.id, user.id));
      console.log(`  ✓ Deleted user (no organization)`);
    }
  }

  // Clear Redis sessions
  await clearRedisKeys([
    `${SESSION_KEY_PREFIX}*`, // Clear all sessions to be safe
  ]);

  console.log(`\n✅ Cleanup complete for ${normalized}\n`);
}

async function cleanupByTelegram(telegramId: string) {
  console.log(`\n🧹 Cleaning up user with Telegram ID: ${telegramId}\n`);

  const user = await db.query.users.findFirst({
    where: eq(users.telegram_id, telegramId),
    with: { organization: true },
  });

  if (!user) {
    console.log(`  ℹ No user found with Telegram ID ${telegramId}`);
    return;
  }

  console.log(`  Found user: ${user.id} (${user.name || "unnamed"})`);
  console.log(`  Organization: ${user.organization?.id} (${user.organization?.name || "unnamed"})`);

  if (user.organization_id) {
    await db.delete(organizations).where(eq(organizations.id, user.organization_id));
    console.log(`  ✓ Deleted organization and all related data`);
  } else {
    await db.delete(users).where(eq(users.id, user.id));
    console.log(`  ✓ Deleted user (no organization)`);
  }

  // Clear user sessions
  await clearRedisKeys([
    `${SESSION_KEY_PREFIX}*`,
  ]);

  console.log(`\n✅ Cleanup complete for Telegram ${telegramId}\n`);
}

async function cleanupAllTestUsers() {
  console.log(`\n🧹 Cleaning up ALL Eliza App test users\n`);
  console.log(`  Looking for users with phone_number or telegram_id...\n`);

  const testUsers = await db.query.users.findMany({
    where: or(isNotNull(users.phone_number), isNotNull(users.telegram_id)),
    with: { organization: true },
  });

  if (testUsers.length === 0) {
    console.log(`  ℹ No Eliza App users found`);
    return;
  }

  console.log(`  Found ${testUsers.length} Eliza App user(s):\n`);

  for (const user of testUsers) {
    const identifiers = [
      user.phone_number ? `phone: ${user.phone_number}` : null,
      user.telegram_id ? `telegram: ${user.telegram_id}` : null,
    ].filter(Boolean).join(", ");

    console.log(`  - ${user.id} (${user.name || "unnamed"}) [${identifiers}]`);

    if (user.organization_id) {
      await db.delete(organizations).where(eq(organizations.id, user.organization_id));
    } else {
      await db.delete(users).where(eq(users.id, user.id));
    }
  }

  // Clear all eliza-app sessions
  await clearRedisKeys([
    `${SESSION_KEY_PREFIX}*`,
  ]);

  console.log(`\n✅ Deleted ${testUsers.length} user(s) and their organizations\n`);
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log(`
Usage:
  bun run scripts/cleanup-eliza-app-user.ts <phone_number>
  bun run scripts/cleanup-eliza-app-user.ts --telegram <telegram_id>
  bun run scripts/cleanup-eliza-app-user.ts --all-test-users

Examples:
  bun run scripts/cleanup-eliza-app-user.ts +14155552671
  bun run scripts/cleanup-eliza-app-user.ts 4155552671
  bun run scripts/cleanup-eliza-app-user.ts --telegram 123456789
  bun run scripts/cleanup-eliza-app-user.ts --all-test-users
`);
    process.exit(1);
  }

  if (args[0] === "--all-test-users") {
    await cleanupAllTestUsers();
  } else if (args[0] === "--telegram" && args[1]) {
    await cleanupByTelegram(args[1]);
  } else {
    await cleanupByPhone(args[0]);
  }

  process.exit(0);
}

main().catch((err) => {
  console.error("❌ Cleanup failed:", err);
  process.exit(1);
});
