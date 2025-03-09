// NOTE: The linter error about '@elizaos/core' not being under 'rootDir' is related to the build system
// configuration and doesn't affect functionality. It's related to how TypeScript is configured
// in the monorepo structure.
import { anthropic } from "@ai-sdk/anthropic";
import type {
	IAgentRuntime,
	ObjectGenerationParams,
	Plugin,
	TextEmbeddingParams,
} from "@elizaos/core";
import {
	type GenerateTextParams,
	type ModelType,
	ModelTypes,
} from "@elizaos/core";
import { generateText } from "ai";
import { z } from "zod";

// Define a configuration schema for the Anthropics plugin.
const configSchema = z.object({
	ANTHROPIC_API_KEY: z.string().min(1, "Anthropic API key is required"),
	ANTHROPIC_SMALL_MODEL: z.string().optional(),
	ANTHROPIC_LARGE_MODEL: z.string().optional(),
});

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
			const validatedConfig = await configSchema.parseAsync(config);

			// Set all environment variables at once
			for (const [key, value] of Object.entries(validatedConfig)) {
				if (value) process.env[key] = value;
			}

			// If API key is not set, we'll show a warning but continue
			if (!process.env.ANTHROPIC_API_KEY) {
				console.warn(
					"ANTHROPIC_API_KEY is not set in environment - Anthropic functionality will be limited",
				);
				// Return early without throwing an error
				return;
			}

			// Optional: Add key validation here if Anthropic provides an API endpoint for it
			console.log("Anthropic API key is set");
		} catch (error) {
			if (error instanceof z.ZodError) {
				// Convert to warning instead of error
				console.warn(
					`Anthropic plugin configuration issue: ${error.errors
						.map((e) => e.message)
						.join(
							", ",
						)} - You need to configure the ANTHROPIC_API_KEY in your environment variables`,
				);
				// Continue execution instead of throwing
			} else {
				// For unexpected errors, still throw
				throw error;
			}
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

		// Add new model handlers for object generation
		[ModelTypes.OBJECT_SMALL]: async (runtime, params) => {
			return await generateObject(runtime, {
				...params,
				modelType: ModelTypes.OBJECT_SMALL,
			});
		},

		[ModelTypes.OBJECT_LARGE]: async (runtime, params) => {
			return await generateObject(runtime, {
				...params,
				modelType: ModelTypes.OBJECT_LARGE,
			});
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

/**
 * Generates a structured object from a prompt using Anthropic's tool use capabilities.
 *
 * @param runtime The agent runtime
 * @param params The generation parameters
 * @returns The generated object
 */
async function generateObject(
	runtime: IAgentRuntime,
	params: ObjectGenerationParams,
) {
	const {
		prompt,
		schema,
		output = "object",
		enumValues = [],
		modelType = ModelTypes.OBJECT_SMALL,
		temperature = 0.7,
	} = params;

	// Determine which model to use
	const smallModel =
		runtime.getSetting("ANTHROPIC_SMALL_MODEL") ?? "claude-3-5-haiku-latest";
	const largeModel =
		runtime.getSetting("ANTHROPIC_LARGE_MODEL") ?? "claude-3-opus-20240229";
	const modelName =
		modelType === ModelTypes.OBJECT_SMALL ? smallModel : largeModel;

	const apiKey = process.env.ANTHROPIC_API_KEY;
	if (!apiKey) {
		console.error("ANTHROPIC_API_KEY is not set");
		return null;
	}

	// Handle direct API call to Claude
	const apiUrl = "https://api.anthropic.com/v1/messages";
	const headers = {
		"Content-Type": "application/json",
		"x-api-key": apiKey,
		"anthropic-version": "2023-06-01",
	};

	// Handle enum types specifically
	if (output === "enum" && enumValues.length) {
		try {
			const response = await fetch(apiUrl, {
				method: "POST",
				headers,
				body: JSON.stringify({
					model: modelName,
					temperature,
					system: runtime.character.system ?? "",
					messages: [{ role: "user", content: prompt }],
					tools: [
						{
							name: "select_value",
							description:
								"Select the most appropriate value from the provided options",
							input_schema: {
								type: "object",
								properties: {
									value: {
										type: "string",
										enum: enumValues,
										description: "The selected value",
									},
								},
								required: ["value"],
							},
						},
					],
					tool_choice: { type: "any" },
				}),
			});

			if (!response.ok) {
				throw new Error(`API error: ${response.status}`);
			}

			const data = await response.json();

			// Check for tool use in the response
			if (data.content && Array.isArray(data.content)) {
				for (const block of data.content) {
					if (block.type === "tool_use" && block.name === "select_value") {
						return block.input?.value || null;
					}
				}
			}

			return null;
		} catch (error) {
			console.error("Error generating enum value:", error);
			return null;
		}
	}

	// Handle regular object generation with schema
	try {
		// Determine the appropriate JSON schema
		let toolSchema: any;

		if (schema) {
			// Use provided schema
			toolSchema = schema;
		} else {
			// Default schema based on output type
			toolSchema = {
				type: output === "array" ? "array" : "object",
				...(output === "array" ? { items: { type: "object" } } : {}),
			};
		}

		const response = await fetch(apiUrl, {
			method: "POST",
			headers,
			body: JSON.stringify({
				model: modelName,
				temperature,
				system: runtime.character.system ?? "",
				messages: [{ role: "user", content: prompt }],
				tools: [
					{
						name: "generate_structured_data",
						description: "Generate structured data based on the prompt",
						input_schema: toolSchema,
					},
				],
				tool_choice: { type: "any" },
			}),
		});

		if (!response.ok) {
			throw new Error(`API error: ${response.status}`);
		}

		const data = await response.json();

		// Check for tool use in the response
		if (data.content && Array.isArray(data.content)) {
			for (const block of data.content) {
				if (
					block.type === "tool_use" &&
					block.name === "generate_structured_data"
				) {
					return block.input || null;
				}
			}
		}

		return null;
	} catch (error) {
		console.error("Error generating object:", error);
		return null;
	}
}
