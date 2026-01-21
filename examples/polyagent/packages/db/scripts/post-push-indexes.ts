/**
 * Post db:push script to create custom indexes that Drizzle doesn't support natively.
 *
 * Run this after `bun run db:push` to ensure custom indexes are created.
 *
 * Usage: DATABASE_URL="..." bun run packages/db/scripts/post-push-indexes.ts
 *
 * NOTE: GroupMember now uses a FULL unique constraint on (groupId, userId)
 * managed via schema + migration 0018. The old partial index approach has been
 * deprecated in favor of using isActive flag for soft deletes.
 */

import postgres from "postgres";

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }

  const sql = postgres(databaseUrl);

  console.log("Checking post-push indexes...\n");

  // GroupMember: Drop old partial index if it exists (replaced by full unique constraint)
  // The full unique constraint is now managed in schema + migration 0018
  try {
    await sql`
      DROP INDEX IF EXISTS "GroupMember_groupId_userId_active_key"
    `;
    console.log(
      "✓ Dropped old GroupMember_groupId_userId_active_key partial index (replaced by full unique constraint)",
    );
  } catch {
    console.log(
      "✓ GroupMember_groupId_userId_active_key: already removed or did not exist",
    );
  }

  await sql.end();
  console.log("\n✓ Post-push indexes complete!");
}

main().catch(console.error);
