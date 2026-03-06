/**
 * @elizaos/plugin-secrets-manager
 *
 * Multi-level secret management for elizaOS with:
 * - Conversational onboarding (Discord, Telegram)
 * - Web form-based secret collection
 * - Encryption at rest (AES-256-GCM)
 * - Dynamic plugin activation
 */

// Plugin
export {
  secretsManagerPlugin,
  secretsManagerPlugin as default,
} from "./plugin.js";
export type { SecretsManagerPluginConfig } from "./plugin.js";

// Types
export * from "./types.js";

// Services
export {
  SecretsService,
  SECRETS_SERVICE_TYPE,
  PluginActivatorService,
  PLUGIN_ACTIVATOR_SERVICE_TYPE,
} from "./services/index.js";
export type { PluginWithSecrets } from "./services/index.js";

// Storage
export {
  BaseSecretStorage,
  CompositeSecretStorage,
  MemorySecretStorage,
  CharacterSettingsStorage,
  WorldMetadataStorage,
  ComponentSecretStorage,
} from "./storage/index.js";
export type { ISecretStorage } from "./storage/index.js";

// Crypto
export {
  KeyManager,
  encrypt,
  decrypt,
  deriveKeyFromAgentId,
  deriveKeyPbkdf2,
  generateSalt,
  generateKey,
  generateSecureToken,
  isEncryptedSecret,
} from "./crypto/index.js";

// Validation
export {
  validateSecret,
  ValidationStrategies,
  registerValidator,
  unregisterValidator,
  inferValidationStrategy,
} from "./validation.js";

// Actions
export { setSecretAction, manageSecretAction } from "./actions/index.js";

// Providers
export {
  secretsStatusProvider,
  secretsInfoProvider,
} from "./providers/index.js";

// Onboarding - conversational secrets collection for Discord/Telegram
export {
  // Config types and utilities
  type OnboardingConfig,
  type OnboardingSetting,
  COMMON_API_KEY_SETTINGS,
  DEFAULT_ONBOARDING_MESSAGES,
  createOnboardingConfig,
  getUnconfiguredRequired,
  getUnconfiguredOptional,
  isOnboardingComplete,
  getNextSetting,
  generateSettingPrompt,
  // Service
  OnboardingService,
  ONBOARDING_SERVICE_TYPE,
  // Action
  updateSettingsAction,
  // Providers
  onboardingSettingsProvider,
  missingSecretsProvider,
} from "./onboarding/index.js";
