import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { logger } from '@elizaos/core';
import inquirer from 'inquirer';
import prompts from 'prompts';
import colors from 'yoctocolors';

/**
 * Interface for environment variable configuration
 */
interface EnvVarConfig {
  name: string; // Display name (e.g., "OpenAI API Key")
  key: string; // Environment variable name (e.g., "OPENAI_API_KEY")
  required: boolean; // Whether the variable is required
  description: string; // Description of what it's for and how to get it
  url: string; // URL where the user can get the API key
  secret: boolean; // Whether to mask the input (for sensitive data)
}

// Configuration for known environment variables by plugin name
const ENV_VAR_CONFIGS: Record<string, EnvVarConfig[]> = {
  openai: [
    {
      name: 'OpenAI API Key',
      key: 'OPENAI_API_KEY',
      required: true,
      description: 'Required for the OpenAI plugin to generate text and embeddings.',
      url: 'https://platform.openai.com/api-keys',
      secret: true,
    },
  ],
  anthropic: [
    {
      name: 'Anthropic API Key',
      key: 'ANTHROPIC_API_KEY',
      required: true,
      description: 'Required for the Anthropic plugin to use Claude models.',
      url: 'https://console.anthropic.com/settings/keys',
      secret: true,
    },
  ],
  discord: [
    {
      name: 'Discord API Token',
      key: 'DISCORD_API_TOKEN',
      required: false,
      description:
        'The bot token for your Discord application. This enables your agent to connect to Discord and interact with users there.',
      url: 'https://discord.com/developers/applications',
      secret: true,
    },
    {
      name: 'Discord Application ID',
      key: 'DISCORD_APPLICATION_ID',
      required: false,
      description:
        'The application ID for your Discord bot. Required together with the API token to enable Discord integration.',
      url: 'https://discord.com/developers/applications',
      secret: false,
    },
  ],
  twitter: [
    {
      name: 'Twitter API Key',
      key: 'TWITTER_API_KEY',
      required: false,
      description: 'API Key for Twitter integration. Needed to connect your agent to Twitter.',
      url: 'https://developer.twitter.com/en/portal/dashboard',
      secret: true,
    },
    {
      name: 'Twitter API Secret',
      key: 'TWITTER_API_SECRET',
      required: false,
      description: 'API Secret for Twitter integration.',
      url: 'https://developer.twitter.com/en/portal/dashboard',
      secret: true,
    },
    {
      name: 'Twitter Access Token',
      key: 'TWITTER_ACCESS_TOKEN',
      required: false,
      description: 'Access Token for Twitter integration.',
      url: 'https://developer.twitter.com/en/portal/dashboard',
      secret: true,
    },
    {
      name: 'Twitter Access Token Secret',
      key: 'TWITTER_ACCESS_TOKEN_SECRET',
      required: false,
      description: 'Access Token Secret for Twitter integration.',
      url: 'https://developer.twitter.com/en/portal/dashboard',
      secret: true,
    },
  ],
  telegram: [
    {
      name: 'Telegram Bot Token',
      key: 'TELEGRAM_BOT_TOKEN',
      required: false,
      description: 'Bot Token for Telegram integration. Needed to connect your agent to Telegram.',
      url: 'https://core.telegram.org/bots#how-do-i-create-a-bot',
      secret: true,
    },
  ],
  pglite: [
    {
      name: 'Database Directory',
      key: 'PGLITE_DATA_DIR',
      required: false,
      description: 'Directory where PGLite will store database files.',
      url: '',
      secret: false,
    },
  ],
  postgresql: [
    {
      name: 'PostgreSQL URL',
      key: 'POSTGRES_URL',
      required: false,
      description: 'URL for connecting to your PostgreSQL database.',
      url: 'https://neon.tech/docs/connect/connect-from-any-app',
      secret: false,
    },
  ],
};

/**
 * Gets the path to the .eliza/.env file
 */
export function getEnvFilePath(): string {
  const homeDir = os.homedir();
  return path.join(homeDir, '.eliza', '.env');
}

/**
 * Reads environment variables from the .eliza/.env file
 */
export function readEnvFile(): Record<string, string> {
  const envPath = getEnvFilePath();
  const result: Record<string, string> = {};

  try {
    if (fs.existsSync(envPath)) {
      const content = fs.readFileSync(envPath, 'utf8');
      const lines = content.split('\n');

      for (const line of lines) {
        const trimmedLine = line.trim();
        if (trimmedLine && !trimmedLine.startsWith('#')) {
          const separatorIndex = trimmedLine.indexOf('=');
          if (separatorIndex > 0) {
            const key = trimmedLine.substring(0, separatorIndex).trim();
            const value = trimmedLine.substring(separatorIndex + 1).trim();
            result[key] = value;
          }
        }
      }
    }
  } catch (error) {
    logger.error(`Error reading environment file: ${error}`);
  }

  return result;
}

