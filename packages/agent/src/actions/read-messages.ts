/**
 * READ_MESSAGES — Person-centric cross-platform conversation view.
 *
 * Unlike READ_CHANNEL (which reads a specific channel), READ_MESSAGES
 * resolves a person via the Rolodex and shows recent conversations with
 * them across ALL connected platforms. This enables conversation handoff —
 * the user can see full context from Telegram, Discord, Signal, etc.
 * before deciding where to continue the conversation.
 *
 * @module actions/read-messages
 */

import type { Action, ActionExample, HandlerOptions } from "@elizaos/core";
import { logger } from "@elizaos/core";
import {
  type CrossPlatformConversationView,
  formatContactCandidates,
  formatConversationView,
  getActiveConnectors,
  getPersonConversations,
  resolveContact,
  resolveContactCandidates,
} from "./connector-resolver.js";
import { hasContextSignalSyncForKey } from "./context-signal.js";
import { extractActionParamsViaLlm } from "./extract-params.js";

type ReadMessagesParams = {
  /** Person name for Rolodex resolution. */
  contact?: string;
  /** Entity ID (from SEARCH_ENTITY results) for direct lookup. */
  entityId?: string;
  /** Optional platform filter — only show conversations from this platform. */
  platform?: string;
  /** Max messages per conversation thread (default 15). */
  limit?: number;
};

const DEFAULT_LIMIT = 15;
const MAX_LIMIT = 50;

