#!/usr/bin/env tsx
/**
 * Backfill Agent Usernames
 *
 * Generates unique usernames for all agents that have username IS NULL.
 * Uses slugified agent names with collision handling.
 *
 * Usage:
 *   # Using .env.local database
 *   bunx scripts/backfill-agent-usernames.ts
 *
 *   # Dry run (preview only, no changes)
 *   bunx scripts/backfill-agent-usernames.ts --dry-run
 *
 *   # With custom database URL
 *   DATABASE_URL="postgres://..." bunx scripts/backfill-agent-usernames.ts
 *
 *   # Production dry run
 *   DATABASE_URL="<prod-url>" bunx scripts/backfill-agent-usernames.ts --dry-run
 */

import { config } from "dotenv";
import { resolve } from "path";

// Load environment variables
config({ path: resolve(__dirname, "../.env.local") });
config({ path: resolve(__dirname, "../.env") });

import { db } from "../db/client";
import { userCharacters } from "../db/schemas/user-characters";
import { eq, isNull } from "drizzle-orm";
import {
  generateUsernameFromName,
  generateUniqueUsername,
  validateUsername,
  RESERVED_USERNAMES,
} from "../lib/utils/agent-username";

// Parse CLI arguments
const args = process.argv.slice(2);
const isDryRun = args.includes("--dry-run");
const isVerbose = args.includes("--verbose") || args.includes("-v");

interface BackfillResult {
  id: string;
  name: string;
  oldUsername: string | null;
  newUsername: string;
  status: "updated" | "skipped" | "error";
  error?: string;
}

async function getAllExistingUsernames(): Promise<Set<string>> {
  console.log("📋 Fetching all existing usernames...");

  const characters = await db
    .select({ username: userCharacters.username })
    .from(userCharacters);

  const usernames = new Set<string>();

  for (const char of characters) {
    if (char.username) {
      usernames.add(char.username.toLowerCase());
    }
  }

  // Also add reserved usernames
  for (const reserved of RESERVED_USERNAMES) {
    usernames.add(reserved);
  }

  console.log(`   Found ${usernames.size} existing usernames\n`);
  return usernames;
}

async function getCharactersWithoutUsername(): Promise<
  Array<{ id: string; name: string; username: string | null }>
> {
  console.log("🔍 Finding characters without usernames...");

  const characters = await db
    .select({
      id: userCharacters.id,
      name: userCharacters.name,
      username: userCharacters.username,
    })
    .from(userCharacters)
    .where(isNull(userCharacters.username));

  console.log(`   Found ${characters.length} characters without usernames\n`);
  return characters;
}

/**
 * Generates a unique username from a name, checking against existing usernames.
 */
function generateUniqueUsernameFromName(
  baseName: string,
  existingUsernames: Set<string>,
): string {
  const baseUsername = generateUsernameFromName(baseName);
  return generateUniqueUsername(baseUsername, existingUsernames);
}

async function backfillUsernames(): Promise<void> {
  console.log("=".repeat(70));
  console.log("🏷️  Agent Username Backfill Script");
  console.log("=".repeat(70));

  if (isDryRun) {
    console.log("⚠️  DRY RUN MODE - No changes will be made\n");
  }

  if (process.env.DATABASE_URL) {
    // Mask the connection string for security
    const masked = process.env.DATABASE_URL.replace(/\/\/[^@]+@/, "//*****@");
    console.log(`📊 Database: ${masked}\n`);
  }

  try {
    // Get all existing usernames
    const existingUsernames = await getAllExistingUsernames();

    // Get characters that need usernames
    const characters = await getCharactersWithoutUsername();

    if (characters.length === 0) {
      console.log("✅ All characters already have usernames. Nothing to do!\n");
      return;
    }

    const results: BackfillResult[] = [];
    const batchSize = 50;
    let processed = 0;

    console.log("🔄 Processing characters...\n");

    for (const char of characters) {
      try {
        // Generate unique username
        const newUsername = generateUniqueUsernameFromName(
          char.name,
          existingUsernames,
        );

        // Validate the generated username
        const validation = validateUsername(newUsername);
        if (!validation.valid) {
          results.push({
            id: char.id,
            name: char.name,
            oldUsername: char.username,
            newUsername: newUsername,
            status: "error",
            error: validation.error,
          });
          console.log(
            `   ❌ ${char.name}: Invalid username "${newUsername}" - ${validation.error}`,
          );
          continue;
        }

        // Add to existing set to prevent duplicates in this run
        existingUsernames.add(newUsername);

        if (isVerbose || isDryRun) {
          console.log(`   📝 "${char.name}" → @${newUsername}`);
        }

        if (!isDryRun) {
          // Update the database
          await db
            .update(userCharacters)
            .set({
              username: newUsername,
              updated_at: new Date(),
            })
            .where(eq(userCharacters.id, char.id));
        }

        results.push({
          id: char.id,
          name: char.name,
          oldUsername: char.username,
          newUsername: newUsername,
          status: "updated",
        });

        processed++;

        // Log progress every batch
        if (processed % batchSize === 0) {
          console.log(`   ... processed ${processed}/${characters.length}`);
        }
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        results.push({
          id: char.id,
          name: char.name,
          oldUsername: char.username,
          newUsername: "",
          status: "error",
          error: errorMessage,
        });
        console.log(`   ❌ ${char.name}: Error - ${errorMessage}`);
      }
    }

    // Summary
    console.log("\n" + "=".repeat(70));
    console.log("📊 Backfill Summary");
    console.log("=".repeat(70));

    const updated = results.filter((r) => r.status === "updated").length;
    const errors = results.filter((r) => r.status === "error").length;

    console.log(
      `✅ Successfully ${isDryRun ? "would update" : "updated"}: ${updated}`,
    );
    console.log(`❌ Errors: ${errors}`);
    console.log(`📁 Total processed: ${results.length}`);

    if (errors > 0) {
      console.log("\n⚠️  Errors encountered:");
      for (const result of results.filter((r) => r.status === "error")) {
        console.log(`   - "${result.name}": ${result.error}`);
      }
    }

    if (isDryRun) {
      console.log("\n💡 To apply these changes, run without --dry-run flag");
    } else {
      console.log("\n🎉 Backfill complete!");
    }

    console.log();
  } catch (error) {
    console.error("\n❌ Fatal error:", error);
    if (error instanceof Error) {
      console.error("Stack:", error.stack);
    }
    process.exit(1);
  }
}

// Run the script
backfillUsernames()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
  });
