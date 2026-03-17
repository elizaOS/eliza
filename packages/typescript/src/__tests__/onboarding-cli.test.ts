/**
 * Onboarding CLI Adapter Tests
 *
 * Tests for the CLI onboarding adapter with mock prompts.
 * Tests input parsing for each step and full onboarding flow.
 */

import { describe, expect, it, vi } from "vitest";

// ============================================================================
// Types
// ============================================================================

interface OnboardingSetting {
	name: string;
	description: string;
	usageDescription?: string;
	secret: boolean;
	public: boolean;
	required: boolean;
	dependsOn: string[];
	validation?: (value: string) => boolean;
	type?: string;
	value?: string | null;
}

interface OnboardingConfig {
	settings: Record<string, OnboardingSetting>;
	messages?: {
		welcome?: string[];
		askSetting?: string;
		settingUpdated?: string;
		allComplete?: string;
		error?: string;
	};
}

interface CliPromptResult {
	key: string;
	value: string;
	skipped: boolean;
}

// ============================================================================
// CLI Adapter Implementation (for testing)
// ============================================================================

interface CliPromptAdapter {
	prompt: (
		message: string,
		options?: { type?: "text" | "password"; validate?: (v: string) => boolean },
	) => Promise<string>;
	confirm: (message: string) => Promise<boolean>;
	select: <T>(
		message: string,
		choices: Array<{ value: T; label: string }>,
	) => Promise<T>;
}

/**
 * CLI Onboarding Session
 */
class CliOnboardingSession {
	private config: OnboardingConfig;
	private adapter: CliPromptAdapter;
	private results: Map<string, string> = new Map();

	constructor(config: OnboardingConfig, adapter: CliPromptAdapter) {
		this.config = config;
		this.adapter = adapter;
	}

	/**
	 * Get unconfigured required settings.
	 */
	private getUnconfiguredRequired(): Array<[string, OnboardingSetting]> {
		return Object.entries(this.config.settings).filter(
			([_, s]) => s.required && s.value === null,
		);
	}

	/**
	 * Get unconfigured optional settings.
	 */
	private getUnconfiguredOptional(): Array<[string, OnboardingSetting]> {
		return Object.entries(this.config.settings).filter(
			([_, s]) => !s.required && s.value === null,
		);
	}

	/**
	 * Check if dependencies are met for a setting.
	 */
	private dependenciesMet(setting: OnboardingSetting): boolean {
		return setting.dependsOn.every((dep) => {
			const depSetting = this.config.settings[dep];
			return depSetting && depSetting.value !== null;
		});
	}

	/**
	 * Get the next setting to configure.
	 */
	private getNextSetting(): [string, OnboardingSetting] | null {
		for (const [key, setting] of this.getUnconfiguredRequired()) {
			if (this.dependenciesMet(setting)) {
				return [key, setting];
			}
		}
		return null;
	}

	/**
	 * Prompt for a single setting.
	 */
	async promptForSetting(
		key: string,
		setting: OnboardingSetting,
	): Promise<CliPromptResult> {
		const message = `Enter ${setting.name}${setting.required ? " (required)" : " (optional)"}:`;
		const type = setting.secret ? "password" : "text";

		try {
			const value = await this.adapter.prompt(message, {
				type,
				validate: setting.validation,
			});

			if (value.trim() === "") {
				return { key, value: "", skipped: true };
			}

			return { key, value: value.trim(), skipped: false };
		} catch (_error) {
			return { key, value: "", skipped: true };
		}
	}

	/**
	 * Parse user input for a setting.
	 */
	parseInput(
		key: string,
		input: string,
	): { valid: boolean; value: string; error?: string } {
		const setting = this.config.settings[key];
		if (!setting) {
			return { valid: false, value: "", error: `Unknown setting: ${key}` };
		}

		const trimmed = input.trim();

		if (trimmed === "" && setting.required) {
			return { valid: false, value: "", error: `${setting.name} is required` };
		}

		if (setting.validation && !setting.validation(trimmed)) {
			return {
				valid: false,
				value: trimmed,
				error: `Invalid ${setting.name}. ${setting.usageDescription || ""}`,
			};
		}

		return { valid: true, value: trimmed };
	}

