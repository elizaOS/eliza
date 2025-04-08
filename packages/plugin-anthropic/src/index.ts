import { anthropic } from '@ai-sdk/anthropic';
import type { ObjectGenerationParams, GenerateTextParams, Plugin } from '@elizaos/core';
import { ModelType, logger } from '@elizaos/core';
import { generateText } from 'ai';
import { jsonrepair } from 'jsonrepair';

/**
 * Enhanced function to extract and parse JSON from LLM responses
 * Handles various response formats including mixed markdown and JSON with code blocks
 */
const extractAndParseJSON = (text: string) => {
  try {
    // First attempt: Try direct JSON parsing
    return JSON.parse(text);
  } catch (initialError) {
    logger.debug('Initial JSON parse failed, attempting alternative extraction methods');

    // Try JSONRepair first
    try {
      const repaired = jsonrepair(text);
      return JSON.parse(repaired);
    } catch (repairError) {
      logger.debug('JSONRepair failed, proceeding with manual extraction methods');
    }

    // Check if we have a valid JSON structure with embedded code blocks
    // This specifically addresses the case where Anthropic returns a valid JSON object
    // that contains markdown code blocks inside string values
    const isJsonWithCodeBlocks =
      text.trim().startsWith('{') && text.trim().endsWith('}') && text.includes('```');

    if (isJsonWithCodeBlocks) {
      // Replace code blocks with escaped versions to preserve them in the JSON
      try {
        // First, try to preserve the code blocks by temporarily replacing them
        const codeBlockPlaceholders: { placeholder: string; content: string }[] = [];
        let placeholderCounter = 0;
        const textWithPlaceholders = text.replace(
          /```(\w*)\n([\s\S]*?)```/g,
          (match, language, code) => {
            const placeholder = `__CODE_BLOCK_${placeholderCounter++}__`;
            codeBlockPlaceholders.push({
              placeholder,
              content: `\`\`\`${language}\n${code}\`\`\``,
            });
            return placeholder;
          }
        );

        // Try parsing with placeholders
        let parsed;
        try {
          // Try JSONRepair first
          const repaired = jsonrepair(textWithPlaceholders);
          parsed = JSON.parse(repaired);
        } catch (e) {
          // If JSONRepair fails, try direct parsing
          parsed = JSON.parse(textWithPlaceholders);
        }

        // Restore code blocks in the parsed object
        const restoreCodeBlocks = (obj: any): any => {
          if (typeof obj === 'string') {
            let result = obj;
            for (const { placeholder, content } of codeBlockPlaceholders) {
              result = result.replace(placeholder, content);
            }
            return result;
          } else if (Array.isArray(obj)) {
            return obj.map((item) => restoreCodeBlocks(item));
          } else if (obj !== null && typeof obj === 'object') {
            const result: Record<string, any> = {};
            for (const [key, value] of Object.entries(obj)) {
              result[key] = restoreCodeBlocks(value);
            }
            return result;
          }
          return obj;
        };

        return restoreCodeBlocks(parsed);
      } catch (codeBlockError) {
        logger.debug('Code block preservation failed, continuing with other methods');
      }
    }

    // Try to extract JSON from code blocks
    const extractFromCodeBlocks = (text: string): string | null => {
      // First priority: explicit JSON code blocks
      const jsonBlockRegex = /```json\s*([\s\S]*?)\s*```/;
      const jsonMatch = text.match(jsonBlockRegex);
      if (jsonMatch && jsonMatch[1]) {
        return jsonMatch[1].trim();
      }

      // Second priority: any code block that contains JSON-like content
      const anyBlockRegex = /```(?:\w*)\s*([\s\S]*?)\s*```/g;
      let match;
      while ((match = anyBlockRegex.exec(text)) !== null) {
        const blockContent = match[1].trim();
        if (blockContent.startsWith('{') && blockContent.endsWith('}')) {
          return blockContent;
        }
      }

      return null;
    };

    const extractedFromCodeBlock = extractFromCodeBlocks(text);
    if (extractedFromCodeBlock) {
      try {
        // Try parsing the extracted content
        return JSON.parse(extractedFromCodeBlock);
      } catch (blockParseError) {
        try {
          // Try with JSONRepair
          const repaired = jsonrepair(extractedFromCodeBlock);
          return JSON.parse(repaired);
        } catch (blockRepairError) {
          logger.debug('Failed to parse JSON from code block after repair');
        }
      }
    }

    // Look for JSON structure outside of code blocks
    const extractJSON = (text: string): string | null => {
      // Try to find JSON-like content in the text
      // This regex looks for content that starts with { and ends with }
      const jsonContentRegex = /(^|\n)\s*(\{[\s\S]*\})\s*($|\n)/;
      const contentMatch = text.match(jsonContentRegex);

      if (contentMatch && contentMatch[2]) {
        return contentMatch[2].trim();
      }

      // If no direct match, try to find the largest JSON-like structure
      const jsonPattern = /\{[\s\S]*?\}/g;
      const jsonMatches = text.match(jsonPattern);

      if (jsonMatches && jsonMatches.length > 0) {
        // Sort matches by length (descending) to try the largest JSON-like structure first
        return [...jsonMatches].sort((a, b) => b.length - a.length)[0];
      }

      return null;
    };

    const extractedJSON = extractJSON(text);
    if (extractedJSON) {
      try {
        // Try parsing the extracted JSON
        return JSON.parse(extractedJSON);
      } catch (extractParseError) {
        try {
          // Try with JSONRepair
          const repaired = jsonrepair(extractedJSON);
          return JSON.parse(repaired);
        } catch (extractRepairError) {
          logger.debug('Failed to parse JSON after extraction and repair');
        }
      }
    }

    // Try to manually extract a "thought"/"message" structure which is common
    const manuallyExtractStructure = (text: string) => {
      // Extract thought/message pattern if present
      const thoughtPattern = /"thought"\s*:\s*"([^"]*?)(?:"|$)/;
      const messagePattern = /"message"\s*:\s*"([^"]*?)(?:"|$)/;

      const thoughtMatch = text.match(thoughtPattern);
      const messageMatch = text.match(messagePattern);

      if (thoughtMatch || messageMatch) {
        const extractedContent: Record<string, any> = {
          type: 'reconstructed_response',
        };

        if (thoughtMatch) {
          extractedContent.thought = thoughtMatch[1].replace(/\\n/g, '\n');
        }

        if (messageMatch) {
          extractedContent.message = messageMatch[1].replace(/\\n/g, '\n');
        } else {
          // If no message was found but we have a thought, try to use the rest of the content as message
          let remainingContent = text;
          if (thoughtMatch) {
            // Remove the thought part from the content
            remainingContent = remainingContent.replace(thoughtPattern, '');
          }

          // Look for code blocks in the remaining content
          const codeBlocks: { language: string; code: string }[] = [];
          const codeBlockRegex = /```([\w]*)\n([\s\S]*?)```/g;
          let match;

          while ((match = codeBlockRegex.exec(remainingContent)) !== null) {
            codeBlocks.push({
              language: match[1] || 'text',
              code: match[2].trim(),
            });
          }

          if (codeBlocks.length > 0) {
            extractedContent.codeBlocks = codeBlocks;
            // Remove code blocks from the remaining content
            remainingContent = remainingContent.replace(codeBlockRegex, '');
          }

          // Use the cleaned remaining content as message
          extractedContent.message = remainingContent.trim();
        }

        return extractedContent;
      }

      // For reflection schema-like structure
      if (text.includes('thought') || text.includes('facts') || text.includes('relationships')) {
        logger.debug('Attempting to extract reflection schema components');

        const result: Record<string, any> = {
          thought: '',
          facts: [],
          relationships: [],
          rawContent: text,
        };

        // Try to extract thought
        const thoughtMatch = text.match(/thought["\s:]+([^"{}[\],]+)/i);
        if (thoughtMatch) {
          result.thought = thoughtMatch[1].trim();
        }

        // Attempt to extract facts and relationships would go here
        // This would require more complex parsing logic for arrays

        return result;
      }

      return null;
    };

    const manuallyExtracted = manuallyExtractStructure(text);
    if (manuallyExtracted) {
      return manuallyExtracted;
    }

    // Last resort: Return a structured object with the raw text
    logger.debug(
      'All JSON extraction methods failed, returning structured object with raw content'
    );
    return {
      type: 'unstructured_response',
      content: text,
    };
  }
};

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
      // If API key is not set, we'll show a warning but continue
      if (!process.env.ANTHROPIC_API_KEY) {
        logger.warn(
          'ANTHROPIC_API_KEY is not set in environment - Anthropic functionality will be limited'
        );
        // Return early without throwing an error
        return;
      }
    } catch (error) {
      // Convert to warning instead of error
      logger.warn(
        `Anthropic plugin configuration issue: ${error} - You need to configure the ANTHROPIC_API_KEY in your environment variables`
      );
    }
  },
  models: {
    [ModelType.TEXT_SMALL]: async (runtime, { prompt, stopSequences = [] }: GenerateTextParams) => {
      const temperature = 0.7;
      const smallModel = runtime.getSetting('ANTHROPIC_SMALL_MODEL') ?? 'claude-3-haiku-20240307';
      const maxTokens = smallModel.includes('-3-') ? 4096 : 8192;

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
      const smallModel = runtime.getSetting('ANTHROPIC_SMALL_MODEL') ?? 'claude-3-haiku-20240307';
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

        // Extract and parse JSON from the response with our improved function
        try {
          logger.debug('Attempting to parse response from Anthropic model');
          const jsonObject = extractAndParseJSON(text);

          // For reflection schema, ensure we have all required properties
          if (isReflection && jsonObject) {
            if (!jsonObject.thought) jsonObject.thought = '';
            if (!jsonObject.facts) jsonObject.facts = [];
            if (!jsonObject.relationships) jsonObject.relationships = [];
          }

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

        // Extract and parse JSON from the response with our improved function
        try {
          logger.debug('Attempting to parse response from Anthropic model');
          const jsonObject = extractAndParseJSON(text);

          // For reflection schema, ensure we have all required properties
          if (isReflection && jsonObject) {
            if (!jsonObject.thought) jsonObject.thought = '';
            if (!jsonObject.facts) jsonObject.facts = [];
            if (!jsonObject.relationships) jsonObject.relationships = [];
          }

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
        {
          name: 'anthropic_test_object_with_code_blocks',
          fn: async (runtime) => {
            try {
              const result = await runtime.useModel(ModelType.OBJECT_SMALL, {
                prompt: 'Give me instructions to install Node.js',
                schema: { type: 'object' },
              });
              logger.log('Generated object with code blocks:', result);
              if (!result || result.error) {
                throw new Error('Failed to generate object with code blocks');
              }
            } catch (error) {
              logger.error('Error in test_object_with_code_blocks:', error);
              throw error;
            }
          },
        },
      ],
    },
  ],
};

export default anthropicPlugin;
