/**
 * Publish profile action for Nostr plugin.
 */

import {
  type Action,
  type ActionResult,
  composePromptFromState,
  type IAgentRuntime,
  type Memory,
  ModelType,
  parseJSONObjectFromText,
  type State,
} from "@elizaos/core";
import type { NostrService } from "../service.js";
import { NOSTR_SERVICE_NAME, type NostrProfile } from "../types.js";

const PUBLISH_PROFILE_TEMPLATE = `# Task: Extract Nostr profile data
Based on the conversation, determine what profile information to update.

Recent conversation:
{{recentMessages}}

Extract any of the following profile fields that should be updated:
- name: Display name
- about: Bio/description
- picture: Profile picture URL
- banner: Banner image URL
- nip05: Nostr verification (user@domain.com)
- lud16: Lightning address (user@domain.com)
- website: Website URL

Respond with a JSON object containing only the fields to update:
\`\`\`json
{
  "name": "optional name",
  "about": "optional bio"
}
\`\`\``;

export const publishProfile: Action = {
  name: "NOSTR_PUBLISH_PROFILE",
  similes: ["UPDATE_NOSTR_PROFILE", "SET_NOSTR_PROFILE", "NOSTR_PROFILE"],
  description: "Publish or update the bot's Nostr profile (kind:0 metadata)",

  validate: async (
    _runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
  ): Promise<boolean> => {
    return message.content.source === "nostr";
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    _options?: Record<string, unknown>,
    callback?: (response: { text: string; source?: string }) => void,
  ): Promise<ActionResult> => {
    const nostrService = runtime.getService<NostrService>(NOSTR_SERVICE_NAME);

    if (!nostrService || !nostrService.isConnected()) {
      if (callback) {
        callback({ text: "Nostr service is not available.", source: "nostr" });
      }
      return { success: false, error: "Nostr service not available" };
    }

    // Get or compose state
    const currentState = state ?? (await runtime.composeState(message));

    // Compose prompt
    const prompt = await composePromptFromState({
      template: PUBLISH_PROFILE_TEMPLATE,
      state: currentState,
    });

    // Extract parameters using LLM
    let profileInfo: NostrProfile | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const response = await runtime.useModel(ModelType.TEXT_SMALL, {
        prompt,
      });

      const parsed = parseJSONObjectFromText(String(response));
      if (parsed) {
        profileInfo = {
          name: parsed.name ? String(parsed.name) : undefined,
          displayName: parsed.displayName
            ? String(parsed.displayName)
            : undefined,
          about: parsed.about ? String(parsed.about) : undefined,
          picture: parsed.picture ? String(parsed.picture) : undefined,
          banner: parsed.banner ? String(parsed.banner) : undefined,
          nip05: parsed.nip05 ? String(parsed.nip05) : undefined,
          lud16: parsed.lud16 ? String(parsed.lud16) : undefined,
          website: parsed.website ? String(parsed.website) : undefined,
        };
        break;
      }
    }

    if (!profileInfo) {
      if (callback) {
        callback({
          text: "I couldn't understand the profile information. Please try again.",
          source: "nostr",
        });
      }
      return { success: false, error: "Could not extract profile parameters" };
    }

    // Publish profile
    const result = await nostrService.publishProfile(profileInfo);

    if (!result.success) {
      if (callback) {
        callback({
          text: `Failed to publish profile: ${result.error}`,
          source: "nostr",
        });
      }
      return { success: false, error: result.error };
    }

    if (callback) {
      callback({
        text: "Profile published successfully.",
        source: message.content.source as string,
      });
    }

    return {
      success: true,
      data: {
        eventId: result.eventId,
        relays: result.relays,
        profile: profileInfo,
      },
    };
  },

  examples: [
    [
      {
        name: "{{user1}}",
        content: { text: "Update your profile name to 'Bot Assistant'" },
      },
      {
        name: "{{agent}}",
        content: {
          text: "I'll update my Nostr profile.",
          actions: ["NOSTR_PUBLISH_PROFILE"],
        },
      },
    ],
  ],
};