/**
 * Writes environment variables to the .eliza/.env file
 */
export function writeEnvFile(envVars: Record<string, string>): void {
  try {
    const envPath = getEnvFilePath();
    const elizaDir = path.dirname(envPath);

    // Ensure .eliza directory exists
    if (!fs.existsSync(elizaDir)) {
      fs.mkdirSync(elizaDir, { recursive: true });
    }

    // Format environment variables for writing
    let content = '';
    for (const [key, value] of Object.entries(envVars)) {
      content += `${key}=${value}\n`;
    }

    // Write to file
    fs.writeFileSync(envPath, content, 'utf8');
    logger.info(`Environment variables saved to ${envPath}`);
  } catch (error) {
    logger.error(`Error writing environment file: ${error}`);
  }
}

/**
 * Prompts the user for a specific environment variable
 */
async function promptForEnvVar(config: EnvVarConfig): Promise<string | null> {
  // If the key already exists in the environment and is valid, use that
  const existingValue = process.env[config.key];
  if (existingValue && existingValue.trim() !== '') {
    return existingValue;
  }

  console.log(
    colors.magenta(
      `\n${config.name} ${config.required ? '(Required)' : '(Optional - press Enter to skip)'}`
    )
  );
  console.log(colors.white(config.description));
  if (config.url) {
    console.log(colors.blue(`Get it here: ${config.url}`));
  }

  const { value } = await inquirer.prompt([
    {
      type: config.secret ? 'password' : 'input',
      name: 'value',
      message: `Enter your ${config.name}:`,
      validate: (input: string) => {
        if (config.required && (!input || input.trim() === '')) {
          return 'This field is required';
        }
        return true;
      },
    },
  ]);

  // For optional fields, an empty string means skip
  if (!config.required && (!value || value.trim() === '')) {
    return '';
  }

  // Expand tilde in paths for database directory
  if (config.key === 'PGLITE_DATA_DIR' && value && value.startsWith('~')) {
    return value.replace(/^~/, os.homedir());
  }

  return value;
}

/**
 * Prompts for required environment variables for a given plugin
 *
 * @param pluginName The name of the plugin (e.g., 'openai', 'discord')
 * @returns A record of the environment variables that were set
 */
export async function promptForEnvVars(pluginName: string): Promise<Record<string, string>> {
  const envVarConfigs = ENV_VAR_CONFIGS[pluginName.toLowerCase()];
  if (!envVarConfigs) {
    return {};
  }

  // Special messages for optional integrations
  if (pluginName.toLowerCase() === 'discord') {
    console.log(colors.blue('\n=== Discord Integration (Optional) ==='));
    console.log(
      colors.white(
        'Setting up Discord integration will allow your agent to interact with Discord users.'
      )
    );
    console.log(
      colors.white("You can press Enter to skip these if you don't want to use Discord.")
    );
  } else if (pluginName.toLowerCase() === 'twitter') {
    console.log(colors.blue('\n=== Twitter Integration (Optional) ==='));
    console.log(
      colors.white(
        'Setting up Twitter integration will allow your agent to post and interact on Twitter.'
      )
    );
    console.log(
      colors.white("You can press Enter to skip these if you don't want to use Twitter.")
    );
  } else if (pluginName.toLowerCase() === 'telegram') {
    console.log(colors.blue('\n=== Telegram Integration (Optional) ==='));
    console.log(
      colors.white(
        'Setting up Telegram integration will allow your agent to interact in Telegram chats.'
      )
    );
    console.log(
      colors.white("You can press Enter to skip these if you don't want to use Telegram.")
    );
  }

  // Read existing environment variables
  const envVars = readEnvFile();
  const result: Record<string, string> = {};
  let changes = false;

  // Check each environment variable
  for (const config of envVarConfigs) {
    // Skip if already set and valid
    if (
      envVars[config.key] &&
      envVars[config.key] !== 'dummy_key' &&
      envVars[config.key] !== 'invalid_token_for_testing'
    ) {
      continue;
    }

    // wait 100 ms
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Prompt for the missing or invalid variable
    const value = await promptForEnvVar(config);

    // Save to our record
    result[config.key] = value;
    envVars[config.key] = value;

    // Also set in process.env for immediate use
    process.env[config.key] = value;

    changes = true;
  }

  // Save changes if any were made
  if (changes) {
    writeEnvFile(envVars);
  }

  return result;
}

/**
 * Checks if a plugin has required environment variables set
 */
export function checkEnvVarsForPlugin(pluginName: string): boolean {
  const envVarConfigs = ENV_VAR_CONFIGS[pluginName.toLowerCase()];
  if (!envVarConfigs) {
    return true; // No requirements means everything is fine
  }

  const envVars = readEnvFile();

  // Check if all required variables are set
  for (const config of envVarConfigs) {
    if (config.required && (!envVars[config.key] || envVars[config.key] === 'dummy_key')) {
      return false;
    }
  }

  return true;
}