export const readMessagesAction: Action = {
  name: "READ_MESSAGES",
  contexts: ["messaging", "social_posting", "connectors", "knowledge"],
  roleGate: { minRole: "ADMIN" },
  similes: [
    "GET_MESSAGES",
    "VIEW_MESSAGES",
    "CHECK_MESSAGES",
    "SHOW_MESSAGES",
    "MESSAGES_WITH",
    "CONVERSATION_WITH",
    "CHAT_WITH",
    "READ_DMS",
    "CHECK_DMS",
  ],
  description:
    "Read recent messages/conversations with a specific person across all connected platforms. " +
    "Resolves the person via the Rolodex and shows conversations from every platform where " +
    "the agent has interacted with them. Use for conversation context before sending a reply, " +
    "or to review what was discussed on different platforms. " +
    "Results can be saved to clipboard with CLIPBOARD_WRITE.",
  descriptionCompressed:
    "read recent messages/conversation w/ specific person across connect platform resolve person via Rolodex show conversation every platform agent interact w/ use conversation context before send reply, review what discuss different platform result save clipboard w/ CLIPBOARD_WRITE",

  validate: async (_runtime, message, state) => {
    return hasContextSignalSyncForKey(message, state, "read_messages");
  },

  handler: async (runtime, message, state, options) => {
    const rawParams = ((options as HandlerOptions | undefined)?.parameters ??
      {}) as ReadMessagesParams;
    const params = (await extractActionParamsViaLlm<ReadMessagesParams>({
      runtime,
      message,
      state,
      actionName: "READ_MESSAGES",
      actionDescription: readMessagesAction.description ?? "",
      paramSchema: readMessagesAction.parameters ?? [],
      existingParams: rawParams,
      requiredFields: ["contact"],
    })) as ReadMessagesParams;
    const { contact, entityId, platform } = params;
    const contactName = typeof contact === "string" ? contact.trim() : "";
    const limit = Math.min(
      Math.max(1, params.limit ?? DEFAULT_LIMIT),
      MAX_LIMIT,
    );

    if (
      (!contact || typeof contact !== "string" || !contact.trim()) &&
      (!entityId || typeof entityId !== "string" || !entityId.trim())
    ) {
      return {
        text: "READ_MESSAGES requires either a 'contact' name or 'entityId' parameter.",
        success: false,
        values: { success: false, error: "INVALID_PARAMETERS" },
        data: { actionName: "READ_MESSAGES" },
      };
    }

    try {
      let view: CrossPlatformConversationView;

      if (entityId) {
        // Direct entity ID lookup — find person in graph
        const { getGraphService } = await import("./connector-resolver.js");
        const graphService = await getGraphService(runtime);
        if (!graphService) {
          return {
            text: "Relationships service not available.",
            success: false,
            values: { success: false, error: "SERVICE_NOT_FOUND" },
            data: { actionName: "READ_MESSAGES" },
          };
        }

        const snapshot = await graphService.getGraphSnapshot({
          search: entityId,
          limit: 1,
        });

        if (!snapshot || snapshot.people.length === 0) {
          return {
            text: `No person found for entityId "${entityId}". Use SEARCH_ENTITY first.`,
            success: false,
            values: { success: false, error: "ENTITY_NOT_FOUND" },
            data: { actionName: "READ_MESSAGES", entityId },
          };
        }

        view = await getPersonConversations(runtime, snapshot.people[0], {
          limitPerPlatform: limit,
        });
      } else {
        // Name-based Rolodex resolution
        const resolved = await resolveContact(runtime, contactName, platform);

        if (!resolved) {
          const candidates = await resolveContactCandidates(
            runtime,
            contactName,
          );
          if (candidates.length > 0) {
            return {
              text:
                `Multiple contacts match "${contact}":\n` +
                formatContactCandidates(candidates) +
                "\nSpecify the entityId or use a more specific name.",
              success: false,
              values: { success: false, error: "AMBIGUOUS_CONTACT" },
              data: {
                actionName: "READ_MESSAGES",
                contact,
                candidateCount: candidates.length,
                candidates: candidates.map((c) => ({
                  displayName: c.displayName,
                  primaryEntityId: c.primaryEntityId,
                  platforms: c.platforms,
                })),
              },
            };
          }

          return {
            text: `No contacts found matching "${contact}" in the Rolodex.`,
            success: false,
            values: { success: false, error: "CONTACT_NOT_FOUND" },
            data: { actionName: "READ_MESSAGES", contact },
          };
        }

        view = await getPersonConversations(runtime, resolved.person, {
          limitPerPlatform: limit,
        });
      }

      // Filter by platform if specified
      if (platform) {
        view = {
          ...view,
          conversations: view.conversations.filter(
            (c) => c.platform.toLowerCase() === platform.toLowerCase(),
          ),
          totalMessages: view.conversations
            .filter((c) => c.platform.toLowerCase() === platform.toLowerCase())
            .reduce((sum, c) => sum + c.messageCount, 0),
        };
      }

      if (view.conversations.length === 0) {
        return {
          text:
            `No conversations found with ${view.person.displayName}` +
            (platform ? ` on ${platform}` : "") +
            ".",
          success: true,
          values: {
            success: true,
            messageCount: 0,
            personName: view.person.displayName,
          },
          data: {
            actionName: "READ_MESSAGES",
            contact: contact ?? entityId,
            personName: view.person.displayName,
            platform,
          },
        };
      }

      const formatted = formatConversationView(runtime, view);
      const activeConnectors = getActiveConnectors(runtime);
      const reachable = view.person.platforms.filter((p) =>
        activeConnectors.has(p),
      );

      const footer =
        `\nReachable platforms: ${reachable.join(", ") || "none"}` +
        "\nUse SEND_MESSAGE with target name to reply on the best platform." +
        "\nTo save to clipboard, use CLIPBOARD_WRITE.";

      return {
        text: `${formatted}\n${footer}`,
        success: true,
        values: {
          success: true,
          messageCount: view.totalMessages,
          conversationCount: view.conversations.length,
          personName: view.person.displayName,
          platforms: [...new Set(view.conversations.map((c) => c.platform))],
        },
        data: {
          actionName: "READ_MESSAGES",
          contact: contact ?? entityId,
          personName: view.person.displayName,
          primaryEntityId: view.person.primaryEntityId,
          conversations: view.conversations.map((c) => ({
            platform: c.platform,
            roomId: c.roomId,
            roomName: c.roomName,
            messageCount: c.messageCount,
            lastMessageAt: c.lastMessageAt,
          })),
        },
      };
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      logger.error("[READ_MESSAGES] Error:", errMsg);
      return {
        text: `Failed to read messages: ${errMsg}`,
        success: false,
        values: { success: false, error: "READ_FAILED" },
        data: { actionName: "READ_MESSAGES", contact: contact ?? entityId },
      };
    }
  },

  parameters: [
    {
      name: "contact",
      description:
        "Person's name for Rolodex resolution. The agent will find all conversations " +
        "with this person across all platforms.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "entityId",
      description:
        "Entity ID (from SEARCH_ENTITY results) for direct lookup. Alternative to contact name.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "platform",
      description:
        'Filter to a specific platform (e.g. "discord", "telegram"). ' +
        "Optional — omit to see conversations across all platforms.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "limit",
      description:
        "Maximum number of messages per conversation thread (default 15, max 50).",
      required: false,
      schema: { type: "number" as const },
    },
  ],
  examples: [
    [
      {
        name: "{{name1}}",
        content: {
          text: "What have Jill and I been talking about recently?",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Conversations with Jill Park across discord and telegram — 22 messages total.",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Show me my last DMs with Marco on Telegram.",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Conversations with Marco Pierre on telegram — 8 messages total.",
        },
      },
    ],
  ] as ActionExample[][],
};
