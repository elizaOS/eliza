/**
 * Follow Action
 *
 * Follow or unfollow users on Moltbook.
 */

import type {
  Action,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { PLUGIN_NAME } from "../constants";
import type { MoltbookService } from "../service";

export const followAction: Action = {
  name: "MOLTBOOK_FOLLOW",
  similes: ["FOLLOW_MOLTBOOK_USER", "UNFOLLOW_MOLTBOOK_USER", "MOLTBOOK_UNFOLLOW"],
  description: "Follow or unfollow a user on Moltbook.",

  validate: async (runtime: any, message: any, state?: any, options?: any): Promise<boolean> => {
    const __avTextRaw = typeof message?.content?.text === "string" ? message.content.text : "";
    const __avText = __avTextRaw.toLowerCase();
    const __avKeywords = ["moltbook", "follow"];
    const __avKeywordOk =
      __avKeywords.length > 0 && __avKeywords.some((kw) => kw.length > 0 && __avText.includes(kw));
    const __avRegex = /\b(?:moltbook|follow)\b/i;
    const __avRegexOk = __avRegex.test(__avText);
    const __avSource = String(message?.content?.source ?? message?.source ?? "");
    const __avExpectedSource = "";
    const __avSourceOk = __avExpectedSource
      ? __avSource === __avExpectedSource
      : Boolean(__avSource || state || runtime?.agentId || runtime?.getService);
    const __avOptions = options && typeof options === "object" ? options : {};
    const __avInputOk =
      __avText.trim().length > 0 ||
      Object.keys(__avOptions as Record<string, unknown>).length > 0 ||
      Boolean(message?.content && typeof message.content === "object");

    if (!(__avKeywordOk && __avRegexOk && __avSourceOk && __avInputOk)) {
      return false;
    }

    const __avLegacyValidate = async (
      _runtime: IAgentRuntime,
      message: Memory,
      _state: State | undefined
    ): Promise<boolean> => {
      const text = message.content.text?.toLowerCase() || "";

      // Check for follow intent
      const hasFollowIntent = text.includes("follow") || text.includes("unfollow");

      const hasMoltbookMention =
        text.includes("moltbook") ||
        text.includes("molty") ||
        text.includes("@") ||
        text.includes("user");

      return hasFollowIntent && hasMoltbookMention;
    };
    try {
      return Boolean(await (__avLegacyValidate as any)(runtime, message, state, options));
    } catch {
      return false;
    }
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State | undefined,
    _options: unknown,
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    const service = runtime.getService<MoltbookService>(PLUGIN_NAME);
    if (!service) {
      const error = "Moltbook service is not available";
      if (callback) {
        await callback({ text: error, error: true });
      }
      return { success: false, error: new Error(error) };
    }

    // Check authentication
    const creds = await service.getCredentials();
    if (!creds) {
      const error = "Not authenticated with Moltbook.";
      if (callback) {
        await callback({ text: error, error: true });
      }
      return { success: false, error: new Error(error) };
    }

    // Check if account is claimed (required to follow)
    if (creds.claimStatus !== "claimed") {
      const claimUrl = creds.claimUrl || "https://moltbook.com";
      const error = `Cannot follow - account not yet claimed by human. Claim URL: ${claimUrl}`;
      if (callback) {
        await callback({
          text: `I can't follow others on Moltbook yet - my account needs to be claimed by a human first. Please visit: ${claimUrl}`,
          error: true,
        });
      }
      runtime.logger.warn({ claimUrl }, "Moltbook: Attempted to follow but account not claimed");
      return { success: false, error: new Error(error) };
    }

    // Extract intent
    const intent = extractFollowIntent(message.content.text || "");

    if (!intent.username && !intent.userId) {
      const error = "Please specify who to follow (username or @handle).";
      if (callback) {
        await callback({ text: error });
      }
      return { success: false, error: new Error(error) };
    }

    try {
      // Moltbook uses names for following, not IDs
      const moltyName = intent.username;

      if (!moltyName) {
        const error = "Please specify a molty name to follow (e.g., @MoltyName)";
        if (callback) {
          await callback({ text: error });
        }
        return { success: false, error: new Error(error) };
      }

      // Get profile for display (optional - doesn't fail if not found)
      const profile = await service.getProfile(moltyName);
      const displayName = profile?.username || moltyName;

      // Perform follow/unfollow
      let success: boolean;
      let description: string;

      if (intent.unfollow) {
        success = await service.unfollow(moltyName);
        description = `Unfollowed @${displayName}`;
      } else {
        success = await service.follow(moltyName);
        description = `Now following @${displayName}`;
      }

      if (!success) {
        const error = `Failed to ${intent.unfollow ? "unfollow" : "follow"} molty.`;
        if (callback) {
          await callback({ text: error, error: true });
        }
        return { success: false, error: new Error(error) };
      }

      // Success response
      if (callback) {
        const emoji = intent.unfollow ? "👋" : "🤝";
        let response = `${emoji} ${description}`;

        if (profile && !intent.unfollow) {
          response += `\n\n${profile.bio || "New molty on the block!"}`;
        }

        await callback({ text: response });
      }

      return {
        success: true,
        text: description,
        values: {
          moltyName,
          action: intent.unfollow ? "unfollow" : "follow",
        },
        data: {
          action: "MOLTBOOK_FOLLOW",
          moltyName,
          unfollow: intent.unfollow,
          profile,
        },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      runtime.logger.error({ error }, "Error following/unfollowing on Moltbook");

      if (callback) {
        await callback({
          text: `Failed: ${errorMessage}`,
          error: true,
        });
      }

      return {
        success: false,
        error: error instanceof Error ? error : new Error(errorMessage),
      };
    }
  },

  examples: [
    [
      {
        name: "{{userName}}",
        content: {
          text: "Follow @alice on Moltbook",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "🤝 Now following @alice\n\nAI researcher exploring agent architectures • 42 posts • 128 followers",
          actions: ["MOLTBOOK_FOLLOW"],
        },
      },
    ],
    [
      {
        name: "{{userName}}",
        content: {
          text: "Unfollow bob on Moltbook",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "👋 Unfollowed @bob",
          actions: ["MOLTBOOK_FOLLOW"],
        },
      },
    ],
  ],
};

/**
 * Extract follow intent from user message
 */
function extractFollowIntent(text: string): {
  username?: string;
  userId?: string;
  unfollow: boolean;
} {
  const lowerText = text.toLowerCase();

  // Determine if unfollow
  const unfollow = lowerText.includes("unfollow");

  // Extract @username
  const usernameMatch = text.match(/@(\w+)/);
  if (usernameMatch) {
    return { username: usernameMatch[1], unfollow };
  }

  // Extract username after follow/unfollow
  const actionMatch = text.match(/(?:follow|unfollow)\s+(\w+)/i);
  if (actionMatch) {
    return { username: actionMatch[1], unfollow };
  }

  // Extract user ID
  const userIdMatch = text.match(/user\s+([a-zA-Z0-9_-]+)/i);
  if (userIdMatch) {
    return { userId: userIdMatch[1], unfollow };
  }

  return { unfollow };
}

export default followAction;
