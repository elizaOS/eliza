#!/usr/bin/env bun

/**
 * @fileoverview Admin user management commands
 *
 * Provides commands for checking, granting, and revoking admin privileges,
 * as well as listing all admin users in the system.
 *
 * @module cli/commands/admin
 */

import { asc, closeDatabase, db, eq, or, sql, users } from "@feed/db";
import { parseArgs, wantsHelp } from "../lib/args.js";
import { logger } from "../lib/logger.js";

function printHelp(): void {
  console.log(`
Admin Management

USAGE:
  feed admin <command> [identifier]

COMMANDS:
  check <user>   Check admin status of a user
  grant <user>   Grant admin privileges to a user
  revoke <user>  Revoke admin privileges from a user
  list           List all admin users

IDENTIFIER:
  Can be username, wallet address, or user ID

EXAMPLES:
  feed admin check alice
  feed admin grant alice
  feed admin grant 0x1234...5678
  feed admin revoke bob
  feed admin list
`);
}

/**
 * Checks and displays admin status for a user.
 *
 * Searches by username, wallet address, or user ID. Shows recent users if not found.
 * Displays user details including ID, username, display name, and admin status.
 *
 * @param identifier - Username, wallet address, or user ID to check
 * @throws Exits process with code 1 if user not found
 * @internal
 */
async function checkAdmin(identifier: string): Promise<void> {
  logger.header("Check Admin Status");

  const result = await db
    .select({
      id: users.id,
      username: users.username,
      displayName: users.displayName,
      isAdmin: users.isAdmin,
    })
    .from(users)
    .where(
      or(
        sql`lower(${users.username}) = lower(${identifier})`,
        eq(users.id, identifier),
      ),
    )
    .limit(1);

  if (result.length === 0) {
    logger.fail(`User not found: ${identifier}`);

    const allUsers = await db
      .select({
        id: users.id,
        username: users.username,
        displayName: users.displayName,
      })
      .from(users)
      .where(eq(users.isActor, false))
      .orderBy(sql`${users.createdAt} DESC`)
      .limit(10);

    console.log("\nRecent users:");
    for (const user of allUsers) {
      console.log(
        `  ${user.username || user.id} (${user.displayName || "N/A"})`,
      );
    }
    process.exit(1);
  }

  const userData = result[0]!;

  console.log("User found:");
  console.log(`  ID:           ${userData.id}`);
  console.log(`  Username:     ${userData.username || "N/A"}`);
  console.log(`  Display Name: ${userData.displayName || "N/A"}`);
  console.log(`  Is Admin:     ${userData.isAdmin ? "✅ Yes" : "❌ No"}`);

  if (!userData.isAdmin) {
    console.log("\nTo grant admin privileges:");
    console.log(`  feed admin grant ${identifier}`);
  }
}

/**
 * Grants admin privileges to a user.
 *
 * Verifies the user exists and is not an actor/NPC before granting privileges.
 * Updates the database and verifies the change was applied.
 *
 * @param identifier - Username, wallet address, or user ID to grant admin to
 * @throws Exits process with code 1 if user not found or is an actor
 * @internal
 */
async function grantAdmin(identifier: string): Promise<void> {
  logger.header("Grant Admin Privileges");

  const result = await db
    .select({
      id: users.id,
      username: users.username,
      displayName: users.displayName,
      isAdmin: users.isAdmin,
      isActor: users.isActor,
    })
    .from(users)
    .where(
      or(
        sql`lower(${users.username}) = lower(${identifier})`,
        eq(users.id, identifier),
      ),
    )
    .limit(1);

  if (result.length === 0) {
    logger.fail(`User not found: ${identifier}`);
    process.exit(1);
  }

  const user = result[0]!;

  if (user.isActor) {
    logger.fail("Cannot promote actors/NPCs to admin");
    process.exit(1);
  }

  if (user.isAdmin) {
    logger.success(`${user.username || user.id} is already an admin`);
    return;
  }

  await db.update(users).set({ isAdmin: true }).where(eq(users.id, user.id));

  logger.success(
    `Granted admin privileges to ${user.username || user.displayName || user.id}`,
  );
  console.log(`  User ID: ${user.id}`);

  // Verify
  const verification = await db
    .select({ isAdmin: users.isAdmin })
    .from(users)
    .where(eq(users.id, user.id));

  console.log(`  Verified: ${verification[0]?.isAdmin ? "✅" : "❌"}`);
}

