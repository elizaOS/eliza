/**
 * Exercises AgentRuntime model-registration observability: the
 * `MODEL_REGISTERED` event payload, `getModelRegistrations()` returning
 * handler-free metadata, plugin `modelMetadata` application, and canonical
 * capability admission. A real runtime over the in-memory
 * adapter registers noop handlers — no live model.
 */

import { createSQLiteTestRuntime } from "@elizaos/testing/sqlite-adapter";
import { describe, expect, it, vi } from "vitest";
import type { AgentRuntime } from "../../runtime";
import {
	type Character,
	EventType,
	type ModelRegisteredEventPayload,
	ModelType,
} from "../../types";

function makeRuntime(settings: Record<string, string> = {}): AgentRuntime {
	return createSQLiteTestRuntime({
		character: {
			name: "ModelRegistrationsAgent",
			bio: "test",
		} as Character,

		logLevel: "fatal",
		settings,
	});
}

const noopHandler = async () => "ok";

describe("AgentRuntime model-registration observability", () => {
	it("exposes all registrations through handler-free events and snapshots", async () => {
		const runtime = makeRuntime();
		const seen: ModelRegisteredEventPayload[] = [];
		runtime.registerEvent(EventType.MODEL_REGISTERED, async (payload) => {
			seen.push(payload);
		});

		runtime.registerModel(ModelType.TEXT_LARGE, noopHandler, "provider-a", 50, {
			displayModel: "model-a",
		});
		runtime.registerModel(ModelType.TEXT_LARGE, noopHandler, "provider-b", 10);
		runtime.registerModel(ModelType.TEXT_EMBEDDING, noopHandler, "provider-a");
		// Registration events are fire-and-forget.
		await Promise.resolve();

		const expected = [
			{
				modelType: ModelType.TEXT_LARGE,
				provider: "provider-a",
				priority: 50,
				metadata: { displayModel: "model-a" },
			},
			{ modelType: ModelType.TEXT_LARGE, provider: "provider-b", priority: 10 },
			{
				modelType: ModelType.TEXT_EMBEDDING,
				provider: "provider-a",
				priority: 0,
			},
		];
		const registrations = runtime.getModelRegistrations();
		expect(registrations).toMatchObject(expected);
		expect(seen).toMatchObject(expected);
		for (const entry of [...registrations, ...seen]) {
			expect(entry).not.toHaveProperty("handler");
		}
		for (const registration of registrations) {
			expect(typeof registration.registrationOrder).toBe("number");
		}
	});

	it("applies plugin modelMetadata when registering Plugin.models", async () => {
		const runtime = makeRuntime();

		await runtime.registerPlugin({
			name: "metadata-model-plugin",
			description: "Model metadata registration test",
			models: {
				[ModelType.TEXT_SMALL]: noopHandler,
			},
			modelMetadata: {
				[ModelType.TEXT_SMALL]: {
					displayModelSetting: "PLUGIN_MODEL",
				},
			},
		});

		const registration = runtime
			.getModelRegistrations()
			.find(
				(reg) =>
					reg.modelType === ModelType.TEXT_SMALL &&
					reg.provider === "metadata-model-plugin",
			);
		expect(registration?.metadata).toEqual({
			displayModelSetting: "PLUGIN_MODEL",
		});
	});

	it("prevents a text-only canonical provider from claiming embeddings", async () => {
		const runtime = makeRuntime({
			ELIZA_CANONICAL_LLM_TEXT_ENABLED: "true",
			ELIZA_CANONICAL_EMBEDDINGS_ENABLED: "false",
		});
		const textHandler = vi.fn(async () => "text-owner");
		const embeddingHandler = vi.fn(async () => new Array(384).fill(0));

		runtime.registerModel(ModelType.TEXT_SMALL, textHandler, "openai", 100);
		runtime.registerModel(
			ModelType.TEXT_EMBEDDING,
			embeddingHandler,
			"openai",
			100,
		);

		await expect(
			runtime.useModel(ModelType.TEXT_SMALL, { prompt: "hello" }),
		).resolves.toBe("text-owner");
		expect(runtime.getModel(ModelType.TEXT_EMBEDDING)).toBeUndefined();
		await expect(
			runtime.useModel(ModelType.TEXT_EMBEDDING, null),
		).rejects.toMatchObject({
			name: "NoModelProviderConfiguredError",
			reason: "capability-disabled",
		});
		expect(embeddingHandler).not.toHaveBeenCalled();
	});

	it("prevents an embeddings-only canonical provider from claiming text", async () => {
		const runtime = makeRuntime({
			ELIZA_CANONICAL_LLM_TEXT_ENABLED: "false",
			ELIZA_CANONICAL_EMBEDDINGS_ENABLED: "true",
		});
		const textHandler = vi.fn(async () => "wrong-owner");
		const embeddingHandler = vi.fn(async () => new Array(384).fill(0));

		runtime.registerModel(ModelType.TEXT_SMALL, textHandler, "openai", 100);
		runtime.registerModel(
			ModelType.TEXT_EMBEDDING,
			embeddingHandler,
			"openai",
			100,
		);

		expect(runtime.getModel(ModelType.TEXT_SMALL)).toBeUndefined();
		await expect(
			runtime.useModel(ModelType.TEXT_SMALL, { prompt: "hello" }),
		).rejects.toMatchObject({
			name: "NoModelProviderConfiguredError",
			reason: "capability-disabled",
		});
		await expect(
			runtime.useModel(ModelType.TEXT_EMBEDDING, "hello"),
		).resolves.toHaveLength(384);
		expect(textHandler).not.toHaveBeenCalled();
		expect(embeddingHandler).toHaveBeenCalledTimes(1);
	});
});
