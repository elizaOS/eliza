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
const SAMPLE_ENV_TEMPLATE = `### elizaOS Environment Variables ###
# To get started, copy this file to .env, or make a .env and add the settings you'd like to override
# Please read the comments for each of the configurations

# The only thing you ABSOLUTELY NEED to get up and running is one of the model provider keys, 
# i.e. OPENAI_API_KEY or ANTHROPIC_API_KEY, or setup the local-ai plugin
# Everything else is optional, and most settings and secrets can be configured in your agent or through the GUI
# For multi-agent, each agent will need keys for the various services it is connected to
# You can use the .env or environment variables generally for shared keys, such as to model providers, 
# database, etc, with scoped keys for services such as Telegram, Discord, etc

### MODEL PROVIDER KEYS ###
# Eliza is compatible with a wide array of model providers. Many have OpenAI compatible APIs, 
# and you can use them by overriding the base URL

# NOTE: You will need a provider that provides embeddings. So even if you use Claude, you will 
# need to get embeddings using another provider, for example openai or our local-ai plugin

# OpenAI Configuration
OPENAI_API_KEY=
# Use this to override the openai endpoint, for example for using together.ai, fireworks or other providers
# OPENAI_BASE_URL=

# Anthropic Configuration
# By default in most of our starter kits, Anthropic will take precedence over OpenAI in handling requests
# Anthropic does not handle embeddings, so you may wish to use OpenAI for that, even while Claude is handling text generation
ANTHROPIC_API_KEY=

# Cloudflare AI
CLOUDFLARE_GW_ENABLED=
CLOUDFLARE_AI_ACCOUNT_ID=
CLOUDFLARE_AI_GATEWAY_ID=

### LOCAL AI CONFIGURATION ###
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

### DATABASE ###
# By default, Eliza will use a local pglite instance
# If you fill out POSTGRES_URL, the agent will connect to your postgres instance instead of using the local path

# You can override the pglite data directory
PGLITE_DATA_DIR=

# Fill this out if you want to use Postgres
POSTGRES_URL=

### LOGGING CONFIGURATION ###
# Logging Configuration (supported: fatal, error, warn, info, debug, trace | default: info)
LOG_LEVEL=

# Sentry Configuration
SENTRY_LOGGING=true
SENTRY_DSN=
SENTRY_ENVIRONMENT=
SENTRY_TRACES_SAMPLE_RATE=
SENTRY_SEND_DEFAULT_PII=

### API KEYS ###
# Many services require API keys to function
# Most plugins will indicate what is needed in their README.md and throw helpful errors if they are missing
BIRDEYE_API_KEY=
JUPITER_API_KEY=
HELIUS_API_KEY=
COINMARKETCAP_API_KEY=
ZEROEX_API_KEY=
COINGECKO_API_KEY=

### SINGLE AGENT VARIABLES ###
# If you are running multiple agents, you will need to configure these variables in the agent secrets 
# (available in the GUI) OR you can namespace the secrets and connect them up in your character definition

# Example: 
# settings: {
#   process.env.COMMUNITY_MANAGER_DISCORD_API_TOKEN
# }

# Note: See below for multi-agent examples

# Discord Configuration
DISCORD_APPLICATION_ID=
DISCORD_API_TOKEN=

# Telegram Configuration
TELEGRAM_BOT_TOKEN=

# Twitter Configuration
TWITTER_USERNAME=
TWITTER_PASSWORD=
TWITTER_EMAIL=
TWITTER_ENABLE_POST_GENERATION=
TWITTER_INTERACTION_ENABLE=
TWITTER_TIMELINE_ENABLE=
TWITTER_SPACES_ENABLE=
TWITTER_TIMELINE_MODE=
TWITTER_TIMELINE_POLL_INTERVAL=

# EVM Configuration
EVM_PRIVATE_KEY=
EVM_CHAINS=mainnet,sepolia,base,arbitrum,polygon
EVM_PROVIDER_URL=

# Solana Configuration
SOLANA_PUBLIC_KEY=
SOLANA_PRIVATE_KEY=

### MULTI-AGENT CONFIGURATION ###
# Settings for The Org
# The Org is an example of a multi-agent swarm
# Available here: https://github.com/elizaOS/the-org
# This is an example of how environment variables can be scoped per-project

# Community Manager
COMMUNITY_MANAGER_DISCORD_APPLICATION_ID=
COMMUNITY_MANAGER_DISCORD_API_TOKEN=

# Social Media Manager
SOCIAL_MEDIA_MANAGER_DISCORD_APPLICATION_ID=
SOCIAL_MEDIA_MANAGER_DISCORD_API_TOKEN=

# Liaison
LIAISON_DISCORD_APPLICATION_ID=
LIAISON_DISCORD_API_TOKEN=

# Project Manager
PROJECT_MANAGER_DISCORD_APPLICATION_ID=
PROJECT_MANAGER_DISCORD_API_TOKEN=

# Developer Relations
DEV_REL_DISCORD_APPLICATION_ID=
DEV_REL_DISCORD_API_TOKEN=
DEVREL_IMPORT_KNOWLEDGE=true

# Investment Manager
INVESTMENT_MANAGER_DISCORD_APPLICATION_ID=
INVESTMENT_MANAGER_DISCORD_API_TOKEN=
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
 * Sets up the .env file by creating it if it doesn't exist or populating it with a hybrid
 * merge of process.env variables and example variables if it's empty
 * @param envFilePath Path to the .env file
 */
export async function setupEnvFile(envFilePath: string): Promise<void> {
  try {
    // Check if .env file exists
    const envExists = existsSync(envFilePath);

    if (!envExists) {
      // Create the file with hybrid merge of process.env and example variables
      const mergedVars = mergeProcessEnvWithTemplate(SAMPLE_ENV_TEMPLATE);
      const formattedContent = formatEnvFileWithTemplate(mergedVars, SAMPLE_ENV_TEMPLATE);
      await fs.writeFile(envFilePath, formattedContent, 'utf8');

      const processEnvCount = Object.keys(process.env).filter(
        (key) => process.env[key] && process.env[key]!.trim() !== ''
      ).length;

      logger.info(
        `[Config] Created .env file with ${processEnvCount} variables from process.env merged with example variables at: ${envFilePath}`
      );
    } else {
      // File exists, check if it's empty
      const content = await fs.readFile(envFilePath, 'utf8');
      const trimmedContent = content.trim();

      if (trimmedContent === '') {
        // File is empty, write the hybrid merge
        const mergedVars = mergeProcessEnvWithTemplate(SAMPLE_ENV_TEMPLATE);
        const formattedContent = formatEnvFileWithTemplate(mergedVars, SAMPLE_ENV_TEMPLATE);
        await fs.writeFile(envFilePath, formattedContent, 'utf8');

        const processEnvCount = Object.keys(process.env).filter(
          (key) => process.env[key] && process.env[key]!.trim() !== ''
        ).length;

        logger.info(
          `[Config] Populated empty .env file with ${processEnvCount} variables from process.env merged with example variables at: ${envFilePath}`
        );
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

    // Set up the .env file with the full template first
    await setupEnvFile(targetEnvPath);

    // Then ensure PGLITE_DATA_DIR is properly set in the .env file
    // This handles both new and existing .env files
    await storePgliteDataDir(targetDbDir, targetEnvPath);

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
 * Stores the provided Postgres connection URL in the specified `.env` file, replacing any existing entry.
 *
 * Updates the `POSTGRES_URL` environment variable in both the file and the current process.
 *
 * @param url - The Postgres connection URL to store.
 * @param envFilePath - Path to the `.env` file where the URL should be saved.
 *
 * @throws {Error} If reading from or writing to the `.env` file fails.
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
 * Stores the provided PGLite data directory in the specified `.env` file, replacing any existing entry.
 *
 * Updates the `PGLITE_DATA_DIR` environment variable in both the file and the current process.
 *
 * @param dataDir - The PGLite data directory path to store.
 * @param envFilePath - Path to the `.env` file where the directory should be saved.
 *
 * @throws {Error} If reading from or writing to the `.env` file fails.
 */
export async function storePgliteDataDir(dataDir: string, envFilePath: string): Promise<void> {
  if (!dataDir) return;

  try {
    // Read existing content first to avoid duplicates
    let content = '';
    if (existsSync(envFilePath)) {
      content = await fs.readFile(envFilePath, 'utf8');
    }

    // Remove existing PGLITE_DATA_DIR line if present
    const lines = content.split('\n').filter((line) => !line.startsWith('PGLITE_DATA_DIR='));
    lines.push(`PGLITE_DATA_DIR=${dataDir}`);

    await fs.writeFile(envFilePath, lines.join('\n'), 'utf8');
    process.env.PGLITE_DATA_DIR = dataDir;

    logger.success('PGLite data directory saved to configuration');
  } catch (error) {
    logger.error('Error saving PGLite configuration:', error);
    throw error; // Re-throw to handle upstream
  }
}

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
        return 'Invalid URL format. Expected: postgresql://user:password@host:port/dbname.';
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
 * Validates an OpenAI API key format
 * @param key The API key to validate
 * @returns True if the key appears valid
 */
export function isValidOpenAIKey(key: string): boolean {
  if (!key || typeof key !== 'string') return false;

  // OpenAI API keys typically start with 'sk-' and are 51 characters long
  return key.startsWith('sk-') && key.length >= 20;
}

/**
 * Validates an Anthropic API key format
 * @param key The API key to validate
 * @returns True if the key appears valid
 */
export function isValidAnthropicKey(key: string): boolean {
  if (!key || typeof key !== 'string') return false;

  // Anthropic API keys typically start with 'sk-ant-'
  return key.startsWith('sk-ant-') && key.length >= 20;
}

/**
 * Stores OpenAI API key in the .env file
 * @param key The OpenAI API key to store
 * @param envFilePath Path to the .env file
 */
export async function storeOpenAIKey(key: string, envFilePath: string): Promise<void> {
  if (!key) return;

  try {
    // Read existing content first to avoid duplicates
    let content = '';
    if (existsSync(envFilePath)) {
      content = await fs.readFile(envFilePath, 'utf8');
    }

    // Remove existing OPENAI_API_KEY line if present
    const lines = content.split('\n').filter((line) => !line.startsWith('OPENAI_API_KEY='));
    lines.push(`OPENAI_API_KEY=${key}`);

    await fs.writeFile(envFilePath, lines.join('\n'), 'utf8');
    process.env.OPENAI_API_KEY = key;

    logger.success('OpenAI API key saved to configuration');
  } catch (error) {
    logger.error('Error saving OpenAI API key:', error);
    throw error;
  }
}

/**
 * Stores Anthropic API key in the .env file
 * @param key The Anthropic API key to store
 * @param envFilePath Path to the .env file
 */
export async function storeAnthropicKey(key: string, envFilePath: string): Promise<void> {
  if (!key) return;

  try {
    // Read existing content first to avoid duplicates
    let content = '';
    if (existsSync(envFilePath)) {
      content = await fs.readFile(envFilePath, 'utf8');
    }

    // Remove existing ANTHROPIC_API_KEY line if present
    const lines = content.split('\n').filter((line) => !line.startsWith('ANTHROPIC_API_KEY='));
    lines.push(`ANTHROPIC_API_KEY=${key}`);

    await fs.writeFile(envFilePath, lines.join('\n'), 'utf8');
    process.env.ANTHROPIC_API_KEY = key;

    logger.success('Anthropic API key saved to configuration');
  } catch (error) {
    logger.error('Error saving Anthropic API key:', error);
    throw error;
  }
}

/**
 * Prompts the user for an OpenAI API key, validates it, and stores it
 * @param envFilePath Path to the .env file
 * @returns The configured OpenAI API key or null if user cancels
 */
export async function promptAndStoreOpenAIKey(envFilePath: string): Promise<string | null> {
  const response = await prompts({
    type: 'password',
    name: 'openaiKey',
    message: 'Enter your OpenAI API key:',
    validate: (value) => {
      if (value.trim() === '') return 'OpenAI API key cannot be empty';
      return true; // Always return true to allow continuation
    },
  });

  // Handle user cancellation (Ctrl+C)
  if (!response.openaiKey) {
    return null;
  }

  // Check if the API key format is valid and warn if not
  const isValid = isValidOpenAIKey(response.openaiKey);
  if (!isValid) {
    logger.warn('[!] Invalid API key format detected. Expected format: sk-...');
    logger.warn('   You can get your API key from: https://platform.openai.com/api-keys');
    logger.warn('   The key has been saved but may not work correctly.');
  }

  // Store the key in the .env file (even if invalid)
  await storeOpenAIKey(response.openaiKey, envFilePath);

  return response.openaiKey;
}

/**
 * Prompts the user for an Anthropic API key, validates it, and stores it
 * @param envFilePath Path to the .env file
 * @returns The configured Anthropic API key or null if user cancels
 */
export async function promptAndStoreAnthropicKey(envFilePath: string): Promise<string | null> {
  const response = await prompts({
    type: 'password',
    name: 'anthropicKey',
    message: 'Enter your Anthropic API key:',
    validate: (value) => {
      if (value.trim() === '') return 'Anthropic API key cannot be empty';
      return true; // Always return true to allow continuation
    },
  });

  // Handle user cancellation (Ctrl+C)
  if (!response.anthropicKey) {
    return null;
  }

  // Check if the API key format is valid and warn if not
  const isValid = isValidAnthropicKey(response.anthropicKey);
  if (!isValid) {
    logger.warn('[!] Invalid API key format detected. Expected format: sk-ant-...');
    logger.warn('   You can get your API key from: https://console.anthropic.com/');
    logger.warn('   The key has been saved but may not work correctly.');
  }

  // Store the key in the .env file (even if invalid)
  await storeAnthropicKey(response.anthropicKey, envFilePath);

  return response.anthropicKey;
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

/**
 * Merges environment variables from process.env with example variables from template.
 * Prioritizes process.env variables that have actual values, and uses example variables as fallback.
 * @param templateContent The template content containing example variables
 * @returns Merged environment variables object
 */
export function mergeProcessEnvWithTemplate(templateContent: string): Record<string, string> {
  const result: Record<string, string> = {};
  const processedKeys = new Set<string>();

  // First, parse the template to get example variables and their structure
  const templateLines = templateContent.split('\n');
  const templateVars: Record<string, string> = {};

  for (const line of templateLines) {
    const trimmedLine = line.trim();
    if (trimmedLine && !trimmedLine.startsWith('#') && trimmedLine.includes('=')) {
      const equalIndex = trimmedLine.indexOf('=');
      const key = trimmedLine.substring(0, equalIndex).trim();
      const value = trimmedLine.substring(equalIndex + 1).trim();
      if (key) {
        templateVars[key] = value;
      }
    }
  }

  // Add all process.env variables that have actual values (prioritized)
  for (const [key, value] of Object.entries(process.env)) {
    if (value && value.trim() !== '') {
      result[key] = value;
      processedKeys.add(key);
    }
  }

  // Add template variables that aren't already set from process.env
  for (const [key, value] of Object.entries(templateVars)) {
    if (!processedKeys.has(key)) {
      result[key] = value;
      processedKeys.add(key);
    }
  }

  return result;
}

/**
 * Converts environment variables object back to .env file format, preserving comments from template
 * @param envVars Environment variables object
 * @param templateContent Original template content for structure and comments
 * @returns Formatted .env file content
 */
export function formatEnvFileWithTemplate(
  envVars: Record<string, string>,
  templateContent: string
): string {
  const lines: string[] = [];
  const processedKeys = new Set<string>();
  const templateLines = templateContent.split('\n');

  // First pass: go through template preserving structure and comments
  for (const line of templateLines) {
    const trimmedLine = line.trim();

    if (!trimmedLine || trimmedLine.startsWith('#') || !trimmedLine.includes('=')) {
      // Preserve comments and empty lines
      lines.push(line);
    } else {
      // This is a variable line
      const equalIndex = trimmedLine.indexOf('=');
      const key = trimmedLine.substring(0, equalIndex).trim();

      if (key && envVars.hasOwnProperty(key)) {
        lines.push(`${key}=${envVars[key]}`);
        processedKeys.add(key);
      } else {
        // Variable not found, keep original line
        lines.push(line);
      }
    }
  }

  // Second pass: add any new variables from process.env that weren't in template
  const newVars: string[] = [];
  for (const [key, value] of Object.entries(envVars)) {
    if (!processedKeys.has(key)) {
      newVars.push(`${key}=${value}`);
    }
  }

  if (newVars.length > 0) {
    lines.push('');
    lines.push('### Additional Environment Variables from Runtime ###');
    lines.push('# Variables found in process.env that were not in the template');
    lines.push(...newVars);
  }

  return lines.join('\n');
}
