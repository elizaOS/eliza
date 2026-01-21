#!/usr/bin/env bun

/**
 * Pre-Development Setup
 *
 * Sets up complete development environment:
 * - Detects environment from .env (localnet/testnet/mainnet)
 * - For localnet: Kills any processes on port 3000, checks for Hardhat node
 * - Starts PostgreSQL, Redis, MinIO
 * - Runs database migrations
 * - Seeds data
 */

import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
// @ts-expect-error - bun global is available in bun runtime
import { $ } from "bun";
import {
  type DeploymentEnv,
  detectEnvironment,
  printValidationResult,
  validateEnvironment,
} from "../../packages/contracts/src/deployment/env-detection";

const POSTGRES_CONTAINER = "polyagent-postgres";
const REDIS_CONTAINER = "polyagent-redis";
const MINIO_CONTAINER = "polyagent-minio";

/**
 * Valid Docker service names for the development environment
 */
type DockerService = "postgres" | "redis" | "minio";

// Detect docker compose command (docker compose vs docker-compose)
let useDockerComposePlugin = false;
const dockerComposeCheck = await $`docker compose version`.quiet().nothrow();
if (dockerComposeCheck.exitCode === 0) {
  useDockerComposePlugin = true;
} else {
  const dockerComposeStandalone = await $`docker-compose version`
    .quiet()
    .nothrow();
  if (dockerComposeStandalone.exitCode !== 0) {
    console.error(
      '❌ Neither "docker compose" nor "docker-compose" is available',
    );
    process.exit(1);
  }
}

async function dockerComposeUp(service: DockerService) {
  if (useDockerComposePlugin) {
    return $`docker compose up -d ${service}`;
  } else {
    return $`docker-compose up -d ${service}`;
  }
}

async function killPort(port: number): Promise<number> {
  const pids = await $`lsof -t -i:${port}`.quiet().nothrow().text();
  const pidList = pids.trim().split("\n").filter(Boolean);

  if (pidList.length === 0) {
    return 0;
  }

  for (const pid of pidList) {
    await $`kill -9 ${pid}`.quiet().nothrow();
  }

  return pidList.length;
}

// Load .env file to detect environment
const envPath = join(process.cwd(), ".env");
if (existsSync(envPath)) {
  const envContent = readFileSync(envPath, "utf-8");
  // Parse .env file and set environment variables
  for (const line of envContent.split("\n")) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith("#")) {
      const [key, ...valueParts] = trimmed.split("=");
      if (key && valueParts.length > 0) {
        const value = valueParts.join("=").replace(/^["']|["']$/g, "");
        if (!process.env[key]) {
          process.env[key] = value;
        }
      }
    }
  }
}

// Detect environment from .env or default to localnet
const detectedEnv: DeploymentEnv = detectEnvironment();
const isLocalnet = detectedEnv === "localnet";

console.info(`[Script] Setting up ${detectedEnv} development environment...`);
console.info("=".repeat(60));

// 0. Kill any processes on port 3000 to prevent port conflicts
console.info("[Script] Checking for processes on port 3000...");
const killedCount = await killPort(3000);
if (killedCount > 0) {
  console.info(`[Script] ✅ Killed ${killedCount} process(es) on port 3000`);
} else {
  console.info("[Script] ✅ Port 3000 is free");
}

// 0.5. Clean up Next.js lock file if it exists
const nextLockPath = join(process.cwd(), ".next", "dev", "lock");
try {
  if (existsSync(nextLockPath)) {
    console.info("Cleaning up Next.js lock file...");
    unlinkSync(nextLockPath);
    console.info("✅ Next.js lock file removed");
  }
} catch (_error) {
  console.warn("Could not remove Next.js lock file (may not exist)");
}

// Set environment based on detection (don't override if already set in .env)
if (!process.env.DEPLOYMENT_ENV) {
  process.env.DEPLOYMENT_ENV = detectedEnv;
}

// For localnet, also set chain defaults
if (isLocalnet) {
  process.env.NEXT_PUBLIC_CHAIN_ID = "31337";
  process.env.NEXT_PUBLIC_RPC_URL = "http://localhost:8545";
}

// 1. Check Docker
await $`docker --version`.quiet();
await $`docker info`.quiet().catch(() => {
  console.error("❌ Docker is not running");
  console.info("Please start Docker Desktop or Docker daemon");
  process.exit(1);
});
console.info("✅ Docker is running");

