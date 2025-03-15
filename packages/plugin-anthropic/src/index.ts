import { anthropic } from "@ai-sdk/anthropic";
import { ModelTypes, logger } from "@elizaos/core";
import type { IAgentRuntime, ObjectGenerationParams, Plugin, GenerateTextParams } from "@elizaos/core";
import { generateText, generateObject } from "ai";
import { z } from "zod";

// Define a configuration schema for the Anthropics plugin.
// const configSchema = z.object({
// 	ANTHROPIC_API_KEY: z.string().min(1, "Anthropic API key is required"),
// 	ANTHROPIC_SMALL_MODEL: z.string().optional(),
// 	ANTHROPIC_LARGE_MODEL: z.string().optional(),
// });

/**
 * Plugin for Anthropic.
 *
 * @type {Plugin}
 * @property {string} name - The name of the plugin.
 * @property {string} description - The description of the plugin.
 * @property {Object} config - The configuration object with API keys and model variables.
 * @property {Function} init - Initializes the plugin with the given configuration.
 * @property {Function} models - Contains functions for generating text using small and large models.
 * @property {Function[]} tests - An array of test functions for the plugin.
 */
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
			// const validatedConfig = await configSchema.parseAsync(config);

			// Set all environment variables at once
			// for (const [key, value] of Object.entries(validatedConfig)) {
			// 	if (value) process.env[key] = value;
			// }

			// If API key is not set, we'll show a warning but continue
			if (!process.env.ANTHROPIC_API_KEY) {
				logger.warn(
					"ANTHROPIC_API_KEY is not set in environment - Anthropic functionality will be limited",
				);
				// Return early without throwing an error
				return;
			}
		} catch (error) {
			// if (error instanceof z.ZodError) {
				// Convert to warning instead of error
				logger.warn(
					`Anthropic plugin configuration issue: ${error.errors
						.map((e) => e.message)
						.join(
							", ",
						)} - You need to configure the ANTHROPIC_API_KEY in your environment variables`,
				);
				// Continue execution instead of throwing
			// } else {
				// For unexpected errors, still throw
				// throw error;
			// }
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

		[ModelTypes.OBJECT_SMALL]: async (runtime, params: ObjectGenerationParams) => {
			const smallModel = runtime.getSetting("ANTHROPIC_SMALL_MODEL") ?? "claude-3-5-haiku-latest";
			try {
				if (params.schema) {
					const { object } = await generateObject({
						model: anthropic(smallModel),
						schema: z.object(params.schema),
						prompt: params.prompt,
						temperature: params.temperature,
						system: runtime.character.system ?? undefined,
					});
					return object;
				}
				
				const { object } = await generateObject({
					model: anthropic(smallModel),
					output: 'no-schema',
					prompt: params.prompt,
					temperature: params.temperature,
					system: runtime.character.system ?? undefined,
				});
				return object;
			} catch (error) {
				logger.error("Error generating object:", error);
				throw error;
			}
		},

		[ModelTypes.OBJECT_LARGE]: async (runtime, params: ObjectGenerationParams) => {
			const largeModel = runtime.getSetting("ANTHROPIC_LARGE_MODEL") ?? "claude-3-5-sonnet-latest";
			try {
				if (params.schema) {
					const { object } = await generateObject({
						model: anthropic(largeModel),
						schema: z.object(params.schema),
						prompt: params.prompt,
						temperature: params.temperature,
						system: runtime.character.system ?? undefined,
					});
					return object;
				}
				
				const { object } = await generateObject({
					model: anthropic(largeModel),
					output: 'no-schema',
					prompt: params.prompt,
					temperature: params.temperature,
					system: runtime.character.system ?? undefined,
				});
				return object;
			} catch (error) {
				logger.error("Error generating object:", error);
				throw error;
			}
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
							logger.log("generated with test_text_small:", text);
						} catch (error) {
							logger.error("Error in test_text_small:", error);
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
							logger.log("generated with test_text_large:", text);
						} catch (error) {
							logger.error("Error in test_text_large:", error);
							throw error;
						}
					},
				},
			],
		},
	],
};

export default anthropicPlugin;
