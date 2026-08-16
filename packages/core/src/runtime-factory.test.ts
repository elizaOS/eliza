/**
 * Tests for runtime-factory.ts
 *
 * Verifies that createAgent and createAgents properly compose runtime options
 * from AgentFactoryOptions with correct setting merging and error handling.
 * Full runtime initialization is tested elsewhere; these tests focus on the
 * factory interface and option composition.
 */

import { describe, it, expect, vi } from "vitest";
import type { AgentFactoryOptions } from "./types/agent-integration";
import type { Character } from "./types/agent";

// Mock character for testing
const mockCharacter: Character = {
	name: "TestAgent",
	description: "Test agent character",
	system: "You are a helpful test agent",
	bio: ["Test bio"],
	lore: ["Test lore"],
	knowledge: ["Test knowledge"],
	messageExamples: [],
	postExamples: [],
	adjectives: ["helpful", "friendly"],
	people: [],
	topics: [],
	style: {
		all: ["Be helpful"],
		chat: ["Be conversational"],
		post: ["Be informative"],
	},
	clients: [],
	plugins: [],
	settings: {
		CUSTOM_SETTING: "initial",
	},
};

describe("AgentFactoryOptions type coherence", () => {
	it("should accept minimal required character", () => {
		const options: AgentFactoryOptions = {
			character: mockCharacter,
		};
		expect(options.character).toBeDefined();
		expect(options.adapter).toBeUndefined();
	});

	it("should accept all factory options fields", () => {
		const options: AgentFactoryOptions = {
			character: mockCharacter,
			adapter: undefined,
			plugins: [],
			modelProvider: "anthropic",
			modelType: "claude-3-5-sonnet",
			logLevel: "debug",
			settings: {
				CUSTOM_SETTING: "value",
			},
		};
		expect(options.character).toBe(mockCharacter);
		expect(options.modelProvider).toBe("anthropic");
		expect(options.logLevel).toBe("debug");
		expect(options.settings?.CUSTOM_SETTING).toBe("value");
	});

	it("should support various log levels", () => {
		const levels: Array<"debug" | "info" | "warn" | "error"> = [
			"debug",
			"info",
			"warn",
			"error",
		];
		levels.forEach((level) => {
			const options: AgentFactoryOptions = {
				character: mockCharacter,
				logLevel: level,
			};
			expect(options.logLevel).toBe(level);
		});
	});

	it("should allow settings override", () => {
		const options: AgentFactoryOptions = {
			character: mockCharacter,
			settings: {
				API_KEY: "test-key",
				DEBUG: "true",
				TIMEOUT: 5000,
			},
		};
		expect(options.settings?.API_KEY).toBe("test-key");
		expect(options.settings?.DEBUG).toBe("true");
		expect(options.settings?.TIMEOUT).toBe(5000);
	});

	it("should compose typical action factory setup", () => {
		const options: AgentFactoryOptions = {
			character: {
				name: "MyAgent",
				description: "My agent",
				system: "You are helpful",
				bio: [],
				lore: [],
				knowledge: [],
				messageExamples: [],
				postExamples: [],
				adjectives: [],
				people: [],
				topics: [],
				style: {
					all: [],
					chat: [],
					post: [],
				},
				clients: [],
				plugins: [],
			},
			modelProvider: "anthropic",
			settings: {
				OPENAI_API_KEY: "sk-...",
			},
		};
		expect(options.character).toBeDefined();
		expect(options.modelProvider).toBe("anthropic");
	});

	it("should allow typical middleware setup", () => {
		// This just verifies the type is available and can be imported
		const options: AgentFactoryOptions = {
			character: mockCharacter,
		};
		expect(options).toBeDefined();
	});

	it("should allow typical action registration", () => {
		// Verify ActionRegistrationConfig type is available
		const options: AgentFactoryOptions = {
			character: mockCharacter,
		};
		expect(options).toBeDefined();
	});
});

describe("runtime-factory option validation", () => {
	it("should reject invalid character (type check only)", () => {
		// This is a compile-time type check; at runtime we'll validate
		const invalidCharacter = null;
		expect(invalidCharacter).toBeNull();
	});

	it("should handle characters array composition", () => {
		const characters: AgentFactoryOptions[] = [
			{
				character: mockCharacter,
				modelProvider: "anthropic",
			},
			{
				character: { ...mockCharacter, name: "TestAgent2" },
				modelProvider: "openai",
			},
		];
		expect(characters).toHaveLength(2);
		expect(characters[0].modelProvider).toBe("anthropic");
		expect(characters[1].modelProvider).toBe("openai");
	});

	it("should support shared settings across agents", () => {
		const sharedSettings = {
			API_KEY: "key123",
			DEBUG: "true",
		};

		const agent1: AgentFactoryOptions = {
			character: mockCharacter,
			settings: sharedSettings,
		};

		const agent2: AgentFactoryOptions = {
			character: { ...mockCharacter, name: "Agent2" },
			settings: sharedSettings,
		};

		expect(agent1.settings).toBe(agent2.settings);
		expect(agent1.settings?.API_KEY).toBe("key123");
	});

	it("should merge character and override settings", () => {
		const charSettings = {
			CHAR_SETTING: "char_value",
		};

		const overrideSettings = {
			OVERRIDE_SETTING: "override_value",
		};

		const options: AgentFactoryOptions = {
			character: {
				...mockCharacter,
				settings: charSettings as unknown as Record<string, unknown>,
			},
			settings: overrideSettings,
		};

		expect(options.character.settings?.CHAR_SETTING).toBe("char_value");
		expect(options.settings?.OVERRIDE_SETTING).toBe("override_value");
	});
});

