import { logger } from '@elizaos/core';
import dotenv from 'dotenv';
import path from 'node:path';
import { UserEnvironment } from './user-environment';
import { existsSync, promises as fs } from 'node:fs';
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
 * Default sample environment variables written to new .env files.
 */
const SAMPLE_ENV_TEMPLATE = `
# Logging Configuration (supported: fatal, error, warn, info, debug, trace | default: info)
LOG_LEVEL=

SENTRY_LOGGING=true
SENTRY_DSN=
SENTRY_ENVIRONMENT=
SENTRY_TRACES_SAMPLE_RATE=
SENTRY_SEND_DEFAULT_PII=

# OpenAI Configuration
OPENAI_API_KEY=

# Anthropic Configuration
ANTHROPIC_API_KEY=

# Cloudflare AI
CLOUDFLARE_GW_ENABLED= # Enable Cloudflare AI Gateway
CLOUDFLARE_AI_ACCOUNT_ID= # Account ID
CLOUDFLARE_AI_GATEWAY_ID= # Gateway ID

# Fill these out if you want to use Discord
DISCORD_APPLICATION_ID=
DISCORD_API_TOKEN=

# Fill these out if you want to use Postgres
POSTGRES_URL=

# Fill these out if you want to use Telegram
TELEGRAM_BOT_TOKEN=

# Fill these out if you want to use Twitter
TWITTER_USERNAME=
TWITTER_PASSWORD=
TWITTER_EMAIL=
TWITTER_ENABLE_POST_GENERATION=
TWITTER_INTERACTION_ENABLE=
TWITTER_TIMELINE_ENABLE=
TWITTER_SPACES_ENABLE=
TWITTER_TIMELINE_MODE=
TWITTER_TIMELINE_POLL_INTERVAL=

# Fill these out if you want to use EVM
EVM_PRIVATE_KEY=
EVM_CHAINS=mainnet,sepolia,base,arbitrum,polygon
EVM_PROVIDER_URL=

# Fill these out if you want to use Solana
SOLANA_PUBLIC_KEY=
SOLANA_PRIVATE_KEY=
BIRDEYE_API_KEY=

# Local AI Configuration
USE_LOCAL_AI=
USE_STUDIOLM_TEXT_MODELS=
USE_OLLAMA_TEXT_MODELS=

# Ollama Configuration
OLLAMA_API_ENDPOINT=
OLLAMA_MODEL=
USE_OLLAMA_EMBEDDING=
OLLAMA_EMBEDDING_MODEL=
OLLAMA_SMALL_MODEL=
OLLAMA_MEDIUM_MODEL=
OLLAMA_LARGE_MODEL=

# StudioLM Configuration
STUDIOLM_SERVER_URL=
STUDIOLM_SMALL_MODEL=
STUDIOLM_MEDIUM_MODEL=
STUDIOLM_EMBEDDING_MODEL=

# Settings for The Org

COMMUNITY_MANAGER_DISCORD_APPLICATION_ID=
COMMUNITY_MANAGER_DISCORD_API_TOKEN=

SOCIAL_MEDIA_MANAGER_DISCORD_APPLICATION_ID=
SOCIAL_MEDIA_MANAGER_DISCORD_API_TOKEN=

LIAISON_DISCORD_APPLICATION_ID=
LIAISON_DISCORD_API_TOKEN=

PROJECT_MANAGER_DISCORD_APPLICATION_ID=
PROJECT_MANAGER_DISCORD_API_TOKEN=

DEV_REL_DISCORD_APPLICATION_ID=
DEV_REL_DISCORD_API_TOKEN=
DEVREL_IMPORT_KNOWLEDGE=true

INVESTMENT_MANAGER_DISCORD_APPLICATION_ID=
INVESTMENT_MANAGER_DISCORD_API_TOKEN=

# Settings for Investment Manager plugins
BIRDEYE_API_KEY=
JUPITER_API_KEY=
HELIUS_API_KEY=
COINMARKETCAP_API_KEY=
ZEROEX_API_KEY=
COINGECKO_API_KEY=
`;

/**
 * Validates a Postgres URL format
 * @param url The URL to validate
 * @returns True if the URL appears valid
 */
export function isValidPostgresUrl(url: string): boolean {
  if (!url || typeof url !== 'string') return false;

  try {
    // More robust validation using URL constructor
    const parsedUrl = new URL(url);
    return (
      parsedUrl.protocol === 'postgresql:' &&
      parsedUrl.hostname &&
      parsedUrl.pathname &&
      parsedUrl.pathname !== '/'
    );
  } catch {
    // Fallback to regex patterns for edge cases
    const patterns = [
      /^postgresql:\/\/[^:]+:[^@]+@[^:]+:\d+\/\w+$/,
      /^postgresql:\/\/[^:]+:[^@]+@[^\/]+\/[^?]+(\?.*)?$/,
      /^postgresql:\/\/.*@.*:\d+\/.*$/,
    ];

    return patterns.some((pattern) => pattern.test(url));
  }
}

/**
 * Retrieves the standard directory paths used by Eliza for configuration and database storage.
 *
 * @returns An object containing the Eliza configuration directory, the Eliza database directory for the current project, and the path to the Eliza `.env` file.
 */
