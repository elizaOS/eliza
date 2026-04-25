import type {
  Action,
  ActionExample,
  ActionResult,
  Content,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { getSignalContactDisplayName } from "../types";
import {
  getMessageText,
  getSignalService,
  hasSignalService,
  hasStructuredSignalInvocation,
  isSignalConversation,
} from "./action-utils";

export const listContacts: Action = {
  name: "SIGNAL_LIST_CONTACTS",
  similes: ["LIST_SIGNAL_CONTACTS", "SHOW_CONTACTS", "GET_CONTACTS", "SIGNAL_CONTACTS"],
  description: "List Signal contacts",
  descriptionCompressed: "List Signal contacts.",
  validate: async (runtime: IAgentRuntime, message: Memory, _state?: State): Promise<boolean> => {
    if (!hasSignalService(runtime)) {
      return false;
    }

    if (isSignalConversation(message)) {
      return true;
    }

    if (hasStructuredSignalInvocation(message, "SIGNAL_LIST_CONTACTS")) {
      return true;
    }

    const text = getMessageText(message);
    return /\bsignal\b/i.test(text) && /\b(contact|contacts|people)\b/i.test(text);
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: HandlerOptions,
    callback?: HandlerCallback
  ): Promise<ActionResult | undefined> => {
    const signalService = getSignalService(runtime);

    if (!signalService || !signalService.isServiceConnected()) {
      await callback?.({
        text: "Signal service is not available.",
        source: "signal",
      });
      return { success: false, error: "Signal service not available" };
    }

    const contacts = await signalService.getContacts();

    // Filter out blocked contacts and sort by name
    const activeContacts = contacts
      .filter((c) => !c.blocked)
      .sort((a, b) => {
        const nameA = getSignalContactDisplayName(a);
        const nameB = getSignalContactDisplayName(b);
        return nameA.localeCompare(nameB);
      });

    // Format contact list
    const contactList = activeContacts.map((c) => {
      const name = getSignalContactDisplayName(c);
      const number = c.number;
      return `• ${name} (${number})`;
    });

    const response: Content = {
      text: `Found ${activeContacts.length} contacts:\n\n${contactList.join("\n")}`,
      source: message.content.source || "signal",
    };

    runtime.logger.debug(
      {
        src: "plugin:signal:action:list-contacts",
        contactCount: activeContacts.length,
      },
      "[SIGNAL_LIST_CONTACTS] Contacts listed"
    );

    await callback?.(response);

    return {
      success: true,
      data: {
        contactCount: activeContacts.length,
        contacts: activeContacts.map((c) => ({
          number: c.number,
          name: getSignalContactDisplayName(c),
          uuid: c.uuid,
        })),
      },
    };
  },
  examples: [
    [
      {
        name: "{{user1}}",
        content: {
          text: "Show me my Signal contacts",
        },
      },
      {
        name: "{{agent}}",
        content: {
          text: "I'll list your Signal contacts.",
          actions: ["SIGNAL_LIST_CONTACTS"],
        },
      },
    ],
  ] as ActionExample[][],
};

export default listContacts;
