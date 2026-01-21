#!/usr/bin/env bun
/**
 * Pre-Development Setup for Testnet
 *
 * Validates testnet deployment before starting dev server:
 * - Checks environment variables
 * - Validates contract deployments
 * - Checks Agent0 configuration
 * - Starts local database services
 */

import { $ } from "bun";
import {
  type DeploymentEnv,
  printValidationResult,
  validateEnvironment,
} from "../../packages/contracts/src/deployment/env-detection";
import {
  type ValidationResult,
  validateDeployment,
} from "../../packages/contracts/src/deployment/validation";

function printDeploymentResult(
  result: ValidationResult,
  _env: DeploymentEnv,
): void {
  if (!result.deployed) {
    console.error("❌ Contracts not deployed to testnet", undefined, "Script");
    console.info("", undefined, "Script");
    console.info("Deploy contracts with:", undefined, "Script");
    console.info("  bun run contracts:deploy:testnet", undefined, "Script");
    process.exit(1);
  }
}

const BASE_SEPOLIA_RPC_URL =
  process.env.BASE_SEPOLIA_RPC_URL ||
  process.env.NEXT_PUBLIC_RPC_URL ||
  "https://sepolia.base.org";

console.info(
  "Setting up testnet development environment...",
  undefined,
  "Script",
);
console.info("=".repeat(60), undefined, "Script");

// Set environment for testnet
process.env.DEPLOYMENT_ENV = "testnet";
process.env.NEXT_PUBLIC_CHAIN_ID = "84532";

// 1. Validate environment variables
console.info("Validating environment...", undefined, "Script");
const envValidation = validateEnvironment("testnet");

if (!envValidation.valid) {
  console.error("❌ Environment validation failed", undefined, "Script");
  envValidation.errors.forEach((error) => {
    console.error(`   ${error}`, undefined, "Script");
  });
  console.info("", undefined, "Script");
  console.info("To fix:", undefined, "Script");
  console.info(
    "  1. Copy .env.testnet.example to .env.testnet",
    undefined,
    "Script",
  );
  console.info("  2. Fill in required values", undefined, "Script");
  console.info(
    "  3. Deploy contracts: bun run contracts:deploy:testnet",
    undefined,
    "Script",
  );
  process.exit(1);
}

printValidationResult(envValidation);

// 2. Validate contract deployment
console.info("", undefined, "Script");
console.info("Validating contract deployment...", undefined, "Script");

const contractValidation = await validateDeployment(
  "testnet",
  BASE_SEPOLIA_RPC_URL,
);

if (!contractValidation.deployed) {
  console.error("❌ Contracts not deployed to testnet", undefined, "Script");
  console.info("", undefined, "Script");
  console.info("Deploy contracts with:", undefined, "Script");
  console.info("  bun run contracts:deploy:testnet", undefined, "Script");
  process.exit(1);
}

if (!contractValidation.valid) {
  console.error("❌ Contract validation failed", undefined, "Script");
  contractValidation.errors.forEach((error) => {
    console.error(`   ${error}`, undefined, "Script");
  });
  process.exit(1);
}

printDeploymentResult(contractValidation, "testnet");

// 3. Check Agent0 configuration (if enabled)
if (process.env.AGENT0_ENABLED === "true") {
  console.info("", undefined, "Script");
  console.info("Checking Agent0 configuration...", undefined, "Script");

  if (!process.env.BASE_SEPOLIA_RPC_URL) {
    console.warn("⚠️  BASE_SEPOLIA_RPC_URL not set", undefined, "Script");
  }

  if (!process.env.POLYAGENT_GAME_PRIVATE_KEY) {
    console.warn("⚠️  POLYAGENT_GAME_PRIVATE_KEY not set", undefined, "Script");
    console.info("   Agent0 integration may not work", undefined, "Script");
  }

  if (!process.env.AGENT0_SUBGRAPH_URL) {
    console.warn("⚠️  AGENT0_SUBGRAPH_URL not set", undefined, "Script");
    console.info("   Agent discovery may not work", undefined, "Script");
  } else {
    console.info("✅ Agent0 configured", undefined, "Script");
  }
}

