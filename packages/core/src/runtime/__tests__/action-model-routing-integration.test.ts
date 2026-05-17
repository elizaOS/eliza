/**
 * Per-action model routing — runtime integration test.
 *
 * Verifies the end-to-end seam: a real `AgentRuntime` with multiple model
 * registrations honors `Action.modelClass` when the action handler calls
 * `runtime.useModel(...)`. Closes W1-R2.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { InMemoryDatabaseAdapter } from "../../database/inMemoryAdapter";
import { AgentRuntime } from "../../runtime";
import {
	type Action,
	type Character,
	type Memory,
	ModelType,
} from "../../types";

function makeCharacter(): Character {
	return {
		name: "RoutingTestAgent",
		bio: "test",
		settings: {},
	} as Character;
}

function makeMessage(): Memory {
	return {
		id: "00000000-0000-0000-0000-00000000000a" as Memory["id"],
		entityId: "00000000-0000-0000-0000-00000000000b" as Memory["entityId"],
		roomId: "00000000-0000-0000-0000-00000000000c" as Memory["roomId"],
		content: { text: "test message", source: "test" },
	} as Memory;
}

describe("action model routing — runtime integration", () => {
	let runtime: AgentRuntime;
	let ollamaHandler: ReturnType<typeof vi.fn>;
	let openaiSmallHandler: ReturnType<typeof vi.fn>;
	let anthropicLargeHandler: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		runtime = new AgentRuntime({
			character: makeCharacter(),
			adapter: new InMemoryDatabaseAdapter(),
			logLevel: "fatal",
		});
		runtime.composeState = async () => ({ values: {}, data: {}, text: "" });

		ollamaHandler = vi.fn(async () => "ollama-response");
		openaiSmallHandler = vi.fn(async () => "openai-small-response");
		anthropicLargeHandler = vi.fn(async () => "anthropic-large-response");

		runtime.registerModel(ModelType.TEXT_SMALL, ollamaHandler, "ollama");
		runtime.registerModel(ModelType.TEXT_SMALL, openaiSmallHandler, "openai");
		runtime.registerModel(
			ModelType.TEXT_LARGE,
			anthropicLargeHandler,
			"anthropic",
		);
	});

	it("modelClass='LOCAL' routes useModel(TEXT_LARGE) to the local handler", async () => {
		const action: Action = {
			name: "LOCAL_ACTION",
			description: "Always runs on the local model.",
			modelClass: "LOCAL",
			mode: "ALWAYS_AFTER",
			examples: [],
			validate: async () => true,
			handler: async () => {
				// Action requests TEXT_LARGE — the runtime should re-route to LOCAL.
				const text = await runtime.useModel(ModelType.TEXT_LARGE, {
					prompt: "hi",
				});
				return { success: true, text };
			},
		};
		runtime.actions.length = 0;
		runtime.actions.push(action);

		await runtime.runActionsByMode("ALWAYS_AFTER", makeMessage());

		expect(ollamaHandler).toHaveBeenCalledTimes(1);
		expect(openaiSmallHandler).not.toHaveBeenCalled();
		expect(anthropicLargeHandler).not.toHaveBeenCalled();
	});

	it("modelClass='TEXT_SMALL' routes to the small cloud handler (first non-filtered)", async () => {
		const action: Action = {
			name: "SMALL_ACTION",
			description: "Runs on a small model.",
			modelClass: "TEXT_SMALL",
			mode: "ALWAYS_AFTER",
			examples: [],
			validate: async () => true,
			handler: async () => {
				const text = await runtime.useModel(ModelType.TEXT_LARGE, {
					prompt: "hi",
				});
				return { success: true, text };
			},
		};
		runtime.actions.length = 0;
		runtime.actions.push(action);

		await runtime.runActionsByMode("ALWAYS_AFTER", makeMessage());

		// TEXT_SMALL chain: first registered TEXT_SMALL handler wins.
		// Both `ollama` and `openai` are registered for TEXT_SMALL; the registry
		// preserves registration order at equal priority, so `ollama` wins.
		expect(ollamaHandler).toHaveBeenCalledTimes(1);
		expect(openaiSmallHandler).not.toHaveBeenCalled();
		expect(anthropicLargeHandler).not.toHaveBeenCalled();
	});

	it("modelClass='TEXT_LARGE' routes to the large handler", async () => {
		const action: Action = {
			name: "LARGE_ACTION",
			description: "Runs on a large model.",
			modelClass: "TEXT_LARGE",
			mode: "ALWAYS_AFTER",
			examples: [],
			validate: async () => true,
			handler: async () => {
				const text = await runtime.useModel(ModelType.TEXT_SMALL, {
					prompt: "hi",
				});
				return { success: true, text };
			},
		};
		runtime.actions.length = 0;
		runtime.actions.push(action);

		await runtime.runActionsByMode("ALWAYS_AFTER", makeMessage());

		expect(anthropicLargeHandler).toHaveBeenCalledTimes(1);
		expect(ollamaHandler).not.toHaveBeenCalled();
		expect(openaiSmallHandler).not.toHaveBeenCalled();
	});

	it("back-compat: action with no modelClass uses default resolution", async () => {
		const action: Action = {
			name: "DEFAULT_ACTION",
			description: "No modelClass set.",
			mode: "ALWAYS_AFTER",
			examples: [],
			validate: async () => true,
			handler: async () => {
				const text = await runtime.useModel(ModelType.TEXT_LARGE, {
					prompt: "hi",
				});
				return { success: true, text };
			},
		};
		runtime.actions.length = 0;
		runtime.actions.push(action);

		await runtime.runActionsByMode("ALWAYS_AFTER", makeMessage());

		// Direct request honored: TEXT_LARGE → anthropic.
		expect(anthropicLargeHandler).toHaveBeenCalledTimes(1);
		expect(ollamaHandler).not.toHaveBeenCalled();
	});

	it("fallback: LOCAL with no local handler registered falls through to the cloud TEXT_SMALL", async () => {
		// Re-create runtime with NO local handler.
		const runtime2 = new AgentRuntime({
			character: makeCharacter(),
			adapter: new InMemoryDatabaseAdapter(),
			logLevel: "fatal",
		});
		runtime2.composeState = async () => ({ values: {}, data: {}, text: "" });

		const openaiOnly = vi.fn(async () => "openai-fallback");
		const anthropicOnly = vi.fn(async () => "anthropic-fallback");
		runtime2.registerModel(ModelType.TEXT_SMALL, openaiOnly, "openai");
		runtime2.registerModel(ModelType.TEXT_LARGE, anthropicOnly, "anthropic");

		const action: Action = {
			name: "LOCAL_NO_LOCAL_HANDLER",
			description: "LOCAL with no local provider available.",
			modelClass: "LOCAL",
			mode: "ALWAYS_AFTER",
			examples: [],
			validate: async () => true,
			handler: async () => {
				const text = await runtime2.useModel(ModelType.TEXT_LARGE, {
					prompt: "hi",
				});
				return { success: true, text };
			},
		};
		runtime2.actions.length = 0;
		runtime2.actions.push(action);

		await runtime2.runActionsByMode("ALWAYS_AFTER", makeMessage());

		// No local-tagged TEXT_SMALL → chain skips that step. Next steps:
		//   2. TEXT_SMALL unfiltered → openai-fallback
		//   (TEXT_LARGE is later in chain — not reached on success)
		expect(openaiOnly).toHaveBeenCalledTimes(1);
		expect(anthropicOnly).not.toHaveBeenCalled();
	});

	it("fallback: handler error escalates one step up the chain", async () => {
		const runtime3 = new AgentRuntime({
			character: makeCharacter(),
			adapter: new InMemoryDatabaseAdapter(),
			logLevel: "fatal",
		});
		runtime3.composeState = async () => ({ values: {}, data: {}, text: "" });

		const ollamaFails = vi.fn(async () => {
			throw new Error("ollama: connection refused");
		});
		const openaiOk = vi.fn(async () => "openai-after-fallback");
		const anthropicOk = vi.fn(async () => "anthropic-unused");
		runtime3.registerModel(ModelType.TEXT_SMALL, ollamaFails, "ollama");
		runtime3.registerModel(ModelType.TEXT_SMALL, openaiOk, "openai");
		runtime3.registerModel(ModelType.TEXT_LARGE, anthropicOk, "anthropic");

		const action: Action = {
			name: "LOCAL_WITH_ERROR",
			description: "LOCAL with a flaky local handler.",
			modelClass: "LOCAL",
			mode: "ALWAYS_AFTER",
			examples: [],
			validate: async () => true,
			handler: async () => {
				const text = await runtime3.useModel(ModelType.TEXT_LARGE, {
					prompt: "hi",
				});
				return { success: true, text };
			},
		};
		runtime3.actions.length = 0;
		runtime3.actions.push(action);

		await runtime3.runActionsByMode("ALWAYS_AFTER", makeMessage());

		// Step 1: ollama (local-filtered TEXT_SMALL) → throws.
		// Step 2: openai (unfiltered TEXT_SMALL) → succeeds.
		expect(ollamaFails).toHaveBeenCalledTimes(1);
		expect(openaiOk).toHaveBeenCalledTimes(1);
		expect(anthropicOk).not.toHaveBeenCalled();
	});
});
