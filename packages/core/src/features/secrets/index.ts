/**
 * Secrets Manager — Core Capability
 *
 * Multi-level secret management for elizaOS with:
 * - Conversational setup (Discord, Telegram)
 * - Web form-based secret collection
 * - Encryption at rest (AES-256-GCM)
 * - Dynamic plugin activation
 */

// Actions
export { maskSecretValue, secretsAction } from "./actions/index.ts";

// Crypto — re-exported from the defining file, NOT through a re-export-only
// barrel (Bun.build drops barrel-only-reachable modules when the mobile
// bundle lowers @elizaos/core to lazy CJS-interop inits; see ./plugin.ts).
export {
	ALGORITHM_GCM,
	createKeyDerivationParams,
	DEFAULT_PBKDF2_ITERATIONS,
	DEFAULT_SALT_LENGTH,
	decrypt,
	decryptGcm,
	deriveKeyPbkdf2,
	deriveKeyScrypt,
	encrypt,
	encryptGcm,
	generateKey,
	generateSalt,
	generateSecureToken,
	hashValue,
	IV_LENGTH,
	isEncryptedSecret,
	KEY_LENGTH,
	KeyManager,
	secureCompare,
} from "./crypto/encryption.ts";
// Plugin
export type { SecretsManagerPluginConfig } from "./plugin.ts";
export {
	secretsManagerPlugin,
	secretsManagerPlugin as default,
} from "./plugin.ts";
// Providers
export {
	secretsInfoProvider,
	secretsStatusProvider,
} from "./providers/secrets-status.ts";
// Services
export type { PluginWithSecrets } from "./services/index.ts";
export {
	PLUGIN_ACTIVATOR_SERVICE_TYPE,
	PluginActivatorService,
	SECRETS_SERVICE_TYPE,
	SecretsService,
} from "./services/index.ts";
// Setup — conversational secrets collection for Discord/Telegram.
// Re-exported per defining file, NOT through a re-export-only barrel
// (see the crypto note above).
export { updateSettingsAction } from "./setup/action.ts";
export {
	COMMON_API_KEY_SETTINGS,
	createSetupConfig,
	DEFAULT_SETUP_MESSAGES,
	generateSettingPrompt,
	getNextSetting,
	getUnconfiguredOptional,
	getUnconfiguredRequired,
	isSetupComplete,
	type SetupConfig,
	type SetupSetting,
} from "./setup/config.ts";
export {
	missingSecretsProvider,
	setupSettingsProvider,
} from "./setup/provider.ts";
export { SETUP_SERVICE_TYPE, SetupService } from "./setup/service.ts";

// Storage
export type { ISecretStorage } from "./storage/index.ts";
export {
	BaseSecretStorage,
	CharacterSettingsStorage,
	ComponentSecretStorage,
	CompositeSecretStorage,
	MemorySecretStorage,
	WorldMetadataStorage,
} from "./storage/index.ts";

// Types
export * from "./types.ts";

// Validation
export {
	inferValidationStrategy,
	registerValidator,
	unregisterValidator,
	ValidationStrategies,
	validateSecret,
} from "./validation.ts";
