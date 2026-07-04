/**
 * Exercises `composePromptFromState` with both string and function (callback)
 * templates, and confirms `characterSchema` accepts function template values
 * while rejecting non-string/non-function ones. Deterministic: pure prompt
 * composition, no model.
 */
import { describe, expect, it } from "vitest";
import { characterSchema } from "../schemas/character";
import type { Character } from "../types/agent";
import type { State } from "../types/state";
import { composePromptFromState } from "../utils";

describe("Character Callback Templates", () => {
	it("should support string templates (existing behavior)", async () => {
		const template = "Hello, {{agentName}}!";
		const state: State = {
			agentName: "Alice",
			values: {},
			data: {},
			text: "",
		};

		const result = composePromptFromState({ state, template });
		expect(result).toContain("Alice");
	});

	it("should support callback templates that return strings", async () => {
		const template = ({
			state,
		}: {
			state: State | Record<string, unknown>;
		}) => {
			const agentName =
				typeof state === "object" && "agentName" in state
					? (state.agentName as string)
					: "Unknown";
			return `Hello, ${agentName}!`;
		};

		const state: State = {
			agentName: "Bob",
			values: {},
			data: {},
			text: "",
		};

		const result = composePromptFromState({ state, template });
		expect(result).toContain("Bob");
	});

	it("should support callbacks with dynamic logic", async () => {
		const template = ({
			state,
		}: {
			state: State | Record<string, unknown>;
		}) => {
			const stateObj = state as Record<string, unknown>;
			const tone = stateObj.formalTone ? "formal" : "casual";
			return `Respond in a {{tone}} manner. {{agentName}} here.`.replace(
				"{{tone}}",
				tone,
			);
		};

		const state: State = {
			agentName: "Charlie",
			formalTone: true,
			values: {},
			data: {},
			text: "",
		};

		const result = composePromptFromState({ state, template });
		expect(result).toContain("formal");
		expect(result).toContain("Charlie");
	});

	it("should handle mixed string and callback templates in character", async () => {
		const stringTemplate = "Simple string template";
		const callbackTemplate = ({
			state,
		}: {
			state: State | Record<string, unknown>;
		}) => {
			const stateObj = state as Record<string, unknown>;
			return `Dynamic template with ${stateObj.agentName || "agent"}`;
		};
		const character: Character = {
			name: "TestAgent",
			templates: { stringTemplate, callbackTemplate },
		};
		expect(character.templates).toBeDefined();

		const state: State = {
			agentName: "TestAgent",
			values: {},
			data: {},
			text: "",
		};

		// Test string template
		const stringResult = composePromptFromState({
			state,
			template: stringTemplate,
		});
		expect(stringResult).toBe("Simple string template");

		// Test callback template
		const callbackResult = composePromptFromState({
			state,
			template: callbackTemplate,
		});
		expect(callbackResult).toContain("Dynamic template");
		expect(callbackResult).toContain("TestAgent");
	});

	it("should allow callbacks to access full state context", async () => {
		const template = ({
			state,
		}: {
			state: State | Record<string, unknown>;
		}) => {
			const stateObj = state as State;
			return `Agent: {{agentName}}, Context: {{roomId}}`.replace(
				/\{\{(\w+)\}\}/g,
				(_match, key) => {
					const value = stateObj[key as keyof State];
					return typeof value === "string" ? value : String(value);
				},
			);
		};

		const state: State = {
			agentName: "David",
			roomId: "room-123",
			values: {},
			data: {},
			text: "",
		};

		const result = composePromptFromState({ state, template });
		expect(result).toContain("David");
		expect(result).toContain("room-123");
	});
});

describe("characterSchema templates field accepts callbacks", () => {
	it("accepts string template values (baseline)", () => {
		const result = characterSchema.safeParse({
			name: "Tmpl",
			templates: { greeting: "Hello there" },
		});
		expect(result.success).toBe(true);
	});

	it("accepts a function template value", () => {
		const result = characterSchema.safeParse({
			name: "Tmpl",
			templates: { rateLimitedReply: () => "slow down a sec" },
		});
		expect(result.success).toBe(true);
	});

	it("rejects a template value that is neither string nor function", () => {
		const result = characterSchema.safeParse({
			name: "Tmpl",
			templates: { bad: 123 },
		});
		expect(result.success).toBe(false);
	});
});
