import { logger } from '@elizaos/core';
import { isQuietMode } from './spinner-utils';
import dotenv from 'dotenv';
import path from 'node:path';
import { UserEnvironment } from './user-environment';
import { existsSync, promises as fs } from 'node:fs';
import * as clack from '@clack/prompts';
import { z } from 'zod';
import { resolveEnvFile, resolvePgliteDir } from './resolve-utils';
import colors from 'yoctocolors';
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

## The only thing you ABSOLUTELY NEED to get up and running is one of the model provider keys,
## i.e. OPENAI_API_KEY or ANTHROPIC_API_KEY, or setup the ollama plugin
## Everything else is optional, and most settings and secrets can be configured in your agent or through the GUI
## For multi-agent, each agent will need keys for the various services it is connected to
-------------------------------
## You can use the .env or environment variables generally for shared keys, such as to model providers,
## database, etc, with scoped keys for services such as Telegram, Discord, etc

## MODEL PROVIDER KEYS ##
## Eliza is compatible with a wide array of model providers. Many have OpenAI compatible APIs,
## and you can use them by overriding the base URL

## NOTE: You will need a provider that provides embeddings. So even if you use Claude, you will
## need to get embeddings using another provider, for example openai or ollama

# OpenAI Configuration
OPENAI_API_KEY=
## Use this to override the openai endpoint, for example for using together.ai, fireworks or other providers
## Optional overrides:
--------------------------------
# OPENAI_BASE_URL=
# OPENAI_SMALL_MODEL=gpt-4o-mini
# OPENAI_LARGE_MODEL=gpt-4o
# OPENAI_EMBEDDING_MODEL=text-embedding-3-small
# OPENAI_EMBEDDING_URL=
# OPENAI_EMBEDDING_DIMENSIONS=1536
# OPENAI_IMAGE_DESCRIPTION_MODEL=gpt-4o-mini
# OPENAI_IMAGE_DESCRIPTION_MAX_TOKENS=8192

# Anthropic Configuration
## By default in most of our starter kits, Anthropic will take precedence over OpenAI in handling requests
## Anthropic does not handle embeddings, so you may wish to use OpenAI for that, even while Claude is handling text generation
--------------------------------
ANTHROPIC_API_KEY=
# Optional overrides:
# ANTHROPIC_SMALL_MODEL=claude-3-5-haiku-latest
# ANTHROPIC_LARGE_MODEL=claude-3-5-sonnet-latest


# Ollama Configuration
## Highly recommended to use gemma3:latest for text generation
--------------------------------
# OLLAMA_API_ENDPOINT=http://localhost:11434/api
# OLLAMA_SMALL_MODEL=gemma3:latest
# OLLAMA_MEDIUM_MODEL=gemma3:latest
# OLLAMA_LARGE_MODEL=gemma3:latest

# OpenRouter Configuration
# OPENROUTER_API_KEY=
# OPENROUTER_EMBEDDING_MODEL=openai/text-embedding-3-small
# OPENROUTER_EMBEDDING_DIMENSIONS=1536

# Highly recommended to use nomic-embed-text for embeddings
# OLLAMA_EMBEDDING_MODEL=nomic-embed-text

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
--------------------------------
## DO NOT CHANGE THIS UNLESS YOU KNOW WHAT YOU ARE DOING
--------------------------------
# Sentry is a tool for monitoring and logging errors and exceptions
# It is used to track errors and exceptions in the agent
--------------------------------
# Sentry Configuration
SENTRY_LOGGING=true
SENTRY_DSN=
SENTRY_ENVIRONMENT=
SENTRY_TRACES_SAMPLE_RATE=
SENTRY_SEND_DEFAULT_PII=

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
      !!parsedUrl.hostname &&
      !!parsedUrl.pathname &&
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

  logger.debug(
    {
      src: 'cli',
      util: 'get-config',
      elizaDir,
      projectRoot,
      targetProjectDir: targetProjectDir || 'none',
    },
    'Eliza directories'
  );

  const defaultElizaDbDir = path.resolve(projectRoot, '.eliza', '.elizadb');
  // Pass targetProjectDir to resolvePgliteDir to ensure it uses the correct base directory
  const elizaDbDir = await resolvePgliteDir(undefined, defaultElizaDbDir, targetProjectDir);

  return { elizaDir, elizaDbDir, envFilePath };
}

