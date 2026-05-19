/**
 * Secret Key Constants and Aliases
 *
 * This module provides canonical secret key names, aliases for backward compatibility,
 * and mappings for model providers. All secret key naming should reference this module
 * to ensure consistency across the codebase.
 *
 * @module constants/secrets
 */

// ═══════════════════════════════════════════════════════════════════════════════
// CANONICAL SECRET KEYS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * List of all canonical secret key names.
 * These are the "official" key names that should be used throughout the codebase.
 */
export const CANONICAL_SECRET_KEYS = [
	// Model Provider API Keys
	"OPENAI_API_KEY",
	"ANTHROPIC_API_KEY",
	"GOOGLE_API_KEY",
	"GROQ_API_KEY",
	"XAI_API_KEY",
	"OPENROUTER_API_KEY",
	"MISTRAL_API_KEY",
	"COHERE_API_KEY",
	"TOGETHER_API_KEY",
	"FIREWORKS_API_KEY",
	"PERPLEXITY_API_KEY",
	"DEEPSEEK_API_KEY",
	"ZAI_API_KEY",
	"MOONSHOT_API_KEY",

	// Channel/Platform Tokens
	"DISCORD_BOT_TOKEN",
	"DISCORD_APPLICATION_ID",
	"TELEGRAM_BOT_TOKEN",
	"SLACK_BOT_TOKEN",
	"SLACK_APP_TOKEN",
	"WHATSAPP_TOKEN",
	"SIGNAL_CLI_PATH",

	// Twitter/X credentials
	"TWITTER_USERNAME",
	"TWITTER_PASSWORD",
	"TWITTER_EMAIL",
	"TWITTER_2FA_SECRET",

	// Media/Voice Services
	"ELEVENLABS_API_KEY",
	"ELEVENLABS_VOICE_ID",

	// Infrastructure
	"ENCRYPTION_SALT",
	"DATABASE_URL",

	// Ollama (local inference)
	"OLLAMA_BASE_URL",
] as const;

/**
 * Type for canonical secret keys
 */
export type CanonicalSecretKey = (typeof CANONICAL_SECRET_KEYS)[number];

// ═══════════════════════════════════════════════════════════════════════════════
// SECRET KEY ALIASES (BACKWARD COMPATIBILITY)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Maps legacy/alternative secret key names to their canonical names.
 * Key: legacy/alternative name. Value: canonical name.
 */
export const SECRET_KEY_ALIASES: Record<string, string> = {
	// Discord aliases
	DISCORD_TOKEN: "DISCORD_BOT_TOKEN",
	DISCORD_API_TOKEN: "DISCORD_BOT_TOKEN",

	// Telegram aliases
	TELEGRAM_TOKEN: "TELEGRAM_BOT_TOKEN",
	TELEGRAM_API_TOKEN: "TELEGRAM_BOT_TOKEN",
	TG_BOT_TOKEN: "TELEGRAM_BOT_TOKEN",

	// Slack aliases
	SLACK_TOKEN: "SLACK_BOT_TOKEN",
	SLACK_API_TOKEN: "SLACK_BOT_TOKEN",

	// OpenAI aliases
	OPENAI_KEY: "OPENAI_API_KEY",
	OPENAI_TOKEN: "OPENAI_API_KEY",

	// Anthropic aliases
	ANTHROPIC_KEY: "ANTHROPIC_API_KEY",
	ANTHROPIC_TOKEN: "ANTHROPIC_API_KEY",
	CLAUDE_API_KEY: "ANTHROPIC_API_KEY",

	// Google aliases
	GOOGLE_KEY: "GOOGLE_API_KEY",
	GOOGLE_AI_KEY: "GOOGLE_API_KEY",
	GEMINI_API_KEY: "GOOGLE_API_KEY",
	GOOGLE_GENERATIVE_AI_API_KEY: "GOOGLE_API_KEY",

	// Groq aliases
	GROQ_KEY: "GROQ_API_KEY",
	GROQ_TOKEN: "GROQ_API_KEY",

	// XAI aliases
	XAI_KEY: "XAI_API_KEY",
	GROK_API_KEY: "XAI_API_KEY",

	// OpenRouter aliases
	OPENROUTER_KEY: "OPENROUTER_API_KEY",
	OPENROUTER_TOKEN: "OPENROUTER_API_KEY",

	// z.ai aliases
	Z_AI_API_KEY: "ZAI_API_KEY",
	ZAI_KEY: "ZAI_API_KEY",

	// Moonshot/Kimi aliases
	KIMI_API_KEY: "MOONSHOT_API_KEY",
	MOONSHOT_KEY: "MOONSHOT_API_KEY",

	// Mistral aliases
	MISTRAL_KEY: "MISTRAL_API_KEY",
	MISTRAL_TOKEN: "MISTRAL_API_KEY",

	// Cohere aliases
	COHERE_KEY: "COHERE_API_KEY",
	COHERE_TOKEN: "COHERE_API_KEY",

	// Together aliases
	TOGETHER_KEY: "TOGETHER_API_KEY",
	TOGETHER_TOKEN: "TOGETHER_API_KEY",

	// ElevenLabs aliases
	ELEVENLABS_KEY: "ELEVENLABS_API_KEY",
	ELEVEN_LABS_API_KEY: "ELEVENLABS_API_KEY",

	// WhatsApp aliases
	WHATSAPP_BOT_TOKEN: "WHATSAPP_TOKEN",
	WHATSAPP_API_TOKEN: "WHATSAPP_TOKEN",
};

