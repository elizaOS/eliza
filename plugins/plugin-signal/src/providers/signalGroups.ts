import type { IAgentRuntime, Memory, Provider, ProviderResult, State } from "@elizaos/core";
import { validateActionKeywords, validateActionRegex } from "@elizaos/core";
import type { SignalService } from "../service";
import { SIGNAL_SERVICE_NAME } from "../types";

const RELEVANCE_KEYWORDS = ["signal", "group", "groups"] as const;
const RELEVANCE_REGEX = /\b(?:signal|groups?)\b/i;

const DESCRIPTION_PREVIEW_LIMIT = 50;
const GROUP_LIMIT = 50;

interface SignalGroupEntry {
  id: string;
  name: string;
  description: string;
  memberCount: number;
}

export const signalGroupsProvider: Provider = {
  name: "signalGroups",
  description:
    "Lists active Signal groups the bot is a member of with member counts and short descriptions.",
  descriptionCompressed: "Active Signal groups (member counts, descriptions).",
  dynamic: true,
  contexts: ["messaging", "connectors"],
  contextGate: { anyOf: ["messaging", "connectors"] },
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
      const groups = await service.getGroups();
      const sorted = groups
        .filter((g) => g.isMember && !g.isBlocked)
        .sort((a, b) => a.name.localeCompare(b.name))
        .slice(0, GROUP_LIMIT);

      const entries: SignalGroupEntry[] = sorted.map((g) => {
        const desc = g.description ?? "";
        return {
          id: g.id,
          name: g.name,
          description:
            desc.length > DESCRIPTION_PREVIEW_LIMIT
              ? `${desc.slice(0, DESCRIPTION_PREVIEW_LIMIT)}...`
              : desc,
          memberCount: g.members.length,
        };
      });

      return {
        data: {
          groupCount: entries.length,
          groups: entries,
        },
        values: {
          groupCount: entries.length,
        },
        text: JSON.stringify({
          signal_groups: {
            count: entries.length,
            items: entries,
          },
        }),
      };
    } catch (error) {
      return {
        data: {
          groupCount: 0,
          groups: [],
          error: error instanceof Error ? error.message : String(error),
        },
        values: {
          groupCount: 0,
          signalGroupsAvailable: false,
        },
        text: JSON.stringify({ signal_groups: { status: "error" } }),
      };
    }
  },
};

export default signalGroupsProvider;