/**
 * Lists missing environment variables for a plugin
 */
export function listMissingEnvVars(pluginName: string): string[] {
  const envVarConfigs = ENV_VAR_CONFIGS[pluginName.toLowerCase()];
  if (!envVarConfigs) {
    return [];
  }

  const envVars = readEnvFile();
  const missing: string[] = [];

  for (const config of envVarConfigs) {
    if (config.required && (!envVars[config.key] || envVars[config.key] === 'dummy_key')) {
      missing.push(config.key);
    }
  }

  return missing;
}

/**
 * Validates and provides feedback about specific plugin configurations
 *
 * @param pluginName Name of the plugin to validate
 * @returns An object with status and message
 */
export function validatePluginConfig(pluginName: string): {
  valid: boolean;
  message: string;
} {
  const envVars = readEnvFile();

  switch (pluginName.toLowerCase()) {
    case 'discord':
      // Check if Discord token is provided but application ID is not
      if (
        envVars.DISCORD_API_TOKEN &&
        envVars.DISCORD_API_TOKEN.trim() !== '' &&
        (!envVars.DISCORD_APPLICATION_ID || envVars.DISCORD_APPLICATION_ID.trim() === '')
      ) {
        return {
          valid: false,
          message:
            'Discord API Token is provided but Application ID is missing. Both are needed for Discord integration.',
        };
      }

      // Check if both are provided and valid
      if (
        envVars.DISCORD_API_TOKEN &&
        envVars.DISCORD_API_TOKEN.trim() !== '' &&
        envVars.DISCORD_APPLICATION_ID &&
        envVars.DISCORD_APPLICATION_ID.trim() !== ''
      ) {
        return {
          valid: true,
          message: 'Discord integration is properly configured.',
        };
      }

      // If neither is provided, that's fine - Discord is optional
      if (
        (!envVars.DISCORD_API_TOKEN || envVars.DISCORD_API_TOKEN.trim() === '') &&
        (!envVars.DISCORD_APPLICATION_ID || envVars.DISCORD_APPLICATION_ID.trim() === '')
      ) {
        return {
          valid: true,
          message: 'Discord integration is not configured (optional).',
        };
      }

      return {
        valid: false,
        message:
          'Discord configuration is incomplete. Please provide both API Token and Application ID.',
      };

    case 'twitter': {
      // Check if all Twitter credentials are provided
      const twitterKeys = [
        'TWITTER_API_KEY',
        'TWITTER_API_SECRET',
        'TWITTER_ACCESS_TOKEN',
        'TWITTER_ACCESS_TOKEN_SECRET',
      ];

      // Check if any Twitter credentials are provided but not all
      const providedKeys = twitterKeys.filter((key) => envVars[key] && envVars[key].trim() !== '');

      if (providedKeys.length > 0 && providedKeys.length < twitterKeys.length) {
        return {
          valid: false,
          message: `Twitter configuration is incomplete. Missing: ${twitterKeys
            .filter((key) => !providedKeys.includes(key))
            .join(', ')}`,
        };
      }

      // If all are provided, Twitter is properly configured
      if (providedKeys.length === twitterKeys.length) {
        return {
          valid: true,
          message: 'Twitter integration is properly configured.',
        };
      }

      // If none are provided, that's fine - Twitter is optional
      return {
        valid: true,
        message: 'Twitter integration is not configured (optional).',
      };
    }

    case 'telegram':
      if (envVars.TELEGRAM_BOT_TOKEN && envVars.TELEGRAM_BOT_TOKEN.trim() !== '') {
        return {
          valid: true,
          message: 'Telegram integration is properly configured.',
        };
      }

      // Telegram is optional
      return {
        valid: true,
        message: 'Telegram integration is not configured (optional).',
      };

    // Add cases for other plugins as needed
    case 'openai':
      if (!envVars.OPENAI_API_KEY || envVars.OPENAI_API_KEY.trim() === '') {
        return {
          valid: false,
          message: 'OpenAI API Key is not configured. This is required for using OpenAI models.',
        };
      }
      return {
        valid: true,
        message: 'OpenAI API is properly configured.',
      };

    case 'anthropic':
      if (!envVars.ANTHROPIC_API_KEY || envVars.ANTHROPIC_API_KEY.trim() === '') {
        return {
          valid: false,
          message: 'Anthropic API Key is not configured. This is required for using Claude models.',
        };
      }
      return {
        valid: true,
        message: 'Anthropic API is properly configured.',
      };

    case 'postgresql':
      if (!envVars.POSTGRES_URL || envVars.POSTGRES_URL.trim() === '') {
        return {
          valid: true, // Not required by default
          message: 'PostgreSQL URL is not configured. Using default PGLite database.',
        };
      }

      return {
        valid: true,
        message: 'PostgreSQL connection is configured.',
      };

    default:
      return {
        valid: true,
        message: `${pluginName} configuration is valid.`,
      };
  }
}
