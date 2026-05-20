/**
 * Coordinator Team Members Provider
 *
 * Provides information about team chat members for coordinator context.
 * Allows coordinator to know who the user's agents are and help with @mentions.
 */

import type {
  IAgentRuntime,
  Memory,
  Provider,
  ProviderResult,
  State,
} from "@elizaos/core";
import { and, chatParticipants, db, eq, users } from "@feed/db";

/** Team member info */
interface TeamMember {
  id: string;
  displayName: string | null;
  username: string | null;
  isAgent: boolean;
}

/**
 * Coordinator Team Members Provider
 *
 * Fetches all active members of a team chat and formats them
 * for LLM context with proper @username mentions.
 */
export const coordinatorTeamMembersProvider: Provider = {
  name: "TEAM_MEMBERS",
  description: "List of team members in the Agents chat",

  get: async (
    _runtime: IAgentRuntime,
    _message: Memory,
    state: State,
  ): Promise<ProviderResult> => {
    const teamChatId = state?.values?.teamChatId as string | undefined;

    if (!teamChatId) {
      return {
        data: {
          teamMembers: [],
          memberCount: 0,
          agentCount: 0,
        },
        values: {
          teamMembers: "",
          memberCount: 0,
          agentCount: 0,
          hasTeamMembers: false,
        },
        text: "",
      };
    }

    // Fetch all ACTIVE participants in the team chat
    // Fail-fast: let DB errors propagate to caller
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
          agentCount: 0,
        },
        values: {
          teamMembers: "No team members found.",
          memberCount: 0,
          agentCount: 0,
          hasTeamMembers: false,
        },
        text: "No team members found.",
      };
    }

    // Separate owner from agents for better formatting
    const owner = participants.find((p) => !p.isAgent);
    const agents = participants.filter((p) => p.isAgent);

    // Format members list with helpful context for coordinator
    let formattedMembers = "## Team Members\n\n";

    if (owner) {
      const ownerName = owner.displayName || owner.username || "User";
      // Only include handle when username exists to avoid invalid @unknown mentions
      const ownerHandle = owner.username ? ` (@${owner.username})` : "";
      formattedMembers += `**Owner:** ${ownerName}${ownerHandle}\n\n`;
    }

    if (agents.length > 0) {
      formattedMembers += `**Agents (${agents.length}):**\n`;
      formattedMembers += agents
        .map((agent) => {
          const name = agent.displayName || agent.username || "Unknown";
          // Only include handle portion when username exists
          const handleSuffix = agent.username ? ` (@${agent.username})` : "";
          // Include agent ID so the LLM can use it in DISPATCH_TO_AGENT parameters
          return `- ${name}${handleSuffix} [id: ${agent.id}] - Available for tasks`;
        })
        .join("\n");
    } else {
      formattedMembers +=
        "**Agents:** No agents created yet. Suggest user create agents at /agents page.";
    }

    // Create structured member list
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
        agentCount: agents.length,
      },
      values: {
        teamMembers: formattedMembers,
        memberCount: participants.length,
        agentCount: agents.length,
        hasTeamMembers: true,
      },
      text: formattedMembers,
    };
  },
};
