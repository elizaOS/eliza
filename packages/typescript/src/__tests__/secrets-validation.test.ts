/**
 * Secret Validation Tests
 *
 * Tests for secret validation patterns, validateSecretKey function,
 * and checkRequiredSecrets function.
 */

import { describe, expect, it } from "vitest";
import {
	checkRequiredSecrets,
	getValidationPattern,
	hasValidationPattern,
	inferValidationPatternKey,
	SECRET_VALIDATION_PATTERNS,
	validateSecretKey,
	validateSecrets,
} from "../validation/secrets";

// ============================================================================
// Tests
// ============================================================================

describe("Secret Validation Patterns", () => {
	describe("OpenAI API Key Pattern", () => {
		const pattern = SECRET_VALIDATION_PATTERNS.OPENAI_API_KEY;

		it("should validate correct OpenAI API keys", () => {
			expect(pattern.pattern.test("sk-proj-abcdefghij1234567890")).toBe(true);
			expect(
				pattern.pattern.test("sk-1234567890123456789012345678901234567890"),
			).toBe(true);
			expect(pattern.pattern.test("sk-test_key-with-dashes_underscores")).toBe(
				true,
			);
		});

		it("should reject invalid OpenAI API keys", () => {
			expect(pattern.pattern.test("invalid-key")).toBe(false);
			expect(pattern.pattern.test("sk-short")).toBe(false);
			expect(pattern.pattern.test("pk-wrong-prefix")).toBe(false);
			expect(pattern.pattern.test("")).toBe(false);
		});
	});

	describe("Anthropic API Key Pattern", () => {
		const pattern = SECRET_VALIDATION_PATTERNS.ANTHROPIC_API_KEY;

		it("should validate correct Anthropic API keys", () => {
			expect(pattern.pattern.test("sk-ant-api03-abcdefghij1234567890")).toBe(
				true,
			);
			expect(pattern.pattern.test("sk-ant-test1234567890123456789012345")).toBe(
				true,
			);
		});

		it("should reject invalid Anthropic API keys", () => {
			expect(pattern.pattern.test("sk-ant-short")).toBe(false);
			expect(pattern.pattern.test("sk-12345678901234567890")).toBe(false);
			expect(pattern.pattern.test("invalid")).toBe(false);
		});
	});

	describe("Google API Key Pattern", () => {
		const pattern = SECRET_VALIDATION_PATTERNS.GOOGLE_API_KEY;

		it("should validate correct Google API keys", () => {
			expect(
				pattern.pattern.test("AIzaSyABCDEFGHIJKLMNOPQRSTUVWXYZ123456"),
			).toBe(true);
			expect(pattern.pattern.test("AIzaxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx")).toBe(
				true,
			);
		});

		it("should reject invalid Google API keys", () => {
			expect(pattern.pattern.test("AIza-short")).toBe(false);
			expect(pattern.pattern.test("invalid-key")).toBe(false);
			expect(pattern.pattern.test("sk-wrong-prefix")).toBe(false);
		});
	});

	describe("Groq API Key Pattern", () => {
		const pattern = SECRET_VALIDATION_PATTERNS.GROQ_API_KEY;

		it("should validate correct Groq API keys", () => {
			expect(pattern.pattern.test("gsk_abcdefghij1234567890")).toBe(true);
			expect(
				pattern.pattern.test("gsk_1234567890123456789012345678901234567890"),
			).toBe(true);
		});

		it("should reject invalid Groq API keys", () => {
			expect(pattern.pattern.test("gsk_short")).toBe(false);
			expect(pattern.pattern.test("invalid")).toBe(false);
		});
	});

	describe("Discord Bot Token Pattern", () => {
		const pattern = SECRET_VALIDATION_PATTERNS.DISCORD_BOT_TOKEN;

		it("should validate correct Discord bot tokens", () => {
			expect(
				pattern.pattern.test(
					"MTIzNDU2Nzg5MDEyMzQ1Njc4.GxxxxX.xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
				),
			).toBe(true);
			expect(
				pattern.pattern.test(
					"ODk0NzU2NDUyMDM0NjU0OTI2.YVo0Kw.abcdefghijklmnopqrstuvwxyz1",
				),
			).toBe(true);
		});

		it("should reject invalid Discord bot tokens", () => {
			expect(pattern.pattern.test("invalid-token")).toBe(false);
			expect(pattern.pattern.test("too.short.token")).toBe(false);
			expect(pattern.pattern.test("")).toBe(false);
		});
	});

	describe("Telegram Bot Token Pattern", () => {
		const pattern = SECRET_VALIDATION_PATTERNS.TELEGRAM_BOT_TOKEN;

		it("should validate correct Telegram bot tokens", () => {
			// Pattern requires exactly 35 chars after colon: \d{8,10}:[A-Za-z0-9_-]{35}
			expect(
				pattern.pattern.test("123456789:ABCdefGHIjklMNOpqrSTUvwxYZ123456789"),
			).toBe(true);
			expect(
				pattern.pattern.test("1234567890:abcdefghijklmnopqrstuvwxyz123456789"),
			).toBe(true);
		});

		it("should reject invalid Telegram bot tokens", () => {
			expect(pattern.pattern.test("123:short")).toBe(false);
			expect(pattern.pattern.test("invalid-format")).toBe(false);
			expect(pattern.pattern.test("")).toBe(false);
		});
	});

	describe("Twitter Username Pattern", () => {
		const pattern = SECRET_VALIDATION_PATTERNS.TWITTER_USERNAME;

		it("should validate correct Twitter usernames", () => {
			expect(pattern.pattern.test("username")).toBe(true);
			expect(pattern.pattern.test("user_name")).toBe(true);
			expect(pattern.pattern.test("user123")).toBe(true);
			expect(pattern.pattern.test("a")).toBe(true);
			expect(pattern.pattern.test("fifteen_chars12")).toBe(true);
		});

		it("should reject invalid Twitter usernames", () => {
			expect(pattern.pattern.test("")).toBe(false);
			expect(pattern.pattern.test("this_is_way_too_long")).toBe(false);
			expect(pattern.pattern.test("invalid@chars")).toBe(false);
			expect(pattern.pattern.test("has spaces")).toBe(false);
		});
	});

	describe("Email Pattern", () => {
		const pattern = SECRET_VALIDATION_PATTERNS.TWITTER_EMAIL;

		it("should validate correct email addresses", () => {
			expect(pattern.pattern.test("user@example.com")).toBe(true);
			expect(pattern.pattern.test("test.user@domain.org")).toBe(true);
			expect(pattern.pattern.test("user+tag@email.co.uk")).toBe(true);
		});

		it("should reject invalid email addresses", () => {
			expect(pattern.pattern.test("invalid")).toBe(false);
			expect(pattern.pattern.test("@domain.com")).toBe(false);
			expect(pattern.pattern.test("user@")).toBe(false);
			expect(pattern.pattern.test("has spaces@domain.com")).toBe(false);
		});
	});

	describe("Database URL Pattern", () => {
		const pattern = SECRET_VALIDATION_PATTERNS.DATABASE_URL;

		it("should validate correct database URLs", () => {
			expect(
				pattern.pattern.test("postgres://user:pass@localhost:5432/db"),
			).toBe(true);
			expect(pattern.pattern.test("postgresql://localhost/mydb")).toBe(true);
			expect(
				pattern.pattern.test(
					"mysql://root:password@mysql.example.com:3306/app",
				),
			).toBe(true);
			expect(pattern.pattern.test("sqlite:///path/to/db.sqlite")).toBe(true);
			expect(pattern.pattern.test("mongodb://localhost:27017/mydb")).toBe(true);
		});

		it("should reject invalid database URLs", () => {
			expect(pattern.pattern.test("http://not-a-db")).toBe(false);
			expect(pattern.pattern.test("invalid-url")).toBe(false);
			expect(pattern.pattern.test("")).toBe(false);
		});
	});
});

