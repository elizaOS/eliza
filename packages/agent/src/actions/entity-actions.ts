import type {
  Action,
  HandlerOptions,
  IAgentRuntime,
  UUID,
} from "@elizaos/core";
import { logger } from "@elizaos/core";
import { hasAdminAccess } from "../security/access.js";
import type {
  RelationshipsGraphService,
  RelationshipsPersonDetail,
  RelationshipsPersonSummary,
} from "../services/relationships-graph.js";
import { hasContextSignalSyncForKey } from "./context-signal.js";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function formatPersonSummary(person: RelationshipsPersonSummary): string {
  const parts: string[] = [];
  parts.push(`Name: ${person.displayName}`);
  if (person.isOwner) {
    parts.push("Role: OWNER");
  }
  if (person.aliases.length > 0) {
    parts.push(`Aliases: ${person.aliases.join(", ")}`);
  }
  parts.push(`Platforms: ${person.platforms.join(", ") || "none"}`);

  for (const identity of person.identities) {
    for (const handle of identity.handles) {
      parts.push(
        `  @${handle.handle} on ${handle.platform}${handle.verified ? " (verified)" : ""}`,
      );
    }
  }

  if (person.emails.length > 0)
    parts.push(`Emails: ${person.emails.join(", ")}`);
  if (person.phones.length > 0)
    parts.push(`Phones: ${person.phones.join(", ")}`);
  if (person.websites.length > 0)
    parts.push(`Websites: ${person.websites.join(", ")}`);
  if (person.preferredCommunicationChannel) {
    parts.push(`Preferred channel: ${person.preferredCommunicationChannel}`);
  }
  if (person.categories.length > 0)
    parts.push(`Categories: ${person.categories.join(", ")}`);
  if (person.tags.length > 0) parts.push(`Tags: ${person.tags.join(", ")}`);
  if (person.profiles?.length > 0) {
    parts.push(
      `Profiles: ${person.profiles
        .map((profile) => {
          const primary =
            profile.handle ??
            profile.userId ??
            profile.displayName ??
            profile.entityId;
          return `${profile.source}=${primary}`;
        })
        .join(", ")}`,
    );
  }
  parts.push(
    `Facts: ${person.factCount} | Relationships: ${person.relationshipCount}`,
  );
  if (person.lastInteractionAt) {
    parts.push(`Last interaction: ${person.lastInteractionAt.slice(0, 10)}`);
  }

  return parts.join("\n");
}

function formatPersonDetail(detail: RelationshipsPersonDetail): string {
  const sections: string[] = [];

  // Basic info
  sections.push("## Identity");
  sections.push(formatPersonSummary(detail));

  // Facts
  if (detail.facts.length > 0) {
    sections.push("\n## Facts");
    for (const fact of detail.facts) {
      const confidence =
        fact.confidence != null
          ? ` (${Math.round(fact.confidence * 100)}%)`
          : "";
      sections.push(`- [${fact.sourceType}]${confidence} ${fact.text}`);
    }
  }

  // Recent conversations
  if (detail.recentConversations.length > 0) {
    sections.push("\n## Recent Conversations");
    for (const convo of detail.recentConversations) {
      sections.push(
        `### ${convo.roomName} (${convo.lastActivityAt?.slice(0, 10) ?? "?"})`,
      );
      for (const msg of convo.messages.slice(0, 5)) {
        const ts = msg.createdAt
          ? new Date(msg.createdAt).toISOString().slice(0, 19)
          : "";
        sections.push(`  ${ts} ${msg.speaker}: ${msg.text.slice(0, 200)}`);
      }
      if (convo.messages.length > 5) {
        sections.push(`  ... ${convo.messages.length - 5} more messages`);
      }
    }
  }

  // Relationships
  if (detail.relationships.length > 0) {
    sections.push("\n## Relationships");
    for (const rel of detail.relationships) {
      const types = rel.relationshipTypes.join(", ") || "unknown";
      const target =
        rel.sourcePersonId === detail.primaryEntityId
          ? rel.targetPersonName
          : rel.sourcePersonName;
      sections.push(
        `- ${target}: ${types} (strength: ${Math.round(rel.strength * 100)}%, sentiment: ${rel.sentiment}, interactions: ${rel.interactionCount})`,
      );
    }
  }

  return sections.join("\n");
}

