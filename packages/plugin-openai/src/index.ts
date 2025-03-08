import { createOpenAI } from "@ai-sdk/openai";
import type { IAgentRuntime, ModelType, Plugin } from "@elizaos/core";
import {
	type DetokenizeTextParams,
	type GenerateTextParams,
	ModelTypes,
	type TokenizeTextParams,
} from "@elizaos/core";
import { generateText } from "ai";
import { encodingForModel, type TiktokenModel } from "js-tiktoken";
import { z } from "zod";

/**
 * Asynchronously tokenizes the given text based on the specified model and prompt.
 * 
 * @param {ModelType} model - The type of model to use for tokenization.
 * @param {string} prompt - The text prompt to tokenize.
 * @returns {number[]} - An array of tokens representing the encoded prompt.
 */
async function tokenizeText(model: ModelType, prompt: string) {
	const modelName =
		model === ModelTypes.TEXT_SMALL
			? (process.env.OPENAI_SMALL_MODEL ??
				process.env.SMALL_MODEL ??
				"gpt-4o-mini")
			: (process.env.LARGE_MODEL ?? "gpt-4o");
	const encoding = encodingForModel(modelName as TiktokenModel);
	const tokens = encoding.encode(prompt);
	return tokens;
}

/**
 * Detokenize a sequence of tokens back into text using the specified model.
 * 
 * @param {ModelType} model - The type of model to use for detokenization.
 * @param {number[]} tokens - The sequence of tokens to detokenize.
 * @returns {string} The detokenized text.
 */
async function detokenizeText(model: ModelType, tokens: number[]) {
	const modelName =
		model === ModelTypes.TEXT_SMALL
			? (process.env.OPENAI_SMALL_MODEL ??
				process.env.SMALL_MODEL ??
				"gpt-4o-mini")
			: (process.env.OPENAI_LARGE_MODEL ?? process.env.LARGE_MODEL ?? "gpt-4o");
	const encoding = encodingForModel(modelName as TiktokenModel);
	return encoding.decode(tokens);
}

const configSchema = z.object({
	OPENAI_API_KEY: z.string().min(1, "OpenAI API key is required"),
	OPENAI_BASE_URL: z.string().url().optional(),
	OPENAI_SMALL_MODEL: z.string().optional(),
	OPENAI_LARGE_MODEL: z.string().optional(),
	SMALL_MODEL: z.string().optional(),
	LARGE_MODEL: z.string().optional(),
});

/**
 * Defines the OpenAI plugin with its name, description, and configuration options.
 * @type {Plugin}
 */