/**
 * Revokes admin privileges from a user.
 *
 * Searches by username, wallet address, or user ID and removes admin status.
 *
 * @param identifier - Username, wallet address, or user ID to revoke admin from
 * @throws Exits process with code 1 if user not found
 * @internal
 */
async function revokeAdmin(identifier: string): Promise<void> {
  logger.header("Revoke Admin Privileges");

  const result = await db
    .select({
      id: users.id,
      username: users.username,
      walletAddress: users.walletAddress,
      isAdmin: users.isAdmin,
    })
    .from(users)
    .where(
      or(
        eq(users.walletAddress, identifier),
        sql`lower(${users.username}) = lower(${identifier})`,
        eq(users.id, identifier),
      ),
    )
    .limit(1);

  if (result.length === 0) {
    logger.fail(`User not found: ${identifier}`);
    process.exit(1);
  }

  const user = result[0]!;

  if (!user.isAdmin) {
    console.log(
      `${user.username || user.walletAddress || user.id} is not an admin`,
    );
    return;
  }

  await db.update(users).set({ isAdmin: false }).where(eq(users.id, user.id));

  logger.success(
    `Revoked admin privileges from ${user.username || user.walletAddress || user.id}`,
  );
}

/**
 * Lists all users with admin privileges.
 *
 * Displays username, display name, wallet address, user ID, and join date
 * for all admin users, ordered by creation date.
 *
 * @internal
 */
async function listAdmins(): Promise<void> {
  logger.header("Admin Users");

  const admins = await db
    .select({
      id: users.id,
      username: users.username,
      displayName: users.displayName,
      walletAddress: users.walletAddress,
      createdAt: users.createdAt,
    })
    .from(users)
    .where(eq(users.isAdmin, true))
    .orderBy(asc(users.createdAt));

  if (admins.length === 0) {
    console.log("No admin users found");
    return;
  }

  console.log(`Found ${admins.length} admin(s):\n`);

  for (const admin of admins) {
    console.log(`${"─".repeat(50)}`);
    console.log(`Username:     ${admin.username || "N/A"}`);
    console.log(`Display Name: ${admin.displayName || "N/A"}`);
    console.log(`Wallet:       ${admin.walletAddress || "N/A"}`);
    console.log(`User ID:      ${admin.id}`);
    console.log(`Joined:       ${admin.createdAt.toISOString()}`);
  }
  console.log(`${"─".repeat(50)}`);
}

/**
 * Main entry point for admin domain commands.
 *
 * Routes to appropriate sub-command handlers and ensures database cleanup.
 *
 * **Supported Commands:**
 * - `check <identifier>` - Check admin status of a user
 * - `grant <identifier>` - Grant admin privileges to a user
 * - `revoke <identifier>` - Revoke admin privileges from a user
 * - `list` - List all admin users
 *
 * @param args - Raw command-line arguments for the admin domain
 * @throws Exits process with code 1 on error, 0 on success
 */
export async function runAdminCommand(args: string[]): Promise<void> {
  const parsed = parseArgs(args);

  if (wantsHelp(parsed)) {
    printHelp();
    process.exit(0);
  }

  try {
    switch (parsed.command) {
      case "check":
        if (!parsed.positional[0]) {
          logger.fail("Please provide a username or user ID");
          printHelp();
          process.exit(1);
        }
        await checkAdmin(parsed.positional[0]);
        break;

      case "grant":
        if (!parsed.positional[0]) {
          logger.fail("Please provide a username, wallet address, or user ID");
          printHelp();
          process.exit(1);
        }
        await grantAdmin(parsed.positional[0]);
        break;

      case "revoke":
        if (!parsed.positional[0]) {
          logger.fail("Please provide a username, wallet address, or user ID");
          printHelp();
          process.exit(1);
        }
        await revokeAdmin(parsed.positional[0]);
        break;

      case "list":
        await listAdmins();
        break;

      default:
        if (parsed.command) {
          logger.fail(`Unknown command: ${parsed.command}`);
        }
        printHelp();
        process.exit(parsed.command ? 1 : 0);
    }
  } finally {
    await closeDatabase();
  }
}
