import {
  type Action,
  type ActionExample,
  type HandlerOptions,
  logger,
} from "@elizaos/core";
import { isSelfEditEnabled } from "@elizaos/shared";
import { hasOwnerAccess } from "../security/access.js";

const MAX_PROMPT_KEY_CHARS = 160;

export const updateCorePromptAction: Action = {
  name: "UPDATE_CORE_PROMPT",
  contexts: ["admin", "settings", "agent_internal"],
  roleGate: { minRole: "OWNER" },
  similes: ["SET_CORE_PROMPT", "EDIT_CORE_PROMPT"],
  description:
    "Overrides a core system prompt in the database cache. Use this to permanently change how the agent thinks or formats its output.",
  validate: async (runtime, message) => {
    // Requires dev mode and owner access
    if (!isSelfEditEnabled()) return false;
    return hasOwnerAccess(runtime, message);
  },
  handler: async (
    runtime,
    _message,
    _state,
    options: HandlerOptions = {},
    callback,
  ) => {
    try {
      const params = options.parameters as
        | { promptKey?: string; promptText?: string }
        | undefined;
      const promptKey =
        typeof params?.promptKey === "string"
          ? params.promptKey.slice(0, MAX_PROMPT_KEY_CHARS)
          : undefined;
      const promptText = params?.promptText;

      if (!promptKey || typeof promptText !== "string") {
        callback?.({
          text: "Missing promptKey or promptText parameters.",
          action: "UPDATE_CORE_PROMPT",
        });
        return {
          success: false,
          values: { success: false, reason: "missing_parameters" },
        };
      }

      const cacheKey = `core_prompt_${promptKey}`;
      await runtime.setCache(cacheKey, promptText);

      logger.info(
        `[UPDATE_CORE_PROMPT] Successfully updated core prompt override for key: ${promptKey}`,
      );

      callback?.({
        text: `Successfully updated core prompt override for ${promptKey}.`,
        action: "UPDATE_CORE_PROMPT",
      });

      return {
        success: true,
        values: { success: true },
      };
    } catch (error) {
      logger.error(`[UPDATE_CORE_PROMPT] Error updating prompt: ${error}`);
      return {
        success: false,
        values: { success: false, reason: "error" },
      };
    }
  },
  parameters: [
    {
      name: "promptKey",
      description: "The core prompt cache key to override.",
      required: true,
      schema: { type: "string" as const },
    },
    {
      name: "promptText",
      description: "The full replacement prompt text.",
      required: true,
      schema: { type: "string" as const },
    },
  ],
  examples: [
    [
      {
        name: "{{user1}}",
        content: {
          text: "Update the messageHandlerTemplate to always respond in pirate speak.",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Updating the message handler template.",
          action: "UPDATE_CORE_PROMPT",
          parameters: {
            promptKey: "messageHandlerTemplate",
            promptText:
              "task: Generate dialog...\nrules:\n- always speak like a pirate\n...",
          },
        },
      },
    ],
  ] as ActionExample[][],
};