// ═══════════════════════════════════════════════════════════════════════════════
// MODEL PROVIDER SECRETS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Comprehensive mapping of model provider names to their API key environment variables.
 * Used for detecting which AI provider is configured and for auto-enabling provider plugins.
 */
export const MODEL_PROVIDER_SECRETS: Record<string, string> = {
	// Primary providers
	anthropic: "ANTHROPIC_API_KEY",
	openai: "OPENAI_API_KEY",
	google: "GOOGLE_API_KEY",
	groq: "GROQ_API_KEY",
	xai: "XAI_API_KEY",
	openrouter: "OPENROUTER_API_KEY",

	// Additional providers
	mistral: "MISTRAL_API_KEY",
	cohere: "COHERE_API_KEY",
	together: "TOGETHER_API_KEY",
	fireworks: "FIREWORKS_API_KEY",
	perplexity: "PERPLEXITY_API_KEY",
	deepseek: "DEEPSEEK_API_KEY",
	zai: "ZAI_API_KEY",
	moonshot: "MOONSHOT_API_KEY",

	// Local inference (checks for URL instead of API key)
	ollama: "OLLAMA_BASE_URL",
};

/**
 * Model providers that don't require API keys (local inference).
 * These are validated differently (check for URL availability).
 */
export const LOCAL_MODEL_PROVIDERS = ["ollama"] as const;

// ═══════════════════════════════════════════════════════════════════════════════
// CHANNEL SECRETS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Required secrets for each communication channel.
 * Used to determine if a channel can be enabled.
 */
export const CHANNEL_SECRETS: Record<string, string[]> = {
	discord: ["DISCORD_BOT_TOKEN"],
	telegram: ["TELEGRAM_BOT_TOKEN"],
	slack: ["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN"],
	whatsapp: ["WHATSAPP_TOKEN"],
	signal: ["SIGNAL_CLI_PATH"],
	twitter: ["TWITTER_USERNAME", "TWITTER_PASSWORD"],
};

/**
 * Optional secrets for channels (enhance functionality but not required).
 */
export const CHANNEL_OPTIONAL_SECRETS: Record<string, string[]> = {
	discord: ["DISCORD_APPLICATION_ID"],
	twitter: ["TWITTER_EMAIL", "TWITTER_2FA_SECRET"],
};

// ═══════════════════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Resolve a secret key alias to its canonical name.
 * If the key is not an alias, returns the original key.
 */
export function resolveSecretKeyAlias(key: string): string {
	return SECRET_KEY_ALIASES[key] ?? key;
}

/** Check whether a key is a known alias. */
export function isSecretKeyAlias(key: string): boolean {
	return key in SECRET_KEY_ALIASES;
}

/** Get all aliases that map to a canonical key. */
export function getAliasesForKey(canonicalKey: string): string[] {
	return Object.entries(SECRET_KEY_ALIASES)
		.filter(([_, canonical]) => canonical === canonicalKey)
		.map(([alias]) => alias);
}

/**
 * Check if a key is a canonical secret key.
 *
 * @param key - The key to check
 * @returns true if the key is in the canonical keys list
 */
export function isCanonicalSecretKey(key: string): key is CanonicalSecretKey {
	return (CANONICAL_SECRET_KEYS as readonly string[]).includes(key);
}

/**
 * Get the model provider name for a given API key.
 *
 * @param apiKey - The API key environment variable name
 * @returns The provider name, or null if not found
 */
export function getProviderForApiKey(apiKey: string): string | null {
	for (const [provider, key] of Object.entries(MODEL_PROVIDER_SECRETS)) {
		if (key === apiKey) {
			return provider;
		}
	}
	return null;
}

/**
 * Get required secrets for a channel.
 *
 * @param channel - The channel name
 * @returns Array of required secret key names
 */
export function getRequiredSecretsForChannel(channel: string): string[] {
	return CHANNEL_SECRETS[channel] ?? [];
}

/**
 * Get all secrets (required + optional) for a channel.
 *
 * @param channel - The channel name
 * @returns Object with required and optional secret arrays
 */
export function getAllSecretsForChannel(channel: string): {
	required: string[];
	optional: string[];
} {
	return {
		required: CHANNEL_SECRETS[channel] ?? [],
		optional: CHANNEL_OPTIONAL_SECRETS[channel] ?? [],
	};
}
