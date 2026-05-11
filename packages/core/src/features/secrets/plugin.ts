/**
 * Secrets capability
 *
 * Comprehensive secret management for ElizaOS with:
 * - Multi-level storage (global, world, user)
 * - Encryption at rest
 * - Dynamic plugin activation when secrets become available
 * - Natural language secret management
 * - Conversational onboarding flow (Discord, Telegram)
 */

import { promoteSubactionsToActions } from "../../actions/promote-subactions.ts";
import { logger } from "../../logger.ts";
import type { Plugin } from "../../types/index.ts";
import { secretsAction } from "./actions/manage-secret.ts";
import {
	missingSecretsProvider,
	OnboardingService,
	onboardingSettingsProvider,
	updateSettingsAction,
} from "./onboarding/index.ts";
import {
	secretsInfoProvider,
	secretsStatusProvider,
} from "./providers/index.ts";
import { PluginActivatorService } from "./services/plugin-activator.ts";
import { SecretsService } from "./services/secrets.ts";

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
 * Secrets capability
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
 * import { secretsManagerPlugin } from '@elizaos/core';
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
	name: "secrets",
	description:
		"Multi-level secret management with encryption, dynamic plugin activation, and conversational onboarding",

	// Services
	services: [SecretsService, PluginActivatorService, OnboardingService],

	// Actions for natural language secret management and onboarding.
	// `SECRETS` is the single umbrella action; `promoteSubactionsToActions`
	// surfaces each enum value of its `action` discriminator as a virtual
	// top-level action (e.g. `SECRETS_GET`, `SECRETS_LIST`) so the planner
	// can pick a specific operation directly while structured callers can
	// still target the umbrella with `action=...`. `SECRETS_UPDATE_SETTINGS`
	// stays separate — it's a settings mutation, not a secret operation.
	actions: [
		...promoteSubactionsToActions(secretsAction),
		updateSettingsAction,
	],

	// Providers for context injection
	providers: [
		secretsStatusProvider,
		secretsInfoProvider,
		onboardingSettingsProvider,
		missingSecretsProvider,
	],

	// Plugin initialization
	init: async (_config: SecretsManagerPluginConfig, _runtime) => {
		logger.info("[SecretsManagerPlugin] Initializing");

		// Configuration is passed to services via their start() methods
		// The runtime will call Service.start() for each service

		logger.info("[SecretsManagerPlugin] Initialized");
	},
};

// Default export
export default secretsManagerPlugin;

export * from "./crypto/index.ts";
export * from "./onboarding/index.ts";
export * from "./services/index.ts";
export * from "./storage/index.ts";
// Re-export types and utilities
export * from "./types.ts";
export {
	inferValidationStrategy,
	registerValidator,
	ValidationStrategies,
	validateSecret,
} from "./validation.ts";
