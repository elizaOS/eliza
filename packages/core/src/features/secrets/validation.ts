/**
 * Secret Validation Module
 *
 * Provides validation strategies for different types of secrets
 * including API keys, URLs, and custom validation.
 */

import { logger } from "../../logger.ts";
import type {
	CustomValidator,
	ValidationResult,
	ValidationStrategy,
} from "./types.ts";

/**
 * Validation strategy implementations
 */
export const ValidationStrategies: Record<string, CustomValidator> = {
	/**
	 * No validation - always passes
	 */
	none: async (_key: string, _value: string): Promise<ValidationResult> => ({
		isValid: true,
		validatedAt: Date.now(),
	}),

	/**
	 * OpenAI API key validation
	 * Format: sk-... or sk-proj-...
	 */
	"api_key:openai": async (
		_key: string,
		value: string,
	): Promise<ValidationResult> => {
		const validatedAt = Date.now();

		if (!value.startsWith("sk-")) {
			return {
				isValid: false,
				error: 'OpenAI API key must start with "sk-"',
				validatedAt,
			};
		}

		if (value.length < 20) {
			return {
				isValid: false,
				error: "OpenAI API key is too short",
				validatedAt,
			};
		}

		// Optionally verify by making a test request
		const shouldVerify = process.env.VALIDATE_API_KEYS === "true";
		if (shouldVerify) {
			const verified = await verifyOpenAIKey(value);
			if (!verified.isValid) {
				return { ...verified, validatedAt };
			}
		}

		return { isValid: true, validatedAt };
	},

	/**
	 * Anthropic API key validation
	 * Format: sk-ant-...
	 */
	"api_key:anthropic": async (
		_key: string,
		value: string,
	): Promise<ValidationResult> => {
		const validatedAt = Date.now();

		if (!value.startsWith("sk-ant-")) {
			return {
				isValid: false,
				error: 'Anthropic API key must start with "sk-ant-"',
				validatedAt,
			};
		}

		if (value.length < 30) {
			return {
				isValid: false,
				error: "Anthropic API key is too short",
				validatedAt,
			};
		}

		// Optionally verify by making a test request
		const shouldVerify = process.env.VALIDATE_API_KEYS === "true";
		if (shouldVerify) {
			const verified = await verifyAnthropicKey(value);
			if (!verified.isValid) {
				return { ...verified, validatedAt };
			}
		}

		return { isValid: true, validatedAt };
	},

	/**
	 * Groq API key validation
	 * Format: gsk_...
	 */
	"api_key:groq": async (
		_key: string,
		value: string,
	): Promise<ValidationResult> => {
		const validatedAt = Date.now();

		if (!value.startsWith("gsk_")) {
			return {
				isValid: false,
				error: 'Groq API key must start with "gsk_"',
				validatedAt,
			};
		}

		if (value.length < 20) {
			return {
				isValid: false,
				error: "Groq API key is too short",
				validatedAt,
			};
		}

		return { isValid: true, validatedAt };
	},

	/**
	 * Google API key validation
	 * Format: AIza...
	 */
	"api_key:google": async (
		_key: string,
		value: string,
	): Promise<ValidationResult> => {
		const validatedAt = Date.now();

		if (!value.startsWith("AIza")) {
			return {
				isValid: false,
				error: 'Google API key must start with "AIza"',
				validatedAt,
			};
		}

		if (value.length < 30) {
			return {
				isValid: false,
				error: "Google API key is too short",
				validatedAt,
			};
		}

		return { isValid: true, validatedAt };
	},

	/**
	 * Mistral API key validation
	 */
	"api_key:mistral": async (
		_key: string,
		value: string,
	): Promise<ValidationResult> => {
		const validatedAt = Date.now();

		if (value.length < 20) {
			return {
				isValid: false,
				error: "Mistral API key is too short",
				validatedAt,
			};
		}

		return { isValid: true, validatedAt };
	},

	/**
	 * Cohere API key validation
	 */
	"api_key:cohere": async (
		_key: string,
		value: string,
	): Promise<ValidationResult> => {
		const validatedAt = Date.now();

		if (value.length < 20) {
			return {
				isValid: false,
				error: "Cohere API key is too short",
				validatedAt,
			};
		}

		return { isValid: true, validatedAt };
	},

	/**
	 * URL format validation
	 */
	"url:valid": async (
		_key: string,
		value: string,
	): Promise<ValidationResult> => {
		const validatedAt = Date.now();

		try {
			new URL(value);
			return { isValid: true, validatedAt };
		} catch {
			return {
				isValid: false,
				error: "Invalid URL format",
				validatedAt,
			};
		}
	},

	/**
	 * URL reachability validation
	 */
	"url:reachable": async (
		_key: string,
		value: string,
	): Promise<ValidationResult> => {
		const validatedAt = Date.now();

		try {
			new URL(value);
		} catch {
			return {
				isValid: false,
				error: "Invalid URL format",
				validatedAt,
			};
		}

		try {
			const response = await fetch(value, {
				method: "HEAD",
				signal: AbortSignal.timeout(5000),
			});

			if (!response.ok) {
				return {
					isValid: false,
					error: `URL returned status ${response.status}`,
					validatedAt,
				};
			}

			return { isValid: true, validatedAt };
		} catch (error) {
			return {
				isValid: false,
				error: `URL is not reachable: ${error instanceof Error ? error.message : "Unknown error"}`,
				validatedAt,
			};
		}
	},

	/**
	 * Custom validation placeholder
	 */
	custom: async (_key: string, _value: string): Promise<ValidationResult> => {
		// Custom validation should be registered separately
		return {
			isValid: true,
			details: "Custom validation not implemented",
			validatedAt: Date.now(),
		};
	},
};

