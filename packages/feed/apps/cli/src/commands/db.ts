#!/usr/bin/env bun

/**
 * @fileoverview Database management commands
 *
 * Provides commands for managing the PostgreSQL database container, running migrations,
 * seeding data, and checking database status using Docker and docker-compose.
 *
 * @module cli/commands/db
 */

import { $ } from 'bun';
import { existsSync } from 'fs';
import { join } from 'path';
import { parseArgs, wantsHelp } from '../lib/args.js';
import { logger } from '../lib/logger.js';

const CONTAINER_NAME = 'feed-postgres';
const COMPOSE_FILE = 'docker-compose.yml';
const HOST_PORT = '5433';

export function isRecoverableComposeStartError(message: string): boolean {
  const normalized = message.toLowerCase();

  return (
    normalized.includes('failed to set up container networking') ||
    (normalized.includes('network') && normalized.includes('not found'))
  );
}

async function startPostgresContainer(forceRecreate = false): Promise<void> {
  if (forceRecreate) {
    await $`docker-compose up -d --force-recreate postgres`;
    return;
  }

  await $`docker-compose up -d postgres`;
}

function getShellErrorText(error: unknown): string {
  if (error && typeof error === 'object' && 'stderr' in error) {
    const stderr = error.stderr;

    if (typeof stderr === 'string') {
      return stderr;
    }

    if (stderr instanceof Uint8Array) {
      return Buffer.from(stderr).toString('utf8');
    }

    if (stderr != null) {
      return String(stderr);
    }
  }

  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function printHelp(): void {
  console.log(`
Database Management

USAGE:
  feed db <command>

COMMANDS:
  start     Start PostgreSQL container
  stop      Stop PostgreSQL container
  restart   Restart PostgreSQL container
  status    Show database status
  migrate   Run database migrations
  seed      Seed database with initial data
  reset     Reset database (drop + migrate)

EXAMPLES:
  feed db start
  feed db migrate
  feed db seed
  feed db status

ENVIRONMENT:
  DATABASE_URL should be set in your .env file:
  DATABASE_URL="postgresql://feed:feed_dev_password@localhost:5433/feed"
`);
}

/**
 * Verifies Docker is installed and running.
 *
 * Checks both Docker installation and daemon status before proceeding with
 * database operations.
 *
 * @throws Exits process with code 1 if Docker is not installed or not running
 * @internal
 */
async function checkDocker(): Promise<void> {
  logger.step('Checking Docker installation...');

  try {
    await $`docker --version`.quiet();
  } catch {
    logger.fail('Docker is not installed!');
    console.log('Install Docker: https://docs.docker.com/get-docker/');
    process.exit(1);
  }

  try {
    await $`docker info`.quiet();
  } catch {
    logger.fail('Docker is installed but not running!');
    console.log('Please start Docker Desktop or the Docker daemon.');
    process.exit(1);
  }

  logger.success('Docker is running');
}

/**
 * Verifies docker-compose.yml exists in project root.
 *
 * @throws Exits process with code 1 if compose file not found
 * @internal
 */
function checkComposeFile(): void {
  const composePath = join(process.cwd(), COMPOSE_FILE);
  if (!existsSync(composePath)) {
    logger.fail(`${COMPOSE_FILE} not found in project root`);
    process.exit(1);
  }
}

/**
 * Checks if the PostgreSQL container is currently running.
 *
 * @returns `true` if container is running, `false` otherwise
 * @internal
 */
async function isContainerRunning(): Promise<boolean> {
  const result =
    await $`docker ps --filter name=${CONTAINER_NAME} --format "{{.Names}}"`
      .quiet()
      .text()
      .catch(() => '');
  return result.trim() === CONTAINER_NAME;
}

/**
 * Checks if the PostgreSQL container exists (running or stopped).
 *
 * @returns `true` if container exists, `false` otherwise
 * @internal
 */
async function doesContainerExist(): Promise<boolean> {
  const result =
    await $`docker ps -a --filter name=${CONTAINER_NAME} --format "{{.Names}}"`
      .quiet()
      .text()
      .catch(() => '');
  return result.trim() === CONTAINER_NAME;
}

/**
 * Starts the PostgreSQL database container.
 *
 * Creates container if it doesn't exist and waits for health check to pass.
 * Uses docker-compose to manage the container lifecycle.
 *
 * @internal
 */
async function startDatabase(): Promise<void> {
  logger.header('Starting PostgreSQL');

  await checkDocker();
  checkComposeFile();

  if (await isContainerRunning()) {
    logger.success('PostgreSQL is already running');
    await showConnectionInfo();
    return;
  }

  logger.step('Starting container...');
  try {
    await startPostgresContainer();
  } catch (error) {
    const stderr = getShellErrorText(error);

    if (!isRecoverableComposeStartError(stderr)) {
      throw error;
    }

    logger.warn(
      'Detected stale Docker networking state. Recreating feed-postgres...'
    );

    await $`docker rm -f ${CONTAINER_NAME}`.quiet().catch(() => undefined);
    await startPostgresContainer(true);
  }

  logger.step('Waiting for PostgreSQL to be ready...');

  let attempts = 0;
  const maxAttempts = 30;

  while (attempts < maxAttempts) {
    const health =
      await $`docker inspect --format='{{.State.Health.Status}}' ${CONTAINER_NAME}`
        .quiet()
        .text()
        .catch(() => '');

    if (health.trim() === 'healthy') {
      logger.success('PostgreSQL is ready');
      await showConnectionInfo();
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));
    attempts++;
  }

  logger.warn('Health check timeout - PostgreSQL may still be starting...');
  await showConnectionInfo();
}

