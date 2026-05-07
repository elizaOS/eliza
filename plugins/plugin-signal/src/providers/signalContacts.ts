import type { IAgentRuntime, Memory, Provider, ProviderResult, State } from "@elizaos/core";
import { validateActionKeywords, validateActionRegex } from "@elizaos/core";
import type { SignalService } from "../service";
import { getSignalContactDisplayName, SIGNAL_SERVICE_NAME } from "../types";

const RELEVANCE_KEYWORDS = ["signal", "contact", "contacts", "people"] as const;
const RELEVANCE_REGEX = /\b(?:signal|contacts?|people)\b/i;
const CONTACT_LIMIT = 100;

interface SignalContactEntry {
  number: string;
  name: string;
  uuid: string;
}

export const signalContactsProvider: Provider = {
  name: "signalContacts",
  description: "Lists active (non-blocked) Signal contacts with display name, number, and uuid.",
  descriptionCompressed: "Active Signal contacts (name, number, uuid).",
  dynamic: true,
  contexts: ["messaging", "connectors", "contacts"],
  contextGate: { anyOf: ["messaging", "connectors", "contacts"] },
  cacheScope: "turn",
  roleGate: { minRole: "ADMIN" },
  cacheStable: false,
  relevanceKeywords: [...RELEVANCE_KEYWORDS],
  get: async (runtime: IAgentRuntime, message: Memory, state: State): Promise<ProviderResult> => {
    const recentMessages = (state?.recentMessagesData as Memory[] | undefined) ?? [];
    const isRelevant =
      validateActionKeywords(message, recentMessages, [...RELEVANCE_KEYWORDS]) ||
      validateActionRegex(message, recentMessages, RELEVANCE_REGEX);
    if (!isRelevant) {
      return { text: "" };
    }

    if (message.content.source !== "signal") {
      return { data: {}, values: {}, text: "" };
    }

    const service = runtime.getService(SIGNAL_SERVICE_NAME) as SignalService | null;
    if (!service || !service.isServiceConnected()) {
      return { data: {}, values: {}, text: "" };
    }

    try {
      const contacts = await service.getContacts();
      const sorted = contacts
        .filter((c) => !c.blocked)
        .sort((a, b) => {
          const nameA = getSignalContactDisplayName(a);
          const nameB = getSignalContactDisplayName(b);
          return nameA.localeCompare(nameB);
        })
        .slice(0, CONTACT_LIMIT);

      const entries: SignalContactEntry[] = sorted.map((c) => ({
        number: c.number,
        name: getSignalContactDisplayName(c),
        uuid: c.uuid ?? "",
      }));

      return {
        data: {
          contactCount: entries.length,
          contacts: entries,
        },
        values: {
          contactCount: entries.length,
        },
        text: JSON.stringify({
          signal_contacts: {
            count: entries.length,
            items: entries,
          },
        }),
      };
    } catch (error) {
      return {
        data: {
          contactCount: 0,
          contacts: [],
          error: error instanceof Error ? error.message : String(error),
        },
        values: {
          contactCount: 0,
          signalContactsAvailable: false,
        },
        text: JSON.stringify({ signal_contacts: { status: "error" } }),
      };
    }
  },
};

export default signalContactsProvider;
