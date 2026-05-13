import { ModelType } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
	createLocalInferenceModelHandlers,
	isLocalInferenceUnavailableError,
	LOCAL_INFERENCE_MODEL_TYPES,
	LOCAL_INFERENCE_PROVIDER_ID,
	localInferencePlugin,
	LocalInferenceUnavailableError,
} from "../src/provider.ts";

function runtimeWithService(service: Record<string, unknown>) {
	return {
		getService: vi.fn((name: string) =>
			name === "localInferenceLoader" ? service : null,
		),
	};
}

describe("local inference provider", () => {
	it("exports one provider for text, embedding, TTS, and transcription", () => {
		expect(localInferencePlugin.name).toBe(LOCAL_INFERENCE_PROVIDER_ID);
		expect(localInferencePlugin.priority).toBe(0);
		for (const modelType of LOCAL_INFERENCE_MODEL_TYPES) {
			expect(localInferencePlugin.models?.[modelType]).toBeTypeOf("function");
		}
	});

	it("delegates text generation to the runtime local inference service", async () => {
		const generate = vi.fn(async (args: { prompt: string }) => `local:${args.prompt}`);
		const runtime = runtimeWithService({ generate });
		const handlers = createLocalInferenceModelHandlers();

		const result = await handlers[ModelType.TEXT_SMALL]?.(runtime as never, {
			prompt: "hello",
			stopSequences: ["</s>"],
			temperature: 0.2,
		} as never);

		expect(result).toBe("local:hello");
		expect(generate).toHaveBeenCalledWith(
			expect.objectContaining({
				prompt: "hello",
				stopSequences: ["</s>"],
				temperature: 0.2,
			}),
		);
	});

	it("renders v5 message arrays before delegating text generation", async () => {
		const generate = vi.fn(async (args: { prompt: string }) => args.prompt);
		const runtime = runtimeWithService({ generate });
		const handlers = createLocalInferenceModelHandlers();

		const result = await handlers[ModelType.TEXT_SMALL]?.(runtime as never, {
			messages: [
				{ role: "system", content: "You are Eliza." },
				{
					role: "user",
					content: [{ type: "text", text: "hello. say hello back" }],
				},
			],
			maxTokens: 32,
			topP: 0.9,
		} as never);

		expect(result).toBe(
			"system:\nYou are Eliza.\n\nuser:\nhello. say hello back",
		);
		expect(generate).toHaveBeenCalledWith(
			expect.objectContaining({
				prompt: "system:\nYou are Eliza.\n\nuser:\nhello. say hello back",
				maxTokens: 32,
				topP: 0.9,
			}),
		);
	});

	it("renders prompt segments before delegating text generation", async () => {
		const generate = vi.fn(async (args: { prompt: string }) => args.prompt);
		const runtime = runtimeWithService({ generate });
		const handlers = createLocalInferenceModelHandlers();

		await expect(
			handlers[ModelType.TEXT_LARGE]?.(runtime as never, {
				promptSegments: [
					{ content: "system:\nYou are Eliza.\n\n" },
					{ content: "user:\nhello" },
				],
			} as never),
		).resolves.toBe("system:\nYou are Eliza.\n\nuser:\nhello");
	});

	it("delegates embeddings without returning fake vectors for warmup probes", async () => {
		const embed = vi.fn(async () => ({ embedding: [0.1, 0.2, 0.3] }));
		const runtime = runtimeWithService({ embed });
		const handlers = createLocalInferenceModelHandlers();

		await expect(
			handlers[ModelType.TEXT_EMBEDDING]?.(runtime as never, null as never),
		).rejects.toMatchObject({
			code: "LOCAL_INFERENCE_UNAVAILABLE",
			reason: "invalid_input",
		});

		await expect(
			handlers[ModelType.TEXT_EMBEDDING]?.(runtime as never, {
				text: "embed me",
			} as never),
		).resolves.toEqual([0.1, 0.2, 0.3]);
		expect(embed).toHaveBeenCalledWith({ input: "embed me" });
	});

	it("delegates local TTS and transcription when those backend APIs exist", async () => {
		const wav = new Uint8Array([82, 73, 70, 70]);
		const synthesizeSpeech = vi.fn(async () => wav);
		const transcribePcm = vi.fn(async () => "hello transcript");
		const runtime = runtimeWithService({ synthesizeSpeech, transcribePcm });
		const handlers = createLocalInferenceModelHandlers();

		await expect(
			handlers[ModelType.TEXT_TO_SPEECH]?.(runtime as never, {
				text: "say this",
			} as never),
		).resolves.toEqual(wav);
		expect(synthesizeSpeech).toHaveBeenCalledWith("say this");

		const pcm = new Float32Array([0, 0.1, -0.1]);
		await expect(
			handlers[ModelType.TRANSCRIPTION]?.(runtime as never, {
				pcm,
				sampleRateHz: 16_000,
			} as never),
		).resolves.toBe("hello transcript");
		expect(transcribePcm).toHaveBeenCalledWith({ pcm, sampleRate: 16_000 });
	});

	it("delegates image description to the unified local backend", async () => {
		const describeImage = vi.fn(async () => ({
			title: "A chart",
			description: "A chart on a laptop screen.",
		}));
		const runtime = runtimeWithService({ describeImage });
		const handlers = createLocalInferenceModelHandlers();

		await expect(
			handlers[ModelType.IMAGE_DESCRIPTION]?.(runtime as never, {
				imageUrl: "data:image/png;base64,AAAA",
				prompt: "describe it",
			} as never),
		).resolves.toEqual({
			title: "A chart",
			description: "A chart on a laptop screen.",
		});
		expect(describeImage).toHaveBeenCalledWith({
			imageUrl: "data:image/png;base64,AAAA",
			prompt: "describe it",
		});
	});

	it("throws a typed unavailable error when no real backend is exposed", async () => {
		const handlers = createLocalInferenceModelHandlers();
		const call = handlers[ModelType.TEXT_TO_SPEECH]?.({} as never, "hello" as never);
		let caught: unknown;
		try {
			await call;
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(LocalInferenceUnavailableError);
		expect(isLocalInferenceUnavailableError(caught)).toBe(true);
		expect(caught).toMatchObject({
			code: "LOCAL_INFERENCE_UNAVAILABLE",
			provider: LOCAL_INFERENCE_PROVIDER_ID,
			modelType: ModelType.TEXT_TO_SPEECH,
			reason: "backend_unavailable",
		});
	});
});
