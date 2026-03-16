#!/usr/bin/env bun
/**
 * Debug Auth Script - Diagnose and fix authentication issues
 *
 * Usage:
 *   bun run scripts/debug-auth.ts                    # Test DB connection
 *   bun run scripts/debug-auth.ts check <privy_id>  # Check if user exists
 *   bun run scripts/debug-auth.ts create <privy_id> # Create user if missing
 *   bun run scripts/debug-auth.ts fix <privy_id>    # Full fix - create user + org
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { eq } from "drizzle-orm";
import * as schema from "../db/schemas";

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error("❌ DATABASE_URL not set in .env.local");
  process.exit(1);
}

console.log("🔧 Debug Auth Script");
console.log("====================\n");

// Create a direct pg connection (bypassing Neon serverless)
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL.includes("neon.tech")
    ? { rejectUnauthorized: false }
    : undefined,
});

const db = drizzle(pool, { schema });

async function testConnection(): Promise<boolean> {
  console.log("📡 Testing database connection...");
  try {
    const result = await pool.query(
      "SELECT NOW() as now, current_database() as db",
    );
    console.log(`✅ Connected to database: ${result.rows[0].db}`);
    console.log(`   Server time: ${result.rows[0].now}\n`);
    return true;
  } catch (error) {
    console.error("❌ Database connection failed:", error);
    return false;
  }
}

async function checkUser(privyUserId: string): Promise<schema.User | null> {
  console.log(`🔍 Looking for user with privy_user_id: ${privyUserId}`);

  try {
    const user = await db.query.users.findFirst({
      where: eq(schema.users.privy_user_id, privyUserId),
    });

    if (user) {
      console.log("✅ User found:");
      console.log(`   ID: ${user.id}`);
      console.log(`   Email: ${user.email || "(none)"}`);
      console.log(`   Name: ${user.name || "(none)"}`);
      console.log(`   Org ID: ${user.organization_id || "(none)"}`);
      console.log(`   Active: ${user.is_active}`);
      console.log(`   Created: ${user.created_at}\n`);
      return user;
    } else {
      console.log("❌ User NOT found in database\n");
      return null;
    }
  } catch (error) {
    console.error("❌ Error querying user:", error);
    return null;
  }
}

async function checkUserWithOrg(privyUserId: string): Promise<void> {
  console.log(`🔍 Looking for user WITH organization...`);

  try {
    const user = await db.query.users.findFirst({
      where: eq(schema.users.privy_user_id, privyUserId),
      with: {
        organization: true,
      },
    });

    if (user) {
      console.log("✅ User with org found:");
      console.log(`   User ID: ${user.id}`);
      console.log(`   Org ID: ${user.organization_id}`);
      if (user.organization) {
        console.log(`   Org Name: ${user.organization.name}`);
        console.log(`   Org Slug: ${user.organization.slug}`);
        console.log(`   Credits: ${user.organization.credit_balance}`);
      } else {
        console.log("   ⚠️  Organization relation is NULL");
      }
    } else {
      console.log("❌ User NOT found\n");
    }
  } catch (error) {
    console.error("❌ Error querying user with org:", error);
    console.error("   This is the error that's causing auth to fail!");
  }
}

async function listAllUsers(): Promise<void> {
  console.log("📋 Listing all users...\n");

  try {
    const users = await db.query.users.findMany({
      limit: 10,
      orderBy: (users, { desc }) => [desc(users.created_at)],
    });

    if (users.length === 0) {
      console.log("   No users found in database");
    } else {
      console.log(`   Found ${users.length} users (showing most recent):\n`);
      for (const user of users) {
        console.log(`   - ${user.privy_user_id}`);
        console.log(`     Email: ${user.email || "(none)"}`);
        console.log(`     Org: ${user.organization_id || "(none)"}`);
        console.log("");
      }
    }
  } catch (error) {
    console.error("❌ Error listing users:", error);
  }
}

async function createUserAndOrg(privyUserId: string): Promise<void> {
  console.log(`🔨 Creating user and organization for: ${privyUserId}\n`);

  try {
    // Generate a unique slug
    const timestamp = Date.now().toString(36).slice(-4);
    const random = Math.random().toString(36).substring(2, 8);
    const slug = `debug-user-${timestamp}${random}`;

    // Create organization first
    console.log("   Creating organization...");
    const [org] = await db
      .insert(schema.organizations)
      .values({
        name: `Debug User's Organization`,
        slug,
        credit_balance: "5.00",
      })
      .returning();

    console.log(`   ✅ Organization created: ${org.id}`);

    // Create user
    console.log("   Creating user...");
    const [user] = await db
      .insert(schema.users)
      .values({
        privy_user_id: privyUserId,
        email: null,
        name: `Debug User`,
        organization_id: org.id,
        role: "owner",
        is_active: true,
      })
      .returning();

    console.log(`   ✅ User created: ${user.id}`);
    console.log("\n🎉 User and organization created successfully!");
    console.log(`   User ID: ${user.id}`);
    console.log(`   Org ID: ${org.id}`);
    console.log(`   Credits: 5.00`);
  } catch (error) {
    console.error("❌ Error creating user:", error);
  }
}

async function rawQuery(privyUserId: string): Promise<void> {
  console.log("🔧 Running raw SQL query (bypassing Drizzle)...\n");

  try {
    const result = await pool.query(
      `SELECT u.id, u.privy_user_id, u.email, u.name, u.organization_id, u.is_active,
              o.id as org_id, o.name as org_name, o.credit_balance
       FROM users u
       LEFT JOIN organizations o ON u.organization_id = o.id
       WHERE u.privy_user_id = $1`,
      [privyUserId],
    );

    if (result.rows.length > 0) {
      console.log("✅ Raw query successful:");
      console.log(JSON.stringify(result.rows[0], null, 2));
    } else {
      console.log("❌ No rows returned from raw query");
    }
  } catch (error) {
    console.error("❌ Raw query failed:", error);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || "test";
  const privyUserId = args[1] || "did:privy:cmgqonppn01o2l70cxix113g2"; // Default from error

  // Always test connection first
  const connected = await testConnection();
  if (!connected) {
    await pool.end();
    process.exit(1);
  }

  switch (command) {
    case "test":
      await listAllUsers();
      break;

    case "check":
      await checkUser(privyUserId);
      await checkUserWithOrg(privyUserId);
      await rawQuery(privyUserId);
      break;

    case "create":
    case "fix":
      const existing = await checkUser(privyUserId);
      if (existing) {
        console.log("⚠️  User already exists, skipping creation");
      } else {
        await createUserAndOrg(privyUserId);
      }
      // Verify it worked
      await checkUserWithOrg(privyUserId);
      break;

    case "raw":
      await rawQuery(privyUserId);
      break;

    default:
      console.log("Usage:");
      console.log(
        "  bun run scripts/debug-auth.ts test              # Test connection & list users",
      );
      console.log(
        "  bun run scripts/debug-auth.ts check <privy_id>  # Check if user exists",
      );
      console.log(
        "  bun run scripts/debug-auth.ts fix <privy_id>    # Create user if missing",
      );
      console.log(
        "  bun run scripts/debug-auth.ts raw <privy_id>    # Run raw SQL query",
      );
  }

  await pool.end();
  console.log("\n✅ Done");
}

main().catch(console.error);
