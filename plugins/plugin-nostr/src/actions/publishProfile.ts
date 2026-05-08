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
import { normalizeNostrAccountId, readNostrAccountId } from "../accounts.js";
import type { NostrService } from "../service.js";
import { NOSTR_SERVICE_NAME, type NostrProfile } from "../types.js";

const PUBLISH_PROFILE_TEMPLATE = `# Task: Extract Nostr profile data
Based on the conversation, determine what profile information to update.

Recent conversation:
{{recentMessages}}

Respond with JSON only, no prose or fences, listing only the fields to update:

{
  "name": "optional display name",
  "about": "optional bio",
  "picture": "optional profile picture URL",
  "banner": "optional banner URL",
  "nip05": "optional user@domain.com",
  "lud16": "optional lightning address",
  "website": "optional website URL"
}`;

const MAX_NOSTR_PROFILE_FIELD_CHARS = 500;
const MAX_NOSTR_PROFILE_RELAYS = 10;
const NOSTR_PROFILE_ACTION_TIMEOUT_MS = 30_000;

function truncateProfileField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim()
    ? value.trim().slice(0, MAX_NOSTR_PROFILE_FIELD_CHARS)
    : undefined;
}

export const publishProfile: Action = {
  name: "NOSTR_PUBLISH_PROFILE",
  similes: ["UPDATE_NOSTR_PROFILE", "SET_NOSTR_PROFILE", "NOSTR_PROFILE"],
  description: "Publish or update the bot's Nostr profile (kind:0 metadata)",
  descriptionCompressed: "publish update bot Nostr profile (kind: 0 metadata)",
  contexts: ["social_posting", "connectors"],
  contextGate: { anyOf: ["social_posting", "connectors"] },
  roleGate: { minRole: "USER" },
  parameters: [
    {
      name: "name",
      description: "Display name for the Nostr profile.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "about",
      description: "Profile bio/about text.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "picture",
      description: "Profile picture URL.",
      required: false,
      schema: { type: "string" },
    },
  ],
  validate: async (_runtime: IAgentRuntime, message: Memory, _state?: State): Promise<boolean> => {
    return message.content.source === "nostr";
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    _options?: Record<string, unknown>,
    callback?: (response: { text: string; source?: string }) => void
  ): Promise<ActionResult> => {
    const nostrService = runtime.getService<NostrService>(NOSTR_SERVICE_NAME);

    if (!nostrService?.isConnected()) {
      if (callback) {
        callback({ text: "Nostr service is not available.", source: "nostr" });
      }
      return { success: false, error: "Nostr service not available" };
    }

    const requestedAccountId = normalizeNostrAccountId(
      readNostrAccountId(_options, message.content) ?? nostrService.getAccountId(runtime)
    );
    if (requestedAccountId !== nostrService.getAccountId(runtime)) {
      return {
        success: false,
        error: `Nostr account '${requestedAccountId}' is not available`,
      };
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

      const actionParams = parseJSONObjectFromText(String(response)) as Record<
        string,
        unknown
      > | null;
      if (actionParams) {
        profileInfo = {
          name: truncateProfileField(actionParams.name),
          displayName: truncateProfileField(actionParams.displayName),
          about: truncateProfileField(actionParams.about),
          picture: truncateProfileField(actionParams.picture),
          banner: truncateProfileField(actionParams.banner),
          nip05: truncateProfileField(actionParams.nip05),
          lud16: truncateProfileField(actionParams.lud16),
          website: truncateProfileField(actionParams.website),
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
    const timeoutMs = NOSTR_PROFILE_ACTION_TIMEOUT_MS;
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
        relays: result.relays?.slice(0, MAX_NOSTR_PROFILE_RELAYS),
        profile: profileInfo,
        timeoutMs,
        accountId: requestedAccountId,
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
