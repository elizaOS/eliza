/**
 * Secret Validation Module
 *
 * Consolidated validation patterns for secrets across the entire codebase.
 * All secret validation should use these patterns to ensure consistency.
 *
 * @module validation/secrets
 */

// ═══════════════════════════════════════════════════════════════════════════════
// VALIDATION PATTERNS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Validation pattern definition
 */
export interface SecretValidationPattern {
	/** Regular expression to validate the secret format */
	pattern: RegExp;
	/** Human-readable description of the expected format */
	description: string;
	/** Minimum length requirement */
	minLength?: number;
	/** Maximum length requirement */
	maxLength?: number;
	/** Example of a valid format (redacted/fake) */
	example?: string;
}

/**
 * Consolidated validation patterns for all secret types.
 * These patterns validate the format of secrets without making API calls.
 */
export const SECRET_VALIDATION_PATTERNS: Record<
	string,
	SecretValidationPattern
> = {
	// ─────────────────────────────────────────────────────────────────────────────
	// Model Provider API Keys
	// ─────────────────────────────────────────────────────────────────────────────

	OPENAI_API_KEY: {
		pattern: /^sk-[a-zA-Z0-9-_]{20,}$/,
		description: 'OpenAI API key must start with "sk-"',
		minLength: 20,
		example: "sk-proj-xxxxxxxxxxxxxxxxxxxx",
	},

	ANTHROPIC_API_KEY: {
		pattern: /^sk-ant-[a-zA-Z0-9-_]{20,}$/,
		description: 'Anthropic API key must start with "sk-ant-"',
		minLength: 30,
		example: "sk-ant-api03-xxxxxxxxxxxxxxxxxxxx",
	},

	GOOGLE_API_KEY: {
		pattern: /^AIza[a-zA-Z0-9-_]{30,}$/,
		description: 'Google API key must start with "AIza"',
		minLength: 30,
		example: "AIzaSyxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
	},

	GROQ_API_KEY: {
		pattern: /^gsk_[a-zA-Z0-9]{20,}$/,
		description: 'Groq API key must start with "gsk_"',
		minLength: 20,
		example: "gsk_xxxxxxxxxxxxxxxxxxxx",
	},

	XAI_API_KEY: {
		pattern: /^xai-[a-zA-Z0-9-_]{20,}$/,
		description: 'XAI API key must start with "xai-"',
		minLength: 20,
		example: "xai-xxxxxxxxxxxxxxxxxxxx",
	},

	OPENROUTER_API_KEY: {
		pattern: /^sk-or-[a-zA-Z0-9-_]{20,}$/,
		description: 'OpenRouter API key must start with "sk-or-"',
		minLength: 20,
		example: "sk-or-v1-xxxxxxxxxxxxxxxxxxxx",
	},

	MISTRAL_API_KEY: {
		pattern: /^[a-zA-Z0-9]{20,}$/,
		description: "Mistral API key must be at least 20 characters",
		minLength: 20,
		example: "xxxxxxxxxxxxxxxxxxxx",
	},

	COHERE_API_KEY: {
		pattern: /^[a-zA-Z0-9]{20,}$/,
		description: "Cohere API key must be at least 20 characters",
		minLength: 20,
		example: "xxxxxxxxxxxxxxxxxxxx",
	},

	TOGETHER_API_KEY: {
		pattern: /^[a-zA-Z0-9]{20,}$/,
		description: "Together API key must be at least 20 characters",
		minLength: 20,
		example: "xxxxxxxxxxxxxxxxxxxx",
	},

	FIREWORKS_API_KEY: {
		pattern: /^fw_[a-zA-Z0-9]{20,}$/,
		description: 'Fireworks API key must start with "fw_"',
		minLength: 20,
		example: "fw_xxxxxxxxxxxxxxxxxxxx",
	},

	PERPLEXITY_API_KEY: {
		pattern: /^pplx-[a-zA-Z0-9]{20,}$/,
		description: 'Perplexity API key must start with "pplx-"',
		minLength: 20,
		example: "pplx-xxxxxxxxxxxxxxxxxxxx",
	},

	DEEPSEEK_API_KEY: {
		pattern: /^sk-[a-zA-Z0-9]{20,}$/,
		description: 'DeepSeek API key must start with "sk-"',
		minLength: 20,
		example: "sk-xxxxxxxxxxxxxxxxxxxx",
	},

	ZAI_API_KEY: {
		pattern: /^[a-zA-Z0-9._-]{20,}$/,
		description: "z.ai API key must be at least 20 characters",
		minLength: 20,
		example: "xxxxxxxxxxxxxxxxxxxx",
	},

	MOONSHOT_API_KEY: {
		pattern: /^sk-[a-zA-Z0-9._-]{20,}$/,
		description: 'Moonshot API key must start with "sk-"',
		minLength: 20,
		example: "sk-xxxxxxxxxxxxxxxxxxxx",
	},

	// ─────────────────────────────────────────────────────────────────────────────
	// Channel/Platform Tokens
	// ─────────────────────────────────────────────────────────────────────────────

	DISCORD_BOT_TOKEN: {
		pattern: /^[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}$/,
		description: "Discord bot token must be in the format: ID.TIMESTAMP.HMAC",
		minLength: 59,
		example: "MTIzNDU2Nzg5MDEyMzQ1Njc4.GxxxxX.xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
	},

	DISCORD_APPLICATION_ID: {
		pattern: /^\d{17,20}$/,
		description: "Discord application ID must be a 17-20 digit number",
		minLength: 17,
		maxLength: 20,
		example: "123456789012345678",
	},

	TELEGRAM_BOT_TOKEN: {
		pattern: /^\d{8,10}:[A-Za-z0-9_-]{35}$/,
		description: "Telegram bot token must be in the format: BOT_ID:TOKEN",
		minLength: 44,
		example: "123456789:ABCdefGHIjklMNOpqrSTUvwxYZ12345678901",
	},

	SLACK_BOT_TOKEN: {
		pattern: /^xoxb-[0-9]+-[0-9]+-[a-zA-Z0-9]+$/,
		description: 'Slack bot token must start with "xoxb-"',
		minLength: 50,
		example: "xoxb-123456789012-1234567890123-xxxxxxxxxxxxxxxxxxxxxxxx",
	},

	SLACK_APP_TOKEN: {
		pattern: /^xapp-[0-9]+-[a-zA-Z0-9]+-[0-9]+-[a-zA-Z0-9]+$/,
		description: 'Slack app token must start with "xapp-"',
		minLength: 50,
		example: "xapp-1-A0123456789-1234567890123-xxxxxxxxxxxxxxxx",
	},

	WHATSAPP_TOKEN: {
		pattern: /^[a-zA-Z0-9]{50,}$/,
		description: "WhatsApp token must be at least 50 characters",
		minLength: 50,
		example: "EAAxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
	},

	// ─────────────────────────────────────────────────────────────────────────────
	// Twitter/X Credentials
	// ─────────────────────────────────────────────────────────────────────────────

	TWITTER_USERNAME: {
		pattern: /^[a-zA-Z0-9_]{1,15}$/,
		description:
			"Twitter username must be 1-15 alphanumeric characters or underscores",
		minLength: 1,
		maxLength: 15,
		example: "myusername",
	},

	TWITTER_PASSWORD: {
		pattern: /^.{8,}$/,
		description: "Twitter password must be at least 8 characters",
		minLength: 8,
		example: "********",
	},

	TWITTER_EMAIL: {
		pattern: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
		description: "Must be a valid email address",
		example: "user@example.com",
	},

	TWITTER_2FA_SECRET: {
		pattern: /^[A-Z2-7]{16,32}$/,
		description: "Twitter 2FA secret must be a base32 encoded string",
		minLength: 16,
		maxLength: 32,
		example: "JBSWY3DPEHPK3PXP",
	},

	// ─────────────────────────────────────────────────────────────────────────────
	// Media/Voice Services
	// ─────────────────────────────────────────────────────────────────────────────

	ELEVENLABS_API_KEY: {
		pattern: /^[a-f0-9]{32}$/,
		description: "ElevenLabs API key must be a 32-character hex string",
		minLength: 32,
		maxLength: 32,
		example: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4",
	},

	ELEVENLABS_VOICE_ID: {
		pattern: /^[a-zA-Z0-9]{20,}$/,
		description: "ElevenLabs voice ID must be at least 20 characters",
		minLength: 20,
		example: "21m00Tcm4TlvDq8ikWAM",
	},

	// ─────────────────────────────────────────────────────────────────────────────
	// Infrastructure
	// ─────────────────────────────────────────────────────────────────────────────

	ENCRYPTION_SALT: {
		pattern: /^[a-f0-9]{32,64}$/,
		description: "Encryption salt must be a 32-64 character hex string",
		minLength: 32,
		maxLength: 64,
		example: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4",
	},

	DATABASE_URL: {
		pattern: /^(postgres|postgresql|mysql|sqlite|mongodb):\/\/.+$/,
		description: "Database URL must be a valid connection string",
		example: "postgresql://user:pass@localhost:5432/db",
	},

	OLLAMA_BASE_URL: {
		pattern: /^https?:\/\/.+$/,
		description: "Ollama base URL must be a valid HTTP(S) URL",
		example: "http://localhost:11434",
	},

	SIGNAL_CLI_PATH: {
		pattern: /^[/~].+$/,
		description: "Signal CLI path must be an absolute path or start with ~",
		example: "/usr/local/bin/signal-cli",
	},
};

