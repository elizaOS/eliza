/**
 * Onboarding State Machine Tests
 *
 * Tests for the onboarding state management, transitions, serialization,
 * and validation. Note: The actual onboarding implementation lives in
 * plugin-secrets-manager, but we test the core config utilities here.
 */

import { describe, expect, it } from "vitest";

// ============================================================================
// Types and Utilities (mirrored from plugin-secrets-manager for testing)
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
	validationMethod?: string;
	type?: string;
	envVar?: string;
	defaultValue?: string;
	value?: string | null;
	visibleIf?: (settings: Record<string, OnboardingSetting>) => boolean;
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
	mode?: "conversational" | "form" | "hybrid";
}

/**
 * Get unconfigured required settings from an onboarding config.
 */
function getUnconfiguredRequired(
	config: OnboardingConfig,
): Array<[string, OnboardingSetting]> {
	return Object.entries(config.settings).filter(
		([_, setting]) => setting.required && setting.value == null,
	);
}

/**
 * Get unconfigured optional settings from an onboarding config.
 */
function getUnconfiguredOptional(
	config: OnboardingConfig,
): Array<[string, OnboardingSetting]> {
	return Object.entries(config.settings).filter(
		([_, setting]) => !setting.required && setting.value === null,
	);
}

/**
 * Check if all required settings are configured.
 */
function isOnboardingComplete(config: OnboardingConfig): boolean {
	return getUnconfiguredRequired(config).length === 0;
}

/**
 * Get the next setting to configure (respects dependencies).
 */
function getNextSetting(
	config: OnboardingConfig,
): [string, OnboardingSetting] | null {
	const unconfigured = getUnconfiguredRequired(config);

	for (const [key, setting] of unconfigured) {
		const dependenciesMet = setting.dependsOn.every((dep) => {
			const depSetting = config.settings[dep];
			return depSetting && depSetting.value !== null;
		});

		const isVisible = !setting.visibleIf || setting.visibleIf(config.settings);

		if (dependenciesMet && isVisible) {
			return [key, setting];
		}
	}

	const optionalUnconfigured = getUnconfiguredOptional(config);
	for (const [key, setting] of optionalUnconfigured) {
		const dependenciesMet = setting.dependsOn.every((dep) => {
			const depSetting = config.settings[dep];
			return depSetting && depSetting.value !== null;
		});
		const isVisible = !setting.visibleIf || setting.visibleIf(config.settings);

		if (dependenciesMet && isVisible) {
			return [key, setting];
		}
	}

	return null;
}

/**
 * Serialize onboarding state to JSON.
 */
function serializeOnboardingState(config: OnboardingConfig): string {
	const serialized = {
		settings: Object.fromEntries(
			Object.entries(config.settings).map(([key, setting]) => [
				key,
				{
					name: setting.name,
					description: setting.description,
					required: setting.required,
					value: setting.value,
					type: setting.type,
				},
			]),
		),
		mode: config.mode,
	};
	return JSON.stringify(serialized);
}

/**
 * Deserialize onboarding state from JSON.
 */
function deserializeOnboardingState(
	json: string,
	baseConfig: OnboardingConfig,
): OnboardingConfig {
	const parsed = JSON.parse(json) as {
		settings: Record<string, { value?: string | null }>;
		mode?: "conversational" | "form" | "hybrid";
	};

	const restored: OnboardingConfig = {
		...baseConfig,
		mode: parsed.mode || baseConfig.mode,
		settings: { ...baseConfig.settings },
	};

	for (const [key, data] of Object.entries(parsed.settings)) {
		if (restored.settings[key]) {
			restored.settings[key] = {
				...restored.settings[key],
				value: data.value ?? null,
			};
		}
	}

	return restored;
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
			visibleIf: partial.visibleIf,
			...partial,
		};
	}

	return { settings: fullSettings };
}

// ============================================================================
// Tests
// ============================================================================