// 4. Start local database services
console.info("", undefined, "Script");
console.info("Starting local database services...", undefined, "Script");

await $`docker --version`.quiet().catch(() => {
  console.warn("⚠️  Could not start local services", undefined, "Script");
  console.info("   Make sure Docker is running", undefined, "Script");
  throw new Error("Docker not available");
});

await $`docker info`.quiet();

// Start PostgreSQL
const postgresRunning =
  await $`docker ps --filter name=polyagent-postgres --format "{{.Names}}"`
    .quiet()
    .text();

if (postgresRunning.trim() !== "polyagent-postgres") {
  console.info("Starting PostgreSQL...", undefined, "Script");
  await $`docker-compose up -d postgres`;
  await new Promise((resolve) => setTimeout(resolve, 3000));
  console.info("✅ PostgreSQL started", undefined, "Script");
} else {
  console.info("✅ PostgreSQL is running", undefined, "Script");
}

// Start Redis (optional)
const redisRunning =
  await $`docker ps --filter name=polyagent-redis --format "{{.Names}}"`
    .quiet()
    .text();

if (redisRunning.trim() !== "polyagent-redis") {
  await $`docker-compose up -d redis`
    .then(() => {
      console.info("✅ Redis started", undefined, "Script");
    })
    .catch(() => {
      console.warn("⚠️  Redis start failed (optional)", undefined, "Script");
    });
} else {
  console.info("✅ Redis is running", undefined, "Script");
}

// Run database migrations
import {
  actorState,
  checkDatabaseHealth,
  closeDatabase,
  count,
  db,
} from "../../packages/db/src";

const isConnected = await checkDatabaseHealth().catch(() => false);
if (!isConnected) {
  console.info(
    "Database not ready, running migrations...",
    undefined,
    "Script",
  );
  await $`bunx drizzle-kit push --config=drizzle.config.ts`
    .cwd("packages/db")
    .quiet()
    .catch(async () => {
      await $`bunx drizzle-kit push --force --config=drizzle.config.ts`
        .cwd("packages/db")
        .quiet();
    });
}

console.info("✅ Database connected", undefined, "Script");

const actorCountResult = await db
  .select({ count: count() })
  .from(actorState)
  .catch(async (error: Error) => {
    const errorMessage = error.message;
    if (
      errorMessage.includes("does not exist") ||
      errorMessage.includes("relation")
    ) {
      console.info("Running database migrations...", undefined, "Script");
      await $`bunx drizzle-kit push --config=drizzle.config.ts`
        .cwd("packages/db")
        .quiet()
        .catch(async () => {
          await $`bunx drizzle-kit push --force --config=drizzle.config.ts`
            .cwd("packages/db")
            .quiet();
        });

      console.info("Running database seed...", undefined, "Script");
      await $`bun run db:seed`;
      console.info("✅ Database ready", undefined, "Script");
      return [{ count: 0 }];
    }
    throw error;
  });

const actorCount = Number(actorCountResult[0]?.count ?? 0);

if (actorCount === 0) {
  console.info("Running database seed...", undefined, "Script");
  await $`bun run db:seed`;
  console.info("✅ Database seeded", undefined, "Script");
} else if (actorCount > 0) {
  console.info(
    `✅ Database has ${actorCount} actor states`,
    undefined,
    "Script",
  );
}

await closeDatabase();

console.info("", undefined, "Script");
console.info("=".repeat(60), undefined, "Script");
console.info("✅ Testnet environment ready!", undefined, "Script");
console.info("", undefined, "Script");
console.info("Network:", undefined, "Script");
console.info("  Chain: Base Sepolia (84532)", undefined, "Script");
console.info(`  RPC: ${BASE_SEPOLIA_RPC_URL}`, undefined, "Script");
console.info("  Explorer: https://sepolia.basescan.org", undefined, "Script");
console.info("", undefined, "Script");
if (contractValidation.contracts.diamond) {
  console.info("Contracts:", undefined, "Script");
  console.info(
    `  Diamond: ${contractValidation.contracts.diamond}`,
    undefined,
    "Script",
  );
}
console.info("", undefined, "Script");
console.info("Starting Next.js...", undefined, "Script");
console.info("=".repeat(60), undefined, "Script");