/**
 * Generic function to ensure a directory exists
 * @param dirPath Path to the directory
 */
async function ensureDir(dirPath: string) {
  if (!existsSync(dirPath)) {
    await fs.mkdir(dirPath, { recursive: true });
    logger.debug({ src: 'cli', util: 'get-config', dirPath }, 'Created directory');
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
      // Create the file with template variables
      await fs.writeFile(envFilePath, SAMPLE_ENV_TEMPLATE, 'utf8');

      if (!isQuietMode()) {
        logger.info(
          { src: 'cli', util: 'get-config', envFilePath },
          'Created .env file with template variables'
        );
      }
    } else {
      // File exists, check if it's empty
      const content = await fs.readFile(envFilePath, 'utf8');
      const trimmedContent = content.trim();

      if (trimmedContent === '') {
        // File is empty, write the template
        await fs.writeFile(envFilePath, SAMPLE_ENV_TEMPLATE, 'utf8');

        logger.info(
          { src: 'cli', util: 'get-config', envFilePath },
          'Populated empty .env file with template variables'
        );
      } else {
        logger.debug(
          { src: 'cli', util: 'get-config', envFilePath },
          '.env file already exists and has content'
        );
      }
    }
  } catch (error) {
    logger.error(
      {
        src: 'cli',
        util: 'get-config',
        error: error instanceof Error ? error.message : String(error),
        envFilePath,
      },
      'Error setting up .env file'
    );
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
    logger.debug(
      { src: 'cli', util: 'get-config', registryCachePath },
      'Created registry cache file'
    );
  }

  if (!existsSync(configPath)) {
    await fs.writeFile(configPath, JSON.stringify({ version: '1.0.0' }, null, 2), 'utf8');
    logger.debug({ src: 'cli', util: 'get-config', configPath }, 'Created config file');
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
  const { elizaDbDir, envFilePath } = dirs;

  // Use provided parameters or defaults from dirs
  const targetDbDir = dbDir || elizaDbDir;
  const targetEnvPath = envPath || envFilePath;

  try {
    // Ensure the PGLite database directory exists
    await ensureDir(targetDbDir);
    logger.debug(
      { src: 'cli', util: 'get-config', targetDbDir },
      'Created PGLite database directory'
    );

    // Set up the .env file with the full template first
    await setupEnvFile(targetEnvPath);

    // Then ensure PGLITE_DATA_DIR is properly set in the .env file
    // This handles both new and existing .env files
    await storePgliteDataDir(targetDbDir, targetEnvPath);

    logger.success({ src: 'cli', util: 'get-config' }, 'PGLite configuration saved');
  } catch (error) {
    logger.error(
      {
        src: 'cli',
        util: 'get-config',
        error: error instanceof Error ? error.message : String(error),
        elizaDbDir,
        envFilePath,
      },
      'Error setting up PGLite directory'
    );
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
    // Ensure parent directory exists
    const envDir = path.dirname(envFilePath);
    await fs.mkdir(envDir, { recursive: true });

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

    logger.success({ src: 'cli', util: 'get-config' }, 'Postgres URL saved to configuration');
  } catch (error) {
    logger.error(
      {
        src: 'cli',
        util: 'get-config',
        error: error instanceof Error ? error.message : String(error),
      },
      'Error saving database configuration'
    );
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

    logger.success(
      { src: 'cli', util: 'get-config' },
      'PGLite data directory saved to configuration'
    );
  } catch (error) {
    logger.error(
      {
        src: 'cli',
        util: 'get-config',
        error: error instanceof Error ? error.message : String(error),
      },
      'Error saving PGLite configuration'
    );
    throw error; // Re-throw to handle upstream
  }
}

/**
 * Prompts the user for a Postgres URL, validates it, and stores it
 * @returns The configured Postgres URL or null if user cancels
 */