describe("Onboarding State Machine", () => {
	describe("State Transitions", () => {
		it("should identify unconfigured required settings", () => {
			const config = createTestConfig({
				OPENAI_API_KEY: { required: true, value: null },
				OPTIONAL_KEY: { required: false, value: null },
			});

			const unconfigured = getUnconfiguredRequired(config);
			expect(unconfigured).toHaveLength(1);
			expect(unconfigured[0][0]).toBe("OPENAI_API_KEY");
		});

		it("should identify unconfigured optional settings", () => {
			const config = createTestConfig({
				REQUIRED_KEY: { required: true, value: "configured" },
				OPTIONAL_KEY: { required: false, value: null },
			});

			const optional = getUnconfiguredOptional(config);
			expect(optional).toHaveLength(1);
			expect(optional[0][0]).toBe("OPTIONAL_KEY");
		});

		it("should mark onboarding complete when all required are configured", () => {
			const config = createTestConfig({
				KEY1: { required: true, value: "value1" },
				KEY2: { required: true, value: "value2" },
				OPTIONAL: { required: false, value: null },
			});

			expect(isOnboardingComplete(config)).toBe(true);
		});

		it("should mark onboarding incomplete when required settings missing", () => {
			const config = createTestConfig({
				KEY1: { required: true, value: "value1" },
				KEY2: { required: true, value: null },
			});

			expect(isOnboardingComplete(config)).toBe(false);
		});

		it("should transition from unconfigured to configured state", () => {
			const config = createTestConfig({
				KEY1: { required: true, value: null },
			});

			expect(isOnboardingComplete(config)).toBe(false);

			// Simulate setting the value
			config.settings.KEY1.value = "configured-value";

			expect(isOnboardingComplete(config)).toBe(true);
		});
	});

	describe("Dependency Resolution", () => {
		it("should respect dependencies when getting next setting", () => {
			const config = createTestConfig({
				TWITTER_USERNAME: { required: true, value: null, dependsOn: [] },
				TWITTER_PASSWORD: {
					required: true,
					value: null,
					dependsOn: ["TWITTER_USERNAME"],
				},
				TWITTER_2FA: {
					required: true,
					value: null,
					dependsOn: ["TWITTER_USERNAME", "TWITTER_PASSWORD"],
				},
			});

			// Should get USERNAME first (no dependencies)
			let next = getNextSetting(config);
			expect(next?.[0]).toBe("TWITTER_USERNAME");

			// Configure USERNAME
			config.settings.TWITTER_USERNAME.value = "myuser";

			// Now should get PASSWORD
			next = getNextSetting(config);
			expect(next?.[0]).toBe("TWITTER_PASSWORD");

			// Configure PASSWORD
			config.settings.TWITTER_PASSWORD.value = "mypass";

			// Now should get 2FA
			next = getNextSetting(config);
			expect(next?.[0]).toBe("TWITTER_2FA");
		});

		it("should skip settings with unmet dependencies", () => {
			const config = createTestConfig({
				CHILD: { required: true, value: null, dependsOn: ["PARENT"] },
				PARENT: { required: true, value: null, dependsOn: [] },
			});

			const next = getNextSetting(config);
			expect(next?.[0]).toBe("PARENT");
		});

		it("should handle circular dependencies gracefully", () => {
			const config = createTestConfig({
				A: { required: true, value: null, dependsOn: ["B"] },
				B: { required: true, value: null, dependsOn: ["A"] },
			});

			// Both have unmet dependencies, neither should be returned
			const next = getNextSetting(config);
			expect(next).toBeNull();
		});
	});

	describe("Visibility Conditions", () => {
		it("should respect visibleIf conditions", () => {
			const config = createTestConfig({
				MODEL_PROVIDER: { required: true, value: null, dependsOn: [] },
				OPENAI_KEY: {
					required: true,
					value: null,
					dependsOn: ["MODEL_PROVIDER"],
					visibleIf: (settings) => settings.MODEL_PROVIDER?.value === "openai",
				},
				ANTHROPIC_KEY: {
					required: true,
					value: null,
					dependsOn: ["MODEL_PROVIDER"],
					visibleIf: (settings) =>
						settings.MODEL_PROVIDER?.value === "anthropic",
				},
			});

			// First setting should be MODEL_PROVIDER
			let next = getNextSetting(config);
			expect(next?.[0]).toBe("MODEL_PROVIDER");

			// Set to openai
			config.settings.MODEL_PROVIDER.value = "openai";

			// Should only show OPENAI_KEY, not ANTHROPIC_KEY
			next = getNextSetting(config);
			expect(next?.[0]).toBe("OPENAI_KEY");

			// Reset and set to anthropic
			config.settings.MODEL_PROVIDER.value = "anthropic";
			config.settings.OPENAI_KEY.value = null;

			next = getNextSetting(config);
			expect(next?.[0]).toBe("ANTHROPIC_KEY");
		});
	});

	describe("Serialization/Deserialization", () => {
		it("should serialize onboarding state to JSON", () => {
			const config = createTestConfig({
				KEY1: { name: "Key One", required: true, value: "value1" },
				KEY2: { name: "Key Two", required: false, value: null },
			});
			config.mode = "conversational";

			const json = serializeOnboardingState(config);
			const parsed = JSON.parse(json);

			expect(parsed.settings.KEY1.value).toBe("value1");
			expect(parsed.settings.KEY2.value).toBeNull();
			expect(parsed.mode).toBe("conversational");
		});

		it("should deserialize onboarding state from JSON", () => {
			const baseConfig = createTestConfig({
				KEY1: { name: "Key One", required: true, value: null },
				KEY2: { name: "Key Two", required: false, value: null },
			});

			const savedState = JSON.stringify({
				settings: {
					KEY1: { value: "restored-value" },
					KEY2: { value: null },
				},
				mode: "form",
			});

			const restored = deserializeOnboardingState(savedState, baseConfig);

			expect(restored.settings.KEY1.value).toBe("restored-value");
			expect(restored.settings.KEY1.name).toBe("Key One"); // Preserves base config
			expect(restored.mode).toBe("form");
		});

		it("should handle partial state restoration", () => {
			const baseConfig = createTestConfig({
				KEY1: { required: true },
				KEY2: { required: true },
				KEY3: { required: false },
			});

			// Only KEY1 was saved
			const partialState = JSON.stringify({
				settings: {
					KEY1: { value: "saved" },
				},
			});

			const restored = deserializeOnboardingState(partialState, baseConfig);

			expect(restored.settings.KEY1.value).toBe("saved");
			expect(restored.settings.KEY2.value).toBeNull();
			expect(restored.settings.KEY3.value).toBeNull();
		});

		it("should ignore unknown keys in serialized state", () => {
			const baseConfig = createTestConfig({
				KEY1: { required: true },
			});

			const stateWithUnknown = JSON.stringify({
				settings: {
					KEY1: { value: "valid" },
					UNKNOWN_KEY: { value: "ignored" },
				},
			});

			const restored = deserializeOnboardingState(stateWithUnknown, baseConfig);

			expect(restored.settings.KEY1.value).toBe("valid");
			expect(restored.settings.UNKNOWN_KEY).toBeUndefined();
		});
	});

	describe("Step Validations", () => {
		it("should validate step values with custom validation function", () => {
			const config = createTestConfig({
				EMAIL: {
					required: true,
					value: null,
					validation: (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v),
				},
			});

			const emailSetting = config.settings.EMAIL;

			expect(emailSetting.validation?.("invalid")).toBe(false);
			expect(emailSetting.validation?.("valid@email.com")).toBe(true);
			expect(emailSetting.validation?.("")).toBe(false);
		});

		it("should validate API key patterns", () => {
			const openaiPattern = /^sk-[a-zA-Z0-9-_]{20,}$/;
			const anthropicPattern = /^sk-ant-[a-zA-Z0-9-_]{20,}$/;
			const groqPattern = /^gsk_[a-zA-Z0-9]{20,}$/;

			expect(openaiPattern.test("sk-proj-abcdefghij1234567890")).toBe(true);
			expect(openaiPattern.test("invalid-key")).toBe(false);

			expect(
				anthropicPattern.test("sk-ant-api03-abcdefghij1234567890123456"),
			).toBe(true);
			expect(anthropicPattern.test("sk-ant-short")).toBe(false);

			expect(groqPattern.test("gsk_abcdefghij1234567890")).toBe(true);
			expect(groqPattern.test("gsk_short")).toBe(false);
		});
	});

	describe("Error Handling", () => {
		it("should handle empty config gracefully", () => {
			const config: OnboardingConfig = { settings: {} };

			expect(isOnboardingComplete(config)).toBe(true);
			expect(getUnconfiguredRequired(config)).toHaveLength(0);
			expect(getNextSetting(config)).toBeNull();
		});

		it("should handle all optional config", () => {
			const config = createTestConfig({
				OPT1: { required: false, value: null },
				OPT2: { required: false, value: null },
			});

			expect(isOnboardingComplete(config)).toBe(true);

			// Should still return optional settings if available
			const next = getNextSetting(config);
			expect(next).not.toBeNull();
		});

		it("should handle malformed JSON gracefully", () => {
			const baseConfig = createTestConfig({
				KEY1: { required: true },
			});

			expect(() => {
				deserializeOnboardingState("invalid json", baseConfig);
			}).toThrow();
		});

		it("should handle null values in settings", () => {
			const config = createTestConfig({
				KEY1: { required: true, value: null },
				KEY2: { required: true, value: undefined as unknown as null },
			});

			const unconfigured = getUnconfiguredRequired(config);
			expect(unconfigured).toHaveLength(2);
		});
	});

	describe("Full Onboarding Flow", () => {
		it("should complete a full onboarding flow", () => {
			const config = createTestConfig({
				MODEL_PROVIDER: { required: true, dependsOn: [] },
				API_KEY: { required: true, dependsOn: ["MODEL_PROVIDER"] },
				VOICE_ENABLED: { required: false, dependsOn: [] },
			});

			// Start: not complete
			expect(isOnboardingComplete(config)).toBe(false);

			// Step 1: Configure MODEL_PROVIDER
			let next = getNextSetting(config);
			expect(next?.[0]).toBe("MODEL_PROVIDER");
			config.settings.MODEL_PROVIDER.value = "openai";

			// Step 2: Configure API_KEY
			next = getNextSetting(config);
			expect(next?.[0]).toBe("API_KEY");
			config.settings.API_KEY.value = "sk-test-key-12345678901234567890";

			// Should be complete now (only required matters)
			expect(isOnboardingComplete(config)).toBe(true);

			// But next setting should return optional
			next = getNextSetting(config);
			expect(next?.[0]).toBe("VOICE_ENABLED");
		});
	});
});