/**
 * Registry for custom validators
 */
const customValidators: Map<string, CustomValidator> = new Map();

/**
 * Register a custom validator
 */
export function registerValidator(
	name: string,
	validator: CustomValidator,
): void {
	customValidators.set(name, validator);
	logger.debug(`[Validation] Registered custom validator: ${name}`);
}

/**
 * Unregister a custom validator
 */
export function unregisterValidator(name: string): boolean {
	return customValidators.delete(name);
}

/**
 * Get a validator by strategy name
 */
export function getValidator(strategy: string): CustomValidator | undefined {
	// Check built-in strategies first
	if (strategy in ValidationStrategies) {
		return ValidationStrategies[strategy];
	}

	// Check custom validators
	return customValidators.get(strategy);
}

/**
 * Validate a secret value
 */
export async function validateSecret(
	key: string,
	value: string,
	strategy?: string,
): Promise<ValidationResult> {
	const strategyName = strategy ?? "none";
	const validator = getValidator(strategyName);

	if (!validator) {
		logger.warn(`[Validation] Unknown validation strategy: ${strategyName}`);
		return {
			isValid: true,
			details: `Unknown validation strategy: ${strategyName}`,
			validatedAt: Date.now(),
		};
	}

	try {
		return await validator(key, value);
	} catch (error) {
		const errorMessage =
			error instanceof Error ? error.message : "Validation error";
		logger.error(`[Validation] Error validating ${key}: ${errorMessage}`);
		return {
			isValid: false,
			error: errorMessage,
			validatedAt: Date.now(),
		};
	}
}

/**
 * Infer validation strategy from secret key name
 */
export function inferValidationStrategy(key: string): ValidationStrategy {
	const upperKey = key.toUpperCase();

	if (upperKey.includes("OPENAI") && upperKey.includes("KEY")) {
		return "api_key:openai";
	}

	if (upperKey.includes("ANTHROPIC") && upperKey.includes("KEY")) {
		return "api_key:anthropic";
	}

	if (upperKey.includes("GROQ") && upperKey.includes("KEY")) {
		return "api_key:groq";
	}

	if (upperKey.includes("GOOGLE") && upperKey.includes("KEY")) {
		return "api_key:google";
	}

	if (upperKey.includes("MISTRAL") && upperKey.includes("KEY")) {
		return "api_key:mistral";
	}

	if (upperKey.includes("COHERE") && upperKey.includes("KEY")) {
		return "api_key:cohere";
	}

	if (upperKey.includes("URL") || upperKey.includes("ENDPOINT")) {
		return "url:valid";
	}

	return "none";
}

// ============================================================================
// API Key Verification Helpers
// ============================================================================

/**
 * Verify OpenAI API key by making a test request
 */
async function verifyOpenAIKey(
	apiKey: string,
): Promise<{ isValid: boolean; error?: string }> {
	try {
		const response = await fetch("https://api.openai.com/v1/models", {
			method: "GET",
			headers: {
				Authorization: `Bearer ${apiKey}`,
			},
			signal: AbortSignal.timeout(10000),
		});

		if (response.status === 401) {
			return { isValid: false, error: "Invalid API key" };
		}

		if (response.status === 429) {
			// Rate limited but key is valid
			return { isValid: true };
		}

		if (!response.ok) {
			return {
				isValid: false,
				error: `API returned status ${response.status}`,
			};
		}

		return { isValid: true };
	} catch (error) {
		return {
			isValid: false,
			error: `Failed to verify: ${error instanceof Error ? error.message : "Unknown error"}`,
		};
	}
}

/**
 * Verify Anthropic API key by making a test request
 */
async function verifyAnthropicKey(
	apiKey: string,
): Promise<{ isValid: boolean; error?: string }> {
	try {
		// @duplicate-component-audit-allow: credential probe validates the key; response content is ignored.
		const response = await fetch("https://api.anthropic.com/v1/messages", {
			method: "POST",
			headers: {
				"x-api-key": apiKey,
				"anthropic-version": "2023-06-01",
				"content-type": "application/json",
			},
			body: JSON.stringify({
				model: "claude-haiku-4-5-20251001-5-20251001-20240307",
				max_tokens: 1,
				messages: [{ role: "user", content: "Hi" }],
			}),
			signal: AbortSignal.timeout(10000),
		});

		if (response.status === 401) {
			return { isValid: false, error: "Invalid API key" };
		}

		if (response.status === 429) {
			// Rate limited but key is valid
			return { isValid: true };
		}

		// 400 with "model" error means key is valid but request is invalid
		// We don't care about that for validation
		if (response.status === 400) {
			const body = (await response.json().catch(() => ({}))) as {
				error?: { type?: string };
			};
			if (body.error?.type === "invalid_request_error") {
				return { isValid: true };
			}
		}

		if (!response.ok && response.status !== 400) {
			return {
				isValid: false,
				error: `API returned status ${response.status}`,
			};
		}

		return { isValid: true };
	} catch (error) {
		return {
			isValid: false,
			error: `Failed to verify: ${error instanceof Error ? error.message : "Unknown error"}`,
		};
	}
}

// ============================================================================
// Exports
// ============================================================================

export { validateSecret as validate };
