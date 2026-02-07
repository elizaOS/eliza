import { exec } from "node:child_process";
import { promisify } from "node:util";
import pg from "pg";
import * as fs from "node:fs";
import * as path from "node:path";

const execAsync = promisify(exec);
const { Client } = pg;

const LOCAL_DATABASE_URL =
  "postgresql://eliza_dev:local_dev_password@localhost:5432/eliza_dev";

function log(message: string) {
  console.log(`[Setup] ${message}`);
}

function error(message: string) {
  console.error(`[Setup Error] ${message}`);
}

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function checkDocker() {
  try {
    await execAsync("docker --version");
    log("✓ Docker is installed");
    return true;
  } catch {
    error("Docker is not installed or not running");
    return false;
  }
}

async function cleanupDocker() {
  log("Cleaning up existing Docker resources...");
  try {
    await execAsync("docker-compose down -v 2>&1");
    log("✓ Docker resources cleaned up");
  } catch {
    log("No existing resources to clean up");
  }

  try {
    await execAsync("docker network prune -f");
    log("✓ Docker networks pruned");
  } catch {
    log("No networks to prune");
  }

  return true;
}

async function startDocker() {
  log("Starting Docker containers...");
  try {
    await execAsync("docker-compose up -d");
    log("✓ Docker containers started");
    return true;
  } catch (e) {
    error(`Failed to start Docker: ${e}`);
    return false;
  }
}

async function waitForPostgres(maxAttempts = 30) {
  log("Waiting for PostgreSQL to be ready...");

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const client = new Client({ connectionString: LOCAL_DATABASE_URL });
      await client.connect();
      await client.query("SELECT 1");
      await client.end();
      log(`✓ PostgreSQL is ready (attempt ${attempt}/${maxAttempts})`);
      return true;
    } catch {
      if (attempt < maxAttempts) {
        process.stdout.write(".");
        await sleep(1000);
      }
    }
  }

  error("PostgreSQL did not become ready in time");
  return false;
}

async function checkPgVector() {
  log("Checking pgvector extension...");
  try {
    const client = new Client({ connectionString: LOCAL_DATABASE_URL });
    await client.connect();

    // Check if extension exists
    const result = await client.query(
      "SELECT * FROM pg_extension WHERE extname = 'vector'",
    );

    if (result.rows.length > 0) {
      log("✓ pgvector extension is installed");
      await client.end();
      return true;
    }

    // Try to create the extension if it doesn't exist
    log("pgvector extension not found, attempting to create...");
    try {
      await client.query("CREATE EXTENSION IF NOT EXISTS vector;");
      await client.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp";');
      log("✓ pgvector extension created successfully");
      await client.end();
      return true;
    } catch (createErr) {
      error(`Failed to create pgvector extension: ${createErr}`);
      error("Make sure you're using the pgvector/pgvector Docker image");
      await client.end();
      return false;
    }
  } catch (e) {
    error(`Failed to check pgvector: ${e}`);
    return false;
  }
}

async function runMigrations() {
  log("Running database migrations...");
  try {
    const oldEnv = process.env.DATABASE_URL;
    process.env.DATABASE_URL = LOCAL_DATABASE_URL;

    // WHY db:migrate instead of db:push:
    // - db:push applies schema directly without tracking (great for rapid prototyping)
    // - db:migrate runs migration files and records them in __drizzle_migrations
    //
    // Using db:migrate for local setup ensures:
    // 1. Local DB matches production migration state
    // 2. Developers can test migrations before deploying
    // 3. The __drizzle_migrations table exists and is populated
    // 4. No surprises when deploying - same migrations run everywhere
    await execAsync("drizzle-kit migrate");

    process.env.DATABASE_URL = oldEnv;

    log("✓ Database migrations completed");
    return true;
  } catch (e) {
    error(`Failed to run migrations: ${e}`);
    return false;
  }
}

