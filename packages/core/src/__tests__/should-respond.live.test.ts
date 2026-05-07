import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { InMemoryDatabaseAdapter } from "../database/inMemoryAdapter";
import { shouldRespondTemplate } from "../prompts";
import { AgentRuntime } from "../runtime";
import {
	createOllamaModelHandlers,
	isOllamaAvailable,
} from "../testing/ollama-provider";
import type { Character, State } from "../types";
import { ModelType } from "../types/model";

const runLiveTests = process.env.ELIZA_RUN_LIVE_TESTS === "1";
const liveDescribe = runLiveTests ? describe : describe.skip;
const LIVE_TEST_TIMEOUT_MS = 30_000;

function buildShouldRespondState(recentMessages: string): State {
	return {
		values: {
			agentName: "Eliza",
			providers: [
				"# Character",
				"Eliza is a direct, technically capable assistant for software work.",
				"",
				"# Recent Messages",
				recentMessages,
			].join("\n"),
			availableContexts: "general\ncode\nwallet",
		},
		data: {},
		text: recentMessages,
	};
}

function getClassifierSchema() {
	return [
		{
			field: "name",
			description: "The name of the agent responding",
			validateField: false,
			streamField: false,
		},
		{
			field: "reasoning",
			description: "Your reasoning for this decision",
			validateField: false,
			streamField: false,
		},
		{
			field: "action",
			description:
				"REPLY | RESPOND | IGNORE | STOP (REPLY and RESPOND both mean engage)",
			validateField: false,
			streamField: false,
		},
		{
			field: "primaryContext",
			description: "Primary domain context from available_contexts",
			validateField: false,
			streamField: false,
		},
		{
			field: "secondaryContexts",
			description: "Optional comma-separated additional domain contexts",
			validateField: false,
			streamField: false,
		},
	] as const;
}

liveDescribe("shouldRespond live", () => {
	let runtime: AgentRuntime;
	let adapter: InMemoryDatabaseAdapter;

	beforeAll(async () => {
		if (!(await isOllamaAvailable())) {
			throw new Error(
				"Ollama is required for shouldRespond live tests when ELIZA_RUN_LIVE_TESTS=1",
			);
		}

		const character: Character = {
			name: "Eliza",
			system: "You are a precise assistant used for live prompt validation.",
			bio: ["Precise assistant used for live prompt validation."],
			templates: {},
			messageExamples: [],
			postExamples: [],
			topics: ["testing", "classification"],
			adjectives: ["precise"],
			knowledge: [],
			plugins: [],
			secrets: {},
			settings: {},
		};

		adapter = new InMemoryDatabaseAdapter();
		runtime = new AgentRuntime({
			character,
			adapter,
			logLevel: "warn",
			settings: {
				VALIDATION_LEVEL: "trusted",
			},
		});
		await adapter.init();

		for (const [modelType, handler] of Object.entries(
			createOllamaModelHandlers(),
		)) {
			if (handler) {
				runtime.registerModel(modelType, handler, "ollama");
			}
		}
	});

	afterAll(async () => {
		await runtime.stop();
		await adapter.close();
	});

	async function classify(recentMessages: string) {
		return await runtime.dynamicPromptExecFromState({
			state: buildShouldRespondState(recentMessages),
			params: {
				prompt: shouldRespondTemplate,
				temperature: 0,
				maxTokens: 200,
			},
			schema: getClassifierSchema(),
			options: {
				modelType: ModelType.TEXT_LARGE,
				preferredEncapsulation: "toon",
				contextCheckLevel: 0,
				maxRetries: 1,
			},
		});
	}

	it(
		"replies to an obvious direct question",
		async () => {
			const result = await classify(
				[
					"user-1: morning everyone",
					"user-1: Eliza, can you help me debug this TypeScript type error?",
				].join("\n"),
			);

			expect(result).not.toBeNull();
			const action = String(result?.action ?? "")
				.trim()
				.toUpperCase();

			expect(["REPLY", "RESPOND"]).toContain(action);
		},
		LIVE_TEST_TIMEOUT_MS,
	);

	it(
		"ignores a side-thread addressed to someone else",
		async () => {
			const result = await classify(
				[
					"user-1: @bob can you merge the release branch after lunch?",
					"user-2: sure, I will handle it",
				].join("\n"),
			);

			expect(result).not.toBeNull();
			const action = String(result?.action ?? "")
				.trim()
				.toUpperCase();

			expect(action).toBe("IGNORE");
		},
		LIVE_TEST_TIMEOUT_MS,
	);

	it(
		"ignores a group request addressed to another bot",
		async () => {
			const result = await classify(
				[
					"fishai: @botdick make a github issue in elizaOS/eliza saying test botdick github auth",
				].join("\n"),
			);

			expect(result).not.toBeNull();
			const action = String(result?.action ?? "")
				.trim()
				.toUpperCase();

			expect(action).toBe("IGNORE");
		},
		LIVE_TEST_TIMEOUT_MS,
	);

	it(
		"stops when explicitly told to stop",
		async () => {
			const result = await classify(
				[
					"user-1: Eliza stop. This is a direct instruction for you to end the run and stop talking immediately.",
				].join("\n"),
			);

			expect(result).not.toBeNull();
			expect(
				String(result?.action ?? "")
					.trim()
					.toUpperCase(),
			).toBe("STOP");
		},
		LIVE_TEST_TIMEOUT_MS,
	);
});
