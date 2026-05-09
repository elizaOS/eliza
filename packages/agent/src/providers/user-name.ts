/**
 * User name provider — injects the user's display name into the system prompt
 * when chatting via the app (client_chat). Tells the agent the user's name if
 * known, or hints that it can ask.
 *
 * Only active for `source === "client_chat"` so it never leaks into Telegram,
 * Discord, or other connectors.
 */

import type {
  IAgentRuntime,
  Memory,
  Provider,
  ProviderResult,
  State,
} from "@elizaos/core";
import { hasOwnerAccess } from "../security/access.js";
import { fetchConfiguredOwnerName } from "../services/owner-name.js";

export function createUserNameProvider(): Provider {
  return {
    name: "userName",
    description:
      "Injects the app user's display name into context (app chat only).",
    descriptionCompressed: "inject app user display name context (app chat)",
    position: 10,
    dynamic: true,
    contexts: ["general"],
    contextGate: { anyOf: ["general"] },
    cacheStable: false,
    cacheScope: "turn",
    roleGate: { minRole: "USER" },

    async get(
      runtime: IAgentRuntime,
      message: Memory,
      _state: State,
    ): Promise<ProviderResult> {
      const content = message.content as Record<string, unknown> | undefined;
      if (content?.source !== "client_chat") {
        return { text: "" };
      }

      if (!(await hasOwnerAccess(runtime, message))) {
        return { text: "" };
      }

      const name = await fetchConfiguredOwnerName();

      if (name) {
        return {
          text: `The user's name is ${name}.`,
          values: { userName: name },
        };
      }

      return {
        text:
          "No preferred user name is stored yet. The current fallback label is admin. " +
          "If it comes up naturally in conversation, you can ask what " +
          "they'd like to be called and use the SETTINGS action with op=set_owner_name to remember it.",
        values: { userName: "admin", userNameFallback: true },
      };
    },
  };
}
