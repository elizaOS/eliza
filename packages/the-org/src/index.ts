import dotenv from 'dotenv';
dotenv.config({ path: '../../.env' });

import { logger, ProjectAgent } from '@elizaos/core';
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
function hasRequiredEnvVars(agent: ProjectAgent): boolean {
  // Get which platform plugins the agent uses
  const usesDiscord = agent.character.plugins?.includes('@elizaos/plugin-discord');
  const usesTelegram = agent.character.plugins?.includes('@elizaos/plugin-telegram');

  // If no communication platforms are needed, we're good
  if (!usesDiscord && !usesTelegram) return true;

  // Check if at least one platform is properly configured
  let hasValidPlatform = false;

  if (usesDiscord) {
    // Get the actual values from agent settings
    const discordId = agent.character.settings.secrets.DISCORD_APPLICATION_ID;
    const discordToken = agent.character.settings.secrets.DISCORD_API_TOKEN;

    if (discordId && discordToken) {
      hasValidPlatform = true;
      logger.debug(`Agent "${agent.character.name}" has Discord configuration`);
    }
  }

  if (usesTelegram) {
    const telegramToken = agent.character.settings.secrets.TELEGRAM_BOT_TOKEN;

    if (telegramToken) {
      hasValidPlatform = true;
      logger.debug(`Agent "${agent.character.name}" has Telegram configuration`);
    }
  }

  if (!hasValidPlatform) {
    logger.warn(`Agent "${agent.character.name}" disabled - missing platform configuration`);
  }

  return hasValidPlatform;
}

// Define which agents you want to enable
const enabledAgents = [
  devRel,
  communityManager,
  investmentManager,
  liaison,
  projectManager,
  socialMediaManager,
];

const availableAgents = enabledAgents.filter(hasRequiredEnvVars);

// Log the filtering results with accurate counts
if (enabledAgents.length === 0) {
  logger.warn('No agents are enabled in the configuration');
} else if (availableAgents.length === 0) {
  logger.error('NO AGENTS AVAILABLE - INITIALIZING DEFAULT ELIZA CHARACTER');
  logger.info('Configure the required platform integrations in your .env file');
} else if (availableAgents.length < enabledAgents.length) {
  logger.warn(
    `${enabledAgents.length - availableAgents.length} out of ${enabledAgents.length} enabled agents were filtered out due to missing platform requirements.`
  );
} else {
  logger.info(`${availableAgents.length} agents successfully initialized`);
}

export const project = {
  agents: availableAgents,
};

export default project;
