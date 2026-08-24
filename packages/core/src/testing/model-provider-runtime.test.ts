/**
 * Exercises `createTestRuntimeWithModelProvider` against fully booted PGLite
 * runtimes: fixture consumption is proven through real `useModel` dispatch,
 * and every option forward (character, embeddings, priority, extra plugins,
 * explicit resolver, streaming) is observed on the resulting runtime.
 */

import { describe, expect, it } from "vitest";
import { ModelType } from "../types/model";
import type { Plugin } from "../types/plugin";
import { createTestRuntimeWithModelProvider } from "./model-provider-runtime";

const markerPlugin: Plugin = {
	name: "model-provider-runtime-marker-plugin",
	description: "Verifies that caller plugins reach registration",
	providers: [
		{
			name: "model-provider-runtime-marker-provider",
			get: async () => ({ text: "marker" }),
		},
	],
};

describe("createTestRuntimeWithModelProvider", () => {
	it("serves a matched fixture through a real useModel call and records its consumption", async () => {
		const result = await createTestRuntimeWithModelProvider({
			fixtures: [
				{
					name: "greeting",
					match: { modelType: ModelType.TEXT_SMALL, prompt: "say hi" },
					response: "fixture-hi",
				},
			],
		});

		try {
			const observed = await result.runtime.useModel(ModelType.TEXT_SMALL, {
				prompt: "say hi",
			});

			expect(observed).toBe("fixture-hi");

			const diagnostics = result.getFixtureDiagnostics();
			expect(diagnostics.calls).toHaveLength(1);
			expect(diagnostics.calls[0]?.matchedFixtureName).toBe("greeting");
			expect(diagnostics.calls[0]?.modelType).toBe(ModelType.TEXT_SMALL);
			expect(diagnostics.fixtures[0]).toMatchObject({
				name: "greeting",
				consumed: 1,
			});
			expect(() => result.assertFixturesConsumed()).not.toThrow();

			expect(result.fixtures).toBe(result.modelProvider.fixtures);
		} finally {
			await result.cleanup();
		}
	});

	it("flags an unconsumed required fixture through assertFixturesConsumed", async () => {
		const result = await createTestRuntimeWithModelProvider({
			fixtures: [
				{
					name: "never-called",
					match: { modelType: ModelType.TEXT_SMALL },
					response: "unused",
				},
			],
		});

		try {
			expect(() => result.assertFixturesConsumed()).toThrow(
				/deterministic model fixtures were not consumed/,
			);
			expect(() => result.assertFixturesConsumed()).toThrow(/never-called/);
		} finally {
			await result.cleanup();
		}
	});

	it("defaults to the model-provider test agent character, an in-memory database, and 384-dimension embeddings", async () => {
		const result = await createTestRuntimeWithModelProvider();

		try {
			expect(result.runtime.character.name).toBe("ModelProviderTestAgent");
			expect(result.pgliteDir.startsWith("memory://")).toBe(true);
			expect(process.env.EMBEDDING_DIMENSION).toBe("384");
			expect(process.env.LOCAL_EMBEDDING_DIMENSIONS).toBe("384");
			expect(typeof result.runtime.agentId).toBe("string");
			expect(result.runtime.agentId.length > 0).toBe(true);
		} finally {
			await result.cleanup();
		}
	});

	it("honors caller overrides for character name, embedding width, provider priority, and extra plugins", async () => {
		const result = await createTestRuntimeWithModelProvider({
			characterName: "CustomNamedAgent",
			embeddingDimensions: 512,
			priority: 77,
			plugins: [markerPlugin],
		});

		try {
			expect(result.runtime.character.name).toBe("CustomNamedAgent");
			expect(process.env.EMBEDDING_DIMENSION).toBe("512");
			expect(process.env.LOCAL_EMBEDDING_DIMENSIONS).toBe("512");
			expect(result.modelProvider.priority).toBe(77);
			expect(
				result.runtime.providers.map((provider) => provider.name),
			).toContain("model-provider-runtime-marker-provider");
		} finally {
			await result.cleanup();
		}
	});

	it("falls back to the forwarded resolver only for calls no fixture matches", async () => {
		const result = await createTestRuntimeWithModelProvider({
			resolve: (call) =>
				call.modelType === ModelType.TEXT_COMPLETION
					? "resolver-fallback"
					: undefined,
		});

		try {
			const observed = await result.runtime.useModel(
				ModelType.TEXT_COMPLETION,
				{ prompt: "unmatched completion" },
			);
			expect(observed).toBe("resolver-fallback");
			expect(() => result.assertFixturesConsumed()).not.toThrow();

			await expect(
				result.runtime.useModel(ModelType.TEXT_MEDIUM, {
					prompt: "nothing can serve this",
				}),
			).rejects.toThrow(/no fixture matched/);
		} finally {
			await result.cleanup();
		}
	});

	it("streams fixture responses chunk by chunk through the forwarded stream configuration", async () => {
		const result = await createTestRuntimeWithModelProvider({
			stream: { chunkSize: 5, intervalMs: 0 },
			fixtures: [
				{
					name: "streamed-greeting",
					match: { modelType: ModelType.TEXT_SMALL },
					response: "0123456789ABCDEFGHIJK",
				},
			],
		});

		try {
			const chunks: string[] = [];
			const observed = await result.runtime.useModel(ModelType.TEXT_SMALL, {
				prompt: "stream please",
				onStreamChunk: (chunk: string) => {
					chunks.push(chunk);
				},
			});

			expect(observed).toBe("0123456789ABCDEFGHIJK");
			expect(chunks.join("")).toBe("0123456789ABCDEFGHIJK");
			expect(chunks.every((chunk) => chunk.length <= 5)).toBe(true);
			expect(chunks.length).toBe(Math.ceil(21 / 5));
			expect(() => result.assertFixturesConsumed()).not.toThrow();
		} finally {
			await result.cleanup();
		}
	});
});
