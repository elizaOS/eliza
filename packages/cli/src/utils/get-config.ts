import { promises as fs, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import dotenv from 'dotenv';
import { z } from 'zod';
import prompts from 'prompts';
import { logger } from '@elizaos/core';

// Database config schemas
const postgresConfigSchema = z.object({
  type: z.literal('postgres'),
  config: z.object({
    url: z.string().optional(),
  }),
});

const pgliteConfigSchema = z.object({
  type: z.literal('pglite'),
  config: z.object({
    dataDir: z.string(),
  }),
});

/**
 * Validates a Postgres URL format
 * @param url The URL to validate
 * @returns True if the URL appears valid
 */
export function isValidPostgresUrl(url: string): boolean {
  if (!url) return false;

  // Basic pattern: postgresql://user:password@host:port/dbname
  const basicPattern = /^postgresql:\/\/[^:]+:[^@]+@[^:]+:\d+\/\w+$/;

  // More permissive pattern (allows missing password, different formats)
  const permissivePattern = /^postgresql:\/\/.*@.*:\d+\/.*$/;

  // Cloud pattern: allows for URLs with query parameters like sslmode=require
  const cloudPattern = /^postgresql:\/\/[^:]+:[^@]+@[^\/]+\/[^?]+(\?.*)?$/;

  return basicPattern.test(url) || cloudPattern.test(url) || permissivePattern.test(url);
}

/**
 * Gets the standard Eliza directories
 * @returns Object containing standard directory paths
 */
export function getElizaDirectories() {
  const homeDir = os.homedir();
  const elizaDir = path.join(homeDir, '.eliza');
  const elizaDbDir = path.join(elizaDir, 'db');
  const envFilePath = path.join(elizaDir, '.env');

  return {
    homeDir,
    elizaDir,
    elizaDbDir,
    envFilePath,
  };
}

/**
 * Ensures the .eliza directory exists
 * @returns The eliza directories object
 */
export async function ensureElizaDir() {
  const dirs = getElizaDirectories();

  if (!existsSync(dirs.elizaDir)) {
    await fs.mkdir(dirs.elizaDir, { recursive: true });
    logger.info(`Created directory: ${dirs.elizaDir}`);
  }

  return dirs;
}

/**
 * Ensures the .env file exists
 * @param envFilePath Path to the .env file
 */
export async function ensureEnvFile(envFilePath: string) {
  if (!existsSync(envFilePath)) {
    await fs.writeFile(envFilePath, '', { encoding: 'utf8' });
    logger.debug(`Created empty .env file at ${envFilePath}`);
  }
}

/**
 * Sets up and configures PGLite database
 * @param elizaDbDir The directory for PGLite database
 * @param envFilePath Path to the .env file
 */
export async function setupPgLite(elizaDbDir: string, envFilePath: string): Promise<void> {
  try {
    // Ensure the PGLite database directory exists
    if (!existsSync(elizaDbDir)) {
      await fs.mkdir(elizaDbDir, { recursive: true });
      logger.info(`Created PGLite database directory: ${elizaDbDir}`);
    }

    // Ensure .env file exists
    await ensureEnvFile(envFilePath);

    // Store PGLITE_DATA_DIR in the environment file
    await fs.writeFile(envFilePath, `PGLITE_DATA_DIR=${elizaDbDir}\n`, { flag: 'a' });

    // Also set in process.env for the current session
    process.env.PGLITE_DATA_DIR = elizaDbDir;

    logger.success('PGLite configuration saved');
  } catch (error) {
    logger.error('Error setting up PGLite directory:', error);
    throw error;
  }
}

/**
 * Stores Postgres URL in the .env file
 * @param url The Postgres URL to store
 * @param envFilePath Path to the .env file
 */
export async function storePostgresUrl(url: string, envFilePath: string): Promise<void> {
  if (!url) return;

  try {
    // Ensure .env file exists
    await ensureEnvFile(envFilePath);

    // Store the URL in the .env file
    await fs.writeFile(envFilePath, `POSTGRES_URL=${url}\n`, { flag: 'a' });

    // Also set in process.env for the current session
    process.env.POSTGRES_URL = url;

    logger.success('Postgres URL saved to configuration');
  } catch (error) {
    logger.warn('Error saving database configuration:', error);
  }
}

/**
 * Prompts the user for a Postgres URL, validates it, and stores it
 * @returns The configured Postgres URL or null if user skips
 */
/**
 * Prompts the user for a Postgres URL, validates it, and stores it
 * @returns The configured Postgres URL or null if user cancels
 */
export async function promptAndStorePostgresUrl(envFilePath: string): Promise<string | null> {
  const response = await prompts({
    type: 'text',
    name: 'postgresUrl',
    message: 'Enter your Postgres URL:',
    validate: (value) => {
      if (value.trim() === '') return 'Postgres URL cannot be empty';

      const isValid = isValidPostgresUrl(value);
      if (!isValid) {
        return `Invalid URL format. Expected: postgresql://user:password@host:port/dbname.`;
      }
      return true;
    },
  });

  // Handle user cancellation (Ctrl+C)
  if (!response.postgresUrl) {
    return null;
  }

  // Store the URL in the .env file
  await storePostgresUrl(response.postgresUrl, envFilePath);

  return response.postgresUrl;
}

/**
 * Configures the database to use, either PGLite or PostgreSQL
 * @param reconfigure If true, force reconfiguration even if already configured
 * @returns The postgres URL if using Postgres, otherwise null
 */
export async function configureDatabaseSettings(reconfigure = false): Promise<string | null> {
  // Set up directories and env file
  const { elizaDbDir, envFilePath } = await ensureElizaDir();
  await ensureEnvFile(envFilePath);

  // Check if we already have database configuration in env
  let postgresUrl = process.env.POSTGRES_URL;
  const pgliteDataDir = process.env.PGLITE_DATA_DIR;

  // Add debug logging
  logger.debug(`Configuration check - POSTGRES_URL: ${postgresUrl ? 'SET' : 'NOT SET'}`);
  logger.debug(`Configuration check - PGLITE_DATA_DIR: ${pgliteDataDir ? 'SET' : 'NOT SET'}`);
  logger.debug(`Configuration check - reconfigure: ${reconfigure}`);

  // BYPASS ADDED: Skip prompts and always use postgres if URL is provided
  if (process.env.POSTGRES_URL) {
    console.log('BYPASS: Using postgres URL from environment variable');
    return process.env.POSTGRES_URL;
  }

  // BYPASS ADDED: Use pglite if PGLITE_DATA_DIR is provided
  if (process.env.PGLITE_DATA_DIR) {
    console.log('BYPASS: Using pglite with provided data directory');
    await setupPgLite(process.env.PGLITE_DATA_DIR, envFilePath);
    return null;
  }

  // BYPASS ADDED: Default to pglite if no configuration is provided
  console.log('BYPASS: No database configuration found, defaulting to pglite');
  await setupPgLite(elizaDbDir, envFilePath);
  return null;
}

// Main config schema
/**
 * Schema definition for the raw configuration object.
 *
 * @type {z.ZodType<RawConfig>}
 */
export const rawConfigSchema = z
  .object({
    $schema: z.string().optional(),
    database: z.discriminatedUnion('type', [postgresConfigSchema, pgliteConfigSchema]),
    plugins: z.object({
      registry: z.string().url(),
      installed: z.array(z.string()),
    }),
    paths: z.object({
      knowledge: z.string(),
    }),
  })
  .strict();

/**
 * Type definition for the inferred type of the raw config schema.
 */
export type RawConfig = z.infer<typeof rawConfigSchema>;

export const configSchema = rawConfigSchema.extend({
  resolvedPaths: z.object({
    knowledge: z.string(),
  }),
});

/**
 * Define the type `Config` as the inferred type from the `configSchema`.
 */
export type Config = z.infer<typeof configSchema>;

/**
 * Resolves the paths in the given configuration based on the provided current working directory (cwd).
 * @param {string} cwd - The current working directory.bun run b
 * @param {RawConfig} config - The raw configuration object.
 * @returns {Promise<ResolvedConfig>} The resolved configuration object with updated paths.
 */
export async function resolveConfigPaths(cwd: string, config: RawConfig) {
  return configSchema.parse({
    ...config,
    resolvedPaths: {
      knowledge: path.resolve(cwd, config.paths.knowledge),
    },
  });
}

/**
 * Load environment variables, trying project .env first, then global ~/.eliza/.env
 */
/**
 * Loads environment variables from either the project directory or global config.
 * If the .env file is found in the project directory, it will be loaded.
 * If not found in the project directory, it will try to load from the global config.
 * If neither exist, it will create the global .env file with a default comment.
 *
 * @param {string} projectDir - The directory where the project is located (default: process.cwd()).
 * @returns {Promise<void>} A Promise that resolves once the environment variables are loaded or created.
 */
export async function loadEnvironment(projectDir: string = process.cwd()): Promise<void> {
  const projectEnvPath = path.join(projectDir, '.env');
  const globalEnvDir = path.join(os.homedir(), '.eliza');
  const globalEnvPath = path.join(globalEnvDir, '.env');

  // First try loading from project directory
  if (existsSync(projectEnvPath)) {
    dotenv.config({ path: projectEnvPath });
    return;
  }

  // If not found, try loading from global config
  if (existsSync(globalEnvPath)) {
    dotenv.config({ path: globalEnvPath });
    return;
  }

  // If neither exists, create the global .env
  if (!existsSync(globalEnvDir)) {
    await fs.mkdir(globalEnvDir, { recursive: true });
  }

  // Create an empty .env file
  if (!existsSync(globalEnvPath)) {
    await fs.writeFile(globalEnvPath, '# Global environment variables for Eliza\n');
  }
}