export const openaiPlugin: Plugin = {
	name: "openai",
	description: "OpenAI plugin",
	config: {
		OPENAI_API_KEY: process.env.OPENAI_API_KEY,
		OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
		OPENAI_SMALL_MODEL: process.env.OPENAI_SMALL_MODEL,
		OPENAI_LARGE_MODEL: process.env.OPENAI_LARGE_MODEL,
		SMALL_MODEL: process.env.SMALL_MODEL,
		LARGE_MODEL: process.env.LARGE_MODEL,
	},
	async init(config: Record<string, string>) {
		try {
			const validatedConfig = await configSchema.parseAsync(config);

			// Set all environment variables at once
			for (const [key, value] of Object.entries(validatedConfig)) {
				if (value) process.env[key] = value;
			}

			// Verify API key
			const baseURL =
				process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";
			const response = await fetch(`${baseURL}/models`, {
				headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
			});

			if (!response.ok) {
				throw new Error(
					`Failed to validate OpenAI API key: ${response.statusText}`,
				);
			}
		} catch (error) {
			if (error instanceof z.ZodError) {
				throw new Error(
					`Invalid plugin configuration: ${error.errors
						.map((e) => e.message)
						.join(
							", ",
						)} - You need to configure the OPENAI_API_KEY in your environment variables`,
				);
			}
			throw error;
		}
	},
	models: {
		[ModelTypes.TEXT_EMBEDDING]: async (
			_runtime: IAgentRuntime,
			text: string | null,
		) => {
			if (!text) {
				// Return zero vector of appropriate length for model
				return new Array(1536).fill(0);
			}

			const baseURL =
				process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";

			// use fetch to call embedding endpoint
			const response = await fetch(`${baseURL}/embeddings`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					model: "text-embedding-3-small",
					input: text,
				}),
			});
			if (!response.ok) {
				throw new Error(`Failed to get embedding: ${response.statusText}`);
			}

			const data = (await response.json()) as {
				data: [{ embedding: number[] }];
			};
			return data.data[0].embedding;
		},
		[ModelTypes.TEXT_TOKENIZER_ENCODE]: async (
			_runtime,
			{ prompt, modelType = ModelTypes.TEXT_LARGE }: TokenizeTextParams,
		) => {
			return await tokenizeText(modelType ?? ModelTypes.TEXT_LARGE, prompt);
		},
		[ModelTypes.TEXT_TOKENIZER_DECODE]: async (
			_runtime,
			{ tokens, modelType = ModelTypes.TEXT_LARGE }: DetokenizeTextParams,
		) => {
			return await detokenizeText(modelType ?? ModelTypes.TEXT_LARGE, tokens);
		},
		[ModelTypes.TEXT_SMALL]: async (
			runtime,
			{ prompt, stopSequences = [] }: GenerateTextParams,
		) => {
			const temperature = 0.7;
			const frequency_penalty = 0.7;
			const presence_penalty = 0.7;
			const max_response_length = 8192;

			const baseURL =
				runtime.getSetting("OPENAI_BASE_URL") ?? "https://api.openai.com/v1";

			const openai = createOpenAI({
				apiKey: runtime.getSetting("OPENAI_API_KEY"),
				baseURL,
			});

			const model =
				runtime.getSetting("OPENAI_SMALL_MODEL") ??
				runtime.getSetting("SMALL_MODEL") ??
				"gpt-4o-mini";

			console.log("generating text");
			console.log(prompt);

			const { text: openaiResponse } = await generateText({
				model: openai.languageModel(model),
				prompt: prompt,
				system: runtime.character.system ?? undefined,
				temperature: temperature,
				maxTokens: max_response_length,
				frequencyPenalty: frequency_penalty,
				presencePenalty: presence_penalty,
				stopSequences: stopSequences,
			});

			return openaiResponse;
		},
		[ModelTypes.TEXT_LARGE]: async (
			runtime,
			{
				prompt,
				stopSequences = [],
				maxTokens = 8192,
				temperature = 0.7,
				frequencyPenalty = 0.7,
				presencePenalty = 0.7,
			}: GenerateTextParams,
		) => {
			const baseURL =
				runtime.getSetting("OPENAI_BASE_URL") ?? "https://api.openai.com/v1";

			const openai = createOpenAI({
				apiKey: runtime.getSetting("OPENAI_API_KEY"),
				baseURL,
			});

			const model =
				runtime.getSetting("OPENAI_LARGE_MODEL") ??
				runtime.getSetting("LARGE_MODEL") ??
				"gpt-4o";

			const { text: openaiResponse } = await generateText({
				model: openai.languageModel(model),
				prompt: prompt,
				system: runtime.character.system ?? undefined,
				temperature: temperature,
				maxTokens: maxTokens,
				frequencyPenalty: frequencyPenalty,
				presencePenalty: presencePenalty,
				stopSequences: stopSequences,
			});

			return openaiResponse;
		},
		[ModelTypes.IMAGE]: async (
			runtime,
			params: {
				prompt: string;
				n?: number;
				size?: string;
			},
		) => {
			const baseURL =
				runtime.getSetting("OPENAI_BASE_URL") ?? "https://api.openai.com/v1";
			const response = await fetch(`${baseURL}/images/generations`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${runtime.getSetting("OPENAI_API_KEY")}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					prompt: params.prompt,
					n: params.n || 1,
					size: params.size || "1024x1024",
				}),
			});
			if (!response.ok) {
				throw new Error(`Failed to generate image: ${response.statusText}`);
			}
			const data = await response.json();
			const typedData = data as { data: { url: string }[] };
			return typedData.data;
		},
		[ModelTypes.IMAGE_DESCRIPTION]: async (runtime, imageUrl) => {
			console.log("IMAGE_DESCRIPTION");
			const baseURL =
				runtime.getSetting("OPENAI_BASE_URL") ?? "https://api.openai.com/v1";
			console.log("baseURL", baseURL);
			const openai = createOpenAI({
				apiKey: runtime.getSetting("OPENAI_API_KEY"),
				baseURL,
			});

			const { text } = await generateText({
				model: openai.languageModel(
					runtime.getSetting("OPENAI_SMALL_MODEL") ?? "gpt-4o-mini",
				),
				messages: [
					{
						role: "system",
						content:
							"Provide a title and brief description of the image. Structure this as XML with the following syntax:\n<title>{{title}}</title>\n<description>{{description}}</description>\nReplacing the handlerbars with the actual text",
					},
					{
						role: "user",
						content: [
							{
								type: "image" as const,
								image: imageUrl,
							},
						],
					},
				],
				temperature: 0.7,
				maxTokens: 1024,
				frequencyPenalty: 0,
				presencePenalty: 0,
				stopSequences: [],
			});

			const titleMatch = text.match(/<title>(.*?)<\/title>/);
			const descriptionMatch = text.match(/<description>(.*?)<\/description>/);

			if (!titleMatch || !descriptionMatch) {
				throw new Error("Could not parse title or description from response");
			}

			return {
				title: titleMatch[1],
				description: descriptionMatch[1],
			};
		},
		[ModelTypes.TRANSCRIPTION]: async (runtime, audioBuffer: Buffer) => {
			console.log("audioBuffer", audioBuffer);
			const baseURL =
				runtime.getSetting("OPENAI_BASE_URL") ?? "https://api.openai.com/v1";
			const formData = new FormData();
			formData.append("file", new Blob([audioBuffer], { type: "audio/mp3" }));
			formData.append("model", "whisper-1");
			const response = await fetch(`${baseURL}/audio/transcriptions`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${runtime.getSetting("OPENAI_API_KEY")}`,
					// Note: Do not set a Content-Type header—letting fetch set it for FormData is best
				},
				body: formData,
			});

			console.log("response", response);
			if (!response.ok) {
				throw new Error(`Failed to transcribe audio: ${response.statusText}`);
			}
			const data = (await response.json()) as { text: string };
			return data.text;
		},
	},
	tests: [
		{
			name: "openai_plugin_tests",
			tests: [
				{
					name: "openai_test_url_and_api_key_validation",
					fn: async (runtime) => {
						const baseURL =
							runtime.getSetting("OPENAI_BASE_URL") ??
							"https://api.openai.com/v1";
						const response = await fetch(`${baseURL}/models`, {
							headers: {
								Authorization: `Bearer ${runtime.getSetting("OPENAI_API_KEY")}`,
							},
						});
						const data = await response.json();
						console.log("Models Available:", (data as any)?.data.length);
						if (!response.ok) {
							throw new Error(
								`Failed to validate OpenAI API key: ${response.statusText}`,
							);
						}
					},
				},
				{
					name: "openai_test_text_embedding",
					fn: async (runtime) => {
						try {
							const embedding = await runtime.useModel(
								ModelTypes.TEXT_EMBEDDING,
								"Hello, world!",
							);
							console.log("embedding", embedding);
						} catch (error) {
							console.error("Error in test_text_embedding:", error);
							throw error;
						}
					},
				},
				{
					name: "openai_test_text_large",
					fn: async (runtime) => {
						try {
							const text = await runtime.useModel(ModelTypes.TEXT_LARGE, {
								prompt: "What is the nature of reality in 10 words?",
							});
							if (text.length === 0) {
								throw new Error("Failed to generate text");
							}
							console.log("generated with test_text_large:", text);
						} catch (error) {
							console.error("Error in test_text_large:", error);
							throw error;
						}
					},
				},
				{
					name: "openai_test_text_small",
					fn: async (runtime) => {
						try {
							const text = await runtime.useModel(ModelTypes.TEXT_SMALL, {
								prompt: "What is the nature of reality in 10 words?",
							});
							if (text.length === 0) {
								throw new Error("Failed to generate text");
							}
							console.log("generated with test_text_small:", text);
						} catch (error) {
							console.error("Error in test_text_small:", error);
							throw error;
						}
					},
				},
				{
					name: "openai_test_image_generation",
					fn: async (runtime) => {
						console.log("openai_test_image_generation");
						try {
							const image = await runtime.useModel(ModelTypes.IMAGE, {
								prompt: "A beautiful sunset over a calm ocean",
								n: 1,
								size: "1024x1024",
							});
							console.log("generated with test_image_generation:", image);
						} catch (error) {
							console.error("Error in test_image_generation:", error);
							throw error;
						}
					},
				},
				{
					name: "openai_test_image_description",
					fn: async (runtime) => {
						console.log("openai_test_image_description");
						try {
							const { title, description } = await runtime.useModel(
								ModelTypes.IMAGE_DESCRIPTION,
								"https://upload.wikimedia.org/wikipedia/commons/thumb/1/1c/Vitalik_Buterin_TechCrunch_London_2015_%28cropped%29.jpg/537px-Vitalik_Buterin_TechCrunch_London_2015_%28cropped%29.jpg",
							);
							console.log(
								"generated with test_image_description:",
								title,
								description,
							);
						} catch (error) {
							console.error("Error in test_image_description:", error);
							throw error;
						}
					},
				},
				{
					name: "openai_test_transcription",
					fn: async (runtime) => {
						console.log("openai_test_transcription");
						try {
							const response = await fetch(
								"https://upload.wikimedia.org/wikipedia/en/4/40/Chris_Benoit_Voice_Message.ogg",
							);
							const arrayBuffer = await response.arrayBuffer();
							const transcription = await runtime.useModel(
								ModelTypes.TRANSCRIPTION,
								Buffer.from(new Uint8Array(arrayBuffer)),
							);
							console.log("generated with test_transcription:", transcription);
						} catch (error) {
							console.error("Error in test_transcription:", error);
							throw error;
						}
					},
				},
				{
					name: "openai_test_text_tokenizer_encode",
					fn: async (runtime) => {
						const prompt = "Hello tokenizer encode!";
						const tokens = await runtime.useModel(
							ModelTypes.TEXT_TOKENIZER_ENCODE,
							{ prompt },
						);
						if (!Array.isArray(tokens) || tokens.length === 0) {
							throw new Error(
								"Failed to tokenize text: expected non-empty array of tokens",
							);
						}
						console.log("Tokenized output:", tokens);
					},
				},
				{
					name: "openai_test_text_tokenizer_decode",
					fn: async (runtime) => {
						const prompt = "Hello tokenizer decode!";
						// Encode the string into tokens first
						const tokens = await runtime.useModel(
							ModelTypes.TEXT_TOKENIZER_ENCODE,
							{ prompt },
						);
						// Now decode tokens back into text
						const decodedText = await runtime.useModel(
							ModelTypes.TEXT_TOKENIZER_DECODE,
							{ tokens },
						);
						if (decodedText !== prompt) {
							throw new Error(
								`Decoded text does not match original. Expected "${prompt}", got "${decodedText}"`,
							);
						}
						console.log("Decoded text:", decodedText);
					},
				},
			],
		},
	],
};
export default openaiPlugin;