	/**
	 * Run the full onboarding flow.
	 */
	async run(): Promise<{
		completed: boolean;
		results: Record<string, string>;
		skipped: string[];
	}> {
		const skipped: string[] = [];
		const results: Record<string, string> = {};

		// Welcome message
		const welcomeMessages = this.config.messages?.welcome || [
			"Welcome to the setup wizard!",
		];
		const welcomeMsg =
			welcomeMessages[Math.floor(Math.random() * welcomeMessages.length)];
		console.log(welcomeMsg);

		// Process required settings
		let next = this.getNextSetting();
		while (next) {
			const [key, setting] = next;
			const result = await this.promptForSetting(key, setting);

			if (result.skipped) {
				skipped.push(key);
				// If required and skipped, we can't continue
				if (setting.required) {
					break;
				}
			} else {
				this.config.settings[key].value = result.value;
				results[key] = result.value;
				this.results.set(key, result.value);
			}

			next = this.getNextSetting();
		}

		// Check for optional settings
		const shouldConfigureOptional = await this.adapter.confirm(
			"Would you like to configure optional settings?",
		);

		if (shouldConfigureOptional) {
			for (const [key, setting] of this.getUnconfiguredOptional()) {
				if (this.dependenciesMet(setting)) {
					const result = await this.promptForSetting(key, setting);
					if (!result.skipped) {
						this.config.settings[key].value = result.value;
						results[key] = result.value;
						this.results.set(key, result.value);
					}
				}
			}
		}

		const completed = this.getUnconfiguredRequired().length === 0;
		return { completed, results, skipped };
	}

	/**
	 * Get current results.
	 */
	getResults(): Record<string, string> {
		return Object.fromEntries(this.results);
	}
}

// ============================================================================
// Test Utilities
// ============================================================================

function createTestConfig(
	settings: Record<string, Partial<OnboardingSetting>>,
): OnboardingConfig {
	const fullSettings: Record<string, OnboardingSetting> = {};

	for (const [key, partial] of Object.entries(settings)) {
		fullSettings[key] = {
			name: partial.name || key,
			description: partial.description || `Description for ${key}`,
			secret: partial.secret ?? true,
			public: partial.public ?? false,
			required: partial.required ?? true,
			dependsOn: partial.dependsOn || [],
			value: partial.value ?? null,
			type: partial.type || "api_key",
			validation: partial.validation,
			...partial,
		};
	}

	return { settings: fullSettings };
}

function createMockAdapter(responses: {
	prompts?: string[];
	confirms?: boolean[];
	selects?: unknown[];
}): CliPromptAdapter {
	let promptIndex = 0;
	let confirmIndex = 0;
	let selectIndex = 0;

	return {
		prompt: vi.fn(async () => {
			const response = responses.prompts?.[promptIndex] ?? "";
			promptIndex++;
			return response;
		}),
		confirm: vi.fn(async () => {
			const response = responses.confirms?.[confirmIndex] ?? false;
			confirmIndex++;
			return response;
		}),
		select: vi.fn(async () => {
			const response = responses.selects?.[selectIndex] ?? "";
			selectIndex++;
			return response;
		}),
	};
}

// ============================================================================
// Tests
// ============================================================================