function getGraphService(
  runtime: IAgentRuntime,
): RelationshipsGraphService | null {
  return runtime.getService(
    "RELATIONSHIPS_GRAPH",
  ) as unknown as RelationshipsGraphService | null;
}

// ---------------------------------------------------------------------------
// SEARCH_ENTITY
// ---------------------------------------------------------------------------

type SearchEntityParams = {
  query?: string;
  platform?: string;
  limit?: number;
};

export const searchEntityAction: Action = {
  name: "SEARCH_ENTITY",
  similes: [
    "FIND_PERSON",
    "SEARCH_CONTACTS",
    "LOOKUP_USER",
    "FIND_USER",
    "SEARCH_ROLODEX",
  ],
  description:
    "Search the Rolodex for a person by name, handle, or platform. " +
    "Returns matching contacts with their cross-platform identities. " +
    "Results include line numbers for copying to clipboard.",

  validate: async (runtime, message, state) => {
    if (!(await hasAdminAccess(runtime, message))) return false;
    return hasContextSignalSyncForKey(message, state, "search_entity");
  },

  handler: async (runtime, message, _state, options) => {
    if (!(await hasAdminAccess(runtime, message))) {
      return {
        text: "Permission denied.",
        success: false,
        values: { success: false, error: "PERMISSION_DENIED" },
        data: { actionName: "SEARCH_ENTITY" },
      };
    }

    const params = ((options as HandlerOptions | undefined)?.parameters ??
      {}) as SearchEntityParams;
    const { query, platform } = params;
    const limit = Math.min(Math.max(1, params.limit ?? 10), 25);

    if (!query || typeof query !== "string" || query.trim().length === 0) {
      return {
        text: "SEARCH_ENTITY requires a non-empty query parameter.",
        success: false,
        values: { success: false, error: "INVALID_PARAMETERS" },
        data: { actionName: "SEARCH_ENTITY" },
      };
    }

    const graphService = getGraphService(runtime);
    if (!graphService) {
      return {
        text: "Relationships service not available.",
        success: false,
        values: { success: false, error: "SERVICE_NOT_FOUND" },
        data: { actionName: "SEARCH_ENTITY" },
      };
    }

    try {
      const snapshot = await graphService.getGraphSnapshot({
        search: query.trim(),
        platform: platform ?? null,
        limit,
      });

      if (!snapshot || snapshot.people.length === 0) {
        return {
          text: `No contacts found matching "${query}"${platform ? ` on ${platform}` : ""}.`,
          success: true,
          values: { success: true, resultCount: 0 },
          data: { actionName: "SEARCH_ENTITY", query, platform },
        };
      }

      const lines: string[] = [];
      for (let i = 0; i < snapshot.people.length; i++) {
        const person = snapshot.people[i];
        const platforms = person.platforms.join(", ") || "none";
        const aliases =
          person.aliases.length > 0
            ? ` (aka ${person.aliases.slice(0, 2).join(", ")})`
            : "";
        lines.push(
          `${String(i + 1).padStart(3, " ")} | ${person.displayName}${aliases} — ${platforms} — ${person.factCount} facts — entityId: ${person.primaryEntityId}`,
        );
      }

      const header = `Search results for "${query}" | ${snapshot.people.length} contacts found`;
      const footer =
        "\nUse READ_ENTITY with an entityId to see full details (facts, conversations, relationships).\nTo save results to clipboard, use CLIPBOARD_WRITE.";

      return {
        text: `${header}\n${"─".repeat(60)}\n${lines.join("\n")}\n${footer}`,
        success: true,
        values: { success: true, resultCount: snapshot.people.length },
        data: {
          actionName: "SEARCH_ENTITY",
          query,
          platform,
          results: snapshot.people.map((p, i) => ({
            line: i + 1,
            primaryEntityId: p.primaryEntityId,
            displayName: p.displayName,
            platforms: p.platforms,
            factCount: p.factCount,
          })),
        },
      };
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      logger.error("[SEARCH_ENTITY] Error:", errMsg);
      return {
        text: `Failed to search contacts: ${errMsg}`,
        success: false,
        values: { success: false, error: "SEARCH_FAILED" },
        data: { actionName: "SEARCH_ENTITY", query },
      };
    }
  },

  parameters: [
    {
      name: "query",
      description: "Name, handle, or search term to find a contact.",
      required: true,
      schema: { type: "string" as const },
    },
    {
      name: "platform",
      description:
        'Filter to a specific platform (e.g. "discord", "telegram"). Optional.',
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "limit",
      description: "Maximum results to return (default 10, max 25).",
      required: false,
      schema: { type: "number" as const },
    },
  ],
};

