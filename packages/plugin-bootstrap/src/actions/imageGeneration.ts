import {
  type Action,
  type ActionExample,
  composePromptFromState,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  ModelType,
  type State,
  ContentType,
  parseKeyValueXml,
  type ActionResult,
  logger,
} from '@elizaos/core';
import { v4 } from 'uuid';

/**
 * Template for generating an image for the character using a prompt.
 *
 * @type {string}
 */
const imageGenerationTemplate = `# Task: Generate an image prompt based on the user's request.
  {{providers}}
  # Instructions:
  Based on the user's message in the conversation, write a clear, concise, and visually descriptive prompt for image generation. Focus only on what the user wants to see, extract the key visual elements from the request, and formulate a detailed prompt suitable for image generation.

  # Recent conversation:
  {{recentMessages}}
  
  Your response should be formatted in XML like this:
  <response>
    <prompt>Your image generation prompt here</prompt>
  </response>
  
  Your response should include the valid XML block and nothing else.`;

/**
 * Represents an action that allows the agent to generate an image using a generated prompt.
 *
 * This action can be used in a chain where the agent needs to visualize or illustrate a concept, emotion, or scene.
 */
export const generateImageAction = {
  name: 'GENERATE_IMAGE',
  similes: ['DRAW', 'CREATE_IMAGE', 'RENDER_IMAGE', 'VISUALIZE'],
  description:
    'Generates an image based on a generated prompt reflecting the current conversation. Use GENERATE_IMAGE when the agent needs to visualize, illustrate, or demonstrate something visually for the user.',
  validate: async (_runtime: IAgentRuntime) => {
    return true;
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State,
    _options: any,
    callback: HandlerCallback,
    responses?: Memory[]
  ): Promise<ActionResult> => {
    try {
      const allProviders = responses?.flatMap((res) => res.content?.providers ?? []) ?? [];

      state = await runtime.composeState(message, [...(allProviders ?? []), 'RECENT_MESSAGES']);

      const prompt = composePromptFromState({
        state,
        template: runtime.character.templates?.imageGenerationTemplate || imageGenerationTemplate,
      });

      const promptResponse = await runtime.useModel(ModelType.TEXT_LARGE, {
        prompt,
      });

      // Parse XML response
      const parsedXml = parseKeyValueXml(promptResponse);

      const imagePrompt = parsedXml?.prompt || 'Unable to generate descriptive prompt for image';

      const imageResponse = await runtime.useModel(ModelType.IMAGE, {
        prompt: imagePrompt,
      });

      if (!imageResponse || imageResponse.length === 0 || !imageResponse[0]?.url) {
        logger.error(
          {
            imageResponse,
            imagePrompt,
          },
          'generateImageAction: Image generation failed - no valid response received'
        );
        return {
          text: 'Image generation failed',
          values: {
            success: false,
            error: 'IMAGE_GENERATION_FAILED',
            prompt: imagePrompt,
          },
          data: {
            actionName: 'GENERATE_IMAGE',
            prompt: imagePrompt,
            rawResponse: imageResponse,
          },
          success: false,
        };
      }

      const imageUrl = imageResponse[0].url;

      logger.info(`[GENERATE_IMAGE] Received image URL: ${imageUrl}`);

      // Determine file extension from URL or default to png
      const getFileExtension = (url: string): string => {
        try {
          const urlPath = new URL(url).pathname;
          const extension = urlPath.split('.').pop()?.toLowerCase();
          // Common image extensions
          if (extension && ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'].includes(extension)) {
            return extension;
          }
          // Extension not in allowed list, fall through to default
        } catch (e) {
          // URL parsing failed (malformed URL), fall back to png
        }
        return 'png'; // Default fallback for invalid/unknown extensions
      };

      // Create shared attachment data to avoid duplication
      const extension = getFileExtension(imageUrl);
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const fileName = `Generated_Image_${timestamp}.${extension}`;
      const attachmentId = v4();

      const responseContent = {
        attachments: [
          {
            id: attachmentId,
            url: imageUrl,
            title: fileName,
            contentType: ContentType.IMAGE,
          },
        ],
        thought: `Generated an image based on: "${imagePrompt}"`,
        actions: ['GENERATE_IMAGE'],
        text: imagePrompt,
      };

      await callback(responseContent);

      return {
        text: 'Generated image',
        values: {
          success: true,
          imageGenerated: true,
          imageUrl,
          prompt: imagePrompt,
        },
        data: {
          actionName: 'GENERATE_IMAGE',
          imageUrl,
          prompt: imagePrompt,
        },
        success: true,
      };
    } catch (error) {
      const err = error as Error;
      logger.error(
        {
          message: err.message,
          stack: err.stack,
        },
        'generateImageAction: Exception during image generation'
      );
      return {
        text: 'Image generation failed',
        values: {
          success: false,
          error: 'IMAGE_GENERATION_FAILED',
        },
        data: {
          actionName: 'GENERATE_IMAGE',
          errorMessage: err.message,
        },
        success: false,
      };
    }
  },
  examples: [
    [
      {
        name: '{{name1}}',
        content: {
          text: 'Can you show me what a futuristic city looks like?',
        },
      },
      {
        name: '{{name2}}',
        content: {
          text: "Sure, I'll create a futuristic city image for you. One moment...",
          actions: ['GENERATE_IMAGE'],
        },
      },
    ],
    [
      {
        name: '{{name1}}',
        content: {
          text: 'What does a neural network look like visually?',
        },
      },
      {
        name: '{{name2}}',
        content: {
          text: 'I’ll create a visualization of a neural network for you, one sec...',
          actions: ['GENERATE_IMAGE'],
        },
      },
    ],
    [
      {
        name: '{{name1}}',
        content: {
          text: 'Can you visualize the feeling of calmness for me?',
        },
      },
      {
        name: '{{name2}}',
        content: {
          text: 'Creating an image to capture calmness for you, please wait a moment...',
          actions: ['GENERATE_IMAGE'],
        },
      },
    ],
    [
      {
        name: '{{name1}}',
        content: {
          text: 'What does excitement look like as an image?',
        },
      },
      {
        name: '{{name2}}',
        content: {
          text: 'Let me generate an image that represents excitement for you, give me a second...',
          actions: ['GENERATE_IMAGE'],
        },
      },
    ],
  ] as ActionExample[][],
} as Action;