describe("Onboarding CLI Adapter", () => {
	describe("Input Parsing", () => {
		it("should parse valid text input", () => {
			const config = createTestConfig({
				USERNAME: { required: true, secret: false },
			});
			const adapter = createMockAdapter({});
			const session = new CliOnboardingSession(config, adapter);

			const result = session.parseInput("USERNAME", "myusername");
			expect(result.valid).toBe(true);
			expect(result.value).toBe("myusername");
		});

		it("should reject empty input for required settings", () => {
			const config = createTestConfig({
				REQUIRED_KEY: { required: true },
			});
			const adapter = createMockAdapter({});
			const session = new CliOnboardingSession(config, adapter);

			const result = session.parseInput("REQUIRED_KEY", "");
			expect(result.valid).toBe(false);
			expect(result.error).toContain("required");
		});

		it("should accept empty input for optional settings", () => {
			const config = createTestConfig({
				OPTIONAL_KEY: { required: false },
			});
			const adapter = createMockAdapter({});
			const session = new CliOnboardingSession(config, adapter);

			const result = session.parseInput("OPTIONAL_KEY", "");
			expect(result.valid).toBe(true);
			expect(result.value).toBe("");
		});

		it("should validate input with custom validation function", () => {
			const config = createTestConfig({
				EMAIL: {
					required: true,
					validation: (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v),
					usageDescription: "Must be a valid email address",
				},
			});
			const adapter = createMockAdapter({});
			const session = new CliOnboardingSession(config, adapter);

			const invalid = session.parseInput("EMAIL", "not-an-email");
			expect(invalid.valid).toBe(false);
			expect(invalid.error).toContain("Invalid");

			const valid = session.parseInput("EMAIL", "user@example.com");
			expect(valid.valid).toBe(true);
			expect(valid.value).toBe("user@example.com");
		});

		it("should trim whitespace from input", () => {
			const config = createTestConfig({
				KEY: { required: true },
			});
			const adapter = createMockAdapter({});
			const session = new CliOnboardingSession(config, adapter);

			const result = session.parseInput("KEY", "  value with spaces  ");
			expect(result.valid).toBe(true);
			expect(result.value).toBe("value with spaces");
		});

		it("should return error for unknown setting", () => {
			const config = createTestConfig({
				KNOWN_KEY: { required: true },
			});
			const adapter = createMockAdapter({});
			const session = new CliOnboardingSession(config, adapter);

			const result = session.parseInput("UNKNOWN_KEY", "value");
			expect(result.valid).toBe(false);
			expect(result.error).toContain("Unknown setting");
		});
	});

	describe("Input Parsing for API Keys", () => {
		it("should validate OpenAI API key format", () => {
			const config = createTestConfig({
				OPENAI_API_KEY: {
					required: true,
					validation: (v) => /^sk-[a-zA-Z0-9-_]{20,}$/.test(v),
				},
			});
			const adapter = createMockAdapter({});
			const session = new CliOnboardingSession(config, adapter);

			expect(
				session.parseInput("OPENAI_API_KEY", "sk-valid12345678901234567890")
					.valid,
			).toBe(true);
			expect(session.parseInput("OPENAI_API_KEY", "invalid-key").valid).toBe(
				false,
			);
			expect(session.parseInput("OPENAI_API_KEY", "sk-short").valid).toBe(
				false,
			);
		});

		it("should validate Anthropic API key format", () => {
			const config = createTestConfig({
				ANTHROPIC_API_KEY: {
					required: true,
					validation: (v) => /^sk-ant-[a-zA-Z0-9-_]{20,}$/.test(v),
				},
			});
			const adapter = createMockAdapter({});
			const session = new CliOnboardingSession(config, adapter);

			expect(
				session.parseInput(
					"ANTHROPIC_API_KEY",
					"sk-ant-api03-12345678901234567890",
				).valid,
			).toBe(true);
			expect(session.parseInput("ANTHROPIC_API_KEY", "sk-12345").valid).toBe(
				false,
			);
		});

		it("should validate Discord bot token format", () => {
			const config = createTestConfig({
				DISCORD_BOT_TOKEN: {
					required: true,
					validation: (v) =>
						/^[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}$/.test(
							v,
						),
				},
			});
			const adapter = createMockAdapter({});
			const session = new CliOnboardingSession(config, adapter);

			const validToken =
				"MTIzNDU2Nzg5MDEyMzQ1Njc4.GxxxxX.xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
			expect(session.parseInput("DISCORD_BOT_TOKEN", validToken).valid).toBe(
				true,
			);
			expect(
				session.parseInput("DISCORD_BOT_TOKEN", "invalid-token").valid,
			).toBe(false);
		});

		it("should validate Telegram bot token format", () => {
			const config = createTestConfig({
				TELEGRAM_BOT_TOKEN: {
					required: true,
					validation: (v) => /^\d{8,10}:[A-Za-z0-9_-]{35}$/.test(v),
				},
			});
			const adapter = createMockAdapter({});
			const session = new CliOnboardingSession(config, adapter);

			const validToken = "123456789:ABCdefGHIjklMNOpqrSTUvwxYZ123456789";
			expect(session.parseInput("TELEGRAM_BOT_TOKEN", validToken).valid).toBe(
				true,
			);
			expect(session.parseInput("TELEGRAM_BOT_TOKEN", "123:short").valid).toBe(
				false,
			);
		});
	});

	describe("Prompt for Setting", () => {
		it("should prompt for text input", async () => {
			const config = createTestConfig({
				USERNAME: { required: true, secret: false, name: "Username" },
			});
			const adapter = createMockAdapter({ prompts: ["testuser"] });
			const session = new CliOnboardingSession(config, adapter);

			const result = await session.promptForSetting(
				"USERNAME",
				config.settings.USERNAME,
			);

			expect(result.key).toBe("USERNAME");
			expect(result.value).toBe("testuser");
			expect(result.skipped).toBe(false);
			expect(adapter.prompt).toHaveBeenCalledWith(
				expect.stringContaining("Username"),
				expect.objectContaining({ type: "text" }),
			);
		});

		it("should prompt for password input for secrets", async () => {
			const config = createTestConfig({
				API_KEY: { required: true, secret: true, name: "API Key" },
			});
			const adapter = createMockAdapter({ prompts: ["secret-value"] });
			const session = new CliOnboardingSession(config, adapter);

			await session.promptForSetting("API_KEY", config.settings.API_KEY);

			expect(adapter.prompt).toHaveBeenCalledWith(
				expect.stringContaining("API Key"),
				expect.objectContaining({ type: "password" }),
			);
		});

		it("should mark empty responses as skipped", async () => {
			const config = createTestConfig({
				OPTIONAL: { required: false },
			});
			const adapter = createMockAdapter({ prompts: [""] });
			const session = new CliOnboardingSession(config, adapter);

			const result = await session.promptForSetting(
				"OPTIONAL",
				config.settings.OPTIONAL,
			);

			expect(result.skipped).toBe(true);
			expect(result.value).toBe("");
		});
	});

	describe("Full Onboarding Flow", () => {
		it("should complete flow with all required settings", async () => {
			const config = createTestConfig({
				MODEL_PROVIDER: {
					required: true,
					name: "Model Provider",
					secret: false,
				},
				API_KEY: {
					required: true,
					name: "API Key",
					dependsOn: ["MODEL_PROVIDER"],
				},
			});
			const adapter = createMockAdapter({
				prompts: ["openai", "sk-test12345678901234567890"],
				confirms: [false], // Don't configure optional
			});

			const session = new CliOnboardingSession(config, adapter);
			const result = await session.run();

			expect(result.completed).toBe(true);
			expect(result.results.MODEL_PROVIDER).toBe("openai");
			expect(result.results.API_KEY).toBe("sk-test12345678901234567890");
			expect(result.skipped).toHaveLength(0);
		});

		it("should handle skipped required settings", async () => {
			const config = createTestConfig({
				REQUIRED_KEY: { required: true },
			});
			const adapter = createMockAdapter({
				prompts: [""], // Skip required
				confirms: [false],
			});

			const session = new CliOnboardingSession(config, adapter);
			const result = await session.run();

			expect(result.completed).toBe(false);
			expect(result.skipped).toContain("REQUIRED_KEY");
		});

		it("should prompt for optional settings when confirmed", async () => {
			const config = createTestConfig({
				REQUIRED_KEY: { required: true },
				OPTIONAL_KEY: { required: false, name: "Optional Key" },
			});
			const adapter = createMockAdapter({
				prompts: ["required-value", "optional-value"],
				confirms: [true], // Configure optional
			});

			const session = new CliOnboardingSession(config, adapter);
			const result = await session.run();

			expect(result.completed).toBe(true);
			expect(result.results.REQUIRED_KEY).toBe("required-value");
			expect(result.results.OPTIONAL_KEY).toBe("optional-value");
		});

		it("should skip optional settings when declined", async () => {
			const config = createTestConfig({
				REQUIRED_KEY: { required: true },
				OPTIONAL_KEY: { required: false },
			});
			const adapter = createMockAdapter({
				prompts: ["required-value"],
				confirms: [false], // Skip optional
			});

			const session = new CliOnboardingSession(config, adapter);
			const result = await session.run();

			expect(result.completed).toBe(true);
			expect(result.results.REQUIRED_KEY).toBe("required-value");
			expect(result.results.OPTIONAL_KEY).toBeUndefined();
		});

		it("should respect dependencies in flow", async () => {
			const config = createTestConfig({
				TWITTER_PASSWORD: { required: true, dependsOn: ["TWITTER_USERNAME"] },
				TWITTER_USERNAME: { required: true, dependsOn: [] },
			});
			const adapter = createMockAdapter({
				prompts: ["myuser", "mypass"],
				confirms: [false],
			});

			const session = new CliOnboardingSession(config, adapter);
			const result = await session.run();

			expect(result.completed).toBe(true);
			// Verify order: USERNAME should be prompted before PASSWORD
			expect(adapter.prompt).toHaveBeenNthCalledWith(
				1,
				expect.stringContaining("TWITTER_USERNAME"),
				expect.anything(),
			);
			expect(adapter.prompt).toHaveBeenNthCalledWith(
				2,
				expect.stringContaining("TWITTER_PASSWORD"),
				expect.anything(),
			);
		});
	});

	describe("Results Tracking", () => {
		it("should track results during session", async () => {
			const config = createTestConfig({
				KEY1: { required: true },
				KEY2: { required: true },
			});
			const adapter = createMockAdapter({
				prompts: ["value1", "value2"],
				confirms: [false],
			});

			const session = new CliOnboardingSession(config, adapter);
			await session.run();

			const results = session.getResults();
			expect(results.KEY1).toBe("value1");
			expect(results.KEY2).toBe("value2");
		});

		it("should not include skipped settings in results", async () => {
			const config = createTestConfig({
				KEY1: { required: true },
				KEY2: { required: false },
			});
			const adapter = createMockAdapter({
				prompts: ["value1"],
				confirms: [false], // Skip optional
			});

			const session = new CliOnboardingSession(config, adapter);
			await session.run();

			const results = session.getResults();
			expect(results.KEY1).toBe("value1");
			expect(results.KEY2).toBeUndefined();
		});
	});
});
