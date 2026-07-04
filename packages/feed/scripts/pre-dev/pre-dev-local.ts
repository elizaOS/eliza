#!/usr/bin/env bun

/**
 * Pre-Development Setup
 *
 * Sets up the development environment:
 * - Kills any processes on port 3000
 * - Starts PostgreSQL, Redis, MinIO via Docker Compose
 * - Runs database migrations and seeds data
 */

import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
// @ts-expect-error - bun global is available in bun runtime
import { $ } from "bun";

const POSTGRES_CONTAINER = "feed-postgres";
const REDIS_CONTAINER = "feed-redis";
const MINIO_CONTAINER = "feed-minio";
const STEWARD_CONTAINER = "feed-steward";

type DockerService = "postgres" | "redis" | "minio" | "steward";

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
  if (pidList.length === 0) return 0;
  for (const pid of pidList) {
    await $`kill -9 ${pid}`.quiet().nothrow();
  }
  return pidList.length;
}

function ensureEnvDefaults(
  envPath: string,
  defaults: Record<string, string>,
): void {
  let envContent = existsSync(envPath) ? readFileSync(envPath, "utf-8") : "";
  for (const [key, value] of Object.entries(defaults)) {
    const regex = new RegExp(`^${key}=.*$`, "m");
    if (!regex.test(envContent)) {
      envContent += `\n${key}=${value}`;
    }
  }
  writeFileSync(envPath, envContent);
}

// Load .env file into process.env
const envPath = join(process.cwd(), ".env");
if (existsSync(envPath)) {
  const envContent = readFileSync(envPath, "utf-8");
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

console.info("[Script] Setting up development environment...");
console.info("=".repeat(60));

// 1. Kill any processes on port 3000
console.info("[Script] Checking for processes on port 3000...");
const killedCount = await killPort(3000);
if (killedCount > 0) {
  console.info(`[Script] ✅ Killed ${killedCount} process(es) on port 3000`);
} else {
  console.info("[Script] ✅ Port 3000 is free");
}

// 2. Clean up stale Next.js lock files
const nextLockPath = join(process.cwd(), "apps", "web", ".next", "dev", "lock");
try {
  if (existsSync(nextLockPath)) {
    console.info("[Script] Cleaning up Next.js lock file...");
    unlinkSync(nextLockPath);
    console.info("[Script] ✅ Next.js lock file removed");
  }
} catch (_error) {
  console.warn("[Script] Could not remove Next.js lock file (may not exist)");
}

await $`pkill -f "next dev" || true`.quiet().nothrow();
await $`pkill -f "next-server" || true`.quiet().nothrow();

// 3. Create .env from .env.example if missing
if (!existsSync(envPath)) {
  console.info("Creating .env file...");
  const envExamplePath = join(process.cwd(), ".env.example");
  let envContent = "";

  if (existsSync(envExamplePath)) {
    envContent = readFileSync(envExamplePath, "utf-8");
    envContent = envContent.replace(
      /DATABASE_URL=.*/,
      'DATABASE_URL="postgresql://feed:feed_dev_password@localhost:5433/feed"',
    );
    envContent = envContent.replace(
      /REDIS_URL=.*/,
      'REDIS_URL="redis://localhost:6380"',
    );
  } else {
    envContent = `DATABASE_URL="postgresql://feed:feed_dev_password@localhost:5433/feed"
REDIS_URL="redis://localhost:6380"
STEWARD_JWT_SECRET="dev-jwt-secret-change-in-prod"
`;
  }

  writeFileSync(envPath, envContent);
  console.info("✅ .env created from template");
}

ensureEnvDefaults(envPath, {
  NEXT_PUBLIC_PERP_SETTLEMENT_MODE: "simulation",
  PERP_SETTLEMENT_MODE: "simulation",
});

// 4. Check Docker
await $`docker --version`.quiet();
await $`docker info`.quiet().catch(() => {
  console.error("❌ Docker is not running");
  process.exit(1);
});
console.info("✅ Docker is running");

// 5. Start PostgreSQL
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

// 6. Start Redis
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

// 7. Start MinIO
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

const LOCAL_DATABASE_URL =
  "postgresql://feed:feed_dev_password@localhost:5433/feed";
process.env.DATABASE_URL = LOCAL_DATABASE_URL;
process.env.DIRECT_DATABASE_URL = LOCAL_DATABASE_URL;

async function runMigrations(): Promise<void> {
  const MIGRATION_TIMEOUT_MS = 120_000;

  console.info("Running database migrations (drizzle-kit push --force)...");

  const migrationPromise = (async () => {
    const result =
      await $`DATABASE_URL=${LOCAL_DATABASE_URL} DIRECT_DATABASE_URL=${LOCAL_DATABASE_URL} bun run db:push -- --force`
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

let userCount = 0;
let needsMigrations = false;
let needsSeed = false;

try {
  const countResult =
    await $`docker exec feed-postgres psql -U feed -d feed -t -c "SELECT count(*) FROM \"User\";"`.quiet();
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
  await $`DATABASE_URL=${LOCAL_DATABASE_URL} DIRECT_DATABASE_URL=${LOCAL_DATABASE_URL} bun run db:seed`;
  console.info("✅ Database seeded");
}

// 9. Start Steward auth service (optional — requires ../steward sibling directory)
const stewardSiblingExists = existsSync(
  join(process.cwd(), "..", "steward", "Dockerfile"),
);

if (!stewardSiblingExists) {
  console.warn(
    "⚠️  ../steward not found — Steward auth service will not start.",
  );
  console.warn(
    "   Clone https://github.com/Steward-Fi/steward as a sibling to enable auth.",
  );
} else {
  const stewardRunning =
    await $`docker ps --filter name=${STEWARD_CONTAINER} --format "{{.Names}}"`
      .quiet()
      .text();

  if (stewardRunning.trim() !== STEWARD_CONTAINER) {
    console.info("Starting Steward auth service...");
    await dockerComposeUp("steward")
      .then(() =>
        console.info("✅ Steward container started, waiting for health..."),
      )
      .catch(() => console.warn("⚠️  Steward start failed (auth may not work)"));

    // Wait up to 60s for Steward's /health endpoint
    let stewardReady = false;
    for (let i = 0; i < 30; i++) {
      const ok = await fetch("http://localhost:3200/health")
        .then((r) => r.ok)
        .catch(() => false);
      if (ok) {
        stewardReady = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }

    if (stewardReady) {
      console.info("✅ Steward is ready at http://localhost:3200");
      console.info(
        '   Run "bun run steward:init" once to provision the feed tenant.',
      );
    } else {
      console.warn(
        "⚠️  Steward did not become healthy within 60s — check logs with:",
      );
      console.warn(`   docker logs ${STEWARD_CONTAINER}`);
    }
  } else {
    console.info("✅ Steward is running at http://localhost:3200");
  }
}

console.info("");
console.info("=".repeat(60));
console.info("✅ Development environment ready!");
console.info("");
console.info("Services:");
console.info("  PostgreSQL: localhost:5433");
console.info("  Redis:      localhost:6380");
console.info("  MinIO:      http://localhost:9000 (console: :9001)");
console.info("  Steward:    http://localhost:3200");
console.info("");
console.info("App Routes:");
console.info("  Main:       http://localhost:3000");
console.info("=".repeat(60));

process.exit(0);
