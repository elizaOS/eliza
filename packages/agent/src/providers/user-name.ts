/**
 * User name provider — injects the user's display name into the system prompt
 * when chatting via the app (client_chat). Tells the agent the user's name if
 * known, or hints that it can ask.
 *
 * Only active for `source === "client_chat"` so it never leaks into Telegram,
 * Discord, or other connectors.
 */

import { fetchConfiguredOwnerName } from "@elizaos/app-lifeops/lifeops/owner-profile";
import type {
  IAgentRuntime,
  Memory,
  Provider,
  ProviderResult,
  State,
} from "@elizaos/core";
import { hasOwnerAccess } from "../security/access.js";

export function createUserNameProvider(): Provider {
  return {
    name: "userName",
    description:
      "Injects the app user's display name into context (app chat only).",
    position: 10,
    dynamic: true,

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
          "they'd like to be called and use the SET_USER_NAME action to remember it.",
        values: { userName: "admin", userNameFallback: true },
      };
    },
  };
}
