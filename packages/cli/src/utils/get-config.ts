import { logger } from '@elizaos/core';
import dotenv from 'dotenv';
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import prompts from 'prompts';
import { z } from 'zod';
import { resolveEnvFile, resolvePgliteDir } from './resolve-utils';
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
 * Retrieves the standard directory paths used by Eliza for configuration and database storage.
 *
 * @returns An object containing the Eliza configuration directory, the Eliza database directory for the current project, and the path to the Eliza `.env` file.
 */
export async function getElizaDirectories() {
  const elizaDir = path.join(process.cwd(), '.eliza');
  const elizaDbDir = await resolvePgliteDir();
  const envFilePath = resolveEnvFile();

  logger.debug('[Config] Using database directory:', elizaDbDir);

  return {
    elizaDir,
    elizaDbDir,
    envFilePath,
  };
}

/**
 * Generic function to ensure a directory exists
 * @param dirPath Path to the directory
 */
async function ensureDir(dirPath: string) {
  if (!existsSync(dirPath)) {
    await fs.mkdir(dirPath, { recursive: true });
    logger.info(`Created directory: ${dirPath}`);
  }
}

/**
 * Generic function to ensure a file exists
 * @param filePath Path to the file
 */
async function ensureFile(filePath: string) {
  if (!existsSync(filePath)) {
    await fs.writeFile(filePath, '', { encoding: 'utf8' });
    logger.info(`Created file: ${filePath}`);
  }
}

/**
 * Ensures the Eliza configuration directory exists and returns standard Eliza directory paths.
 *
 * @returns An object containing paths for the Eliza configuration directory, the Eliza database directory, and the `.env` file.
 */
export async function ensureElizaDir() {
  const dirs = await getElizaDirectories();
  await ensureDir(dirs.elizaDir);
  return dirs;
}

/**
 * Sets up and configures PGLite database
 * @param elizaDbDir The directory for PGLite database
 * @param envFilePath Path to the .env file
 */
export async function setupPgLite(dbDir: any, envPath: any): Promise<void> {
  const dirs = await ensureElizaDir();
  const { elizaDir, elizaDbDir, envFilePath } = dirs;

  // Use provided parameters or defaults from dirs
  const targetDbDir = dbDir || elizaDbDir;
  const targetEnvPath = envPath || envFilePath;

  try {
    // Ensure the PGLite database directory exists
    await ensureDir(targetDbDir);
    logger.debug('[PGLite] Created database directory:', targetDbDir);

    // Ensure .env file exists
    await ensureFile(targetEnvPath);
    logger.debug('[PGLite] Ensured .env file exists:', targetEnvPath);

    // Store PGLITE_DATA_DIR in the environment file
    await fs.writeFile(targetEnvPath, `PGLITE_DATA_DIR=${targetDbDir}\n`, { flag: 'a' });

    // Also set in process.env for the current session
    process.env.PGLITE_DATA_DIR = targetDbDir;

    logger.success('PGLite configuration saved');
  } catch (error) {
    logger.error('Error setting up PGLite directory:', {
      error: error instanceof Error ? error.message : String(error),
      elizaDbDir,
      envFilePath,
    });
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
    await ensureFile(envFilePath);

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
  await ensureFile(envFilePath);
  await loadEnvironment(elizaDbDir);

  // Check if we already have database configuration in env
  let postgresUrl = process.env.POSTGRES_URL;
  const pgliteDataDir = resolvePgliteDir(undefined, elizaDbDir);

  // Add debug logging
  logger.debug(`Configuration check - POSTGRES_URL: ${postgresUrl ? 'SET' : 'NOT SET'}`);
  logger.debug(`Configuration check - PGLITE_DATA_DIR: ${pgliteDataDir ? 'SET' : 'NOT SET'}`);
  logger.debug(`Configuration check - reconfigure: ${reconfigure}`);

  // BYPASS ADDED: Skip prompts and always use postgres if URL is provided
  if (process.env.POSTGRES_URL) {
    console.log('BYPASS: Using postgres URL from environment variable');
    return process.env.POSTGRES_URL;
  }

  // If we already have PGLITE_DATA_DIR set in env and not reconfiguring, use PGLite
  if (pgliteDataDir && !reconfigure) {
    logger.debug(`Using existing PGLite configuration: ${pgliteDataDir}`);

    // Ensure the directory exists
    await ensureDir(pgliteDataDir);

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
 * Load environment variables from the project `.env` file if it exists.
 *
 * @param projectDir - Directory containing the `.env` file. Defaults to the current working directory.
 */
export async function loadEnvironment(projectDir: string = process.cwd()): Promise<void> {
  const envPath = resolveEnvFile(projectDir);
  if (existsSync(envPath)) {
    dotenv.config({ path: envPath });
  }
}