describe("validateSecretKey()", () => {
	describe("With Known Patterns", () => {
		it("should validate correct OpenAI key", () => {
			const result = validateSecretKey(
				"OPENAI_API_KEY",
				"sk-proj-abcdefghij1234567890",
			);
			expect(result.isValid).toBe(true);
			expect(result.error).toBeUndefined();
		});

		it("should reject invalid OpenAI key", () => {
			const result = validateSecretKey("OPENAI_API_KEY", "invalid");
			expect(result.isValid).toBe(false);
			expect(result.error).toBeDefined();
		});

		it("should reject too short keys", () => {
			const result = validateSecretKey("OPENAI_API_KEY", "sk-short");
			expect(result.isValid).toBe(false);
			expect(result.error).toContain("too short");
		});

		it("should validate correct Anthropic key", () => {
			const result = validateSecretKey(
				"ANTHROPIC_API_KEY",
				"sk-ant-api03-abcdefghij1234567890",
			);
			expect(result.isValid).toBe(true);
		});

		it("should validate Discord bot token", () => {
			const result = validateSecretKey(
				"DISCORD_BOT_TOKEN",
				"MTIzNDU2Nzg5MDEyMzQ1Njc4.GxxxxX.xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
			);
			expect(result.isValid).toBe(true);
		});
	});

	describe("With Unknown Keys (Basic Validation)", () => {
		it("should accept valid unknown keys", () => {
			const result = validateSecretKey("UNKNOWN_KEY", "some-valid-value-12345");
			expect(result.isValid).toBe(true);
		});

		it("should reject empty values", () => {
			const result = validateSecretKey("UNKNOWN_KEY", "");
			expect(result.isValid).toBe(false);
			expect(result.error).toContain("empty");
		});

		it("should reject whitespace-only values", () => {
			const result = validateSecretKey("UNKNOWN_KEY", "   ");
			expect(result.isValid).toBe(false);
		});

		it("should reject placeholder values", () => {
			expect(
				validateSecretKey("UNKNOWN_KEY", "your_api_key_here").isValid,
			).toBe(false);
			expect(validateSecretKey("UNKNOWN_KEY", "your-api-key").isValid).toBe(
				false,
			);
			expect(validateSecretKey("UNKNOWN_KEY", "TODO").isValid).toBe(false);
			expect(validateSecretKey("UNKNOWN_KEY", "REPLACE_ME").isValid).toBe(
				false,
			);
			expect(validateSecretKey("UNKNOWN_KEY", "placeholder").isValid).toBe(
				false,
			);
			expect(validateSecretKey("UNKNOWN_KEY", "<your_key>").isValid).toBe(
				false,
			);
			expect(validateSecretKey("UNKNOWN_KEY", "[your_key]").isValid).toBe(
				false,
			);
		});

		it("should warn for suspiciously short values", () => {
			const result = validateSecretKey("UNKNOWN_KEY", "short");
			expect(result.isValid).toBe(true);
			expect(result.warning).toBeDefined();
			expect(result.warning).toContain("short");
		});
	});

	describe("Validation Timestamp", () => {
		it("should include validation timestamp", () => {
			const before = Date.now();
			const result = validateSecretKey(
				"OPENAI_API_KEY",
				"sk-test12345678901234567890",
			);
			const after = Date.now();

			expect(result.validatedAt).toBeGreaterThanOrEqual(before);
			expect(result.validatedAt).toBeLessThanOrEqual(after);
		});
	});
});