// ---------------------------------------------------------------------------
// READ_ENTITY
// ---------------------------------------------------------------------------

type ReadEntityParams = {
  entityId?: string;
  name?: string;
};

export const readEntityAction: Action = {
  name: "READ_ENTITY",
  similes: [
    "VIEW_PERSON",
    "GET_CONTACT",
    "VIEW_CONTACT",
    "PERSON_DETAILS",
    "READ_CONTACT",
  ],
  description:
    "Read full details about a person: identity, all facts, recent conversations, and relationships. " +
    "Look up by entity ID (from SEARCH_ENTITY results) or by name. " +
    "Full output can be saved to clipboard.",

  validate: async (runtime, message, state) => {
    if (!(await hasAdminAccess(runtime, message))) return false;
    return hasContextSignalSyncForKey(message, state, "search_entity");
  },

  handler: async (runtime, message, _state, options) => {
    if (!(await hasAdminAccess(runtime, message))) {
      return {
        text: "Permission denied.",
        success: false,
        values: { success: false, error: "PERMISSION_DENIED" },
        data: { actionName: "READ_ENTITY" },
      };
    }

    const params = ((options as HandlerOptions | undefined)?.parameters ??
      {}) as ReadEntityParams;
    const { entityId, name } = params;

    if (!entityId && !name) {
      return {
        text: "READ_ENTITY requires either entityId or name parameter.",
        success: false,
        values: { success: false, error: "INVALID_PARAMETERS" },
        data: { actionName: "READ_ENTITY" },
      };
    }

    const graphService = getGraphService(runtime);
    if (!graphService) {
      return {
        text: "Relationships service not available.",
        success: false,
        values: { success: false, error: "SERVICE_NOT_FOUND" },
        data: { actionName: "READ_ENTITY" },
      };
    }

    try {
      let resolvedEntityId = entityId as UUID | undefined;

      // If name provided instead of ID, search first
      if (!resolvedEntityId && name) {
        const snapshot = await graphService.getGraphSnapshot({
          search: name,
          limit: 1,
        });
        if (snapshot && snapshot.people.length > 0) {
          resolvedEntityId = snapshot.people[0].primaryEntityId;
        }
      }

      if (!resolvedEntityId) {
        return {
          text: `Could not find entity${name ? ` named "${name}"` : ""}. Try SEARCH_ENTITY first.`,
          success: false,
          values: { success: false, error: "ENTITY_NOT_FOUND" },
          data: { actionName: "READ_ENTITY", entityId, name },
        };
      }

      const detail = await graphService.getPersonDetail(resolvedEntityId);

      if (!detail) {
        return {
          text: `No details found for entity ${resolvedEntityId}.`,
          success: false,
          values: { success: false, error: "ENTITY_NOT_FOUND" },
          data: { actionName: "READ_ENTITY", entityId: resolvedEntityId },
        };
      }

      const formatted = formatPersonDetail(detail);
      const footer = "\nTo save this to clipboard, use CLIPBOARD_WRITE.";

      return {
        text: `${formatted}\n${footer}`,
        success: true,
        values: {
          success: true,
          entityId: resolvedEntityId,
          displayName: detail.displayName,
        },
        data: {
          actionName: "READ_ENTITY",
          entityId: resolvedEntityId,
          detail: {
            displayName: detail.displayName,
            platforms: detail.platforms,
            factCount: detail.facts.length,
            conversationCount: detail.recentConversations.length,
            relationshipCount: detail.relationships.length,
          },
        },
      };
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      logger.error("[READ_ENTITY] Error:", errMsg);
      return {
        text: `Failed to read entity details: ${errMsg}`,
        success: false,
        values: { success: false, error: "READ_FAILED" },
        data: { actionName: "READ_ENTITY", entityId, name },
      };
    }
  },

  parameters: [
    {
      name: "entityId",
      description:
        "Entity ID to look up (from SEARCH_ENTITY results). Preferred over name.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "name",
      description:
        "Person name to search for. Used if entityId is not provided.",
      required: false,
      schema: { type: "string" as const },
    },
  ],
};
