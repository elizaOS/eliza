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
  } from '@elizaos/core';
  
  /**
   * Template for generating an image for the character using a prompt.
   *
   * @type {string}
   */
  const imageGenerationTemplate = `# Task: Generate an image prompt for {{agentName}}.
  {{providers}}
  # Instructions:
  Write a clear, concise, and visually descriptive prompt that should be used to generate an image representing {{agentName}}'s next action or visualization for the conversation.
  
  Your response should be formatted in a valid JSON block like this:
  \`\`\`json
  {
      "prompt": "<string>"
  }
  \`\`\`
  
  Your response should include the valid JSON block and nothing else.`;
  
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
    ) => {
      const allProviders = responses?.flatMap((res) => res.content?.providers ?? []) ?? [];
  
      state = await runtime.composeState(message, [...(allProviders ?? []), 'RECENT_MESSAGES']);
  
      const prompt = composePromptFromState({
        state,
        template: imageGenerationTemplate,
      });

      const promptResponse = await runtime.useModel(ModelType.OBJECT_LARGE, {
        prompt,
      });

      const imagePrompt = typeof promptResponse === 'object' && promptResponse && 'prompt' in promptResponse 
        ? String(promptResponse.prompt) 
        : 'Unable to generate descriptive prompt for image';

      const imageResponse = await runtime.useModel(ModelType.IMAGE, {
        prompt: imagePrompt,
      });

      if (!imageResponse || imageResponse.length === 0 || !imageResponse[0]?.url) {
        console.error('generateImageAction: Image generation failed - no valid response received', {
          imageResponse,
          imagePrompt,
        });
        return;
      }

      const imageUrl = imageResponse[0].url;

      const responseContent = {
        attachments: [
          {
            id: crypto.randomUUID(),
            url: imageUrl,
            title: "Generated Image",
            contentType: ContentType.IMAGE
          },
        ],
        thought: `Generated an image based on: "${imagePrompt}"`,
        actions: ['GENERATE_IMAGE'],
        text: imagePrompt
      };

      await callback(responseContent);
  
      return true;
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
            image: '<image_url_or_reference>',
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
            image: '<image_url_or_reference>',
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
            image: '<image_url_or_reference>',
            actions: ['GENERATE_IMAGE'],
          },
        },
      ],
    ] as ActionExample[][],
  } as Action;
  