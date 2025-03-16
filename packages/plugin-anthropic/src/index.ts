import { anthropic } from '@ai-sdk/anthropic';
import type {
  IAgentRuntime,
  ObjectGenerationParams,
  GenerateTextParams,
  Plugin,
} from '@elizaos/core';
import { ModelType, logger } from '@elizaos/core';
import { generateText } from 'ai';

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
  name: 'anthropic',
  description: 'Anthropic plugin (supports text generation only)',
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
          'ANTHROPIC_API_KEY is not set in environment - Anthropic functionality will be limited'
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
          .join(', ')} - You need to configure the ANTHROPIC_API_KEY in your environment variables`
      );
      // Continue execution instead of throwing
      // } else {
      // For unexpected errors, still throw
      // throw error;
      // }
    }
  },
  models: {
    [ModelType.TEXT_SMALL]: async (runtime, { prompt, stopSequences = [] }: GenerateTextParams) => {
      const temperature = 0.7;
      const maxTokens = 8192;
      const smallModel = runtime.getSetting('ANTHROPIC_SMALL_MODEL') ?? 'claude-3-5-haiku-latest';

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
    [ModelType.TEXT_LARGE]: async (
      runtime,
      {
        prompt,
        maxTokens = 8192,
        stopSequences = [],
        temperature = 0.7,
        frequencyPenalty = 0.7,
        presencePenalty = 0.7,
      }: GenerateTextParams
    ) => {
      const largeModel = runtime.getSetting('ANTHROPIC_LARGE_MODEL') ?? 'claude-3-5-sonnet-latest';

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

    [ModelType.OBJECT_SMALL]: async (runtime, params: ObjectGenerationParams) => {
      const smallModel = runtime.getSetting('ANTHROPIC_SMALL_MODEL') ?? 'claude-3-5-haiku-latest';
      try {
        // Check if this is a reflection schema request (has specific format)
        const isReflection = params.schema?.facts && params.schema.relationships;

        // Build a prompt that asks for JSON output
        let jsonPrompt = params.prompt;

        // Don't modify the prompt if it already contains explicit JSON formatting instructions
        if (!jsonPrompt.includes('```json') && !jsonPrompt.includes('respond with valid JSON')) {
          jsonPrompt +=
            '\nPlease respond with valid JSON only, without any explanations, markdown formatting, or additional text.';
        }

        let systemPrompt = runtime.character.system
          ? `${runtime.character.system}\nYou must respond with valid JSON only.`
          : 'You must respond with valid JSON only.';

        // For reflection schemas, we need a more specific instruction
        if (isReflection) {
          systemPrompt +=
            " Ensure your response includes 'thought', 'facts', and 'relationships' properties exactly as specified in the prompt.";
        } else {
          systemPrompt += ' No markdown, no code blocks, no explanation text.';
        }

        // Generate text response that should contain JSON
        const { text } = await generateText({
          model: anthropic(smallModel),
          prompt: jsonPrompt,
          system: systemPrompt,
          temperature: params.temperature || 0.2, // Lower temperature for more predictable structured output
        });

        // Extract JSON from response
        try {
          // Try to extract JSON from potential code blocks or surrounding text
          const extractJSON = (text: string): string => {
            // Try to find content between JSON codeblocks or markdown blocks
            const jsonBlockRegex = /```(?:json)?\s*([\s\S]*?)\s*```/;
            const match = text.match(jsonBlockRegex);

            if (match && match[1]) {
              return match[1].trim();
            }

            // If no code blocks, try to find JSON-like content
            // This regex looks for content that starts with { and ends with } across multiple lines
            const jsonContentRegex = /\s*(\{[\s\S]*\})\s*$/;
            const contentMatch = text.match(jsonContentRegex);

            if (contentMatch && contentMatch[1]) {
              return contentMatch[1].trim();
            }

            // If no JSON-like content found, return the original text
            return text.trim();
          };

          const extractedJsonText = extractJSON(text);
          logger.debug('Extracted JSON text:', extractedJsonText);

          let jsonObject;
          try {
            jsonObject = JSON.parse(text);
          } catch (parseError) {
            // Try fixing common JSON issues
            logger.debug('Initial JSON parse failed, attempting to fix common issues');

            // Replace any unescaped newlines in string values
            let fixedJson = extractedJsonText
              .replace(/:\s*"([^"]*)(?:\n)([^"]*)"/g, ': "$1\\n$2"')
              // Remove any non-JSON text that might have gotten mixed into string values
              .replace(/"([^"]*?)[^a-zA-Z0-9\s\.,;:\-_\(\)"'\[\]{}]([^"]*?)"/g, '"$1$2"')
              // Fix missing quotes around property names
              .replace(/(\s*)(\w+)(\s*):/g, '$1"$2"$3:')
              // Fix trailing commas in arrays and objects
              .replace(/,(\s*[\]}])/g, '$1');

            // Sometimes strings get corrupted with injected text, try to fix by finding broken strings
            const brokenStringRegex = /"([^"]*?)([^"]*?)"\s*,\s*"([^"]+)"\s*:/g;
            while (brokenStringRegex.test(fixedJson)) {
              fixedJson = fixedJson.replace(brokenStringRegex, '"$1$2",\n"$3":');
            }

            try {
              jsonObject = JSON.parse(fixedJson);
            } catch (finalError) {
              // Last resort - try manual reconstruction for reflection schema
              // Find the thought, facts and relationships separately and manually construct the JSON
              if (isReflection) {
                logger.debug('Attempting manual reconstruction of reflection schema');

                const thoughtMatch = extractedJsonText.match(/"thought"\s*:\s*"([^"]+)"/);
                const thoughtValue = thoughtMatch ? thoughtMatch[1] : '';

                // Initialize a basic valid reflection object
                jsonObject = {
                  thought: thoughtValue || 'Unable to extract valid thought from model response',
                  facts: [],
                  relationships: [],
                };

                // Try to extract some facts if possible
                const factMatches = extractedJsonText.match(/"claim"\s*:\s*"([^"]+)"/g);
                if (factMatches) {
                  jsonObject.facts = factMatches.map((match) => ({
                    claim: match.replace(/"claim"\s*:\s*"([^"]+)"/, '$1'),
                    type: 'fact',
                    in_bio: false,
                    already_known: false,
                  }));
                }

                logger.debug('Manually reconstructed object:', jsonObject);
              } else {
                // For non-reflection schemas, can't reliably reconstruct
                throw finalError;
              }
            }
          }

          // For reflection schema, ensure we have all required properties
          if (isReflection && jsonObject) {
            if (!jsonObject.thought) jsonObject.thought = '';
            if (!jsonObject.facts) jsonObject.facts = [];
            if (!jsonObject.relationships) jsonObject.relationships = [];
          }

          // Validate against schema if provided
          // if (params.schema) {
          // 	try {
          // 		return z.object(params.schema).parse(jsonObject);
          // 	} catch (zodError) {
          // 		logger.error("Schema validation failed:", zodError);
          // 		// If we have partial data that matches the schema structure, return what we have
          // 		if (isReflection && jsonObject.thought) {
          // 			return jsonObject;
          // 		}
          // 		throw zodError;
          // 	}
          // }

          return jsonObject;
        } catch (parseError) {
          logger.error('Failed to parse JSON from Anthropic response:', parseError);
          logger.error('Raw response:', text);
          throw new Error('Invalid JSON returned from Anthropic model');
        }
      } catch (error) {
        logger.error('Error generating object:', error);
        throw error;
      }
    },

    [ModelType.OBJECT_LARGE]: async (runtime, params: ObjectGenerationParams) => {
      const largeModel = runtime.getSetting('ANTHROPIC_LARGE_MODEL') ?? 'claude-3-5-sonnet-latest';
      try {
        // Check if this is a reflection schema request (has specific format)
        const isReflection = params.schema?.facts && params.schema.relationships;

        // Build a prompt that asks for JSON output
        let jsonPrompt = params.prompt;

        // Don't modify the prompt if it already contains explicit JSON formatting instructions
        if (!jsonPrompt.includes('```json') && !jsonPrompt.includes('respond with valid JSON')) {
          jsonPrompt +=
            '\nPlease respond with valid JSON only, without any explanations, markdown formatting, or additional text.';
        }

        let systemPrompt = runtime.character.system
          ? `${runtime.character.system}\nYou must respond with valid JSON only.`
          : 'You must respond with valid JSON only.';

        // For reflection schemas, we need a more specific instruction
        if (isReflection) {
          systemPrompt +=
            " Ensure your response includes 'thought', 'facts', and 'relationships' properties exactly as specified in the prompt.";
        } else {
          systemPrompt += ' No markdown, no code blocks, no explanation text.';
        }

        // Generate text response that should contain JSON
        const { text } = await generateText({
          model: anthropic(largeModel),
          prompt: jsonPrompt,
          system: systemPrompt,
          temperature: params.temperature || 0.2, // Lower temperature for more predictable structured output
        });

        // Extract JSON from response
        try {
          // Try to extract JSON from potential code blocks or surrounding text
          const extractJSON = (text: string): string => {
            // Try to find content between JSON codeblocks or markdown blocks
            const jsonBlockRegex = /```(?:json)?\s*([\s\S]*?)\s*```/;
            const match = text.match(jsonBlockRegex);

            if (match && match[1]) {
              return match[1].trim();
            }

            // If no code blocks, try to find JSON-like content
            // This regex looks for content that starts with { and ends with } across multiple lines
            const jsonContentRegex = /\s*(\{[\s\S]*\})\s*$/;
            const contentMatch = text.match(jsonContentRegex);

            if (contentMatch && contentMatch[1]) {
              return contentMatch[1].trim();
            }

            // If no JSON-like content found, return the original text
            return text.trim();
          };

          // Clean up the extracted JSON to remove any debugging or log messages
          const cleanupJSON = (jsonText: string): string => {
            // Remove common logging/debugging patterns that might get mixed into the JSON
            return (
              jsonText
                // Remove "Waiting for debugger" and similar messages that break JSON
                .replace(/Waiting for the debugger[^"]*?(\w)/g, '$1')
                // Remove any other common debugging outputs
                .replace(/\[DEBUG\].*?(\n|$)/g, '\n')
                .replace(/\[LOG\].*?(\n|$)/g, '\n')
                .replace(/console\.log.*?(\n|$)/g, '\n')
            );
          };

          let extractedJsonText = extractJSON(text);
          extractedJsonText = cleanupJSON(extractedJsonText);
          logger.debug('Extracted JSON text:', extractedJsonText);

          let jsonObject;
          try {
            jsonObject = JSON.parse(extractedJsonText);
          } catch (parseError) {
            // Try fixing common JSON issues
            logger.debug('Initial JSON parse failed, attempting to fix common issues');

            // Replace any unescaped newlines in string values
            let fixedJson = extractedJsonText
              .replace(/:\s*"([^"]*)(?:\n)([^"]*)"/g, ': "$1\\n$2"')
              // Remove any non-JSON text that might have gotten mixed into string values
              .replace(/"([^"]*?)[^a-zA-Z0-9\s\.,;:\-_\(\)"'\[\]{}]([^"]*?)"/g, '"$1$2"')
              // Fix missing quotes around property names
              .replace(/(\s*)(\w+)(\s*):/g, '$1"$2"$3:')
              // Fix trailing commas in arrays and objects
              .replace(/,(\s*[\]}])/g, '$1');

            // Sometimes strings get corrupted with injected text, try to fix by finding broken strings
            const brokenStringRegex = /"([^"]*?)([^"]*?)"\s*,\s*"([^"]+)"\s*:/g;
            while (brokenStringRegex.test(fixedJson)) {
              fixedJson = fixedJson.replace(brokenStringRegex, '"$1$2",\n"$3":');
            }

            try {
              jsonObject = JSON.parse(fixedJson);
            } catch (finalError) {
              // Last resort - try manual reconstruction for reflection schema
              // Find the thought, facts and relationships separately and manually construct the JSON
              if (isReflection) {
                logger.debug('Attempting manual reconstruction of reflection schema');

                const thoughtMatch = extractedJsonText.match(/"thought"\s*:\s*"([^"]+)"/);
                const thoughtValue = thoughtMatch ? thoughtMatch[1] : '';

                // Initialize a basic valid reflection object
                jsonObject = {
                  thought: thoughtValue || 'Unable to extract valid thought from model response',
                  facts: [],
                  relationships: [],
                };

                // Try to extract some facts if possible
                const factMatches = extractedJsonText.match(/"claim"\s*:\s*"([^"]+)"/g);
                if (factMatches) {
                  jsonObject.facts = factMatches.map((match) => ({
                    claim: match.replace(/"claim"\s*:\s*"([^"]+)"/, '$1'),
                    type: 'fact',
                    in_bio: false,
                    already_known: false,
                  }));
                }

                logger.debug('Manually reconstructed object:', jsonObject);
              } else {
                // For non-reflection schemas, can't reliably reconstruct
                throw finalError;
              }
            }
          }

          // For reflection schema, ensure we have all required properties
          if (isReflection && jsonObject) {
            if (!jsonObject.thought) jsonObject.thought = '';
            if (!jsonObject.facts) jsonObject.facts = [];
            if (!jsonObject.relationships) jsonObject.relationships = [];
          }

          // Validate against schema if provided
          // if (params.schema) {
          // 	try {
          // 		return z.object(params.schema).parse(jsonObject);
          // 	} catch (zodError) {
          // 		logger.error("Schema validation failed:", zodError);
          // 		// If we have partial data that matches the schema structure, return what we have
          // 		if (isReflection && jsonObject.thought) {
          // 			return jsonObject;
          // 		}
          // 		throw zodError;
          // 	}
          // }

          return jsonObject;
        } catch (parseError) {
          logger.error('Failed to parse JSON from Anthropic response:', parseError);
          logger.error('Raw response:', text);
          throw new Error('Invalid JSON returned from Anthropic model');
        }
      } catch (error) {
        logger.error('Error generating object:', error);
        throw error;
      }
    },
  },
  tests: [
    {
      name: 'anthropic_plugin_tests',
      tests: [
        {
          name: 'anthropic_test_text_small',
          fn: async (runtime) => {
            try {
              const text = await runtime.useModel(ModelType.TEXT_SMALL, {
                prompt: 'What is the nature of reality in 10 words?',
              });
              if (text.length === 0) {
                throw new Error('Failed to generate text');
              }
              logger.log('generated with test_text_small:', text);
            } catch (error) {
              logger.error('Error in test_text_small:', error);
              throw error;
            }
          },
        },
        {
          name: 'anthropic_test_text_large',
          fn: async (runtime) => {
            try {
              const text = await runtime.useModel(ModelType.TEXT_LARGE, {
                prompt: 'What is the nature of reality in 10 words?',
              });
              if (text.length === 0) {
                throw new Error('Failed to generate text');
              }
              logger.log('generated with test_text_large:', text);
            } catch (error) {
              logger.error('Error in test_text_large:', error);
              throw error;
            }
          },
        },
      ],
    },
  ],
};

export default anthropicPlugin;
