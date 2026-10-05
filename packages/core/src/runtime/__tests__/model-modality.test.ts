/**
 * Covers the single model-slot modality table and the PII-swap exclusions it
 * drives in dispatch. Uses a real AgentRuntime with spy handlers; no live model.
 */
import { createSQLiteTestRuntime } from "@elizaos/testing/runtime";
import { describe, expect, it, vi } from "vitest";
import type { AgentRuntime } from "../../runtime";
import type { Character } from "../../types/agent.js";
import { ModelType } from "../../types/model.js";
import {
	modalityForModelType,
	PII_SWAP_SKIP_MODEL_TYPES,
} from "../model-modality";

const ADDRESS = "221 Baker Street";

function makeRuntime(): AgentRuntime {
	return createSQLiteTestRuntime({
		character: {
			name: "ModalityAgent",
			bio: "test",
			settings: {},
		} as Character,
		settings: { ELIZA_PII_SWAP_ENABLED: "true" },
		logLevel: "fatal",
	});
}

describe("modalityForModelType", () => {
	it("classifies every built-in model slot", () => {
		for (const modelType of new Set(Object.values(ModelType))) {
			expect(modalityForModelType(modelType), modelType).toBeDefined();
		}
	});

	it("returns undefined for a custom slot", () => {
		expect(modalityForModelType("CUSTOM_PLUGIN_SLOT")).toBeUndefined();
	});

	it("keeps embeddings, speech and PII scrub on real text", () => {
		for (const modelType of [
			ModelType.TEXT_EMBEDDING,
			ModelType.TEXT_EMBEDDING_BATCH,
			ModelType.TEXT_TO_SPEECH,
			ModelType.PII_SCRUB,
		]) {
			expect(PII_SWAP_SKIP_MODEL_TYPES.has(modelType)).toBe(true);
		}
		expect(PII_SWAP_SKIP_MODEL_TYPES.has(ModelType.IMAGE)).toBe(false);
	});
});

describe("PII swap modality exclusions in dispatch", () => {
	it("swaps text generation prompts while the swap is enabled", async () => {
		const runtime = makeRuntime();
		const handler = vi.fn(async (_runtime: unknown, params: unknown) => {
			expect(JSON.stringify(params)).not.toContain(ADDRESS);
			return "ok";
		});
		runtime.registerModel(ModelType.TEXT_LARGE, handler, "spy", 10);
		await runtime.useModel(ModelType.TEXT_LARGE, {
			prompt: `Write to ${ADDRESS}`,
		});
		expect(handler).toHaveBeenCalledTimes(1);
	});

	it("sends batch embedding texts unmodified", async () => {
		const runtime = makeRuntime();
		const received: string[][] = [];
		runtime.registerModel(
			ModelType.TEXT_EMBEDDING_BATCH,
			async (_runtime: unknown, params: { texts: string[] }) => {
				received.push([...params.texts]);
				return params.texts.map(() => [0.1, 0.2, 0.3]);
			},
			"spy",
			10,
		);
		await runtime.useModel(ModelType.TEXT_EMBEDDING_BATCH, {
			texts: [`Contact ${ADDRESS}`, "second"],
		});
		expect(received).toEqual([[`Contact ${ADDRESS}`, "second"]]);
	});

	it("sends text-to-speech input unmodified", async () => {
		const runtime = makeRuntime();
		const received: unknown[] = [];
		runtime.registerModel(
			ModelType.TEXT_TO_SPEECH,
			async (_runtime: unknown, params: unknown) => {
				received.push(params);
				return new Uint8Array([1, 2, 3]);
			},
			"spy",
			10,
		);
		await runtime.useModel(ModelType.TEXT_TO_SPEECH, {
			text: `Reply to ${ADDRESS}`,
		});
		expect(JSON.stringify(received)).toContain(ADDRESS);
	});
});
