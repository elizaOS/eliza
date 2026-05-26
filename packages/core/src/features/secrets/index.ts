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

// Crypto
export {
	ALGORITHM_CBC,
	ALGORITHM_GCM,
	createKeyDerivationParams,
	DEFAULT_PBKDF2_ITERATIONS,
	DEFAULT_SALT_LENGTH,
	decrypt,
	decryptCbc,
	decryptGcm,
	deriveKeyFromAgentId,
	deriveKeyPbkdf2,
	deriveKeyScrypt,
	encrypt,
	encryptCbc,
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
} from "./crypto/index.ts";
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
} from "./providers/index.ts";
// Services
export type { PluginWithSecrets } from "./services/index.ts";
export {
	PLUGIN_ACTIVATOR_SERVICE_TYPE,
	PluginActivatorService,
	SECRETS_SERVICE_TYPE,
	SecretsService,
} from "./services/index.ts";
// Setup — conversational secrets collection for Discord/Telegram
export {
	COMMON_API_KEY_SETTINGS,
	createSetupConfig,
	DEFAULT_SETUP_MESSAGES,
	generateSettingPrompt,
	getNextSetting,
	getUnconfiguredOptional,
	getUnconfiguredRequired,
	isSetupComplete,
	missingSecretsProvider,
	SETUP_SERVICE_TYPE,
	type SetupConfig,
	SetupService,
	type SetupSetting,
	setupSettingsProvider,
	updateSettingsAction,
} from "./setup/index.ts";

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