/**
 * Stops the PostgreSQL database container.
 *
 * Gracefully stops the container using docker-compose stop.
 *
 * @internal
 */
async function stopDatabase(): Promise<void> {
  logger.header('Stopping PostgreSQL');

  await checkDocker();

  if (!(await isContainerRunning())) {
    logger.success('PostgreSQL is not running');
    return;
  }

  logger.step('Stopping container...');
  await $`docker-compose stop postgres`;
  logger.success('PostgreSQL stopped');
}

/**
 * Restarts the PostgreSQL database container.
 *
 * Stops and then starts the container with a brief delay between operations.
 *
 * @internal
 */
async function restartDatabase(): Promise<void> {
  logger.header('Restarting PostgreSQL');

  await stopDatabase();
  await new Promise((resolve) => setTimeout(resolve, 2000));
  await startDatabase();
}

/**
 * Displays the current database container status.
 *
 * Shows running state, uptime, health status, and connection information.
 * Provides helpful messages if container doesn't exist or isn't running.
 *
 * @internal
 */
async function showStatus(): Promise<void> {
  logger.header('Database Status');

  await checkDocker();

  const exists = await doesContainerExist();
  const isRunning = await isContainerRunning();

  if (!exists) {
    console.log('Status: Not created');
    console.log("\nRun 'feed db start' to create and start the database.");
    return;
  }

  if (isRunning) {
    console.log('Status: ✅ Running');

    const uptime =
      await $`docker inspect --format='{{.State.StartedAt}}' ${CONTAINER_NAME}`
        .quiet()
        .text()
        .catch(() => '');
    if (uptime) {
      console.log(`Started: ${uptime.trim()}`);
    }

    const health =
      await $`docker inspect --format='{{.State.Health.Status}}' ${CONTAINER_NAME}`
        .quiet()
        .text()
        .catch(() => '');
    if (health) {
      console.log(`Health: ${health.trim()}`);
    }

    await showConnectionInfo();
  } else {
    console.log('Status: ⏸️  Stopped');
    console.log("\nRun 'feed db start' to start the database.");
  }
}

/**
 * Displays database connection information.
 *
 * Shows host, port, database name, user, password, and connection URL
 * for the PostgreSQL container.
 *
 * @internal
 */