// ═══════════════════════════════════════════════════════════════════════════════
// VALIDATION RESULT TYPE
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Result of a secret validation
 */
export interface SecretValidationResult {
	/** Whether the secret is valid */
	isValid: boolean;
	/** Error message if invalid */
	error?: string;
	/** Warning message (valid but with caveats) */
	warning?: string;
	/** Additional details */
	details?: string;
	/** Timestamp of validation */
	validatedAt: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// VALIDATION FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Validate a secret key/value pair.
 *
 * @param key - The secret key name
 * @param value - The secret value to validate
 * @returns Validation result
 */
export function validateSecretKey(
	key: string,
	value: string,
): SecretValidationResult {
	const validatedAt = Date.now();

	// Check if we have a pattern for this key
	const pattern = SECRET_VALIDATION_PATTERNS[key];

	if (!pattern) {
		// No specific pattern - do basic validation
		return validateBasicSecret(value, validatedAt);
	}

	// Check minimum length
	if (pattern.minLength && value.length < pattern.minLength) {
		return {
			isValid: false,
			error: `${key} is too short (minimum ${pattern.minLength} characters)`,
			validatedAt,
		};
	}

	// Check maximum length
	if (pattern.maxLength && value.length > pattern.maxLength) {
		return {
			isValid: false,
			error: `${key} is too long (maximum ${pattern.maxLength} characters)`,
			validatedAt,
		};
	}

	// Check pattern
	if (!pattern.pattern.test(value)) {
		return {
			isValid: false,
			error: pattern.description,
			validatedAt,
		};
	}

	return {
		isValid: true,
		validatedAt,
	};
}

/**
 * Basic validation for secrets without specific patterns.
 *
 * @param value - The value to validate
 * @param validatedAt - Timestamp
 * @returns Validation result
 */
function validateBasicSecret(
	value: string,
	validatedAt: number,
): SecretValidationResult {
	// Check for empty/whitespace only
	if (!value || value.trim().length === 0) {
		return {
			isValid: false,
			error: "Secret value cannot be empty",
			validatedAt,
		};
	}

	// Check for placeholder values
	const placeholders = [
		"your_api_key_here",
		"your-api-key",
		"xxx",
		"TODO",
		"REPLACE_ME",
		"placeholder",
		"<your_key>",
		"[your_key]",
	];

	const lowerValue = value.toLowerCase();
	for (const placeholder of placeholders) {
		if (
			lowerValue === placeholder.toLowerCase() ||
			lowerValue.includes(placeholder.toLowerCase())
		) {
			return {
				isValid: false,
				error: "Secret appears to be a placeholder value",
				validatedAt,
			};
		}
	}

	// Warn if too short for typical API keys
	if (value.length < 10) {
		return {
			isValid: true,
			warning: "Secret value seems unusually short",
			validatedAt,
		};
	}

	return {
		isValid: true,
		validatedAt,
	};
}

/**
 * Validate multiple secrets at once.
 *
 * @param secrets - Record of key-value pairs to validate
 * @returns Record of validation results
 */
export function validateSecrets(
	secrets: Record<string, string>,
): Record<string, SecretValidationResult> {
	const results: Record<string, SecretValidationResult> = {};

	for (const [key, value] of Object.entries(secrets)) {
		results[key] = validateSecretKey(key, value);
	}

	return results;
}

/**
 * Check if all required secrets are present and valid.
 *
 * @param secrets - Record of secrets to check
 * @param requiredKeys - Array of required key names
 * @returns Object with missing and invalid keys
 */
export function checkRequiredSecrets(
	secrets: Record<string, string>,
	requiredKeys: string[],
): {
	valid: boolean;
	missing: string[];
	invalid: string[];
	results: Record<string, SecretValidationResult>;
} {
	const missing: string[] = [];
	const invalid: string[] = [];
	const results: Record<string, SecretValidationResult> = {};

	for (const key of requiredKeys) {
		const value = secrets[key];

		if (!value) {
			missing.push(key);
			continue;
		}

		const result = validateSecretKey(key, value);
		results[key] = result;

		if (!result.isValid) {
			invalid.push(key);
		}
	}

	return {
		valid: missing.length === 0 && invalid.length === 0,
		missing,
		invalid,
		results,
	};
}

/**
 * Get the validation pattern for a secret key.
 *
 * @param key - The secret key name
 * @returns The validation pattern, or undefined if none exists
 */
export function getValidationPattern(
	key: string,
): SecretValidationPattern | undefined {
	return SECRET_VALIDATION_PATTERNS[key];
}

/**
 * Check if a key has a specific validation pattern.
 *
 * @param key - The secret key name
 * @returns true if a pattern exists for this key
 */
export function hasValidationPattern(key: string): boolean {
	return key in SECRET_VALIDATION_PATTERNS;
}

/**
 * Infer the validation pattern key from a secret key name.
 * Useful for keys that might have slight variations.
 *
 * @param key - The secret key name
 * @returns The inferred pattern key, or the original key
 */
export function inferValidationPatternKey(key: string): string {
	const upperKey = key.toUpperCase();

	// Try exact match first
	if (upperKey in SECRET_VALIDATION_PATTERNS) {
		return upperKey;
	}

	// Try common variations
	if (upperKey.includes("OPENAI") && upperKey.includes("KEY")) {
		return "OPENAI_API_KEY";
	}

	if (upperKey.includes("ANTHROPIC") && upperKey.includes("KEY")) {
		return "ANTHROPIC_API_KEY";
	}

	if (upperKey.includes("GOOGLE") && upperKey.includes("KEY")) {
		return "GOOGLE_API_KEY";
	}

	if (upperKey.includes("GROQ") && upperKey.includes("KEY")) {
		return "GROQ_API_KEY";
	}

	if (
		upperKey.includes("DISCORD") &&
		(upperKey.includes("TOKEN") || upperKey.includes("BOT"))
	) {
		return "DISCORD_BOT_TOKEN";
	}

	if (
		upperKey.includes("TELEGRAM") &&
		(upperKey.includes("TOKEN") || upperKey.includes("BOT"))
	) {
		return "TELEGRAM_BOT_TOKEN";
	}

	if (upperKey.includes("SLACK") && upperKey.includes("BOT")) {
		return "SLACK_BOT_TOKEN";
	}

	if (upperKey.includes("SLACK") && upperKey.includes("APP")) {
		return "SLACK_APP_TOKEN";
	}

	return key;
}
