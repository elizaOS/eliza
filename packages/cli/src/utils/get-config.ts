import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { z } from 'zod';
import prompts from 'prompts';
import { logger, stringToUuid } from '@elizaos/core';
import { UserEnvironment } from './user-environment';

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
 * @returns An object containing the user's home directory, the Eliza configuration directory, the Eliza database directory for the current project, and the path to the Eliza `.env` file.
 */
export async function getElizaDirectories() {
  const envInfo = await UserEnvironment.getInstanceInfo();
  const homeDir = envInfo.os.homedir;

  logger.debug('[Config] Using home directory:', homeDir);

  const elizaDir = path.join(homeDir, '.eliza');
  const elizaDbDir = path.join(elizaDir, 'projects', stringToUuid(process.cwd()), 'pglite/');
  const envFilePath = path.join(elizaDir, '.env');

  logger.debug('[Config] Using database directory:', elizaDbDir);

  return {
    homeDir,
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
 * @returns An object containing paths for the user's home directory, the Eliza configuration directory, the Eliza database directory, and the `.env` file.
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
export async function setupPgLite(): Promise<void> {
  const dirs = await ensureElizaDir();
  const { elizaDir, elizaDbDir, envFilePath } = dirs;

  try {
    // Ensure the PGLite database directory exists
    await ensureDir(elizaDbDir);
    logger.debug('[PGLite] Created database directory:', elizaDbDir);

    // Ensure .env file exists
    await ensureFile(envFilePath);
    logger.debug('[PGLite] Ensured .env file exists:', envFilePath);

    // Store PGLITE_DATA_DIR in the environment file
    await fs.writeFile(envFilePath, `PGLITE_DATA_DIR=${elizaDbDir}\n`, { flag: 'a' });

    // Also set in process.env for the current session
    process.env.PGLITE_DATA_DIR = elizaDbDir;

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
  const pgliteDataDir = process.env.PGLITE_DATA_DIR || path.join(elizaDbDir, 'pglite');

  // If we already have a postgres URL configured and not reconfiguring, use that
  if (postgresUrl && !reconfigure) {
    logger.debug('Using existing PostgreSQL configuration');
    return postgresUrl;
  }

  // If we already have PGLITE_DATA_DIR set in env and not reconfiguring, use PGLite
  if (pgliteDataDir && !reconfigure) {
    logger.debug(`Using existing PGLite configuration: ${pgliteDataDir}`);

    // Ensure the directory exists
    await ensureDir(pgliteDataDir);

    return null;
  }

  try {
    // Prompt for database selection
    const { database } = await prompts({
      type: 'select',
      name: 'database',
      message: 'Select your database:',
      choices: [
        { title: 'pglite (embedded database)', value: 'pglite' },
        { title: 'postgres (external database)', value: 'postgres' },
      ],
      initial: 0,
    });

    if (!database || database === 'pglite') {
      // If selection canceled or pglite selected
      const dbChoice = !database ? 'Selection canceled, defaulting to' : 'Selected';
      logger.info(`${dbChoice} pglite database`);

      await setupPgLite();
      return null;
    }

    // User selected postgres
    const result = await promptAndStorePostgresUrl(envFilePath);
    if (!result) {
      // If no valid Postgres URL provided, default to PGLite
      logger.warn('No valid Postgres URL provided, defaulting to pglite database');
      await setupPgLite();
      return null;
    }

    return result;
  } catch (error) {
    logger.error('Error during database configuration:', error);
    logger.info('Defaulting to pglite database');

    try {
      await setupPgLite();
    } catch (setupError) {
      logger.error('Critical error setting up database:', setupError);
      throw new Error('Failed to configure database');
    }
  }

  return null; // Default to pglite
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
 * Loads environment variables from a project-specific or global `.env` file, creating the global file if neither exists.
 *
 * If a `.env` file is present in the project directory, its variables are loaded. Otherwise, the function attempts to load from the global Eliza configuration. If neither file exists, a global `.env` file is created with a default comment.
 *
 * @param projectDir - The directory to search for a project-specific `.env` file. Defaults to the current working directory.
 */
export async function loadEnvironment(projectDir: string = process.cwd()): Promise<void> {
  const projectEnvPath = path.join(projectDir, '.env');
  const { elizaDir: globalEnvDir, envFilePath: globalEnvPath } = await getElizaDirectories();

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

  // Ensure global env directory and file exist
  await ensureDir(globalEnvDir);
  await ensureFile(globalEnvPath);
  await fs.writeFile(globalEnvPath, '# Global environment variables for Eliza\n', {
    encoding: 'utf8',
  });
}
