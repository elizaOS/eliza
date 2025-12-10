/**
 * Cloud Account Service
 *
 * Manages ElizaOS Cloud account detection, validation, and onboarding.
 * This service helps push users towards the cloud by checking account status
 * and offering free signup with credits.
 */

import { existsSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import * as clack from '@clack/prompts';
import colors from 'yoctocolors';
import { logger } from '@elizaos/core';

/** Cloud account status information */
export interface CloudAccountStatus {
  hasAccount: boolean;
  hasApiKey: boolean;
  apiKeyValid: boolean;
  creditBalance?: number;
  email?: string;
}

/** Model tier options available on ElizaOS Cloud */
export type CloudModelTier = 'fast' | 'pro' | 'ultra';

/** Model tier configuration */
export interface CloudModelTierConfig {
  id: CloudModelTier;
  name: string;
  description: string;
  priceIndicator: '$' | '$$' | '$$$';
  modelInfo: string;
}

/** Available cloud model tiers */
export const CLOUD_MODEL_TIERS: CloudModelTierConfig[] = [
  {
    id: 'fast',
    name: 'Fast',
    description: 'Lowest cost',
    priceIndicator: '$',
    modelInfo: 'Gemini Flash',
  },
  {
    id: 'pro',
    name: 'Pro',
    description: 'Recommended',
    priceIndicator: '$$',
    modelInfo: 'Claude Sonnet',
  },
  {
    id: 'ultra',
    name: 'Ultra',
    description: 'Best quality',
    priceIndicator: '$$$',
    modelInfo: 'Claude Opus',
  },
];

const ELIZAOS_CLOUD_API_KEY = 'ELIZAOS_CLOUD_API_KEY';
const CLOUD_URL = process.env.ELIZA_CLOUD_URL || 'https://www.elizacloud.ai';
const FREE_CREDITS_AMOUNT = 1000;

// Config file for storing first-run flag
const ELIZA_CONFIG_DIR = path.join(os.homedir(), '.eliza');
const FIRST_RUN_FILE = path.join(ELIZA_CONFIG_DIR, '.first-run-complete');

/**
 * Cloud Account Service for managing ElizaOS Cloud integration
 */
export class CloudAccountService {
  private static instance: CloudAccountService;

  private constructor() {}

  static getInstance(): CloudAccountService {
    if (!CloudAccountService.instance) {
      CloudAccountService.instance = new CloudAccountService();
    }
    return CloudAccountService.instance;
  }

  /**
   * Check if this is the user's first time running the CLI
   */
  async isFirstRun(): Promise<boolean> {
    return !existsSync(FIRST_RUN_FILE);
  }

  /**
   * Mark first run as complete
   */
  async markFirstRunComplete(): Promise<void> {
    if (!existsSync(ELIZA_CONFIG_DIR)) {
      await fs.mkdir(ELIZA_CONFIG_DIR, { recursive: true });
    }
    await fs.writeFile(FIRST_RUN_FILE, new Date().toISOString(), 'utf8');
  }

  /**
   * Get the API key from environment or .env file
   */
  async getApiKey(envFilePath?: string): Promise<string | null> {
    // Check process.env first
    if (process.env[ELIZAOS_CLOUD_API_KEY]) {
      const key = process.env[ELIZAOS_CLOUD_API_KEY];
      if (this.isValidApiKeyFormat(key)) {
        return key;
      }
    }

    // Check .env file if provided
    if (envFilePath && existsSync(envFilePath)) {
      const content = await fs.readFile(envFilePath, 'utf8');
      const match = content.match(/^ELIZAOS_CLOUD_API_KEY=(.+)$/m);
      if (match) {
        const key = match[1].trim();
        if (this.isValidApiKeyFormat(key)) {
          return key;
        }
      }
    }

    // Check current directory .env
    const cwdEnv = path.join(process.cwd(), '.env');
    if (existsSync(cwdEnv)) {
      const content = await fs.readFile(cwdEnv, 'utf8');
      const match = content.match(/^ELIZAOS_CLOUD_API_KEY=(.+)$/m);
      if (match) {
        const key = match[1].trim();
        if (this.isValidApiKeyFormat(key)) {
          return key;
        }
      }
    }

    return null;
  }

  /**
   * Check if a string is a valid elizaOS Cloud API key format
   */
  isValidApiKeyFormat(key: string | undefined): boolean {
    if (!key || typeof key !== 'string') {
      return false;
    }
    // Keys start with 'eliza_' and have sufficient length
    return key.startsWith('eliza_') && key.length > 10;
  }

  /**
   * Validate an API key with the cloud service
   */
  async validateApiKey(apiKey: string): Promise<CloudAccountStatus> {
    try {
      const response = await fetch(`${CLOUD_URL}/api/v1/me`, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
      });

      if (response.ok) {
        const data = await response.json();
        return {
          hasAccount: true,
          hasApiKey: true,
          apiKeyValid: true,
          creditBalance: data.creditBalance,
          email: data.email,
        };
      }

      return {
        hasAccount: false,
        hasApiKey: true,
        apiKeyValid: false,
      };
    } catch (error) {
      logger.debug({ src: 'cli', service: 'cloud-account', error }, 'Failed to validate cloud API key');
      return {
        hasAccount: false,
        hasApiKey: true,
        apiKeyValid: false,
      };
    }
  }

  /**
   * Get the current cloud account status
   */
  async getAccountStatus(envFilePath?: string): Promise<CloudAccountStatus> {
    const apiKey = await this.getApiKey(envFilePath);

    if (!apiKey) {
      return {
        hasAccount: false,
        hasApiKey: false,
        apiKeyValid: false,
      };
    }

    return this.validateApiKey(apiKey);
  }

  /**
   * Check if user has a valid cloud account
   */
  async hasValidCloudAccount(envFilePath?: string): Promise<boolean> {
    const status = await this.getAccountStatus(envFilePath);
    return status.hasAccount && status.apiKeyValid;
  }

  /**
   * Show the cloud onboarding prompt for new users
   * Returns true if user chose to set up cloud, false otherwise
   */
  async showOnboardingPrompt(): Promise<boolean> {
    const setupChoice = await clack.select({
      message: 'How would you like to run your AI models?',
      options: [
        {
          label: 'ElizaOS Cloud',
          value: 'setup',
          hint: `${FREE_CREDITS_AMOUNT} free credits, no setup required`,
        },
        {
          label: 'Bring my own API keys',
          value: 'skip',
          hint: 'OpenAI, Anthropic, etc.',
        },
      ],
      initialValue: 'setup',
    });

    if (clack.isCancel(setupChoice)) {
      return false;
    }

    if (setupChoice === 'setup') {
      return this.initiateCloudLogin();
    }

    return false;
  }

  /**
   * Initiate the cloud login flow
   */
  async initiateCloudLogin(): Promise<boolean> {
    try {
      const { handleLogin } = await import('../commands/login/actions/login');
      await handleLogin({
        cloudUrl: CLOUD_URL,
        browser: true,
        timeout: '300',
      });
      return true;
    } catch (error) {
      logger.error({ src: 'cli', service: 'cloud-account', error }, 'Cloud login failed');
      clack.log.error('Failed to complete cloud authentication. You can try again with "elizaos login".');
      return false;
    }
  }

  /**
   * Prompt user to select a cloud model tier
   */
  async selectModelTier(): Promise<CloudModelTier> {
    const selectedTier = await clack.select({
      message: 'Select your preferred model tier:',
      options: CLOUD_MODEL_TIERS.map((tier) => ({
        label: `${tier.name} ${tier.priceIndicator}`,
        value: tier.id,
        hint: `${tier.description} - ${tier.modelInfo}`,
      })),
      initialValue: 'pro' as CloudModelTier,
    });

    if (clack.isCancel(selectedTier)) {
      return 'pro';
    }

    return selectedTier as CloudModelTier;
  }

  /**
   * Write cloud configuration to .env file
   */
  async writeCloudConfig(
    envFilePath: string,
    apiKey: string,
    modelTier: CloudModelTier = 'pro'
  ): Promise<void> {
    let content = '';
    if (existsSync(envFilePath)) {
      content = await fs.readFile(envFilePath, 'utf8');
    }

    // Ensure trailing newline
    if (content && !content.endsWith('\n')) {
      content += '\n';
    }

    // Remove existing cloud config if present
    content = content.replace(/# elizaOS Cloud Configuration[\s\S]*?ELIZAOS_CLOUD_MODEL_TIER=\w*\n?/g, '');
    content = content.replace(/ELIZAOS_CLOUD_API_KEY=.*\n?/g, '');
    content = content.replace(/ELIZAOS_CLOUD_MODEL_TIER=.*\n?/g, '');

    // Add cloud configuration
    content += '\n# elizaOS Cloud Configuration\n';
    content += `ELIZAOS_CLOUD_API_KEY=${apiKey}\n`;
    content += `ELIZAOS_CLOUD_MODEL_TIER=${modelTier}\n`;

    await fs.writeFile(envFilePath, content, 'utf8');
    logger.debug({ src: 'cli', service: 'cloud-account', envFilePath, modelTier }, 'Cloud configuration written');
  }

  /**
   * Get the cloud URL
   */
  getCloudUrl(): string {
    return CLOUD_URL;
  }

  /**
   * Get dashboard URL
   */
  getDashboardUrl(): string {
    return `${CLOUD_URL}/dashboard`;
  }

  /**
   * Get API keys management URL
   */
  getApiKeysUrl(): string {
    return `${CLOUD_URL}/dashboard/api-keys`;
  }
}

// Export singleton instance
export const cloudAccountService = CloudAccountService.getInstance();
