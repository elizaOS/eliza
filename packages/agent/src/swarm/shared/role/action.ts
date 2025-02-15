import {
  type Action,
  type ActionExample,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  type State,
  logger,
} from "@elizaos/core";
import type { Message } from "discord.js";
import type { ServerRoleState } from "./types";

export enum RoleName {
  OWNER = "OWNER",
  ADMIN = "ADMIN",
  MEMBER = "MEMBER",
  NONE = "NONE",
  IGNORE = "IGNORE",
}

const canModifyRole = (
  currentRole: RoleName,
  targetRole: RoleName,
  newRole: RoleName
): boolean => {
  // Admins can modify any role except other admins
  if (currentRole === RoleName.OWNER) {
    return targetRole !== RoleName.OWNER;
  }

  // Bosses can only modify MEMBER, NONE, and IGNORE roles
  if (currentRole === RoleName.ADMIN) {
    return (
      ![RoleName.OWNER, RoleName.ADMIN].includes(targetRole) &&
      ![RoleName.OWNER, RoleName.ADMIN].includes(newRole)
    );
  }

  return false;
};

const updateOrgRoleAction: Action = {
  name: "UPDATE_ORG_ROLE",
  similes: ["CHANGE_ROLE", "SET_ROLE", "MODIFY_ROLE"],
  description: "Updates the organizational role of a user",

  validate: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State
  ): Promise<boolean> => {
    const discordMessage = state.discordMessage as Message;
    if (!discordMessage?.guild?.id) {
      return false;
    }

    if (!discordMessage?.guild?.id) {
      return false;
    }

    const serverId = discordMessage.guild.id;
    const requesterId = discordMessage.author.id;

    try {
      // Get roles cache
      const roleCache = await runtime.cacheManager.get<ServerRoleState>(
        `server_${serverId}_user_roles`
      );

      if (!roleCache) {
        return false;
      }

      // Check requester's role
      const requesterRole = roleCache.roles[requesterId]?.role;

      if (
        !requesterRole ||
        ![RoleName.OWNER, RoleName.ADMIN].includes(requesterRole as RoleName)
      ) {
        return false;
      }

      // Check if message contains role update keywords
      const roleKeywords = [
        "make",
        "set",
        "change",
        "update",
        "give",
        "assign",
        "promote",
        "demote",
        "role",
      ];

      return roleKeywords.some((keyword) =>
        message.content.text.toLowerCase().includes(keyword)
      );
    } catch (error) {
      logger.error("Error validating updateOrgRole action:", error);
      return false;
    }
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State,
    options: any,
    callback: HandlerCallback,
    responses: Memory[]
  ): Promise<void> => {
    // Handle initial responses
    for (const response of responses) {
      await callback(response.content);
    }

    const discordMessage = state.discordMessage as Message;
    if (!discordMessage.guild?.id) {
      return;
    }

    if (!discordMessage?.guild?.id) {
      return;
    }

    const serverId = discordMessage.guild.id;
    const requesterId = discordMessage.author.id;

    try {
      // Get roles cache
      let roleCache = await runtime.cacheManager.get<ServerRoleState>(
        `server_${serverId}_user_roles`
      );

      if (!roleCache) {
        roleCache = {
          roles: {},
          lastUpdated: Date.now(),
        };
      }

      // Get requester's role
      const requesterRole = roleCache.roles[requesterId]?.role as RoleName;

      // Get mentioned user
      const mentionedUser = discordMessage?.mentions?.users?.first();
      if (!mentionedUser) {
        await callback({
          text: "Please mention the user whose role you want to update.",
          action: "UPDATE_ORG_ROLE",
          source: "discord",
        });
        return;
      }

      // Parse desired role from message
      const roleWords = message.content.text.toLowerCase().split(" ");
      let newRole: RoleName | null = null;

      for (const role of Object.values(RoleName)) {
        if (roleWords.includes(role.toLowerCase())) {
          newRole = role;
          break;
        }
      }

      if (!newRole) {
        await callback({
          text: `Please specify a valid role (${Object.values(RoleName).join(
            ", "
          )}).`,
          action: "UPDATE_ORG_ROLE",
          source: "discord",
        });
        return;
      }

      // Check if requester can modify the target's role
      const targetRole =
        (roleCache.roles[mentionedUser.id]?.role as RoleName) ?? RoleName.NONE;

      if (!canModifyRole(requesterRole, targetRole, newRole)) {
        await callback({
          text: "You don't have permission to make this role change.",
          action: "UPDATE_ORG_ROLE",
          source: "discord",
        });
        return;
      }

      // Update role
      roleCache.roles[mentionedUser.id] = {
        userId: mentionedUser.id,
        serverId,
        role: newRole,
      };

      roleCache.lastUpdated = Date.now();

      // Save updated roles
      await runtime.cacheManager.set(
        `server_${serverId}_user_roles`,
        roleCache
      );

      // Send confirmation
      await callback({
        text: `Updated ${mentionedUser.username}'s role to ${newRole}.`,
        action: "UPDATE_ORG_ROLE",
        source: "discord",
      });

      // Log role update
      await runtime.databaseAdapter.log({
        body: {
          type: "role_update",
          targetUser: mentionedUser.id,
          oldRole: targetRole,
          newRole: newRole,
          updatedBy: requesterId,
        },
        userId: runtime.agentId,
        roomId: message.roomId,
        type: "role_management",
      });
    } catch (error) {
      logger.error("Error in updateOrgRole handler:", error);
      await callback({
        text: "There was an error updating the role.",
        action: "UPDATE_ORG_ROLE",
        source: "discord",
      });
    }
  },

  examples: [
    [
      {
        user: "{{user1}}",
        content: {
          text: "Make {{user2}} a MEMBER",
          source: "discord",
        },
      },
      {
        user: "{{user3}}",
        content: {
          text: "Updated {{user2}}'s role to MEMBER.",
          action: "UPDATE_ORG_ROLE",
        },
      },
    ],
    [
      {
        user: "{{user1}}",
        content: {
          text: "Change {{user2}}'s role to ADMIN",
          source: "discord",
        },
      },
      {
        user: "{{user3}}",
        content: {
          text: "You don't have permission to make this role change.",
          action: "UPDATE_ORG_ROLE",
        },
      },
    ],
  ] as ActionExample[][],
};

export default updateOrgRoleAction;
