import {
  EventType,
  logger,
  type MessagePayload,
  type Plugin,
} from "@elizaos/core";
import { actionsProvider } from "./providers/actions";
import { assistantGuideProvider } from "./providers/assistant-guide";
import { characterGuideProvider } from "./providers/character-guide";
import { currentCharacterProvider } from "./providers/current-character";
import { modeContextProvider } from "./providers/mode-context";
import { generateAvatarAction } from "./actions/avatar-generation";
import { suggestChangesAction } from "./actions/suggest-changes";
import { createCharacterAction } from "./actions/create-character";
import { saveChangesAction } from "./actions/save-changes";
import { testResponseAction } from "./actions/test-response";
import { builderChatAction } from "./actions/builder-chat";
import { guideOnboardingAction } from "./actions/guide-onboarding";
import { handleMessage } from "./handler";
import { roomTitleEvaluator } from "../shared/evaluators";
import { characterProvider, recentMessagesProvider } from "../shared/providers";
import type { StreamChunkCallback } from "../shared/types";

/**
 * Character Builder Plugin
 *
 * Provides AI-assisted character creation and editing.
 *
 * Two modes:
 * - CREATOR MODE: Chat with Eliza to create new characters/assistants
 * - BUILD MODE: Edit existing characters with the character itself
 *
 * Actions:
 * - GUIDE_ONBOARDING: Initial setup, determine build type (creator mode only)
 * - SUGGEST_CHANGES: Expert guidance with optional character JSON preview
 * - CREATE_CHARACTER: Finalize and save new character (creator mode only)
 * - SAVE_CHANGES: Save changes to existing character (build mode only)
 * - TEST_RESPONSE: Simulate character response (build mode only)
 * - BUILDER_CHAT: General conversation (both modes)
 * - GENERATE_AVATAR: Generate character avatar portrait (both modes)
 */
export const characterBuilderPlugin: Plugin = {
  name: "eliza-character-builder",
  description: "Character creation and editing assistant",
  events: {
    [EventType.MESSAGE_RECEIVED]: [
      async (payload: MessagePayload) => {
        if (!payload.callback) return;
        const onStreamChunk = (
          payload as MessagePayload & { onStreamChunk?: StreamChunkCallback }
        ).onStreamChunk;
        logger.info(
          `[Builder] Message received in room ${payload.message.roomId}, streaming=${!!onStreamChunk}`,
        );
        await handleMessage({
          runtime: payload.runtime,
          message: payload.message,
          callback: payload.callback,
          onStreamChunk,
        });
      },
    ],
    [EventType.MESSAGE_SENT]: [
      async (payload: MessagePayload) => {
        logger.debug(`[Builder] Message sent: ${payload.message.content.text}`);
      },
    ],
  },
  providers: [
    actionsProvider,
    assistantGuideProvider,
    characterGuideProvider,
    currentCharacterProvider,
    modeContextProvider,
    recentMessagesProvider,
    characterProvider,
  ],
  actions: [
    // Creator mode actions
    guideOnboardingAction,
    createCharacterAction,
    // Build mode actions
    saveChangesAction,
    testResponseAction,
    // Shared actions (both modes)
    suggestChangesAction,
    builderChatAction,
    generateAvatarAction,
  ],
  evaluators: [roomTitleEvaluator],
};

export default characterBuilderPlugin;