async function checkTables() {
  log("Verifying database tables...");
  const requiredTables = [
    "users",
    "organizations",
    "usage_records",
    "generations",
    "conversations",
    "conversation_messages",
    "credit_transactions",
    "api_keys",
  ];

  try {
    const client = new Client({ connectionString: LOCAL_DATABASE_URL });
    await client.connect();

    const result = await client.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
    `);

    await client.end();

    const existingTables = result.rows.map((row) => row.table_name);
    const missingTables = requiredTables.filter(
      (table) => !existingTables.includes(table),
    );

    if (missingTables.length === 0) {
      log(`✓ All required tables exist (${requiredTables.length} tables)`);
      return true;
    } else {
      error(`Missing tables: ${missingTables.join(", ")}`);
      return false;
    }
  } catch (e) {
    error(`Failed to check tables: ${e}`);
    return false;
  }
}

// Note: This function is available for manual development seeding but not called by default
// Uncomment the call at the end of main() if you want to seed data
async function seedData() {
  log("Seeding development data...");
  try {
    const oldEnv = process.env.DATABASE_URL;
    process.env.DATABASE_URL = LOCAL_DATABASE_URL;

    await execAsync("bun run db:local:seed");

    process.env.DATABASE_URL = oldEnv;

    log("✓ Development data seeded");
    return true;
  } catch (e) {
    error(`Failed to seed data: ${e}`);
    return false;
  }
}

async function verifySetup() {
  log("Verifying complete setup...");
  try {
    const client = new Client({ connectionString: LOCAL_DATABASE_URL });
    await client.connect();

    const userCount = await client.query("SELECT COUNT(*) FROM users");
    const orgCount = await client.query("SELECT COUNT(*) FROM organizations");

    await client.end();

    log(
      `✓ Database has ${userCount.rows[0].count} users and ${orgCount.rows[0].count} organizations`,
    );
    return true;
  } catch (e) {
    error(`Failed to verify setup: ${e}`);
    return false;
  }
}

async function createEnvFile() {
  const envPath = path.join(process.cwd(), ".env.local");

  if (fs.existsSync(envPath)) {
    const content = fs.readFileSync(envPath, "utf-8");
    if (content.includes(LOCAL_DATABASE_URL)) {
      log("✓ .env.local already configured for local database");
      return true;
    }
  }

  log("⚠ Warning: Update your .env.local with:");
  console.log(`\nDATABASE_URL="${LOCAL_DATABASE_URL}"\n`);
  return true;
}

async function main() {
  console.log("\n=== Eliza Cloud - Local Database Setup ===\n");

  const steps = [
    { name: "Check Docker installation", fn: checkDocker },
    { name: "Cleanup existing resources", fn: cleanupDocker },
    { name: "Start Docker containers", fn: startDocker },
    { name: "Wait for PostgreSQL", fn: waitForPostgres },
    { name: "Check pgvector extension", fn: checkPgVector },
    { name: "Run database migrations", fn: runMigrations },
    { name: "Verify tables exist", fn: checkTables },
    // { name: "Seed development data", fn: seedData },
    { name: "Verify setup", fn: verifySetup },
    { name: "Check environment configuration", fn: createEnvFile },
  ];

  for (const step of steps) {
    const success = await step.fn();
    if (!success) {
      error(`\nSetup failed at step: ${step.name}`);
      error("Please fix the issue and try again");
      process.exit(1);
    }
  }

  console.log("\n=== ✓ Local Database Setup Complete ===\n");
  console.log("Your local database is ready!");
  console.log(`Connection string: ${LOCAL_DATABASE_URL}`);
  console.log("\nNext steps:");
  console.log(
    "1. Make sure DATABASE_URL in .env.local points to the local database",
  );
  console.log("2. Run 'bun run dev' to start the development server");
  console.log("3. Visit http://localhost:3000/dashboard");
  console.log("\nUseful commands:");
  console.log("  bun run db:local:logs    - View database logs");
  console.log("  bun run db:local:stop    - Stop database");
  console.log("  bun run db:studio        - Open Drizzle Studio\n");
}

main().catch((e) => {
  error(`Unexpected error: ${e}`);
  process.exit(1);
});