export async function promptAndStorePostgresUrl(envFilePath: string): Promise<string | null> {
  clack.intro('🗄️  PostgreSQL Configuration');

  const response = await clack.text({
    message: 'Enter your Postgres URL:',
    placeholder: 'postgresql://user:password@host:port/dbname',
    validate: (value) => {
      if (value.trim() === '') return 'Postgres URL cannot be empty';

      const isValid = isValidPostgresUrl(value);
      if (!isValid) {
        return 'Invalid URL format. Expected: postgresql://user:password@host:port/dbname.';
      }
      return undefined;
    },
  });

  if (clack.isCancel(response)) {
    clack.cancel('Operation cancelled.');
    return null;
  }

  // Store the URL in the .env file
  const spinner = clack.spinner();
  spinner.start('Saving PostgreSQL configuration...');

  try {
    await storePostgresUrl(response, envFilePath);
    spinner.stop('PostgreSQL configuration saved successfully!');
    clack.outro('\u2713 Database connection configured');
    return response;
  } catch (error) {
    spinner.stop('Failed to save configuration');
    clack.log.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
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
 * Validates a Google Generative AI API key format
 * @param key The API key to validate
 * @returns True if the key appears valid
 */
export function isValidGoogleKey(key: string): boolean {
  if (!key || typeof key !== 'string') return false;

  // Google API keys are typically 39 characters long and contain alphanumeric chars with dashes
  return key.length === 39 && /^[A-Za-z0-9_-]+$/.test(key);
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

    logger.success({ src: 'cli', util: 'get-config' }, 'OpenAI API key saved to configuration');
  } catch (error) {
    logger.error(
      {
        src: 'cli',
        util: 'get-config',
        error: error instanceof Error ? error.message : String(error),
      },
      'Error saving OpenAI API key'
    );
    throw error;
  }
}

/**
 * Stores Google Generative AI API key in the .env file
 * @param key The Google API key to store
 * @param envFilePath Path to the .env file
 */
export async function storeGoogleKey(key: string, envFilePath: string): Promise<void> {
  if (!key) return;

  try {
    // Read existing content first to avoid duplicates
    let content = '';
    if (existsSync(envFilePath)) {
      content = await fs.readFile(envFilePath, 'utf8');
    }

    // Remove existing GOOGLE_GENERATIVE_AI_API_KEY line if present
    const lines = content
      .split('\n')
      .filter((line) => !line.startsWith('GOOGLE_GENERATIVE_AI_API_KEY='));
    lines.push(`GOOGLE_GENERATIVE_AI_API_KEY=${key}`);

    await fs.writeFile(envFilePath, lines.join('\n'), 'utf8');
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = key;

    logger.success(
      { src: 'cli', util: 'get-config' },
      'Google Generative AI API key saved to configuration'
    );
  } catch (error) {
    logger.error(
      {
        src: 'cli',
        util: 'get-config',
        error: error instanceof Error ? error.message : String(error),
      },
      'Error saving Google API key'
    );
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

    logger.success({ src: 'cli', util: 'get-config' }, 'Anthropic API key saved to configuration');
  } catch (error) {
    logger.error(
      {
        src: 'cli',
        util: 'get-config',
        error: error instanceof Error ? error.message : String(error),
      },
      'Error saving Anthropic API key'
    );
    throw error;
  }
}

/**
 * Generic configuration for provider prompts
 */
interface ProviderPromptConfig {
  name: string;
  icon: string;
  noteText: string;
  inputs: Array<{
    key: string;
    message: string;
    placeholder?: string;
    initialValue?: string;
    type: 'text' | 'password';
    validate: (value: string) => string | undefined;
  }>;
  storeFunction: (config: Record<string, string>, envFilePath: string) => Promise<void>;
  successMessage: string;
}

/**
 * Generic function to prompt for provider configuration
 * @param config Provider-specific configuration
 * @param envFilePath Path to the .env file
 * @returns The configured values or null if user cancels
 */
async function promptAndStoreProviderConfig<T>(
  config: ProviderPromptConfig,
  envFilePath: string
): Promise<T | null> {
  clack.intro(`${config.icon} ${config.name} Configuration`);

  if (config.noteText) {
    clack.note(config.noteText, 'API Key Information');
  }

  const results: Record<string, string> = {};

  // Collect all inputs
  for (const input of config.inputs) {
    const promptFn = input.type === 'password' ? clack.password : clack.text;
    const promptConfig: {
      message: string;
      validate: (value: string) => string | undefined;
      placeholder?: string;
      initialValue?: string;
    } = {
      message: input.message,
      validate: input.validate,
    };

    if (input.placeholder) promptConfig.placeholder = input.placeholder;
    if (input.initialValue) promptConfig.initialValue = input.initialValue;

    const response = await promptFn(promptConfig);

    if (clack.isCancel(response)) {
      clack.cancel('Operation cancelled.');
      return null;
    }

    results[input.key] = input.type === 'text' ? response.trim() : response;
  }

  // Store the configuration
  const spinner = clack.spinner();
  spinner.start(`Saving ${config.name} configuration...`);

  try {
    await config.storeFunction(results, envFilePath);
    spinner.stop(`${config.name} configuration saved successfully!`);
    clack.outro(`✓ ${config.successMessage}`);
    return results as T;
  } catch (error) {
    spinner.stop('Failed to save configuration');
    clack.log.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/**
 * Prompts the user for an OpenAI API key, validates it, and stores it
 * @param envFilePath Path to the .env file
 * @returns The configured OpenAI API key or null if user cancels
 */
export async function promptAndStoreOpenAIKey(envFilePath: string): Promise<string | null> {
  const config: ProviderPromptConfig = {
    name: 'OpenAI API',
    icon: '🤖',
    noteText: 'Get your API key from: https://platform.openai.com/api-keys',
    inputs: [
      {
        key: 'key',
        message: 'Enter your OpenAI API key:',
        type: 'password',
        validate: (value) => {
          if (value.trim() === '') return 'OpenAI API key cannot be empty';
          return undefined;
        },
      },
    ],
    storeFunction: async (results, envPath) => {
      const isValid = isValidOpenAIKey(results.key);
      if (!isValid) {
        clack.log.warn('Invalid API key format detected. Expected format: sk-...');
        clack.log.warn('The key has been saved but may not work correctly.');
      }
      await storeOpenAIKey(results.key, envPath);
    },
    successMessage: 'OpenAI integration configured',
  };

  const result = await promptAndStoreProviderConfig<{ key: string }>(config, envFilePath);
  return result?.key || null;
}

/**
 * Prompts the user for an Anthropic API key, validates it, and stores it
 * @param envFilePath Path to the .env file
 * @returns The configured Anthropic API key or null if user cancels
 */
export async function promptAndStoreAnthropicKey(envFilePath: string): Promise<string | null> {
  const config: ProviderPromptConfig = {
    name: 'Anthropic Claude',
    icon: '🤖',
    noteText: 'Get your API key from: https://console.anthropic.com/settings/keys',
    inputs: [
      {
        key: 'key',
        message: 'Enter your Anthropic API key:',
        type: 'password',
        validate: (value) => {
          if (value.trim() === '') return 'Anthropic API key cannot be empty';
          return undefined;
        },
      },
    ],
    storeFunction: async (results, envPath) => {
      const isValid = isValidAnthropicKey(results.key);
      if (!isValid) {
        clack.log.warn('Invalid API key format detected. Expected format: sk-ant-...');
        clack.log.warn('The key has been saved but may not work correctly.');
      }
      await storeAnthropicKey(results.key, envPath);
    },
    successMessage: 'Claude integration configured',
  };

  const result = await promptAndStoreProviderConfig<{ key: string }>(config, envFilePath);
  return result?.key || null;
}

/**
 * Validates an Ollama API endpoint format
 * @param endpoint The endpoint URL to validate
 * @returns True if the endpoint appears valid
 */
export function isValidOllamaEndpoint(endpoint: string): boolean {
  if (!endpoint || typeof endpoint !== 'string') return false;

  try {
    const url = new URL(endpoint);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Stores Ollama configuration in the .env file
 * @param config The Ollama configuration to store
 * @param envFilePath Path to the .env file
 */
export async function storeOllamaConfig(
  config: { endpoint: string; model: string },
  envFilePath: string
): Promise<void> {
  if (!config.endpoint || !config.model) return;

  try {
    // Read existing content first to avoid duplicates
    let content = '';
    if (existsSync(envFilePath)) {
      content = await fs.readFile(envFilePath, 'utf8');
    }

    // Remove existing Ollama lines if present
    const lines = content
      .split('\n')
      .filter(
        (line) => !line.startsWith('OLLAMA_API_ENDPOINT=') && !line.startsWith('OLLAMA_MODEL=')
      );

    // Add new Ollama configuration
    lines.push(`OLLAMA_API_ENDPOINT=${config.endpoint}`);
    lines.push(`OLLAMA_MODEL=${config.model}`);

    await fs.writeFile(envFilePath, lines.join('\n'), 'utf8');

    // Update process.env
    process.env.OLLAMA_API_ENDPOINT = config.endpoint;
    process.env.OLLAMA_MODEL = config.model;

    logger.success(
      { src: 'cli', util: 'get-config' },
      'Ollama configuration saved to configuration'
    );
  } catch (error) {
    logger.error(
      {
        src: 'cli',
        util: 'get-config',
        error: error instanceof Error ? error.message : String(error),
      },
      'Error saving Ollama configuration'
    );
    throw error;
  }
}

/**
 * Prompts the user for Ollama embedding model selection
 * @param envFilePath Path to the .env file
 * @returns The configured Ollama embedding settings or null if user cancels
 */
export async function promptAndStoreOllamaEmbeddingConfig(
  envFilePath: string
): Promise<{ endpoint: string; embeddingModel: string } | null> {
  // Check if we already have an Ollama endpoint configured
  let existingEndpoint = process.env.OLLAMA_API_ENDPOINT;

  const config: ProviderPromptConfig = {
    name: 'Ollama Embeddings',
    icon: '🦙',
    noteText:
      'Select an embedding model for Ollama.\nPopular options: nomic-embed-text, mxbai-embed-large\nMake sure the model is pulled: ollama pull <model-name>',
    inputs: [
      {
        key: 'endpoint',
        message: 'Enter your Ollama API endpoint:',
        placeholder: 'http://localhost:11434',
        initialValue: existingEndpoint || 'http://localhost:11434',
        type: 'text',
        validate: (value) => {
          if (value.trim() === '') return 'Ollama endpoint cannot be empty';
          if (!isValidOllamaEndpoint(value))
            return 'Invalid URL format (http:// or https:// required)';
          return undefined;
        },
      },
      {
        key: 'embeddingModel',
        message: 'Enter your Ollama embedding model:',
        placeholder: 'nomic-embed-text',
        initialValue: 'nomic-embed-text',
        type: 'text',
        validate: (value) => {
          if (value.trim() === '') return 'Embedding model name cannot be empty';
          return undefined;
        },
      },
    ],
    storeFunction: async (results, envPath) => {
      // Store Ollama embedding configuration
      try {
        let content = '';
        if (existsSync(envPath)) {
          content = await fs.readFile(envPath, 'utf8');
        }

        // Only remove embedding-specific lines, preserve general Ollama config
        const lines = content
          .split('\n')
          .filter((line) => !line.startsWith('OLLAMA_EMBEDDING_MODEL='));

        // Check if we need to update the endpoint
        const endpointPattern = /^OLLAMA_API_ENDPOINT=(.*)$/m;
        const existingEndpointMatch = content.match(endpointPattern);

        if (existingEndpointMatch) {
          // Endpoint exists, only update if different
          if (results.endpoint !== existingEndpointMatch[1]) {
            const updatedLines = lines.map((line) => {
              if (line.startsWith('OLLAMA_API_ENDPOINT=')) {
                return `OLLAMA_API_ENDPOINT=${results.endpoint}`;
              }
              return line;
            });
            lines.length = 0;
            lines.push(...updatedLines);
          }
        } else {
          // No existing endpoint, add it
          lines.push(`OLLAMA_API_ENDPOINT=${results.endpoint}`);
        }

        // Add embedding-specific configuration
        lines.push(`OLLAMA_EMBEDDING_MODEL=${results.embeddingModel}`);

        await fs.writeFile(envPath, lines.join('\n'), 'utf8');

        // Update process.env
        process.env.OLLAMA_API_ENDPOINT = results.endpoint;
        process.env.OLLAMA_EMBEDDING_MODEL = results.embeddingModel;

        logger.success({ src: 'cli', util: 'get-config' }, 'Ollama embedding configuration saved');
      } catch (error) {
        logger.error(
          {
            src: 'cli',
            util: 'get-config',
            error: error instanceof Error ? error.message : String(error),
          },
          'Error saving Ollama embedding configuration'
        );
        throw error;
      }
    },
    successMessage: 'Ollama embedding model configured',
  };

  return await promptAndStoreProviderConfig<{ endpoint: string; embeddingModel: string }>(
    config,
    envFilePath
  );
}

/**
 * Prompts the user for Ollama configuration, validates it, and stores it
 * @param envFilePath Path to the .env file
 * @returns The configured Ollama settings or null if user cancels
 */
export async function promptAndStoreOllamaConfig(
  envFilePath: string
): Promise<{ endpoint: string; model: string } | null> {
  const config: ProviderPromptConfig = {
    name: 'Ollama',
    icon: '🦙',
    noteText:
      'Make sure Ollama is installed and running on your system.\nDefault endpoint: http://localhost:11434\nGet started: https://ollama.ai/',
    inputs: [
      {
        key: 'endpoint',
        message: 'Enter your Ollama API endpoint:',
        placeholder: 'http://localhost:11434',
        initialValue: 'http://localhost:11434',
        type: 'text',
        validate: (value) => {
          if (value.trim() === '') return 'Ollama endpoint cannot be empty';
          if (!isValidOllamaEndpoint(value))
            return 'Invalid URL format (http:// or https:// required)';
          return undefined;
        },
      },
      {
        key: 'model',
        message: 'Enter your preferred Ollama model:',
        placeholder: 'llama2',
        initialValue: 'llama2',
        type: 'text',
        validate: (value) => {
          if (value.trim() === '') return 'Model name cannot be empty';
          return undefined;
        },
      },
    ],
    storeFunction: async (results, envPath) => {
      await storeOllamaConfig({ endpoint: results.endpoint, model: results.model }, envPath);
    },
    successMessage: 'Ollama integration configured',
  };

  return await promptAndStoreProviderConfig<{ endpoint: string; model: string }>(
    config,
    envFilePath
  );
}

/**
 * Prompts the user for a Google Generative AI API key, validates it, and stores it
 * @param envFilePath Path to the .env file
 * @returns The configured Google API key or null if user cancels
 */
export async function promptAndStoreGoogleKey(envFilePath: string): Promise<string | null> {
  const config: ProviderPromptConfig = {
    name: 'Google Generative AI',
    icon: '🤖',
    noteText: 'Get your API key from: https://aistudio.google.com/apikey',
    inputs: [
      {
        key: 'key',
        message: 'Enter your Google Generative AI API key:',
        type: 'password',
        validate: (value) => {
          if (value.trim() === '') return 'Google API key cannot be empty';
          return undefined;
        },
      },
    ],
    storeFunction: async (results, envPath) => {
      const isValid = isValidGoogleKey(results.key);
      if (!isValid) {
        clack.log.warn(
          'Invalid API key format detected. Expected format: 39 character alphanumeric key'
        );
        clack.log.warn('The key has been saved but may not work correctly.');
      }
      await storeGoogleKey(results.key, envPath);
    },
    successMessage: 'Google Generative AI integration configured',
  };

  const result = await promptAndStoreProviderConfig<{ key: string }>(config, envFilePath);
  return result?.key || null;
}

/**
 * Validates an OpenRouter API key format
 * @param key The API key to validate
 * @returns True if the key appears to be in valid format
 */
export function isValidOpenRouterKey(key: string): boolean {
  if (!key || typeof key !== 'string') return false;
  // OpenRouter keys typically start with "sk-or-" followed by alphanumeric characters
  return key.startsWith('sk-or-') && key.length > 10;
}

/**
 * Stores OpenRouter API key in the .env file
 * @param key The API key to store
 * @param envFilePath Path to the .env file
 */
export async function storeOpenRouterKey(key: string, envFilePath: string): Promise<void> {
  if (!key) return;

  try {
    // Read existing content first to avoid duplicates
    let content = '';
    if (existsSync(envFilePath)) {
      content = await fs.readFile(envFilePath, 'utf8');
    }

    // Remove existing OpenRouter API key line if present
    const lines = content.split('\n').filter((line) => !line.startsWith('OPENROUTER_API_KEY='));

    // Add new OpenRouter API key
    lines.push(`OPENROUTER_API_KEY=${key}`);

    await fs.writeFile(envFilePath, lines.join('\n'), 'utf8');

    // Update process.env
    process.env.OPENROUTER_API_KEY = key;

    logger.success({ src: 'cli', util: 'get-config' }, 'OpenRouter API key saved to configuration');
  } catch (error) {
    logger.error(
      {
        src: 'cli',
        util: 'get-config',
        error: error instanceof Error ? error.message : String(error),
      },
      'Error saving OpenRouter API key'
    );
    throw error;
  }
}

/**
 * Prompts the user for an OpenRouter API key, validates it, and stores it
 * @param envFilePath Path to the .env file
 * @returns The configured OpenRouter API key or null if user cancels
 */
export async function promptAndStoreOpenRouterKey(envFilePath: string): Promise<string | null> {
  const config: ProviderPromptConfig = {
    name: 'OpenRouter',
    icon: '🔄',
    noteText: 'Get your API key from: https://openrouter.ai/keys',
    inputs: [
      {
        key: 'key',
        message: 'Enter your OpenRouter API key:',
        type: 'password',
        validate: (value) => {
          if (value.trim() === '') return 'OpenRouter API key cannot be empty';
          return undefined;
        },
      },
    ],
    storeFunction: async (results, envPath) => {
      const isValid = isValidOpenRouterKey(results.key);
      if (!isValid) {
        clack.log.warn('Invalid API key format detected. Expected format: sk-or-...');
        clack.log.warn('The key has been saved but may not work correctly.');
      }
      await storeOpenRouterKey(results.key, envPath);
    },
    successMessage: 'OpenRouter integration configured',
  };

  const result = await promptAndStoreProviderConfig<{ key: string }>(config, envFilePath);
  return result?.key || null;
}

/**
 * Validates an elizaOS Cloud API key format
 * @param key The API key to validate
 * @returns True if the key appears valid
 */
export function isValidElizaCloudKey(key: string): boolean {
  if (!key || typeof key !== 'string') return false;
  // elizaOS Cloud keys start with 'eliza_'
  return key.startsWith('eliza_') && key.length > 10;
}

/**
 * Stores elizaOS Cloud API key in the .env file
 * @param key The elizaOS Cloud API key to store
 * @param envFilePath Path to the .env file
 */
export async function storeElizaCloudKey(key: string, envFilePath: string): Promise<void> {
  if (!key) return;

  try {
    // Read existing content first to avoid duplicates
    let content = '';
    if (existsSync(envFilePath)) {
      content = await fs.readFile(envFilePath, 'utf8');
    }

    // Remove existing ELIZAOS_API_KEY line if present
    const lines = content.split('\n').filter((line) => !line.startsWith('ELIZAOS_API_KEY='));
    lines.push(`ELIZAOS_API_KEY=${key}`);

    await fs.writeFile(envFilePath, lines.join('\n'), 'utf8');
    process.env.ELIZAOS_API_KEY = key;

    logger.success(
      { src: 'cli', util: 'get-config' },
      'elizaOS Cloud API key saved to configuration'
    );
  } catch (error) {
    logger.error(
      {
        src: 'cli',
        util: 'get-config',
        error: error instanceof Error ? error.message : String(error),
      },
      'Error saving elizaOS Cloud API key'
    );
    throw error;
  }
}

/**
 * Checks if the user already has a valid elizaOS Cloud API key
 * @param envFilePath Path to the .env file
 * @returns True if a valid API key exists
 */
export async function hasExistingElizaCloudKey(envFilePath: string): Promise<boolean> {
  // Check environment variable first
  if (process.env.ELIZAOS_API_KEY && isValidElizaCloudKey(process.env.ELIZAOS_API_KEY)) {
    return true;
  }

  // Check .env file
  if (existsSync(envFilePath)) {
    try {
      const content = await fs.readFile(envFilePath, 'utf8');
      const match = content.match(/^ELIZAOS_API_KEY=(.+)$/m);
      if (match && match[1] && isValidElizaCloudKey(match[1].trim())) {
        return true;
      }
    } catch {
      // Ignore read errors
    }
  }

  return false;
}

/**
 * Prompts the user for an elizaOS Cloud API key or to login, validates it, and stores it
 * @param envFilePath Path to the .env file
 * @returns The configured elizaOS Cloud API key or null if user cancels
 */
export async function promptAndStoreElizaCloudKey(envFilePath: string): Promise<string | null> {
  // Check if user already has a valid API key
  if (await hasExistingElizaCloudKey(envFilePath)) {
    const existingKey = process.env.ELIZAOS_API_KEY;
    clack.log.success('Found existing elizaOS Cloud API key');
    return existingKey || null;
  }

  clack.intro('☁️  elizaOS Cloud Configuration');

  clack.note(
    `elizaOS Cloud provides multi-model AI access (GPT-4o, Claude, Gemini & more) with a single API key.\n\n` +
      `Get your API key:\n` +
      `  1. Run: ${colors.cyan('elizaos login')} to authenticate with your browser\n` +
      `  2. Or visit: ${colors.blue('https://www.elizacloud.ai/dashboard/api-keys')}\n\n` +
      `Your API key format: ${colors.dim('eliza_xxxxx')}`,
    'Setup Options'
  );

  const authChoice = await clack.select({
    message: 'How would you like to authenticate?',
    options: [
      {
        label: 'Login with browser (recommended)',
        value: 'login',
        hint: 'Opens browser to authenticate and automatically saves your API key',
      },
      {
        label: 'Enter API key manually',
        value: 'manual',
        hint: 'If you already have an API key',
      },
      {
        label: 'Skip for now',
        value: 'skip',
        hint: 'You can run elizaos login later',
      },
    ],
    initialValue: 'login',
  });

  if (clack.isCancel(authChoice)) {
    clack.cancel('Operation cancelled.');
    return null;
  }

  if (authChoice === 'skip') {
    clack.log.warn(
      'Skipping elizaOS Cloud configuration. Run "elizaos login" later to authenticate.'
    );
    // Add placeholder to .env
    let content = '';
    if (existsSync(envFilePath)) {
      content = await fs.readFile(envFilePath, 'utf8');
    }
    if (!content.includes('ELIZAOS_API_KEY=')) {
      if (content && !content.endsWith('\n')) {
        content += '\n';
      }
      content += '\n# elizaOS Cloud Configuration\n';
      content += '# Get your API key by running: elizaos login\n';
      content += '# Or visit: https://www.elizacloud.ai/dashboard/api-keys\n';
      content += 'ELIZAOS_API_KEY=\n';
      await fs.writeFile(envFilePath, content, 'utf8');
    }
    clack.outro('Run "elizaos login" to complete authentication');
    return null;
  }

  if (authChoice === 'login') {
    // Import and run the login handler
    const { handleLogin } = await import('../commands/login/actions/login');
    const cloudUrl = process.env.ELIZA_CLOUD_URL || 'https://www.elizacloud.ai';

    try {
      await handleLogin({
        cloudUrl,
        browser: true,
        timeout: '300',
        envFilePath, // Pass the target .env path so it writes to the correct location
      });

      // After login, the API key should be in the .env file
      // Re-read it to return it
      if (existsSync(envFilePath)) {
        const content = await fs.readFile(envFilePath, 'utf8');
        const match = content.match(/^ELIZAOS_API_KEY=(.+)$/m);
        if (match && match[1]) {
          return match[1].trim();
        }
      }

      return process.env.ELIZAOS_API_KEY || null;
    } catch (error) {
      clack.log.error('Login failed. You can try again later with "elizaos login"');
      return null;
    }
  }

  // Manual API key entry
  const config: ProviderPromptConfig = {
    name: 'elizaOS Cloud',
    icon: '☁️',
    noteText: 'Get your API key from: https://www.elizacloud.ai/dashboard/api-keys',
    inputs: [
      {
        key: 'key',
        message: 'Enter your elizaOS Cloud API key:',
        type: 'password',
        placeholder: 'eliza_xxxxx',
        validate: (value) => {
          if (value.trim() === '') return 'elizaOS Cloud API key cannot be empty';
          return undefined;
        },
      },
    ],
    storeFunction: async (results, envPath) => {
      const isValid = isValidElizaCloudKey(results.key);
      if (!isValid) {
        clack.log.warn('Invalid API key format detected. Expected format: eliza_...');
        clack.log.warn('The key has been saved but may not work correctly.');
      }
      await storeElizaCloudKey(results.key, envPath);
    },
    successMessage: 'elizaOS Cloud integration configured',
  };

  const result = await promptAndStoreProviderConfig<{ key: string }>(config, envFilePath);
  return result?.key || null;
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
  logger.debug(
    {
      src: 'cli',
      util: 'get-config',
      postgresUrlSet: !!postgresUrl,
      pgliteDataDirSet: !!pgliteDataDir,
      reconfigure,
    },
    'Configuration check'
  );

  // BYPASS ADDED: Skip prompts and always use postgres if URL is provided
  if (process.env.POSTGRES_URL) {
    console.log('BYPASS: Using postgres URL from environment variable');
    return process.env.POSTGRES_URL;
  }

  // If we already have PGLITE_DATA_DIR set in env and not reconfiguring, use PGLite
  if (pgliteDataDir && !reconfigure) {
    logger.debug(
      { src: 'cli', util: 'get-config', pgliteDataDir },
      'Using existing PGLite configuration'
    );

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
    logger.error(
      {
        src: 'cli',
        util: 'get-config',
        error: error instanceof Error ? error.message : String(error),
      },
      'Failed to resolve config paths'
    );
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
