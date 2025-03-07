import { anthropic } from "@ai-sdk/anthropic";
import type { Plugin } from "@elizaos/core";
import { type GenerateTextParams, ModelTypes } from "@elizaos/core";
import { generateText } from "ai";
import { z } from "zod";

// Define a configuration schema for the Anthropics plugin.
const configSchema = z.object({
	ANTHROPIC_API_KEY: z.string().min(1, "Anthropic API key is required"),
	ANTHROPIC_SMALL_MODEL: z.string().optional(),
	ANTHROPIC_LARGE_MODEL: z.string().optional(),
});

export const anthropicPlugin: Plugin = {
	name: "anthropic",
	description: "Anthropic plugin (supports text generation only)",
	config: {
		ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
		ANTHROPIC_SMALL_MODEL: process.env.ANTHROPIC_SMALL_MODEL,
		ANTHROPIC_LARGE_MODEL: process.env.ANTHROPIC_LARGE_MODEL,
	},
	async init(config: Record<string, string>) {
		try {
			const validatedConfig = await configSchema.parseAsync(config);

			// Set all environment variables at once
			for (const [key, value] of Object.entries(validatedConfig)) {
				if (value) process.env[key] = value;
			}

			// (Optional) If the Anthropics SDK supports API key verification,
			// you might add a check here.
		} catch (error) {
			if (error instanceof z.ZodError) {
				throw new Error(
					`Invalid plugin configuration: ${error.errors
						.map((e) => e.message)
						.join(
							", ",
						)} - you need to configure the ANTHROPIC_API_KEY in your environment variables`,
				);
			}
			throw error;
		}
	},
	models: {
		[ModelTypes.TEXT_SMALL]: async (
			runtime,
			{ prompt, stopSequences = [] }: GenerateTextParams,
		) => {
			const temperature = 0.7;
			const maxTokens = 8192;
			const smallModel =
				runtime.getSetting("ANTHROPIC_SMALL_MODEL") ??
				"claude-3-5-haiku-latest";

			const { text } = await generateText({
				model: anthropic(smallModel),
				prompt,
				// Pass along any system prompt if available.
				system: runtime.character.system ?? undefined,
				temperature,
				maxTokens,
				stopSequences,
			});
			return text;
		},

		// TEXT_LARGE generation using Anthropics (e.g. using a "claude-3" model).
		[ModelTypes.TEXT_LARGE]: async (
			runtime,
			{
				prompt,
				maxTokens = 8192,
				stopSequences = [],
				temperature = 0.7,
				frequencyPenalty = 0.7,
				presencePenalty = 0.7,
			}: GenerateTextParams,
		) => {
			const largeModel =
				runtime.getSetting("ANTHROPIC_LARGE_MODEL") ??
				"claude-3-5-sonnet-latest";

			const { text } = await generateText({
				model: anthropic(largeModel),
				prompt,
				system: runtime.character.system ?? undefined,
				temperature,
				maxTokens,
				stopSequences,
				frequencyPenalty,
				presencePenalty,
			});
			return text;
		},
	},
	tests: [
		{
			name: "anthropic_plugin_tests",
			tests: [
				{
					name: "anthropic_test_text_small",
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
					name: "anthropic_test_text_large",
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
			],
		},
	],
};

export default anthropicPlugin;
