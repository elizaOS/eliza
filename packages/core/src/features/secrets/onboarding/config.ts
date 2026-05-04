/**
 * Onboarding configuration types and utilities.
 *
 * Provides the structure for defining secret requirements per agent/plugin,
 * supporting both conversational and form-based collection flows.
 */

import type { SecretType } from "../types.ts";

/**
 * Setting definition for onboarding.
 * Compatible with the-org OnboardingConfig format.
 */
export interface OnboardingSetting {
	/** Display name */
	name: string;
	/** Description for LLM context */
	description: string;
	/** Prompt shown when asking user for this setting */
	usageDescription?: string;
	/** Whether this is a secret (should be encrypted) */
	secret: boolean;
	/** Whether this should be visible in non-onboarding contexts */
	public: boolean;
	/** Whether this setting is required */
	required: boolean;
	/** Settings that must be configured first */
	dependsOn: string[];
	/** Validation function */
	validation?: (value: string) => boolean;
	/** Validation method name (openai, anthropic, url, etc.) */
	validationMethod?: string;
	/** Secret type */
	type?: SecretType;
	/** Environment variable to sync to */
	envVar?: string;
	/** Default value if not set */
	defaultValue?: string;
	/** Current value (set during onboarding) */
	value?: string | null;
	/** Conditional visibility based on other settings */
	visibleIf?: (settings: Record<string, OnboardingSetting>) => boolean;
	/** Callback when value is set */
	onSetAction?: (value: string | boolean) => string | undefined;
}

/**
 * Onboarding configuration for an agent or plugin.
 */
export interface OnboardingConfig {
	/** Setting definitions */
	settings: Record<string, OnboardingSetting>;
	/** Optional platform-specific messages */
	messages?: {
		welcome?: string[];
		askSetting?: string;
		settingUpdated?: string;
		allComplete?: string;
		error?: string;
	};
	/** Onboarding flow mode */
	mode?: "conversational" | "form" | "hybrid";
}

/**
 * Default onboarding messages.
 */
export const DEFAULT_ONBOARDING_MESSAGES = {
	welcome: [
		"Hi! I need to collect some information to get set up. Is now a good time?",
		"Hey there! I need to configure a few things. Do you have a moment?",
		"Hello! Could we take a few minutes to get everything set up?",
	],
	askSetting: "I need your {{settingName}}. {{usageDescription}}",
	settingUpdated: "Got it! I've saved your {{settingName}}.",
	allComplete:
		"Great! All required settings have been configured. You're all set!",
	error: "I had trouble understanding that. Could you try again?",
};

/**
 * Common API key settings for quick setup.
 */
export const COMMON_API_KEY_SETTINGS: Record<
	string,
	Partial<OnboardingSetting>
> = {
	OPENAI_API_KEY: {
		name: "OpenAI API Key",
		description: "API key for OpenAI services (GPT models)",
		usageDescription: 'Your OpenAI API key starts with "sk-"',
		secret: true,
		public: false,
		required: false,
		dependsOn: [],
		validationMethod: "openai",
		type: "api_key",
		envVar: "OPENAI_API_KEY",
	},
	ANTHROPIC_API_KEY: {
		name: "Anthropic API Key",
		description: "API key for Anthropic services (Claude models)",
		usageDescription: 'Your Anthropic API key starts with "sk-ant-"',
		secret: true,
		public: false,
		required: false,
		dependsOn: [],
		validationMethod: "anthropic",
		type: "api_key",
		envVar: "ANTHROPIC_API_KEY",
	},
	GROQ_API_KEY: {
		name: "Groq API Key",
		description: "API key for Groq inference services",
		usageDescription: 'Your Groq API key starts with "gsk_"',
		secret: true,
		public: false,
		required: false,
		dependsOn: [],
		validationMethod: "groq",
		type: "api_key",
		envVar: "GROQ_API_KEY",
	},
	GOOGLE_API_KEY: {
		name: "Google API Key",
		description: "API key for Google AI services (Gemini)",
		usageDescription: "Your Google API key for Gemini models",
		secret: true,
		public: false,
		required: false,
		dependsOn: [],
		validationMethod: "google",
		type: "api_key",
		envVar: "GOOGLE_API_KEY",
	},
	DISCORD_BOT_TOKEN: {
		name: "Discord Bot Token",
		description: "Bot token for Discord integration",
		usageDescription: "Your Discord bot token from the developer portal",
		secret: true,
		public: false,
		required: false,
		dependsOn: [],
		validationMethod: "discord",
		type: "token",
		envVar: "DISCORD_BOT_TOKEN",
	},
	TELEGRAM_BOT_TOKEN: {
		name: "Telegram Bot Token",
		description: "Bot token for Telegram integration",
		usageDescription: "Your Telegram bot token from @BotFather",
		secret: true,
		public: false,
		required: false,
		dependsOn: [],
		validationMethod: "telegram",
		type: "token",
		envVar: "TELEGRAM_BOT_TOKEN",
	},
	TWITTER_USERNAME: {
		name: "Twitter Username",
		description: "Twitter/X username for posting",
		usageDescription: "The Twitter username (without @)",
		secret: false,
		public: true,
		required: false,
		dependsOn: [],
		type: "credential",
	},
	TWITTER_PASSWORD: {
		name: "Twitter Password",
		description: "Twitter/X account password",
		usageDescription: "The password for your Twitter account",
		secret: true,
		public: false,
		required: false,
		dependsOn: ["TWITTER_USERNAME"],
		type: "credential",
	},
	TWITTER_EMAIL: {
		name: "Twitter Email",
		description: "Email associated with Twitter account",
		usageDescription: "The email address linked to your Twitter account",
		secret: false,
		public: false,
		required: false,
		dependsOn: ["TWITTER_USERNAME"],
		type: "credential",
		validation: (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value),
	},
	TWITTER_2FA_SECRET: {
		name: "Twitter 2FA Secret",
		description: "2FA secret for Twitter account",
		usageDescription: "The 2FA/TOTP secret (if 2FA is enabled)",
		secret: true,
		public: false,
		required: false,
		dependsOn: ["TWITTER_USERNAME", "TWITTER_PASSWORD"],
		type: "credential",
	},
};