async function showConnectionInfo(): Promise<void> {
  console.log('\nConnection Info:');
  console.log('  Host:     localhost');
  console.log(`  Port:     ${HOST_PORT}`);
  console.log('  Database: feed');
  console.log('  User:     feed');
  console.log('  Password: feed_dev_password');
  console.log(
    `\n  URL: postgresql://feed:feed_dev_password@localhost:${HOST_PORT}/feed`
  );
}

/**
 * Runs database migrations using drizzle-kit push.
 *
 * Pushes schema changes from Drizzle ORM definitions to the database.
 * Requires the database container to be running.
 *
 * @throws Exits process with code 1 if database is not running
 * @internal
 */
async function runMigrations(): Promise<void> {
  logger.header('Running Database Migrations');

  if (!(await isContainerRunning())) {
    logger.fail('PostgreSQL is not running!');
    console.log('Start it first with: feed db start');
    process.exit(1);
  }

  logger.step('Pushing schema changes...');
  await $`bunx drizzle-kit push --config=packages/db/drizzle.config.ts`;
  logger.success('Migrations complete');
}

/**
 * Seeds the database with initial data.
 *
 * Runs the seed script to populate the database with actors, organizations,
 * and other initial data. Requires the database container to be running.
 *
 * @throws Exits process with code 1 if database is not running
 * @internal
 */
async function seedDatabase(): Promise<void> {
  logger.header('Seeding Database');

  if (!(await isContainerRunning())) {
    logger.fail('PostgreSQL is not running!');
    console.log('Start it first with: feed db start');
    process.exit(1);
  }

  logger.step('Running seed script...');
  const rootDir = import.meta.dirname.replace('/apps/cli/src/commands', '');
  await $`bun run ${rootDir}/scripts/seed-database.ts`;
  logger.success('Database seeded');
}

/**
 * Resets the database by dropping and recreating schema.
 *
 * **Warning:** This will delete all data! Forces schema push using drizzle-kit.
 * Requires the database container to be running.
 *
 * @throws Exits process with code 1 if database is not running
 * @internal
 */
async function resetDatabase(): Promise<void> {
  logger.header('Resetting Database');

  logger.warn('This will delete all data!');

  if (!(await isContainerRunning())) {
    logger.fail('PostgreSQL is not running!');
    console.log('Start it first with: feed db start');
    process.exit(1);
  }

  logger.step('Resetting schema...');
  await $`bunx drizzle-kit push --force --config=packages/db/drizzle.config.ts`;
  logger.success('Database reset complete');
}

/**
 * Main entry point for database domain commands.
 *
 * Routes to appropriate sub-command handlers based on parsed arguments.
 *
 * **Supported Commands:**
 * - `start` - Start PostgreSQL container
 * - `stop` - Stop PostgreSQL container
 * - `restart` - Restart PostgreSQL container
 * - `status` - Show database status
 * - `migrate` - Run database migrations
 * - `seed` - Seed database with initial data
 * - `reset` - Reset database (drop + migrate)
 *
 * @param args - Raw command-line arguments for the database domain
 * @throws Exits process with code 1 on error, 0 on success
 */
export async function runDbCommand(args: string[]): Promise<void> {
  const parsed = parseArgs(args);

  if (wantsHelp(parsed)) {
    printHelp();
    process.exit(0);
  }

  switch (parsed.command) {
    case 'start':
      await startDatabase();
      break;

    case 'stop':
      await stopDatabase();
      break;

    case 'restart':
      await restartDatabase();
      break;

    case 'status':
      await showStatus();
      break;

    case 'migrate':
      await runMigrations();
      break;

    case 'seed':
      await seedDatabase();
      break;

    case 'reset':
      await resetDatabase();
      break;

    default:
      if (parsed.command) {
        logger.fail(`Unknown command: ${parsed.command}`);
      }
      printHelp();
      process.exit(parsed.command ? 1 : 0);
  }
}