describe("validateSecrets()", () => {
	it("should validate multiple secrets at once", () => {
		const secrets = {
			OPENAI_API_KEY: "sk-test12345678901234567890",
			ANTHROPIC_API_KEY: "sk-ant-api03-abcdefghij1234567890",
			CUSTOM_KEY: "valid-custom-value",
		};

		const results = validateSecrets(secrets);

		expect(Object.keys(results)).toHaveLength(3);
		expect(results.OPENAI_API_KEY.isValid).toBe(true);
		expect(results.ANTHROPIC_API_KEY.isValid).toBe(true);
		expect(results.CUSTOM_KEY.isValid).toBe(true);
	});

	it("should report invalid secrets", () => {
		const secrets = {
			OPENAI_API_KEY: "invalid",
			ANTHROPIC_API_KEY: "sk-ant-short",
		};

		const results = validateSecrets(secrets);

		expect(results.OPENAI_API_KEY.isValid).toBe(false);
		expect(results.ANTHROPIC_API_KEY.isValid).toBe(false);
	});

	it("should handle empty secrets object", () => {
		const results = validateSecrets({});
		expect(Object.keys(results)).toHaveLength(0);
	});
});

describe("checkRequiredSecrets()", () => {
	it("should report all required secrets present and valid", () => {
		const secrets = {
			OPENAI_API_KEY: "sk-test12345678901234567890",
			DISCORD_BOT_TOKEN:
				"MTIzNDU2Nzg5MDEyMzQ1Njc4.GxxxxX.xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
		};

		const required = ["OPENAI_API_KEY", "DISCORD_BOT_TOKEN"];
		const result = checkRequiredSecrets(secrets, required);

		expect(result.valid).toBe(true);
		expect(result.missing).toHaveLength(0);
		expect(result.invalid).toHaveLength(0);
	});

	it("should report missing required secrets", () => {
		const secrets = {
			OPENAI_API_KEY: "sk-test12345678901234567890",
		};

		const required = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"];
		const result = checkRequiredSecrets(secrets, required);

		expect(result.valid).toBe(false);
		expect(result.missing).toContain("ANTHROPIC_API_KEY");
		expect(result.missing).toHaveLength(1);
	});

	it("should report invalid required secrets", () => {
		const secrets = {
			OPENAI_API_KEY: "invalid-key",
			ANTHROPIC_API_KEY: "sk-ant-api03-abcdefghij1234567890",
		};

		const required = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"];
		const result = checkRequiredSecrets(secrets, required);

		expect(result.valid).toBe(false);
		expect(result.invalid).toContain("OPENAI_API_KEY");
		expect(result.invalid).toHaveLength(1);
	});

	it("should handle empty secrets", () => {
		const result = checkRequiredSecrets({}, ["OPENAI_API_KEY"]);

		expect(result.valid).toBe(false);
		expect(result.missing).toContain("OPENAI_API_KEY");
	});

	it("should handle no required keys", () => {
		const result = checkRequiredSecrets({ SOME_KEY: "value" }, []);

		expect(result.valid).toBe(true);
		expect(result.missing).toHaveLength(0);
		expect(result.invalid).toHaveLength(0);
	});

	it("should include validation results", () => {
		const secrets = {
			OPENAI_API_KEY: "sk-test12345678901234567890",
		};

		const result = checkRequiredSecrets(secrets, ["OPENAI_API_KEY"]);

		expect(result.results.OPENAI_API_KEY).toBeDefined();
		expect(result.results.OPENAI_API_KEY.isValid).toBe(true);
	});
});

