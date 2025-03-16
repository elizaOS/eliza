import dotenv from 'dotenv';
dotenv.config({ path: '../../.env' });

// Use a more generic type definition since 'Project' or 'ProjectType' might not be exported
import { logger } from '@elizaos/core';
import communityManager from './communityManager';
import devRel from './devRel';
import investmentManager from './investmentManager';
import liaison from './liaison';
import projectManager from './projectManager';
import socialMediaManager from './socialMediaManager';

/**
 * Checks if all required environment variables for an agent are available
 * @param agent The agent to check
 * @returns boolean indicating if all required environment variables are set
 */
function hasRequiredEnvVars(agent: any): boolean {
  if (!agent?.character?.settings?.secrets) {
    logger.warn('Agent missing required settings.secrets configuration');
    return false;
  }

  const secrets = agent.character.settings.secrets;
  const missingVars: string[] = [];
  let hasRequiredPlatform = false;
  let checkingPlatforms = false;

  // Check Discord plugin requirements
  if (agent.character.plugins?.includes('@elizaos/plugin-discord')) {
    checkingPlatforms = true;
    let discordConfigured = true;

    // Check for Discord Application ID
    if (secrets.DISCORD_APPLICATION_ID) {
      // Check if it's an environment variable reference or direct value
      if (secrets.DISCORD_APPLICATION_ID.startsWith('process.env.')) {
        const envVarName = secrets.DISCORD_APPLICATION_ID.replace('process.env.', '');
        if (!process.env[envVarName]) {
          missingVars.push(envVarName);
          discordConfigured = false;
        }
      } else {
        // If it's a direct value, it's already available
        logger.info(`Agent "${agent.character.name}" has direct Discord Application ID value`);
      }
    } else {
      logger.warn(`Agent "${agent.character.name}" missing DISCORD_APPLICATION_ID configuration`);
      discordConfigured = false;
    }

    // Check for Discord API Token
    if (secrets.DISCORD_API_TOKEN) {
      // Check if it's an environment variable reference or direct value
      if (secrets.DISCORD_API_TOKEN.startsWith('process.env.')) {
        const envVarName = secrets.DISCORD_API_TOKEN.replace('process.env.', '');
        if (!process.env[envVarName]) {
          missingVars.push(envVarName);
          discordConfigured = false;
        }
      } else {
        // If it's a direct value, it's already available
        logger.info(`Agent "${agent.character.name}" has direct Discord API Token value`);
      }
    } else {
      logger.warn(`Agent "${agent.character.name}" missing DISCORD_API_TOKEN configuration`);
      discordConfigured = false;
    }

    // If Discord is fully configured, mark that we have at least one required platform
    if (discordConfigured) {
      hasRequiredPlatform = true;
    }
  }

  // Check Telegram plugin requirements
  if (agent.character.plugins?.includes('@elizaos/plugin-telegram')) {
    checkingPlatforms = true;
    let telegramConfigured = true;

    // Check for Telegram Bot Token
    if (secrets.TELEGRAM_BOT_TOKEN) {
      // Check if it's an environment variable reference or direct value
      if (secrets.TELEGRAM_BOT_TOKEN.startsWith('process.env.')) {
        const envVarName = secrets.TELEGRAM_BOT_TOKEN.replace('process.env.', '');
        if (!process.env[envVarName]) {
          missingVars.push(envVarName);
          telegramConfigured = false;
        }
      } else {
        // If it's a direct value, it's already available
        logger.info(`Agent "${agent.character.name}" has direct Telegram Bot Token value`);
      }
    } else {
      logger.warn(`Agent "${agent.character.name}" missing TELEGRAM_BOT_TOKEN configuration`);
      telegramConfigured = false;
    }

    // If Telegram is fully configured, mark that we have at least one required platform
    if (telegramConfigured) {
      hasRequiredPlatform = true;
    }
  }

  // If we weren't checking any communication platforms, let the agent pass
  // This handles agents that don't use Discord or Telegram
  if (!checkingPlatforms) {
    logger.info(
      `Agent "${agent.character.name}" doesn't require Discord or Telegram configuration`
    );
    return true;
  }

  // If we checked platforms but none were properly configured, log the missing variables
  if (checkingPlatforms && !hasRequiredPlatform) {
    if (missingVars.length > 0) {
      logger.warn(
        `Agent "${agent.character.name}" disabled due to missing environment variables: ${missingVars.join(', ')}`
      );
    } else {
      logger.warn(`Agent "${agent.character.name}" disabled due to incomplete configuration`);
    }
    return false;
  }

  // If at least one platform is configured, the agent can run
  logger.info(`Agent "${agent.character.name}" enabled with all required environment variables`);
  return true;
}

// Filter agents based on available environment variables
const availableAgents = [
  devRel,
  // communityManager,
  // investmentManager,
  // liaison,
  // projectManager,
  // socialMediaManager,
].filter(hasRequiredEnvVars);

export const project = {
  agents: availableAgents,
};

export default project;