// 2. Check/create .env file (only for localnet when missing)
if (!existsSync(envPath) && isLocalnet) {
  console.info("Creating .env file...");
  // If .env.example exists, use it as a base but override localnet values
  const envExamplePath = join(process.cwd(), ".env.example");
  let envContent = "";

  if (existsSync(envExamplePath)) {
    envContent = readFileSync(envExamplePath, "utf-8");
    // Replace placeholder values with localnet defaults
    envContent = envContent.replace(
      /DATABASE_URL=.*/,
      'DATABASE_URL="postgresql://polyagent:polyagent_dev_password@localhost:5433/polyagent"',
    );
    envContent = envContent.replace(
      /REDIS_URL=.*/,
      'REDIS_URL="redis://localhost:6380"',
    );
    envContent = envContent.replace(
      /NEXT_PUBLIC_CHAIN_ID=.*/,
      "NEXT_PUBLIC_CHAIN_ID=31337",
    );
    envContent = envContent.replace(
      /NEXT_PUBLIC_RPC_URL=.*/,
      "NEXT_PUBLIC_RPC_URL=http://localhost:8545",
    );
    envContent = envContent.replace(
      /DEPLOYER_PRIVATE_KEY=.*/,
      "DEPLOYER_PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
    );
  } else {
    // Fallback to minimal template if .env.example is missing
    envContent = `DATABASE_URL="postgresql://polyagent:polyagent_dev_password@localhost:5433/polyagent"
REDIS_URL="redis://localhost:6380"
DEPLOYMENT_ENV=localnet
NEXT_PUBLIC_CHAIN_ID=31337
NEXT_PUBLIC_RPC_URL=http://localhost:8545
DEPLOYER_PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
NEXT_PUBLIC_PRIVY_APP_ID=""
`;
  }

  // Ensure DEPLOYMENT_ENV is set to localnet
  if (!envContent.includes("DEPLOYMENT_ENV=")) {
    envContent += "\nDEPLOYMENT_ENV=localnet";
  } else {
    envContent = envContent.replace(
      /DEPLOYMENT_ENV=.*/,
      "DEPLOYMENT_ENV=localnet",
    );
  }

  writeFileSync(envPath, envContent);
  console.info("✅ .env created from template");
}

// 3. Start Hardhat Node (only for localnet)
if (isLocalnet) {
  // The pre-dev script just checks if port 8545 is available
  console.info("Checking port 8545 for Hardhat node...");

  // Kill any process on port 8545 to ensure clean start
  const killed8545 = await killPort(8545);
  if (killed8545 > 0) {
    console.info(`✅ Killed ${killed8545} process(es) on port 8545`);
    // Wait a moment for port to be fully released
    await new Promise((resolve) => setTimeout(resolve, 1000));
  } else {
    console.info("✅ Port 8545 is free");
  }

  console.info(
    "Note: Hardhat node will be started automatically by the dev script",
  );
  console.info("      Contracts will be deployed once Hardhat is ready");
} else {
  console.info(`✅ Using ${detectedEnv} network (skipping Hardhat setup)`);
}

// 4. Start PostgreSQL
const postgresRunning =
  await $`docker ps --filter name=${POSTGRES_CONTAINER} --format "{{.Names}}"`
    .quiet()
    .text();

if (postgresRunning.trim() !== POSTGRES_CONTAINER) {
  console.info("Starting PostgreSQL...");
  await dockerComposeUp("postgres");

  let attempts = 0;
  while (attempts < 30) {
    const health =
      await $`docker inspect --format='{{.State.Health.Status}}' ${POSTGRES_CONTAINER}`
        .quiet()
        .text()
        .catch(() => "");
    if (health.trim() === "healthy") {
      console.info("✅ PostgreSQL is ready");
      break;
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));
    attempts++;
  }

  if (attempts === 30) {
    console.error("❌ PostgreSQL health check timeout");
    process.exit(1);
  }
} else {
  console.info("✅ PostgreSQL is running");
}

// 7. Start Redis (optional)
const redisRunning =
  await $`docker ps --filter name=${REDIS_CONTAINER} --format "{{.Names}}"`
    .quiet()
    .text();

if (redisRunning.trim() !== REDIS_CONTAINER) {
  console.info("Starting Redis...");
  await dockerComposeUp("redis")
    .then(async () => {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      console.info("✅ Redis started");
    })
    .catch(() => {
      console.warn("⚠️  Redis start failed (optional, continuing)");
    });
} else {
  console.info("✅ Redis is running");
}

// 8. Start MinIO (optional)
const minioRunning =
  await $`docker ps --filter name=${MINIO_CONTAINER} --format "{{.Names}}"`
    .quiet()
    .text();

if (minioRunning.trim() !== MINIO_CONTAINER) {
  console.info("Starting MinIO...");
  await dockerComposeUp("minio")
    .then(async () => {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      console.info("✅ MinIO started");
    })
    .catch(() => {
      console.warn("⚠️  MinIO start failed (optional, continuing)");
    });
} else {
  console.info("✅ MinIO is running");
}

