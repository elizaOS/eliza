/**
 * Secret Key Aliases Tests
 *
 * Tests for secret key alias resolution, backward compatibility,
 * and canonical key mappings.
 */

import { describe, expect, it } from "vitest";
import {
	CANONICAL_SECRET_KEYS,
	CHANNEL_OPTIONAL_SECRETS,
	CHANNEL_SECRETS,
	getAliasesForKey,
	getAllSecretsForChannel,
	getProviderForApiKey,
	getRequiredSecretsForChannel,
	isCanonicalSecretKey,
	isSecretKeyAlias,
	MODEL_PROVIDER_SECRETS,
	resolveSecretKeyAlias,
	SECRET_KEY_ALIASES,
} from "../constants/secrets";

// ============================================================================
// Tests
// ============================================================================

describe("Secret Key Aliases", () => {
	describe("resolveSecretKeyAlias()", () => {
		it("should resolve Discord aliases to canonical key", () => {
			expect(resolveSecretKeyAlias("DISCORD_TOKEN")).toBe("DISCORD_BOT_TOKEN");
			expect(resolveSecretKeyAlias("DISCORD_API_TOKEN")).toBe(
				"DISCORD_BOT_TOKEN",
			);
		});

		it("should resolve Telegram aliases to canonical key", () => {
			expect(resolveSecretKeyAlias("TELEGRAM_TOKEN")).toBe(
				"TELEGRAM_BOT_TOKEN",
			);
			expect(resolveSecretKeyAlias("TELEGRAM_API_TOKEN")).toBe(
				"TELEGRAM_BOT_TOKEN",
			);
			expect(resolveSecretKeyAlias("TG_BOT_TOKEN")).toBe("TELEGRAM_BOT_TOKEN");
		});

		it("should resolve Slack aliases to canonical key", () => {
			expect(resolveSecretKeyAlias("SLACK_TOKEN")).toBe("SLACK_BOT_TOKEN");
			expect(resolveSecretKeyAlias("SLACK_API_TOKEN")).toBe("SLACK_BOT_TOKEN");
		});

		it("should resolve OpenAI aliases to canonical key", () => {
			expect(resolveSecretKeyAlias("OPENAI_KEY")).toBe("OPENAI_API_KEY");
			expect(resolveSecretKeyAlias("OPENAI_TOKEN")).toBe("OPENAI_API_KEY");
		});

		it("should resolve Anthropic aliases to canonical key", () => {
			expect(resolveSecretKeyAlias("ANTHROPIC_KEY")).toBe("ANTHROPIC_API_KEY");
			expect(resolveSecretKeyAlias("ANTHROPIC_TOKEN")).toBe(
				"ANTHROPIC_API_KEY",
			);
			expect(resolveSecretKeyAlias("CLAUDE_API_KEY")).toBe("ANTHROPIC_API_KEY");
		});

		it("should resolve Google/Gemini aliases to canonical key", () => {
			expect(resolveSecretKeyAlias("GOOGLE_KEY")).toBe("GOOGLE_API_KEY");
			expect(resolveSecretKeyAlias("GOOGLE_AI_KEY")).toBe("GOOGLE_API_KEY");
			expect(resolveSecretKeyAlias("GEMINI_API_KEY")).toBe("GOOGLE_API_KEY");
			expect(resolveSecretKeyAlias("GOOGLE_GENERATIVE_AI_API_KEY")).toBe(
				"GOOGLE_API_KEY",
			);
		});

		it("should resolve Groq aliases to canonical key", () => {
			expect(resolveSecretKeyAlias("GROQ_KEY")).toBe("GROQ_API_KEY");
			expect(resolveSecretKeyAlias("GROQ_TOKEN")).toBe("GROQ_API_KEY");
		});

		it("should resolve XAI/Grok aliases to canonical key", () => {
			expect(resolveSecretKeyAlias("XAI_KEY")).toBe("XAI_API_KEY");
			expect(resolveSecretKeyAlias("GROK_API_KEY")).toBe("XAI_API_KEY");
		});

		it("should resolve OpenRouter aliases to canonical key", () => {
			expect(resolveSecretKeyAlias("OPENROUTER_KEY")).toBe(
				"OPENROUTER_API_KEY",
			);
			expect(resolveSecretKeyAlias("OPENROUTER_TOKEN")).toBe(
				"OPENROUTER_API_KEY",
			);
		});

		it("should resolve Mistral aliases to canonical key", () => {
			expect(resolveSecretKeyAlias("MISTRAL_KEY")).toBe("MISTRAL_API_KEY");
			expect(resolveSecretKeyAlias("MISTRAL_TOKEN")).toBe("MISTRAL_API_KEY");
		});

		it("should resolve Cohere aliases to canonical key", () => {
			expect(resolveSecretKeyAlias("COHERE_KEY")).toBe("COHERE_API_KEY");
			expect(resolveSecretKeyAlias("COHERE_TOKEN")).toBe("COHERE_API_KEY");
		});

		it("should resolve Together aliases to canonical key", () => {
			expect(resolveSecretKeyAlias("TOGETHER_KEY")).toBe("TOGETHER_API_KEY");
			expect(resolveSecretKeyAlias("TOGETHER_TOKEN")).toBe("TOGETHER_API_KEY");
		});

		it("should resolve ElevenLabs aliases to canonical key", () => {
			expect(resolveSecretKeyAlias("ELEVENLABS_KEY")).toBe(
				"ELEVENLABS_API_KEY",
			);
			expect(resolveSecretKeyAlias("ELEVEN_LABS_API_KEY")).toBe(
				"ELEVENLABS_API_KEY",
			);
		});

		it("should resolve WhatsApp aliases to canonical key", () => {
			expect(resolveSecretKeyAlias("WHATSAPP_BOT_TOKEN")).toBe(
				"WHATSAPP_TOKEN",
			);
			expect(resolveSecretKeyAlias("WHATSAPP_API_TOKEN")).toBe(
				"WHATSAPP_TOKEN",
			);
		});

		it("should return original key for canonical keys", () => {
			expect(resolveSecretKeyAlias("OPENAI_API_KEY")).toBe("OPENAI_API_KEY");
			expect(resolveSecretKeyAlias("DISCORD_BOT_TOKEN")).toBe(
				"DISCORD_BOT_TOKEN",
			);
			expect(resolveSecretKeyAlias("ANTHROPIC_API_KEY")).toBe(
				"ANTHROPIC_API_KEY",
			);
		});

		it("should return original key for unknown keys", () => {
			expect(resolveSecretKeyAlias("UNKNOWN_KEY")).toBe("UNKNOWN_KEY");
			expect(resolveSecretKeyAlias("CUSTOM_SECRET")).toBe("CUSTOM_SECRET");
			expect(resolveSecretKeyAlias("MY_API_KEY")).toBe("MY_API_KEY");
		});
	});

	describe("isSecretKeyAlias()", () => {
		it("should return true for known aliases", () => {
			expect(isSecretKeyAlias("DISCORD_TOKEN")).toBe(true);
			expect(isSecretKeyAlias("OPENAI_KEY")).toBe(true);
			expect(isSecretKeyAlias("CLAUDE_API_KEY")).toBe(true);
			expect(isSecretKeyAlias("TG_BOT_TOKEN")).toBe(true);
		});

		it("should return false for canonical keys", () => {
			expect(isSecretKeyAlias("DISCORD_BOT_TOKEN")).toBe(false);
			expect(isSecretKeyAlias("OPENAI_API_KEY")).toBe(false);
			expect(isSecretKeyAlias("ANTHROPIC_API_KEY")).toBe(false);
		});

		it("should return false for unknown keys", () => {
			expect(isSecretKeyAlias("UNKNOWN_KEY")).toBe(false);
			expect(isSecretKeyAlias("CUSTOM_SECRET")).toBe(false);
		});
	});

	describe("getAliasesForKey()", () => {
		it("should return all aliases for DISCORD_BOT_TOKEN", () => {
			const aliases = getAliasesForKey("DISCORD_BOT_TOKEN");
			expect(aliases).toContain("DISCORD_TOKEN");
			expect(aliases).toContain("DISCORD_API_TOKEN");
		});

		it("should return all aliases for OPENAI_API_KEY", () => {
			const aliases = getAliasesForKey("OPENAI_API_KEY");
			expect(aliases).toContain("OPENAI_KEY");
			expect(aliases).toContain("OPENAI_TOKEN");
		});

		it("should return all aliases for ANTHROPIC_API_KEY", () => {
			const aliases = getAliasesForKey("ANTHROPIC_API_KEY");
			expect(aliases).toContain("ANTHROPIC_KEY");
			expect(aliases).toContain("ANTHROPIC_TOKEN");
			expect(aliases).toContain("CLAUDE_API_KEY");
		});

		it("should return all aliases for TELEGRAM_BOT_TOKEN", () => {
			const aliases = getAliasesForKey("TELEGRAM_BOT_TOKEN");
			expect(aliases).toContain("TELEGRAM_TOKEN");
			expect(aliases).toContain("TELEGRAM_API_TOKEN");
			expect(aliases).toContain("TG_BOT_TOKEN");
		});

		it("should return empty array for keys with no aliases", () => {
			const aliases = getAliasesForKey("ENCRYPTION_SALT");
			expect(aliases).toHaveLength(0);
		});

		it("should return empty array for unknown keys", () => {
			const aliases = getAliasesForKey("UNKNOWN_KEY");
			expect(aliases).toHaveLength(0);
		});
	});

	describe("isCanonicalSecretKey()", () => {
		it("should return true for canonical keys", () => {
			expect(isCanonicalSecretKey("OPENAI_API_KEY")).toBe(true);
			expect(isCanonicalSecretKey("ANTHROPIC_API_KEY")).toBe(true);
			expect(isCanonicalSecretKey("DISCORD_BOT_TOKEN")).toBe(true);
			expect(isCanonicalSecretKey("TELEGRAM_BOT_TOKEN")).toBe(true);
			expect(isCanonicalSecretKey("ENCRYPTION_SALT")).toBe(true);
			expect(isCanonicalSecretKey("DATABASE_URL")).toBe(true);
		});

		it("should return false for aliases", () => {
			expect(isCanonicalSecretKey("DISCORD_TOKEN")).toBe(false);
			expect(isCanonicalSecretKey("OPENAI_KEY")).toBe(false);
			expect(isCanonicalSecretKey("CLAUDE_API_KEY")).toBe(false);
		});

		it("should return false for unknown keys", () => {
			expect(isCanonicalSecretKey("UNKNOWN_KEY")).toBe(false);
			expect(isCanonicalSecretKey("CUSTOM_SECRET")).toBe(false);
		});
	});

	describe("Backward Compatibility", () => {
		it("should resolve all defined aliases", () => {
			for (const [alias, canonical] of Object.entries(SECRET_KEY_ALIASES)) {
				expect(resolveSecretKeyAlias(alias)).toBe(canonical);
			}
		});

		it("should ensure all canonical keys are defined", () => {
			expect(CANONICAL_SECRET_KEYS.length).toBeGreaterThan(0);

			// Check key providers
			expect(CANONICAL_SECRET_KEYS).toContain("OPENAI_API_KEY");
			expect(CANONICAL_SECRET_KEYS).toContain("ANTHROPIC_API_KEY");
			expect(CANONICAL_SECRET_KEYS).toContain("GOOGLE_API_KEY");
			expect(CANONICAL_SECRET_KEYS).toContain("GROQ_API_KEY");

			// Check channels
			expect(CANONICAL_SECRET_KEYS).toContain("DISCORD_BOT_TOKEN");
			expect(CANONICAL_SECRET_KEYS).toContain("TELEGRAM_BOT_TOKEN");
			expect(CANONICAL_SECRET_KEYS).toContain("SLACK_BOT_TOKEN");

			// Check infrastructure
			expect(CANONICAL_SECRET_KEYS).toContain("ENCRYPTION_SALT");
			expect(CANONICAL_SECRET_KEYS).toContain("DATABASE_URL");
		});

		it("should have unique canonical names for all aliases", () => {
			const canonicals = new Set(Object.values(SECRET_KEY_ALIASES));
			// All canonical values should be valid canonical keys
			for (const canonical of canonicals) {
				expect(
					CANONICAL_SECRET_KEYS.includes(
						canonical as (typeof CANONICAL_SECRET_KEYS)[number],
					),
				).toBe(true);
			}
		});
	});

	describe("Model Provider Secrets", () => {
		it("should map all model providers to API keys", () => {
			expect(MODEL_PROVIDER_SECRETS.anthropic).toBe("ANTHROPIC_API_KEY");
			expect(MODEL_PROVIDER_SECRETS.openai).toBe("OPENAI_API_KEY");
			expect(MODEL_PROVIDER_SECRETS.google).toBe("GOOGLE_API_KEY");
			expect(MODEL_PROVIDER_SECRETS.groq).toBe("GROQ_API_KEY");
			expect(MODEL_PROVIDER_SECRETS.xai).toBe("XAI_API_KEY");
			expect(MODEL_PROVIDER_SECRETS.openrouter).toBe("OPENROUTER_API_KEY");
			expect(MODEL_PROVIDER_SECRETS.mistral).toBe("MISTRAL_API_KEY");
			expect(MODEL_PROVIDER_SECRETS.cohere).toBe("COHERE_API_KEY");
			expect(MODEL_PROVIDER_SECRETS.together).toBe("TOGETHER_API_KEY");
			expect(MODEL_PROVIDER_SECRETS.fireworks).toBe("FIREWORKS_API_KEY");
			expect(MODEL_PROVIDER_SECRETS.perplexity).toBe("PERPLEXITY_API_KEY");
			expect(MODEL_PROVIDER_SECRETS.deepseek).toBe("DEEPSEEK_API_KEY");
		});

		it("should include local providers with URL check", () => {
			expect(MODEL_PROVIDER_SECRETS.ollama).toBe("OLLAMA_BASE_URL");
		});
	});

	describe("getProviderForApiKey()", () => {
		it("should return provider name for API key", () => {
			expect(getProviderForApiKey("OPENAI_API_KEY")).toBe("openai");
			expect(getProviderForApiKey("ANTHROPIC_API_KEY")).toBe("anthropic");
			expect(getProviderForApiKey("GOOGLE_API_KEY")).toBe("google");
			expect(getProviderForApiKey("GROQ_API_KEY")).toBe("groq");
			expect(getProviderForApiKey("OLLAMA_BASE_URL")).toBe("ollama");
		});

		it("should return null for unknown API key", () => {
			expect(getProviderForApiKey("UNKNOWN_KEY")).toBeNull();
			expect(getProviderForApiKey("DISCORD_BOT_TOKEN")).toBeNull();
		});
	});

	describe("Channel Secrets", () => {
		it("should define required secrets for each channel", () => {
			expect(CHANNEL_SECRETS.discord).toContain("DISCORD_BOT_TOKEN");
			expect(CHANNEL_SECRETS.telegram).toContain("TELEGRAM_BOT_TOKEN");
			expect(CHANNEL_SECRETS.slack).toContain("SLACK_BOT_TOKEN");
			expect(CHANNEL_SECRETS.slack).toContain("SLACK_APP_TOKEN");
			expect(CHANNEL_SECRETS.whatsapp).toContain("WHATSAPP_TOKEN");
			expect(CHANNEL_SECRETS.signal).toContain("SIGNAL_CLI_PATH");
			expect(CHANNEL_SECRETS.twitter).toContain("TWITTER_USERNAME");
			expect(CHANNEL_SECRETS.twitter).toContain("TWITTER_PASSWORD");
		});

		it("should define optional secrets for channels", () => {
			expect(CHANNEL_OPTIONAL_SECRETS.discord).toContain(
				"DISCORD_APPLICATION_ID",
			);
			expect(CHANNEL_OPTIONAL_SECRETS.twitter).toContain("TWITTER_EMAIL");
			expect(CHANNEL_OPTIONAL_SECRETS.twitter).toContain("TWITTER_2FA_SECRET");
		});
	});

	describe("getRequiredSecretsForChannel()", () => {
		it("should return required secrets for known channels", () => {
			expect(getRequiredSecretsForChannel("discord")).toContain(
				"DISCORD_BOT_TOKEN",
			);
			expect(getRequiredSecretsForChannel("telegram")).toContain(
				"TELEGRAM_BOT_TOKEN",
			);
			expect(getRequiredSecretsForChannel("slack")).toContain(
				"SLACK_BOT_TOKEN",
			);
		});

		it("should return empty array for unknown channels", () => {
			expect(getRequiredSecretsForChannel("unknown")).toEqual([]);
		});
	});

	describe("getAllSecretsForChannel()", () => {
		it("should return both required and optional secrets", () => {
			const discordSecrets = getAllSecretsForChannel("discord");
			expect(discordSecrets.required).toContain("DISCORD_BOT_TOKEN");
			expect(discordSecrets.optional).toContain("DISCORD_APPLICATION_ID");
		});

		it("should return empty arrays for unknown channels", () => {
			const unknown = getAllSecretsForChannel("unknown");
			expect(unknown.required).toEqual([]);
			expect(unknown.optional).toEqual([]);
		});

		it("should return all Twitter secrets", () => {
			const twitterSecrets = getAllSecretsForChannel("twitter");
			expect(twitterSecrets.required).toContain("TWITTER_USERNAME");
			expect(twitterSecrets.required).toContain("TWITTER_PASSWORD");
			expect(twitterSecrets.optional).toContain("TWITTER_EMAIL");
			expect(twitterSecrets.optional).toContain("TWITTER_2FA_SECRET");
		});
	});
});
