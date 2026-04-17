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
import type { SignalService } from "../service";
import { getSignalContactDisplayName, SIGNAL_SERVICE_NAME } from "../types";

export const listContacts: Action = {
  name: "SIGNAL_LIST_CONTACTS",
  similes: ["LIST_SIGNAL_CONTACTS", "SHOW_CONTACTS", "GET_CONTACTS", "SIGNAL_CONTACTS"],
  description: "List Signal contacts",
  descriptionCompressed: "List Signal contacts.",
    validate: async (runtime: any, message: any, state?: any, options?: any): Promise<boolean> => {
  	const __avTextRaw = typeof message?.content?.text === 'string' ? message.content.text : '';
  	const __avText = __avTextRaw.toLowerCase();
  	const __avKeywords = ['signal', 'list', 'contacts'];
  	const __avKeywordOk =
  		__avKeywords.length > 0 &&
  		__avKeywords.some((word) => word.length > 0 && __avText.includes(word));
  	const __avRegex = new RegExp('\\b(?:signal|list|contacts)\\b', 'i');
  	const __avRegexOk = __avRegex.test(__avText);
  	const __avSource = String(message?.content?.source ?? message?.source ?? '');
  	const __avExpectedSource = '';
  	const __avSourceOk = __avExpectedSource
  		? __avSource === __avExpectedSource
  		: Boolean(__avSource || state || runtime?.agentId || runtime?.getService || runtime?.getSetting);
  	const __avOptions = options && typeof options === 'object' ? options : {};
  	const __avInputOk =
  		__avText.trim().length > 0 ||
  		Object.keys(__avOptions as Record<string, unknown>).length > 0 ||
  		Boolean(message?.content && typeof message.content === 'object');

  	if (!(__avKeywordOk && __avRegexOk && __avSourceOk && __avInputOk)) {
  		return false;
  	}

  	const __avLegacyValidate = async (_runtime: IAgentRuntime, message: Memory, _state?: State): Promise<boolean> => {
    return message.content.source === "signal";
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
    _state?: State,
    _options?: HandlerOptions,
    callback?: HandlerCallback
  ): Promise<ActionResult | undefined> => {
    const signalService = runtime.getService(SIGNAL_SERVICE_NAME) as SignalService;

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
      source: message.content.source,
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