// 9. Run database migrations and seed
// Force local database URL for local development (overrides .env.local if present)
const LOCAL_DATABASE_URL =
  "postgresql://polyagent:polyagent_dev_password@localhost:5433/polyagent";
process.env.DATABASE_URL = LOCAL_DATABASE_URL;
process.env.DIRECT_DATABASE_URL = LOCAL_DATABASE_URL; // Also override DIRECT_DATABASE_URL to prevent Neon connection

/**
 * Run drizzle-kit push with timeout and proper error handling
 * Uses --force flag to skip interactive confirmations
 * This prevents prompts from blocking the script in development
 */
async function runMigrations(): Promise<void> {
  const MIGRATION_TIMEOUT_MS = 120_000; // 120 seconds (schema pull can be slow)

  console.info("Running database migrations (drizzle-kit push --force)...");

  const migrationPromise = (async () => {
    // Run with --force to skip interactive prompts (safe for development)
    // The --force flag auto-accepts all changes without confirmation
    // Explicitly set DATABASE_URL and DIRECT_DATABASE_URL to local for the subprocess
    // Using tsx to run drizzle-kit for proper ESM support
    const result =
      await $`DATABASE_URL=${LOCAL_DATABASE_URL} DIRECT_DATABASE_URL=${LOCAL_DATABASE_URL} DEPLOYMENT_ENV=localnet npx tsx ../../node_modules/drizzle-kit/bin.cjs push --force --config=drizzle.config.ts`
        .cwd("packages/db")
        .nothrow();
    if (result.exitCode !== 0) {
      throw new Error(
        `drizzle-kit push failed with exit code ${result.exitCode}`,
      );
    }
    console.info("✅ Migrations completed");
  })();

  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => {
      reject(
        new Error(
          `Migration timed out after ${MIGRATION_TIMEOUT_MS / 1000} seconds`,
        ),
      );
    }, MIGRATION_TIMEOUT_MS);
  });

  await Promise.race([migrationPromise, timeoutPromise]);
}

// Query User table directly to check if database is ready
// This avoids potential issues with the health check returning false incorrectly
let userCount = 0;
let needsMigrations = false;
let needsSeed = false;

try {
  // Use a simple query via bun shell to avoid connection state issues
  const countResult =
    await $`docker exec polyagent-postgres psql -U polyagent -d polyagent -t -c "SELECT count(*) FROM \"User\";"`.quiet();
  userCount = parseInt(countResult.text().trim(), 10);
  if (Number.isNaN(userCount)) userCount = 0;
  console.info(`✅ Database connected (${userCount} users)`);
} catch (error: unknown) {
  const errorMessage = error instanceof Error ? error.message : String(error);
  if (
    errorMessage.includes("does not exist") ||
    errorMessage.includes("relation")
  ) {
    console.info("Database tables not found, running migrations...");
    needsMigrations = true;
    needsSeed = true;
  } else {
    console.info("Database not ready, running migrations...");
    needsMigrations = true;
  }
}

if (needsMigrations) {
  await runMigrations();
}

if (needsSeed || userCount === 0) {
  console.info("Running database seed...");
  // Explicitly set DATABASE_URL and DIRECT_DATABASE_URL to local for the seed subprocess
  await $`DATABASE_URL=${LOCAL_DATABASE_URL} DIRECT_DATABASE_URL=${LOCAL_DATABASE_URL} DEPLOYMENT_ENV=localnet bun run db:seed`;
  console.info("✅ Database seeded");
}

// 10. Validate environment
console.info("");
const validation = validateEnvironment(detectedEnv);
printValidationResult(validation);

console.info("");
console.info("=".repeat(60));
console.info(
  `✅ ${detectedEnv === "localnet" ? "Localnet" : detectedEnv === "testnet" ? "Testnet" : "Mainnet"} environment ready!`,
);
console.info("");
console.info("Services:");
if (isLocalnet) {
  console.info(
    "  Hardhat:    http://localhost:8545 (will be started automatically)",
  );
}
console.info("  PostgreSQL: localhost:5433");
console.info("  Redis:      localhost:6380");
console.info("  MinIO:      http://localhost:9000 (console: :9001)");
console.info("");
console.info("App Routes:");
console.info("  Main:       http://localhost:3000");
console.info(
  "  Betting:    http://localhost:3000/betting (Oracle-powered markets)",
);
console.info("");
if (isLocalnet) {
  console.info("Starting services (Hardhat, Next.js, Cron)...");
} else {
  console.info("Starting services (Next.js, Cron)...");
}
console.info("=".repeat(60));

// Force exit to prevent hanging from open handles (Redis, etc.)
process.exit(0);