describe("getValidationPattern()", () => {
	it("should return pattern for known keys", () => {
		expect(getValidationPattern("OPENAI_API_KEY")).toBeDefined();
		expect(getValidationPattern("ANTHROPIC_API_KEY")).toBeDefined();
		expect(getValidationPattern("DISCORD_BOT_TOKEN")).toBeDefined();
	});

	it("should return undefined for unknown keys", () => {
		expect(getValidationPattern("UNKNOWN_KEY")).toBeUndefined();
		expect(getValidationPattern("CUSTOM_SECRET")).toBeUndefined();
	});
});

describe("hasValidationPattern()", () => {
	it("should return true for keys with patterns", () => {
		expect(hasValidationPattern("OPENAI_API_KEY")).toBe(true);
		expect(hasValidationPattern("ANTHROPIC_API_KEY")).toBe(true);
		expect(hasValidationPattern("DISCORD_BOT_TOKEN")).toBe(true);
		expect(hasValidationPattern("TWITTER_USERNAME")).toBe(true);
	});

	it("should return false for keys without patterns", () => {
		expect(hasValidationPattern("UNKNOWN_KEY")).toBe(false);
		expect(hasValidationPattern("CUSTOM_SECRET")).toBe(false);
	});
});

describe("inferValidationPatternKey()", () => {
	it("should infer OPENAI_API_KEY from variations", () => {
		expect(inferValidationPatternKey("OPENAI_API_KEY")).toBe("OPENAI_API_KEY");
		expect(inferValidationPatternKey("openai_api_key")).toBe("OPENAI_API_KEY");
		expect(inferValidationPatternKey("OPENAI_KEY")).toBe("OPENAI_API_KEY");
	});

	it("should infer ANTHROPIC_API_KEY from variations", () => {
		expect(inferValidationPatternKey("ANTHROPIC_API_KEY")).toBe(
			"ANTHROPIC_API_KEY",
		);
		expect(inferValidationPatternKey("ANTHROPIC_KEY")).toBe(
			"ANTHROPIC_API_KEY",
		);
		expect(inferValidationPatternKey("anthropic_key")).toBe(
			"ANTHROPIC_API_KEY",
		);
	});

	it("should infer GOOGLE_API_KEY from variations", () => {
		expect(inferValidationPatternKey("GOOGLE_API_KEY")).toBe("GOOGLE_API_KEY");
		expect(inferValidationPatternKey("GOOGLE_KEY")).toBe("GOOGLE_API_KEY");
		expect(inferValidationPatternKey("google_ai_key")).toBe("GOOGLE_API_KEY");
	});

	it("should infer DISCORD_BOT_TOKEN from variations", () => {
		expect(inferValidationPatternKey("DISCORD_BOT_TOKEN")).toBe(
			"DISCORD_BOT_TOKEN",
		);
		expect(inferValidationPatternKey("DISCORD_TOKEN")).toBe(
			"DISCORD_BOT_TOKEN",
		);
		expect(inferValidationPatternKey("discord_bot")).toBe("DISCORD_BOT_TOKEN");
	});

	it("should infer TELEGRAM_BOT_TOKEN from variations", () => {
		expect(inferValidationPatternKey("TELEGRAM_BOT_TOKEN")).toBe(
			"TELEGRAM_BOT_TOKEN",
		);
		expect(inferValidationPatternKey("TELEGRAM_TOKEN")).toBe(
			"TELEGRAM_BOT_TOKEN",
		);
		expect(inferValidationPatternKey("telegram_bot")).toBe(
			"TELEGRAM_BOT_TOKEN",
		);
	});

	it("should return original key for unrecognized patterns", () => {
		expect(inferValidationPatternKey("UNKNOWN_KEY")).toBe("UNKNOWN_KEY");
		expect(inferValidationPatternKey("CUSTOM_SECRET")).toBe("CUSTOM_SECRET");
	});
});
