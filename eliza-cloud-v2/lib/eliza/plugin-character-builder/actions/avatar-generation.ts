import {
  type Action,
  type ActionExample,
  composePromptFromState,
  type HandlerCallback,
  type HandlerOptions,
  type IAgentRuntime,
  type Memory,
  ModelType,
  type State,
  ContentType,
  type ActionResult,
  logger,
  parseKeyValueXml,
} from "@elizaos/core";
import { v4 } from "uuid";
import { isCreatorMode } from "../../shared/utils/helpers";
import { charactersService } from "@/lib/services/characters/characters";

/**
 * Avatar generation prompt template.
 * Crafts a detailed, stylized prompt based on character traits.
 */
const avatarPromptTemplate = `# Task: Generate a unique character avatar prompt

You are creating a prompt for an AI image generator to produce a character avatar.
The avatar should be iconic, memorable, and capture the character's essence.

## Character Context
Name: {{agentName}}
{{#if bio}}
Bio: {{bio}}
{{/if}}
{{#if adjectives}}
Personality: {{adjectives}}
{{/if}}
{{#if system}}
Identity: {{system}}
{{/if}}

## Avatar Style Guidelines
- **Format**: Square portrait, centered composition, suitable for profile picture
- **Style**: High-quality digital illustration, cinematic lighting
- **Background**: Dark gradient (#0A0A0A to #1a1a1a), subtle atmospheric elements
- **Mood**: Should reflect the character's personality and vibe
- **Details**: Clean lines, professional quality, no text or watermarks

## Prompt Engineering Rules
1. Focus on the character's visual presence and energy
2. Include distinctive features that make them recognizable
3. Use evocative descriptors for mood and atmosphere
4. Keep the subject framed as a portrait (head/shoulders)
5. Avoid generic descriptions - make it unique to THIS character

{{conversationLog}}

{{receivedMessageHeader}}

Based on the user's request and character context:
1. Write a detailed image generation prompt for the avatar
2. Write a brief, natural response to send along with the generated avatar image

<response>
  <thought>What visual elements would best capture this character's essence?</thought>
  <prompt>Your detailed avatar generation prompt here</prompt>
  <text>A brief, natural message to accompany the avatar (1-2 sentences, be specific to this character)</text>
</response>`;

/**
 * GENERATE_AVATAR Action
 *
 * Generates a custom AI avatar for the character being built/edited.
 * Returns the avatar URL in metadata for the UI to update the character.
 *
 * Works in both Creator and Build modes.
 */