/**
 * Create an onboarding config from a list of required secret keys.
 */
export function createOnboardingConfig(
	requiredKeys: string[],
	optionalKeys: string[] = [],
	customSettings: Record<string, Partial<OnboardingSetting>> = {},
): OnboardingConfig {
	const settings: Record<string, OnboardingSetting> = {};

	for (const key of requiredKeys) {
		const common = COMMON_API_KEY_SETTINGS[key] || {};
		const custom = customSettings[key] || {};
		settings[key] = {
			name: custom.name || common.name || key,
			description:
				custom.description || common.description || `Configure ${key}`,
			usageDescription: custom.usageDescription || common.usageDescription,
			secret: custom.secret ?? common.secret ?? true,
			public: custom.public ?? common.public ?? false,
			required: true,
			dependsOn: custom.dependsOn || common.dependsOn || [],
			validationMethod: custom.validationMethod || common.validationMethod,
			type: custom.type || common.type || "api_key",
			envVar: custom.envVar || common.envVar || key,
			value: null,
			...custom,
		};
	}

	for (const key of optionalKeys) {
		const common = COMMON_API_KEY_SETTINGS[key] || {};
		const custom = customSettings[key] || {};
		settings[key] = {
			name: custom.name || common.name || key,
			description:
				custom.description || common.description || `Configure ${key}`,
			usageDescription: custom.usageDescription || common.usageDescription,
			secret: custom.secret ?? common.secret ?? true,
			public: custom.public ?? common.public ?? false,
			required: false,
			dependsOn: custom.dependsOn || common.dependsOn || [],
			validationMethod: custom.validationMethod || common.validationMethod,
			type: custom.type || common.type || "api_key",
			envVar: custom.envVar || common.envVar || key,
			value: null,
			...custom,
		};
	}

	return { settings };
}

/**
 * Get unconfigured required settings from an onboarding config.
 */
export function getUnconfiguredRequired(
	config: OnboardingConfig,
): Array<[string, OnboardingSetting]> {
	return Object.entries(config.settings).filter(
		([_, setting]) => setting.required && setting.value === null,
	);
}

/**
 * Get unconfigured optional settings from an onboarding config.
 */
export function getUnconfiguredOptional(
	config: OnboardingConfig,
): Array<[string, OnboardingSetting]> {
	return Object.entries(config.settings).filter(
		([_, setting]) => !setting.required && setting.value === null,
	);
}

/**
 * Check if all required settings are configured.
 */
export function isOnboardingComplete(config: OnboardingConfig): boolean {
	return getUnconfiguredRequired(config).length === 0;
}

/**
 * Get the next setting to configure (respects dependencies).
 */
export function getNextSetting(
	config: OnboardingConfig,
): [string, OnboardingSetting] | null {
	const unconfigured = getUnconfiguredRequired(config);

	for (const [key, setting] of unconfigured) {
		// Check if dependencies are met
		const dependenciesMet = setting.dependsOn.every((dep) => {
			const depSetting = config.settings[dep];
			return depSetting && depSetting.value !== null;
		});

		// Check visibility condition
		const isVisible = !setting.visibleIf?.(config.settings);

		if (dependenciesMet && isVisible) {
			return [key, setting];
		}
	}

	// If no required settings, try optional
	const optionalUnconfigured = getUnconfiguredOptional(config);
	for (const [key, setting] of optionalUnconfigured) {
		const dependenciesMet = setting.dependsOn.every((dep) => {
			const depSetting = config.settings[dep];
			return depSetting && depSetting.value !== null;
		});
		const isVisible = !setting.visibleIf?.(config.settings);

		if (dependenciesMet && isVisible) {
			return [key, setting];
		}
	}

	return null;
}

/**
 * Generate a prompt for the LLM to ask for a specific setting.
 */
export function generateSettingPrompt(
	_key: string,
	setting: OnboardingSetting,
	agentName: string,
): string {
	const required = setting.required ? "(Required)" : "(Optional)";
	const usage = setting.usageDescription || setting.description;

	return (
		`${agentName} needs to collect the ${setting.name} ${required}.\n` +
		`Description: ${usage}\n` +
		`Ask the user for their ${setting.name} in a natural, conversational way.`
	);
}
