import { describe, expect, it } from "vitest";
import { InMemoryDatabaseAdapter } from "../database/inMemoryAdapter";
import { AgentRuntime } from "../runtime";
import { ModelType } from "../types/model";
import type { State } from "../types/state";

function createRuntime(): AgentRuntime {
	return new AgentRuntime({
		character: {
			name: "Dynamic Prompt Format",
			username: "dynamic-prompt-format",
			clients: [],
			settings: {},
		},
		adapter: new InMemoryDatabaseAdapter(),
		enableKnowledge: false,
		enableRelationships: false,
		enableTrajectories: false,
	});
}

function emptyState(): State {
	return { values: {}, data: {}, text: "" } as State;
}

describe("dynamicPromptExecFromState format selection", () => {
	it("defaults nested schemas to TOON instead of JSON", async () => {
		const runtime = createRuntime();
		let capturedPrompt = "";

		runtime.registerModel(
			ModelType.TEXT_LARGE,
			async (_runtime, params) => {
				capturedPrompt = String(params.prompt ?? "");
				return "meta:\n  count: 1";
			},
			"test",
		);

		await runtime.initialize({
			allowNoDatabase: true,
			skipMigrations: true,
		});

		const result = await runtime.dynamicPromptExecFromState({
			state: emptyState(),
			params: { prompt: "Return the requested fields." },
			schema: [
				{
					field: "meta",
					description: "Metadata",
					type: "object",
					properties: [
						{
							field: "count",
							description: "Number of collected items",
							type: "number",
							required: true,
						},
					],
					required: true,
				},
			],
			options: {
				modelType: ModelType.TEXT_LARGE,
				contextCheckLevel: 0,
				maxRetries: 0,
			},
		});

		expect(capturedPrompt).toContain("Return only TOON");
		expect(capturedPrompt).toContain("Return exactly one TOON document");
		expect(capturedPrompt).not.toContain("Return only JSON");
		expect(capturedPrompt).not.toContain("JSON object");
		expect(result).toEqual({
			meta: { count: 1 },
		});
	});

	it("preserves an explicit JSON preference", async () => {
		const runtime = createRuntime();
		let capturedPrompt = "";

		runtime.registerModel(
			ModelType.TEXT_LARGE,
			async (_runtime, params) => {
				capturedPrompt = String(params.prompt ?? "");
				return '{"items":["value"],"meta":{"count":1}}';
			},
			"test",
		);

		await runtime.initialize({
			allowNoDatabase: true,
			skipMigrations: true,
		});

		const result = await runtime.dynamicPromptExecFromState({
			state: emptyState(),
			params: { prompt: "Return the requested fields." },
			schema: [
				{
					field: "items",
					description: "Collected items",
					type: "array",
					items: { description: "One item" },
					required: true,
				},
				{
					field: "meta",
					description: "Metadata",
					type: "object",
					properties: [
						{
							field: "count",
							description: "Number of collected items",
							type: "number",
							required: true,
						},
					],
					required: true,
				},
			],
			options: {
				modelType: ModelType.TEXT_LARGE,
				preferredEncapsulation: "json",
				contextCheckLevel: 0,
				maxRetries: 0,
			},
		});

		expect(capturedPrompt).toContain("Return only JSON");
		expect(capturedPrompt).toContain("Return exactly one JSON object");
		expect(result).toEqual({
			items: ["value"],
			meta: { count: 1 },
		});
	});

	it("streams only TOON text fields from structured planner output", async () => {
		const runtime = createRuntime();
		const response =
			"thought: hidden\nactions[1]: REPLY\nproviders[0]:\ntext: Visible reply\nsimple: true\n";
		const streamedChunks: string[] = [];

		runtime.registerModel(
			ModelType.TEXT_LARGE,
			async () => ({
				text: Promise.resolve(response),
				textStream: (async function* () {
					yield "thought: hidden\n";
					yield "actions[1]: RE";
					yield "PLY\nproviders[0]:\n";
					yield "text: Visible ";
					yield "reply\nsimple: true\n";
				})(),
				usage: Promise.resolve(undefined),
				finishReason: Promise.resolve("stop"),
			}),
			"test",
		);

		await runtime.initialize({
			allowNoDatabase: true,
			skipMigrations: true,
		});

		const result = await runtime.dynamicPromptExecFromState({
			state: emptyState(),
			params: { prompt: "Return a reply." },
			schema: [
				{
					field: "thought",
					description: "Internal reasoning",
					validateField: false,
					streamField: false,
				},
				{
					field: "actions",
					description: "Action names",
					type: "array",
					items: { description: "One action name" },
					validateField: false,
					streamField: false,
				},
				{
					field: "providers",
					description: "Provider names",
					type: "array",
					items: { description: "One provider name" },
					validateField: false,
					streamField: false,
				},
				{
					field: "text",
					description: "User-facing text",
					required: true,
					streamField: true,
				},
				{
					field: "simple",
					description: "Whether this is a simple reply",
					type: "boolean",
					validateField: false,
					streamField: false,
				},
			],
			options: {
				modelType: ModelType.TEXT_LARGE,
				preferredEncapsulation: "toon",
				contextCheckLevel: 0,
				maxRetries: 0,
				onStreamChunk: async (chunk) => {
					streamedChunks.push(chunk);
				},
			},
		});

		expect(result?.text).toBe("Visible reply");
		expect(streamedChunks.join("")).toBe("Visible reply");
		expect(streamedChunks.join("")).not.toContain("thought:");
		expect(streamedChunks.join("")).not.toContain("actions");
		expect(streamedChunks.join("")).not.toContain("providers");
	});
});
