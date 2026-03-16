/**
 * Secrets Manager Plugin
 *
 * Comprehensive secret management for elizaOS with:
 * - Multi-level storage (global, world, user)
 * - Encryption at rest
 * - Dynamic plugin activation when secrets become available
 * - Natural language secret management
 * - Conversational onboarding flow (Discord, Telegram)
 */

import type { Plugin } from "@elizaos/core";
import { logger } from "@elizaos/core";

import { SecretsService } from "./services/secrets.js";
import { PluginActivatorService } from "./services/plugin-activator.js";
import { setSecretAction, manageSecretAction } from "./actions/index.js";
import {
  secretsStatusProvider,
  secretsInfoProvider,
} from "./providers/index.js";
import {
  OnboardingService,
  updateSettingsAction,
  onboardingSettingsProvider,
  missingSecretsProvider,
} from "./onboarding/index.js";

/**
 * Plugin configuration
 */
export interface SecretsManagerPluginConfig {
  /** Enable encryption for stored secrets (default: true) */
  enableEncryption?: boolean;
  /** Custom salt for encryption key derivation */
  encryptionSalt?: string;
  /** Enable access logging (default: true) */
  enableAccessLogging?: boolean;
  /** Enable automatic plugin activation when secrets are available (default: true) */
  enableAutoActivation?: boolean;
  /** Polling interval for checking plugin requirements (ms, default: 5000) */
  activationPollingMs?: number;
}

/**
 * Secrets Manager Plugin
 *
 * Provides comprehensive secret management capabilities:
 *
 * **Storage Levels:**
 * - Global: Agent-wide secrets (API keys, tokens) stored in character settings
 * - World: Server/channel-specific secrets stored in world metadata
 * - User: Per-user secrets stored as components
 *
 * **Features:**
 * - Automatic encryption using AES-256-GCM
 * - Natural language secret management via actions
 * - Plugin activation when required secrets become available
 * - Access logging and auditing
 * - Backward compatibility with ENV_ prefixed settings
 *
 * **Usage:**
 * ```typescript
 * import { secretsManagerPlugin } from '@elizaos/plugin-secrets-manager';
 *
 * const runtime = createAgentRuntime({
 *   plugins: [secretsManagerPlugin],
 * });
 *
 * // Get the secrets service
 * const secrets = runtime.getService<SecretsService>('SECRETS');
 *
 * // Set a global secret
 * await secrets.setGlobal('OPENAI_API_KEY', 'sk-...');
 *
 * // Get a global secret
 * const apiKey = await secrets.getGlobal('OPENAI_API_KEY');
 * ```
 */
export const secretsManagerPlugin: Plugin = {
  name: "@elizaos/plugin-secrets-manager",
  description:
    "Multi-level secret management with encryption, dynamic plugin activation, and conversational onboarding",

  // Services
  services: [SecretsService, PluginActivatorService, OnboardingService],

  // Actions for natural language secret management and onboarding
  actions: [setSecretAction, manageSecretAction, updateSettingsAction],

  // Providers for context injection
  providers: [
    secretsStatusProvider,
    secretsInfoProvider,
    onboardingSettingsProvider,
    missingSecretsProvider,
  ],

  // Plugin initialization
  init: async (config: SecretsManagerPluginConfig, runtime) => {
    logger.info("[SecretsManagerPlugin] Initializing");

    // Configuration is passed to services via their start() methods
    // The runtime will call Service.start() for each service

    logger.info("[SecretsManagerPlugin] Initialized");
  },
};

// Default export
export default secretsManagerPlugin;

// Re-export types and utilities
export * from "./types.js";
export * from "./services/index.js";
export * from "./storage/index.js";
export * from "./crypto/index.js";
export * from "./onboarding/index.js";
export {
  validateSecret,
  ValidationStrategies,
  registerValidator,
  inferValidationStrategy,
} from "./validation.js";
