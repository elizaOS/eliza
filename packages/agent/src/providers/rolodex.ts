import type {
  IAgentRuntime,
  Memory,
  Provider,
  ProviderResult,
  State,
} from "@elizaos/core";
import { logger } from "@elizaos/core";
import type {
  RelationshipsGraphService,
  RelationshipsPersonSummary,
} from "@elizaos/core";
import { getValidationKeywordTerms } from "@elizaos/shared";
import { hasAdminAccess } from "../security/access.js";

const MAX_CONTACTS = 10;

function formatPerson(person: RelationshipsPersonSummary): string {
  const platforms =
    person.platforms.length > 0 ? person.platforms.join(", ") : "no platforms";
  const parts = [
    `${person.displayName}${person.isOwner ? " [OWNER]" : ""} (${platforms})`,
  ];

  if (person.preferredCommunicationChannel) {
    parts.push(`prefers: ${person.preferredCommunicationChannel}`);
  }
  if (person.aliases.length > 0) {
    parts.push(`aka: ${person.aliases.slice(0, 3).join(", ")}`);
  }
  if (person.lastInteractionAt) {
    parts.push(`last: ${person.lastInteractionAt.slice(0, 10)}`);
  }
  if (person.factCount > 0) {
    parts.push(`${person.factCount} facts`);
  }

  return `- ${parts.join(" | ")}`;
}

export const rolodexProvider: Provider = {
  name: "rolodex",
  description:
    "Known contacts and relationships across all connected platforms (the Rolodex).",
  descriptionCompressed:
    "known contact relationship across connect platform (Rolodex)",
  dynamic: true,
  position: 7,
  relevanceKeywords: getValidationKeywordTerms("provider.rolodex.relevance", {
    includeAllLocales: true,
  }),
  contexts: ["contacts", "memory"],
  contextGate: { anyOf: ["contacts", "memory"] },
  cacheStable: false,
  cacheScope: "turn",
  roleGate: { minRole: "USER" },

  async get(
    runtime: IAgentRuntime,
    _message: Memory,
    _state: State,
  ): Promise<ProviderResult> {
    if (!(await hasAdminAccess(runtime, _message))) {
      return { text: "", values: {}, data: {} };
    }

    try {
      const graphService = runtime.getService(
        "relationships",
      ) as unknown as RelationshipsGraphService | null;

      if (!graphService) {
        return { text: "", values: {}, data: {} };
      }

      const snapshot = await graphService.getGraphSnapshot({
        limit: MAX_CONTACTS,
      });

      if (!snapshot || snapshot.people.length === 0) {
        return {
          text: "Rolodex: No known contacts yet.",
          values: { rolodexCount: 0 },
          data: { contacts: [], stats: snapshot?.stats },
        };
      }

      const lines: string[] = [
        `Rolodex (${snapshot.stats.totalPeople} contacts, ${snapshot.stats.totalIdentities} identities):`,
      ];

      for (const person of snapshot.people) {
        lines.push(formatPerson(person));
      }

      if (snapshot.stats.totalPeople > MAX_CONTACTS) {
        lines.push(
          `... and ${snapshot.stats.totalPeople - MAX_CONTACTS} more. Use SEARCH_ENTITY to find specific contacts.`,
        );
      }

      return {
        text: lines.join("\n"),
        values: {
          rolodexCount: snapshot.stats.totalPeople,
          rolodexIdentityCount: snapshot.stats.totalIdentities,
        },
        data: {
          contacts: snapshot.people,
          stats: snapshot.stats,
        },
      };
    } catch (error) {
      logger.error(
        "[rolodex] Error:",
        error instanceof Error ? error.message : String(error),
      );
      return { text: "", values: {}, data: {} };
    }
  },
};