export async function getElizaDirectories(targetProjectDir?: string) {
  const userEnv = UserEnvironment.getInstance();
  const paths = await userEnv.getPathInfo();

  const projectRoot = targetProjectDir || paths.monorepoRoot || process.cwd();
  const elizaDir = targetProjectDir ? path.resolve(targetProjectDir, '.eliza') : paths.elizaDir;
  const envFilePath = targetProjectDir ? path.resolve(targetProjectDir, '.env') : paths.envFilePath;

  logger.debug('Eliza directories:', {
    elizaDir,
    projectRoot,
    targetProjectDir: targetProjectDir || 'none',
  });

  const defaultElizaDbDir = path.resolve(projectRoot, '.elizadb');
  const elizaDbDir = await resolvePgliteDir(undefined, defaultElizaDbDir);

  return { elizaDir, elizaDbDir, envFilePath };
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
 * Sets up the .env file by creating it if it doesn't exist or populating it with examples if it's empty
 * @param envFilePath Path to the .env file
 */
export async function setupEnvFile(envFilePath: string): Promise<void> {
  try {
    // Check if .env file exists
    const envExists = existsSync(envFilePath);

    if (!envExists) {
      // Create the file with sample template
      await fs.writeFile(envFilePath, SAMPLE_ENV_TEMPLATE, 'utf8');
      logger.info(`[Config] Created .env file with example variables at: ${envFilePath}`);
    } else {
      // File exists, check if it's empty
      const content = await fs.readFile(envFilePath, 'utf8');
      const trimmedContent = content.trim();

      if (trimmedContent === '') {
        // File is empty, write the sample template
        await fs.writeFile(envFilePath, SAMPLE_ENV_TEMPLATE, 'utf8');
        logger.info(`[Config] Populated empty .env file with example variables at: ${envFilePath}`);
      } else {
        logger.debug(`[Config] .env file already exists and has content at: ${envFilePath}`);
      }
    }
  } catch (error) {
    logger.error('Error setting up .env file:', {
      error: error instanceof Error ? error.message : String(error),
      envFilePath,
    });
    throw error;
  }
}

/**
 * Ensures the Eliza configuration directory exists and returns standard Eliza directory paths.
 *
 * @returns An object containing paths for the Eliza configuration directory, the Eliza database directory, and the `.env` file.
 */
export async function ensureElizaDir(targetProjectDir?: string) {
  const dirs = await getElizaDirectories(targetProjectDir);
  await ensureDir(dirs.elizaDir);

  // Also create registry-cache.json and config.json files if they don't exist
  const registryCachePath = path.join(dirs.elizaDir, 'registry-cache.json');
  const configPath = path.join(dirs.elizaDir, 'config.json');

  if (!existsSync(registryCachePath)) {
    await fs.writeFile(registryCachePath, JSON.stringify({}, null, 2), 'utf8');
    logger.debug(`Created registry cache file: ${registryCachePath}`);
  }

  if (!existsSync(configPath)) {
    await fs.writeFile(configPath, JSON.stringify({ version: '1.0.0' }, null, 2), 'utf8');
    logger.debug(`Created config file: ${configPath}`);
  }

  return dirs;
}

/**
 * Sets up and configures PGLite database
 * @param elizaDbDir The directory for PGLite database
 * @param envFilePath Path to the .env file
 */
export async function setupPgLite(
  dbDir: string | undefined,
  envPath: string | undefined,
  targetProjectDir?: string
): Promise<void> {
  const dirs = await ensureElizaDir(targetProjectDir);
  const { elizaDir, elizaDbDir, envFilePath } = dirs;

  // Use provided parameters or defaults from dirs
  const targetDbDir = dbDir || elizaDbDir;
  const targetEnvPath = envPath || envFilePath;

  try {
    // Ensure the PGLite database directory exists
    await ensureDir(targetDbDir);
    logger.debug('[PGLite] Created database directory:', targetDbDir);

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
    // Read existing content first to avoid duplicates
    let content = '';
    if (existsSync(envFilePath)) {
      content = await fs.readFile(envFilePath, 'utf8');
    }

    // Remove existing POSTGRES_URL line if present
    const lines = content.split('\n').filter((line) => !line.startsWith('POSTGRES_URL='));
    lines.push(`POSTGRES_URL=${url}`);

    await fs.writeFile(envFilePath, lines.join('\n'), 'utf8');
    process.env.POSTGRES_URL = url;

    logger.success('Postgres URL saved to configuration');
  } catch (error) {
    logger.error('Error saving database configuration:', error);
    throw error; // Re-throw to handle upstream
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
  await setupEnvFile(envFilePath);
  await loadEnvironment(path.dirname(envFilePath));

  // Check if we already have database configuration in env
  let postgresUrl = process.env.POSTGRES_URL;
  const pgliteDataDir = await resolvePgliteDir(undefined, elizaDbDir);

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
 * @param {string} cwd - The current working directory.
 * @param {RawConfig} config - The raw configuration object.
 * @returns {Promise<Config>} The resolved configuration object with updated paths.
 */
export async function resolveConfigPaths(cwd: string, config: RawConfig) {
  try {
    return configSchema.parse({
      ...config,
      resolvedPaths: {
        knowledge: path.resolve(cwd, config.paths.knowledge),
      },
    });
  } catch (error) {
    logger.error('Failed to resolve config paths:', error);
    throw new Error('Invalid configuration: failed to resolve paths');
  }
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