export const generateAvatarAction = {
  name: "GENERATE_AVATAR",
  description: `Generate an AI avatar portrait for the character. Use when:
- User asks to create, generate, or make an avatar
- User wants a profile picture for their character
- User says "give me an avatar", "create avatar", "generate profile pic"
- User describes how their character should look
Returns the avatar URL for immediate preview and update.`,
  validate: async (
    _runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
  ) => {
    return true;
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State,
    _options: HandlerOptions | undefined,
    callback: HandlerCallback,
    responses?: Memory[],
  ): Promise<ActionResult> => {
    const creatorMode = isCreatorMode(runtime);
    const modeLabel = creatorMode ? "Creator" : "Build";

    logger.info(
      `[GENERATE_AVATAR] ${modeLabel} mode - Generating character avatar`,
    );

    // Compose state with character context
    const allProviders =
      responses?.flatMap((res) => res.content?.providers ?? []) ?? [];

    state = await runtime.composeState(message, [
      ...(allProviders ?? []),
      "SUMMARIZED_CONTEXT",
      "RECENT_MESSAGES",
      "CURRENT_CHARACTER",
    ]);

    const bio = Array.isArray(runtime.character.bio)
      ? runtime.character.bio.join(" ")
      : runtime.character.bio || "";
    const adjectives = runtime.character.adjectives?.join(", ") || "";
    const system = runtime.character.system || "";

    // Add character context to state - conversationLog has the actual character being discussed
    state.values = {
      ...state.values,
      bio,
      adjectives,
      system,
    };

    // Generate the avatar prompt
    const promptTemplate =
      runtime.character.templates?.avatarGenerationTemplate ||
      avatarPromptTemplate;

    const prompt = composePromptFromState({
      state,
      template: promptTemplate,
    });

    const promptResponse = await runtime.useModel(ModelType.TEXT_LARGE, {
      prompt,
    });

    // Parse the response using parseKeyValueXml
    const parsed = parseKeyValueXml(promptResponse) as {
      thought?: string;
      prompt?: string;
      text?: string;
    } | null;

    const avatarPrompt =
      parsed?.prompt?.trim() ||
      `Professional character avatar portrait. Digital illustration, dark background (#0A0A0A), high quality, cinematic lighting, centered portrait composition, suitable for profile picture.`;

    const thought = parsed?.thought?.trim() || "Generating character avatar";
    const responseText = parsed?.text?.trim() || "Here's the avatar I created!";

    logger.info(
      `[GENERATE_AVATAR] Generated prompt: ${avatarPrompt.substring(0, 100)}...`,
    );

    // Generate the avatar image
    const imageResponse = await runtime.useModel(ModelType.IMAGE, {
      prompt: avatarPrompt,
    });

    if (
      !imageResponse ||
      imageResponse.length === 0 ||
      !imageResponse[0]?.url
    ) {
      logger.error(
        "[GENERATE_AVATAR] Image generation failed - no valid response",
        JSON.stringify(
          {
            imageResponse,
            avatarPrompt,
          },
          null,
          2,
        ),
      );

      await callback({
        text: "I couldn't generate the avatar right now. Want me to try again?",
        thought: "Avatar generation failed - no image returned from model",
        metadata: {
          action: "GENERATE_AVATAR",
          success: false,
          error: "IMAGE_GENERATION_FAILED",
        },
      });

      return {
        text: "Avatar generation failed",
        values: {
          success: false,
          error: "IMAGE_GENERATION_FAILED",
          prompt: avatarPrompt,
        },
        data: {
          actionName: "GENERATE_AVATAR",
          prompt: avatarPrompt,
          rawResponse: imageResponse,
        },
        success: false,
      };
    }

    const avatarUrl = imageResponse[0].url;
    logger.info(
      `[GENERATE_AVATAR] Avatar generated successfully: ${avatarUrl}`,
    );

    // Auto-save avatar in build mode (existing character)
    let avatarSaved = false;
    if (!creatorMode && runtime.character.id) {
      // Use getSetting() to properly resolve from request context (not direct character.settings access)
      const userId = runtime.getSetting("USER_ID") as string;

      if (userId) {
        logger.info(
          `[GENERATE_AVATAR] Auto-saving avatar for character ${runtime.character.id}`,
        );

        const savedCharacter = await charactersService.updateForUser(
          runtime.character.id as string,
          userId,
          { avatar_url: avatarUrl },
        );

        if (savedCharacter) {
          avatarSaved = true;
          // Update in-memory character
          runtime.character.settings = {
            ...runtime.character.settings,
            avatarUrl,
          };
          logger.info(`[GENERATE_AVATAR] Avatar saved successfully`);
        } else {
          logger.warn(
            `[GENERATE_AVATAR] Failed to save avatar - permission denied or character not found`,
          );
        }
      } else {
        logger.warn(
          `[GENERATE_AVATAR] Cannot auto-save - no USER_ID in runtime settings`,
        );
      }
    }

    // Create attachment for display
    const attachmentId = v4();
    const timestamp = new Date()
      .toISOString()
      .replace(/[:.]/g, "-")
      .slice(0, 19);
    const fileName = `Avatar_${timestamp}.png`;

    const attachments = [
      {
        id: attachmentId,
        url: avatarUrl,
        title: fileName,
        contentType: ContentType.IMAGE,
      },
    ];

    // Response with avatar image and contextual text from LLM
    const responseContent = {
      text: responseText,
      thought,
      attachments,
      actions: ["GENERATE_AVATAR"],
      metadata: {
        action: "GENERATE_AVATAR",
        success: true,
        avatarUrl,
        avatarSaved,
        characterId: runtime.character.id,
        prompt: avatarPrompt,
        // Include proposed change so UI can apply it like SUGGEST_CHANGES
        changes: {
          avatarUrl,
        },
      },
    };

    await callback(responseContent);

    return {
      text: avatarSaved ? "Generated and saved avatar" : "Generated avatar",
      values: {
        success: true,
        avatarGenerated: true,
        avatarSaved,
        avatarUrl,
        prompt: avatarPrompt,
      },
      data: {
        actionName: "GENERATE_AVATAR",
        avatarUrl,
        avatarSaved,
        prompt: avatarPrompt,
        attachments,
      },
      success: true,
    };
  },
  examples: [
    [
      {
        name: "{{user1}}",
        content: { text: "Generate an avatar for my character" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Here's your character's new look!",
          actions: ["GENERATE_AVATAR"],
        },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: { text: "Create a profile picture" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "I captured the essence of the character in this portrait.",
          actions: ["GENERATE_AVATAR"],
        },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: { text: "Give me an avatar that looks mysterious and dark" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Here's a mysterious vibe that fits the character perfectly.",
          actions: ["GENERATE_AVATAR"],
        },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: { text: "Make an avatar" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Created an avatar that reflects the character's personality.",
          actions: ["GENERATE_AVATAR"],
        },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: { text: "I need a picture for my AI companion" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Here's a portrait that brings your companion to life!",
          actions: ["GENERATE_AVATAR"],
        },
      },
    ],
  ] as ActionExample[][],
} as Action;
