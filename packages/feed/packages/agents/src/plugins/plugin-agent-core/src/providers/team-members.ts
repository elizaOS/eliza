/**
 * Team Members Provider
 *
 * Provides information about team chat members for agent context.
 * Allows agents to know who else is in the Agents chat and
 * properly @mention other agents.
 *
 * Requires `teamChatId` to be set in state.values.
 */

import type {
  IAgentRuntime,
  Memory,
  Provider,
  ProviderResult,
  State,
} from "@elizaos/core";
import { and, chatParticipants, db, eq, users } from "@feed/db";
import { logger } from "../../../../shared/logger";

/** Team member info */
interface TeamMember {
  id: string;
  displayName: string | null;
  username: string | null;
  isAgent: boolean;
}

/**
 * Team Members Provider
 *
 * Fetches all active members of a team chat and formats them
 * for LLM context with proper @username mentions.
 */
export const teamMembersProvider: Provider = {
  name: "TEAM_MEMBERS",
  description: "List of team members in the Agents chat",

  get: async (
    runtime: IAgentRuntime,
    _message: Memory,
    state: State,
  ): Promise<ProviderResult> => {
    const agentId = runtime.agentId;
    const teamChatId = state?.values?.teamChatId as string | undefined;

    // If no team chat ID, return empty (not in team chat mode)
    if (!teamChatId) {
      return {
        data: {
          teamMembers: [],
          memberCount: 0,
        },
        values: {
          teamMembers: "",
          memberCount: 0,
          hasTeamMembers: false,
        },
        text: "",
      };
    }

    try {
      // Fetch all ACTIVE participants in the team chat
      const participants = await db
        .select({
          id: users.id,
          displayName: users.displayName,
          username: users.username,
          isAgent: users.isAgent,
        })
        .from(chatParticipants)
        .innerJoin(users, eq(chatParticipants.userId, users.id))
        .where(
          and(
            eq(chatParticipants.chatId, teamChatId),
            eq(chatParticipants.isActive, true),
          ),
        );

      if (participants.length === 0) {
        return {
          data: {
            teamMembers: [],
            memberCount: 0,
          },
          values: {
            teamMembers: "No team members found.",
            memberCount: 0,
            hasTeamMembers: false,
          },
          text: "No team members found.",
        };
      }

      // Format members list
      const formattedMembers = participants
        .map((member) => {
          const name = member.displayName || member.username || "Unknown";
          const handle = member.username ? `@${member.username}` : "";
          const role = member.isAgent ? "Agent" : "Owner";
          const isSelf = member.id === agentId;
          return `- **${name}** (${handle}) - ${role}${isSelf ? " ← YOU" : ""}`;
        })
        .join("\n");

      // Create structured member list for values
      const memberList: TeamMember[] = participants.map((p) => ({
        id: p.id,
        displayName: p.displayName,
        username: p.username,
        isAgent: p.isAgent ?? false,
      }));

      return {
        data: {
          teamMembers: memberList,
          memberCount: participants.length,
        },
        values: {
          teamMembers: formattedMembers,
          memberCount: participants.length,
          hasTeamMembers: true,
        },
        text: formattedMembers,
      };
    } catch (error) {
      logger.error(
        "Error fetching members",
        error instanceof Error ? error : { error },
        "TeamMembers",
      );
      return {
        data: {
          teamMembers: [],
          memberCount: 0,
        },
        values: {
          teamMembers: "Error retrieving team members.",
          memberCount: 0,
          hasTeamMembers: false,
        },
        text: "Error retrieving team members.",
      };
    }
  },
};
