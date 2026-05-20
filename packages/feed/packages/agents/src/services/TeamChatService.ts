/**
 * Team Chat Service - Agents
 *
 * Manages the unified "Agents" group chat for each user's agents.
 * Each user has exactly ONE team chat containing ALL their agents.
 *
 * Lifecycle:
 * - First agent created → Team chat auto-created
 * - Additional agents → Auto-added to team chat
 * - Agent deleted → Auto-removed from team chat
 * - All agents deleted → Team chat persists (for history)
 *
 * @packageDocumentation
 */

import {
  and,
  type Chat,
  chatParticipants,
  chats,
  db,
  desc,
  eq,
  type Group,
  generateSnowflakeId,
  groupMembers,
  groups,
  isNull,
  messages,
  ne,
  sql,
  type User,
  users,
  withTransaction,
} from '@feed/db';
import { logger } from '../shared/logger';

/** Constants for Agents */
const TEAM_CHAT_NAME = 'Agents';
const TEAM_CHAT_DESCRIPTION = 'Coordinate all your agents in one place';

/**
 * Format a date for display in chat names.
 * Used for UI fallback when chat.name is null.
 * Format: "Jan 24, 10:30 AM"
 */
export function formatChatDate(date: Date): string {
  const dateStr = date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  });
  const timeStr = date.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
  return `${dateStr}, ${timeStr}`;
}

/**
 * Get display name for a chat.
 * Returns the actual name if set, or a fallback using createdAt.
 */
export function getChatDisplayName(chat: {
  name: string | null;
  createdAt: Date | string;
}): string {
  if (chat.name) return chat.name;
  const date =
    chat.createdAt instanceof Date ? chat.createdAt : new Date(chat.createdAt);
  return `New Chat - ${formatChatDate(date)}`;
}

/**
 * Team chat information returned by service methods.
 * Now maps directly from Group table (type='team').
 */
export interface TeamChatInfo {
  id: string; // Group ID (same as groupId for backwards compat)
  groupId: string; // Group ID
  chatId: string; // Currently active Chat ID (from Group.activeChatId)
  ownerId: string; // User who owns this team chat
  createdAt: Date;
  updatedAt: Date;
}

/** Team chat with members */
export interface TeamChatWithMembers extends TeamChatInfo {
  agents: User[];
}

/**
 * Service for managing user agent team chats (Agents)
 */
export class TeamChatService {
  /**
   * Ensure a team chat exists for the user.
   * Creates one if it doesn't exist, returns existing if it does.
   *
   * Now uses Group table directly with type='team'.
   * Group.activeChatId tracks the current conversation.
   *
   * @param userId - The human user ID (not agent ID)
   * @returns Team chat info with groupId and chatId
   */
  async ensureTeamChat(userId: string): Promise<TeamChatInfo> {
    // Check if team chat already exists
    const existing = await this.getTeamChat(userId);
    if (existing) {
      // Ensure user is a participant (repair if missing)
      await this.ensureUserIsParticipant(userId, existing);
      return existing;
    }

    const result = await withTransaction(async (tx) => {
      await tx.execute(
        sql`select ${users.id} from ${users} where ${users.id} = ${userId} for update`
      );

      const [existingInTx] = await tx
        .select()
        .from(groups)
        .where(and(eq(groups.type, 'team'), eq(groups.ownerId, userId)))
        .limit(1);

      if (existingInTx) {
        return this.groupToTeamChatInfo(existingInTx);
      }

      const now = new Date();
      const [groupId, chatId, memberId, participantId] = await Promise.all([
        generateSnowflakeId(),
        generateSnowflakeId(),
        generateSnowflakeId(),
        generateSnowflakeId(),
      ]);

      await tx.insert(groups).values({
        id: groupId,
        name: TEAM_CHAT_NAME,
        description: TEAM_CHAT_DESCRIPTION,
        type: 'team',
        ownerId: userId,
        createdById: userId,
        activeChatId: chatId,
        createdAt: now,
        updatedAt: now,
      });

      await tx.insert(chats).values({
        id: chatId,
        name: null,
        description: null,
        isGroup: true,
        groupId,
        createdBy: userId,
        createdAt: now,
        updatedAt: now,
      });

      await tx.insert(groupMembers).values({
        id: memberId,
        groupId,
        userId,
        role: 'owner',
        addedBy: userId,
        joinedAt: now,
        isActive: true,
        messageCount: 0,
        qualityScore: 1.0,
      });

      await tx.insert(chatParticipants).values({
        id: participantId,
        chatId,
        userId,
        joinedAt: now,
        isActive: true,
      });

      return {
        id: groupId,
        groupId,
        chatId,
        ownerId: userId,
        createdAt: now,
        updatedAt: now,
      };
    });

    logger.info(
      `Team chat created for user ${userId}`,
      { groupId: result.groupId, chatId: result.chatId },
      'TeamChatService'
    );

    return result;
  }

  /**
   * Ensure the user is a participant in their team chat.
   * Repairs missing chatParticipants and groupMembers records.
   *
   * This handles cases where:
   * - Partial creation failure left user without participant record
   * - Database corruption/migration removed the record
   * - Any other scenario where the team chat exists but user can't access it
   *
   * @param userId - The human user ID
   * @param teamChat - The team chat info
   */
  private async ensureUserIsParticipant(
    userId: string,
    teamChat: TeamChatInfo
  ): Promise<void> {
    // Check if user is already a participant AND group member
    const [[existingParticipant], [existingGroupMember]] = await Promise.all([
      db
        .select({ id: chatParticipants.id })
        .from(chatParticipants)
        .where(
          and(
            eq(chatParticipants.chatId, teamChat.chatId),
            eq(chatParticipants.userId, userId),
            eq(chatParticipants.isActive, true)
          )
        )
        .limit(1),
      db
        .select({ id: groupMembers.id })
        .from(groupMembers)
        .where(
          and(
            eq(groupMembers.groupId, teamChat.groupId),
            eq(groupMembers.userId, userId),
            eq(groupMembers.isActive, true)
          )
        )
        .limit(1),
    ]);

    if (existingParticipant && existingGroupMember) {
      // User has both records, nothing to do
      return;
    }

    // User is missing chatParticipants and/or groupMembers - repair it
    logger.warn(
      `Repairing missing records for user ${userId} in team chat`,
      {
        userId,
        chatId: teamChat.chatId,
        groupId: teamChat.groupId,
        missingParticipant: !existingParticipant,
        missingGroupMember: !existingGroupMember,
      },
      'TeamChatService'
    );

    await withTransaction(async (tx) => {
      const now = new Date();
      const [participantId, memberId] = await Promise.all([
        generateSnowflakeId(),
        generateSnowflakeId(),
      ]);

      // Upsert chat participant (in case there's an inactive record)
      await tx
        .insert(chatParticipants)
        .values({
          id: participantId,
          chatId: teamChat.chatId,
          userId,
          joinedAt: now,
          isActive: true,
        })
        .onConflictDoUpdate({
          target: [chatParticipants.chatId, chatParticipants.userId],
          set: {
            isActive: true,
            joinedAt: now,
          },
        });

      // Also ensure user is in groupMembers (in case that's missing too)
      await tx
        .insert(groupMembers)
        .values({
          id: memberId,
          groupId: teamChat.groupId,
          userId,
          role: 'owner',
          addedBy: userId,
          joinedAt: now,
          isActive: true,
          messageCount: 0,
          qualityScore: 1.0,
        })
        .onConflictDoUpdate({
          target: [groupMembers.groupId, groupMembers.userId],
          set: {
            isActive: true,
            role: 'owner',
            joinedAt: now,
          },
        });
    });

    logger.info(
      `Repaired chatParticipant record for user ${userId} in team chat ${teamChat.chatId}`,
      { userId, chatId: teamChat.chatId },
      'TeamChatService'
    );
  }

  /**
   * Get the team chat for a user (if it exists)
   * Now queries Group table directly with type='team'.
   *
   * @param userId - The human user ID
   * @returns Team chat info or null if not found
   */
  async getTeamChat(userId: string): Promise<TeamChatInfo | null> {
    const [group] = await db
      .select()
      .from(groups)
      .where(and(eq(groups.type, 'team'), eq(groups.ownerId, userId)))
      .limit(1);

    if (!group || !group.activeChatId) {
      return null;
    }

    return this.groupToTeamChatInfo(group);
  }

  /**
   * Convert a Group record to TeamChatInfo
   */
  private groupToTeamChatInfo(group: Group): TeamChatInfo {
    return {
      id: group.id,
      groupId: group.id,
      chatId: group.activeChatId!, // activeChatId should be set for team groups
      ownerId: group.ownerId,
      createdAt: group.createdAt,
      updatedAt: group.updatedAt,
    };
  }

  /**
   * Validate that a chat ID belongs to a user's team chat.
   * This is a security check to prevent users from writing to other users' team chats.
   *
   * Since we support multiple conversations (Chats) per team chat,
   * we validate by checking if the Chat's groupId matches the team's groupId.
   *
   * @param userId - The human user ID to validate against
   * @param chatId - The chat ID to validate
   * @returns True if the chat belongs to the user's team, false otherwise
   */
  async validateTeamChatOwnership(
    userId: string,
    chatId: string
  ): Promise<boolean> {
    const teamChat = await this.getTeamChat(userId);
    if (!teamChat) {
      return false;
    }

    // Check if chatId belongs to the team's group
    const [chat] = await db
      .select({ groupId: chats.groupId })
      .from(chats)
      .where(eq(chats.id, chatId))
      .limit(1);

    return chat?.groupId === teamChat.groupId;
  }

  /**
   * Get the team chat with all member agents
   *
   * @param userId - The human user ID
   * @returns Team chat with agents or null if not found
   */
  async getTeamChatWithMembers(
    userId: string
  ): Promise<TeamChatWithMembers | null> {
    const teamChat = await this.getTeamChat(userId);
    if (!teamChat) {
      return null;
    }

    const agents = await this.getTeamChatAgents(userId, teamChat.groupId);

    return { ...teamChat, agents };
  }

  /**
   * Get all agents in the user's team chat
   *
   * @param userId - The human user ID
   * @param groupId - Optional group ID if already known (avoids extra query)
   * @returns Array of agent User objects
   */
  async getTeamChatAgents(userId: string, groupId?: string): Promise<User[]> {
    const gid = groupId ?? (await this.getTeamChat(userId))?.groupId;
    if (!gid) {
      return [];
    }

    // Get all active group members who are agents owned by this user
    // Filtering in SQL for better performance and defense-in-depth
    const memberRows = await db
      .select({ user: users })
      .from(groupMembers)
      .innerJoin(users, eq(groupMembers.userId, users.id))
      .where(
        and(
          eq(groupMembers.groupId, gid),
          eq(groupMembers.isActive, true),
          eq(users.isAgent, true),
          eq(users.managedBy, userId)
        )
      )
      .orderBy(users.createdAt);

    return memberRows.map((row) => row.user);
  }

  /**
   * Add an agent to the user's team chat
   *
   * @param userId - The human user ID (owner)
   * @param agentUserId - The agent user ID to add
   */
  async addAgentToTeamChat(userId: string, agentUserId: string): Promise<void> {
    // Ensure team chat exists
    const teamChat = await this.ensureTeamChat(userId);

    // Get agent info for the system message
    const [agent] = await db
      .select()
      .from(users)
      .where(eq(users.id, agentUserId))
      .limit(1);

    if (!agent) {
      throw new Error(`Agent not found: ${agentUserId}`);
    }

    if (!agent.isAgent) {
      throw new Error(`User ${agentUserId} is not an agent`);
    }

    if (agent.managedBy !== userId) {
      throw new Error(`Agent ${agentUserId} is not managed by user ${userId}`);
    }

    const [[existingGroupMember], [existingParticipant]] = await Promise.all([
      db
        .select({ isActive: groupMembers.isActive })
        .from(groupMembers)
        .where(
          and(
            eq(groupMembers.groupId, teamChat.groupId),
            eq(groupMembers.userId, agentUserId)
          )
        )
        .limit(1),
      db
        .select({ isActive: chatParticipants.isActive })
        .from(chatParticipants)
        .where(
          and(
            eq(chatParticipants.chatId, teamChat.chatId),
            eq(chatParticipants.userId, agentUserId)
          )
        )
        .limit(1),
    ]);

    const shouldAnnounceJoin =
      existingGroupMember?.isActive !== true ||
      existingParticipant?.isActive !== true;

    await withTransaction(async (tx) => {
      const now = new Date();
      const [memberId, participantId, messageId] = await Promise.all([
        generateSnowflakeId(),
        generateSnowflakeId(),
        generateSnowflakeId(),
      ]);

      // 1. Add agent to group members (upsert in case of re-add)
      await tx
        .insert(groupMembers)
        .values({
          id: memberId,
          groupId: teamChat.groupId,
          userId: agentUserId,
          role: 'member',
          addedBy: userId,
          joinedAt: now,
          isActive: true,
          messageCount: 0,
          qualityScore: 1.0,
        })
        .onConflictDoUpdate({
          target: [groupMembers.groupId, groupMembers.userId],
          set: {
            isActive: true,
            joinedAt: now,
            addedBy: userId,
            role: 'member',
            kickedAt: null,
            kickReason: null,
          },
        });

      // 2. Add agent to chat participants (upsert)
      await tx
        .insert(chatParticipants)
        .values({
          id: participantId,
          chatId: teamChat.chatId,
          userId: agentUserId,
          joinedAt: now,
          isActive: true,
        })
        .onConflictDoUpdate({
          target: [chatParticipants.chatId, chatParticipants.userId],
          set: {
            isActive: true,
            joinedAt: now,
          },
        });

      if (shouldAnnounceJoin) {
        await tx.insert(messages).values({
          id: messageId,
          chatId: teamChat.chatId,
          senderId: 'system',
          type: 'system',
          content: `🤖 ${agent.displayName || agent.username || 'Agent'} joined the team`,
          createdAt: now,
        });
      }

      // 3. Update group timestamp
      await tx
        .update(groups)
        .set({ updatedAt: now })
        .where(eq(groups.id, teamChat.groupId));
    });

    logger.info(
      `Agent ${agentUserId} added to team chat`,
      { userId, chatId: teamChat.chatId },
      'TeamChatService'
    );
  }

  /**
   * Remove an agent from the user's team chat
   *
   * @param userId - The human user ID (owner)
   * @param agentUserId - The agent user ID to remove
   */
  async removeAgentFromTeamChat(
    userId: string,
    agentUserId: string
  ): Promise<void> {
    const teamChat = await this.getTeamChat(userId);
    if (!teamChat) {
      // No team chat exists, nothing to remove from
      return;
    }

    // Get agent info for the system message (might be getting deleted, so fetch first)
    const [agent] = await db
      .select()
      .from(users)
      .where(eq(users.id, agentUserId))
      .limit(1);

    // Ownership validation (defense in depth - caller should validate too)
    if (agent && agent.isAgent && agent.managedBy !== userId) {
      logger.warn(
        `Attempted to remove agent not owned by user`,
        { userId, agentUserId, actualOwner: agent.managedBy },
        'TeamChatService'
      );
      return;
    }

    const agentName = agent?.displayName || agent?.username || 'Agent';

    await withTransaction(async (tx) => {
      const now = new Date();
      const messageId = await generateSnowflakeId();

      // 1. Soft-delete from group members (set isActive=false)
      await tx
        .update(groupMembers)
        .set({
          isActive: false,
          kickedAt: now,
          kickReason: 'Agent deleted',
        })
        .where(
          and(
            eq(groupMembers.groupId, teamChat.groupId),
            eq(groupMembers.userId, agentUserId)
          )
        );

      // 2. Soft-delete from chat participants
      await tx
        .update(chatParticipants)
        .set({ isActive: false })
        .where(
          and(
            eq(chatParticipants.chatId, teamChat.chatId),
            eq(chatParticipants.userId, agentUserId)
          )
        );

      // 3. Create system message announcing the agent left
      await tx.insert(messages).values({
        id: messageId,
        chatId: teamChat.chatId,
        senderId: 'system',
        type: 'system',
        content: `🤖 ${agentName} left the team`,
        createdAt: now,
      });

      // 4. Update group timestamp
      await tx
        .update(groups)
        .set({ updatedAt: now })
        .where(eq(groups.id, teamChat.groupId));
    });

    logger.info(
      `Agent ${agentUserId} removed from team chat`,
      { userId, chatId: teamChat.chatId },
      'TeamChatService'
    );
  }

  /**
   * Sync all existing agents to the team chat.
   *
   * This is useful for adding agents that were created before the team chat
   * feature was implemented, or if agents somehow got out of sync.
   *
   * @param userId - The human user ID
   * @returns Number of agents that were added
   */
  async syncExistingAgents(userId: string): Promise<number> {
    // Ensure team chat exists
    const teamChat = await this.ensureTeamChat(userId);

    // Get all agents owned by this user
    const allUserAgents = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.managedBy, userId), eq(users.isAgent, true)));

    if (allUserAgents.length === 0) {
      return 0;
    }

    // Get agents already in the team chat
    const existingMembers = await db
      .select({ userId: groupMembers.userId })
      .from(groupMembers)
      .where(
        and(
          eq(groupMembers.groupId, teamChat.groupId),
          eq(groupMembers.isActive, true)
        )
      );

    const existingMemberIds = new Set(existingMembers.map((m) => m.userId));

    // Find agents that need to be added
    const agentsToAdd = allUserAgents.filter(
      (agent) => !existingMemberIds.has(agent.id)
    );

    if (agentsToAdd.length === 0) {
      return 0;
    }

    // Batch add missing agents (silently, without system messages to avoid spam)
    await this.batchAddAgentsToTeamChatSilent(
      userId,
      agentsToAdd.map((a) => a.id),
      teamChat
    );

    logger.info(
      `Synced ${agentsToAdd.length} existing agent(s) to team chat`,
      { userId, agentIds: agentsToAdd.map((a) => a.id) },
      'TeamChatService'
    );

    return agentsToAdd.length;
  }

  /**
   * Batch add agents to team chat without system messages (for sync operations).
   * More efficient than calling addAgentToTeamChatSilent in a loop.
   * Wrapped in transaction to ensure atomicity.
   */
  private async batchAddAgentsToTeamChatSilent(
    userId: string,
    agentUserIds: string[],
    teamChat: TeamChatInfo
  ): Promise<void> {
    if (agentUserIds.length === 0) return;

    await withTransaction(async (tx) => {
      const now = new Date();

      // Generate all IDs upfront
      const memberIds = await Promise.all(
        agentUserIds.map(() => generateSnowflakeId())
      );
      const participantIds = await Promise.all(
        agentUserIds.map(() => generateSnowflakeId())
      );

      // Batch insert group members (with upsert)
      const memberValues = agentUserIds.map((agentUserId, i) => ({
        id: memberIds[i] as string,
        groupId: teamChat.groupId,
        userId: agentUserId,
        role: 'member' as const,
        addedBy: userId,
        joinedAt: now,
        isActive: true,
        messageCount: 0,
        qualityScore: 1.0,
      }));

      await tx
        .insert(groupMembers)
        .values(memberValues)
        .onConflictDoUpdate({
          target: [groupMembers.groupId, groupMembers.userId],
          set: {
            isActive: true,
            joinedAt: now,
            addedBy: userId,
            role: 'member',
            kickedAt: null,
            kickReason: null,
          },
        });

      // Batch insert chat participants (with upsert)
      const participantValues = agentUserIds.map((agentUserId, i) => ({
        id: participantIds[i] as string,
        chatId: teamChat.chatId,
        userId: agentUserId,
        joinedAt: now,
        isActive: true,
      }));

      await tx
        .insert(chatParticipants)
        .values(participantValues)
        .onConflictDoUpdate({
          target: [chatParticipants.chatId, chatParticipants.userId],
          set: {
            isActive: true,
            joinedAt: now,
          },
        });
    });
  }

  // ===========================================================================
  // CONVERSATION MANAGEMENT (Fresh Chat Feature)
  // ===========================================================================

  /**
   * List all conversations (Chats) for a user's team chat.
   * Returns chats ordered by most recently updated first.
   *
   * @param userId - The human user ID
   * @returns Array of Chat records for this team
   */
  async listConversations(userId: string): Promise<Chat[]> {
    const teamChat = await this.getTeamChat(userId);
    if (!teamChat) {
      return [];
    }

    const conversations = await db
      .select()
      .from(chats)
      .where(eq(chats.groupId, teamChat.groupId))
      .orderBy(desc(chats.updatedAt));

    return conversations;
  }

  /**
   * Create a new conversation (Chat) within the user's team chat.
   * This is the "New Chat" feature - starts fresh context for agents.
   *
   * @param userId - The human user ID
   * @param title - Optional title for the conversation
   * @returns The newly created Chat and updated TeamChatInfo
   */
  async createConversation(
    userId: string,
    title?: string
  ): Promise<{ chat: Chat; teamChat: TeamChatInfo }> {
    const teamChat = await this.ensureTeamChat(userId);

    const result = await withTransaction(async (tx) => {
      const now = new Date();
      const [chatId, participantId] = await Promise.all([
        generateSnowflakeId(),
        generateSnowflakeId(),
      ]);

      // Use provided title, or null to indicate LLM should generate after first message
      const chatTitle = title || null;

      // 1. Create new Chat linked to the same Group
      const [newChat] = await tx
        .insert(chats)
        .values({
          id: chatId,
          name: chatTitle,
          description: null,
          isGroup: true,
          groupId: teamChat.groupId,
          createdBy: userId,
          createdAt: now,
          updatedAt: now,
        })
        .returning();

      // 2. Add user as participant
      await tx.insert(chatParticipants).values({
        id: participantId,
        chatId,
        userId,
        joinedAt: now,
        isActive: true,
      });

      // 3. Add all agents as participants
      const agents = await this.getTeamChatAgents(userId, teamChat.groupId);
      if (agents.length > 0) {
        const agentParticipantIds = await Promise.all(
          agents.map(() => generateSnowflakeId())
        );
        const agentParticipantValues = agents.map((agent, i) => ({
          id: agentParticipantIds[i] as string,
          chatId,
          userId: agent.id,
          joinedAt: now,
          isActive: true,
        }));
        await tx
          .insert(chatParticipants)
          .values(agentParticipantValues)
          .onConflictDoNothing();
      }

      // 4. Update group to point to new conversation
      await tx
        .update(groups)
        .set({ activeChatId: chatId, updatedAt: now })
        .where(eq(groups.id, teamChat.groupId));

      return newChat;
    });

    if (!result) {
      throw new Error('Failed to create conversation');
    }

    logger.info(
      `New conversation created for user ${userId}`,
      { chatId: result.id, title: result.name },
      'TeamChatService'
    );

    // Return updated team chat info
    const updatedTeamChat = await this.getTeamChat(userId);
    return { chat: result, teamChat: updatedTeamChat! };
  }

  /**
   * Switch to a different conversation within the user's team chat.
   *
   * @param userId - The human user ID
   * @param chatId - The chat ID to switch to
   * @returns Updated TeamChatInfo
   */
  async switchConversation(
    userId: string,
    chatId: string
  ): Promise<TeamChatInfo> {
    const teamChat = await this.getTeamChat(userId);
    if (!teamChat) {
      throw new Error('Team chat not found');
    }

    // Verify the chat belongs to this team's group
    const [chat] = await db
      .select()
      .from(chats)
      .where(and(eq(chats.id, chatId), eq(chats.groupId, teamChat.groupId)))
      .limit(1);

    if (!chat) {
      throw new Error('Conversation not found or does not belong to this team');
    }

    // Update active conversation in Group
    const now = new Date();
    await db
      .update(groups)
      .set({ activeChatId: chatId, updatedAt: now })
      .where(eq(groups.id, teamChat.groupId));

    logger.info(
      `Switched conversation for user ${userId}`,
      { chatId, previousChatId: teamChat.chatId },
      'TeamChatService'
    );

    return { ...teamChat, chatId, updatedAt: now };
  }

  /**
   * Rename a conversation.
   *
   * @param userId - The human user ID
   * @param chatId - The chat ID to rename
   * @param newTitle - The new title
   */
  async renameConversation(
    userId: string,
    chatId: string,
    newTitle: string
  ): Promise<void> {
    const teamChat = await this.getTeamChat(userId);
    if (!teamChat) {
      throw new Error('Team chat not found');
    }

    // Verify the chat belongs to this team's group
    const [chat] = await db
      .select()
      .from(chats)
      .where(and(eq(chats.id, chatId), eq(chats.groupId, teamChat.groupId)))
      .limit(1);

    if (!chat) {
      throw new Error('Conversation not found or does not belong to this team');
    }

    await db
      .update(chats)
      .set({ name: newTitle, updatedAt: new Date() })
      .where(eq(chats.id, chatId));

    logger.info(
      `Renamed conversation ${chatId}`,
      { newTitle },
      'TeamChatService'
    );
  }

  /**
   * Check if a chat needs a title to be generated.
   * Returns true if name is null (indicating auto-generation needed).
   * Validates ownership before returning the result.
   *
   * @param chatId - The chat ID to check
   * @param userId - The user ID to validate ownership
   * @returns Whether the chat needs a title, or false if user doesn't own the chat
   */
  async chatNeedsTitle(chatId: string, userId: string): Promise<boolean> {
    // Validate ownership first
    const teamChat = await this.getTeamChat(userId);
    if (!teamChat) {
      logger.warn(
        `chatNeedsTitle: User does not have a team chat`,
        { chatId, userId },
        'TeamChatService'
      );
      return false;
    }

    // Query with ownership validation
    const [chat] = await db
      .select({ name: chats.name })
      .from(chats)
      .where(and(eq(chats.id, chatId), eq(chats.groupId, teamChat.groupId)))
      .limit(1);

    if (!chat) {
      logger.warn(
        `chatNeedsTitle: Chat not found or not owned by user`,
        { chatId, userId },
        'TeamChatService'
      );
      return false;
    }

    return chat.name === null;
  }

  /**
   * Update a chat's title (used for LLM-generated titles).
   * Validates ownership before updating.
   *
   * @param chatId - The chat ID to update
   * @param title - The new title
   * @param userId - The user ID to validate ownership
   */
  async updateChatTitle(
    chatId: string,
    title: string,
    userId: string
  ): Promise<void> {
    // Validate ownership using team chat
    const teamChat = await this.getTeamChat(userId);
    if (!teamChat) {
      throw new Error('Team chat not found for user');
    }

    // Verify the chat belongs to this team's group
    const [chat] = await db
      .select()
      .from(chats)
      .where(and(eq(chats.id, chatId), eq(chats.groupId, teamChat.groupId)))
      .limit(1);

    if (!chat) {
      throw new Error('Chat not found or does not belong to this team');
    }

    await db
      .update(chats)
      .set({ name: title, updatedAt: new Date() })
      .where(eq(chats.id, chatId));

    logger.info(
      `Updated chat title via LLM generation`,
      { chatId, title, userId },
      'TeamChatService'
    );
  }

  /**
   * Atomically update a chat's title only if it's currently null.
   * This prevents race conditions where multiple first messages try to set the title.
   * Validates ownership before updating.
   *
   * @param chatId - The chat ID to update
   * @param title - The new title
   * @param userId - The user ID to validate ownership
   * @returns true if title was updated, false if it was already set or unauthorized
   */
  async updateChatTitleIfNull(
    chatId: string,
    title: string,
    userId: string
  ): Promise<boolean> {
    // Validate ownership using team chat
    const teamChat = await this.getTeamChat(userId);
    if (!teamChat) {
      logger.warn(
        `Cannot update chat title: team chat not found for user`,
        { chatId, userId },
        'TeamChatService'
      );
      return false;
    }

    // Atomic update with ownership check included in WHERE clause
    // Use .returning() to check if any rows were updated
    const result = await db
      .update(chats)
      .set({ name: title, updatedAt: new Date() })
      .where(
        and(
          eq(chats.id, chatId),
          isNull(chats.name),
          eq(chats.groupId, teamChat.groupId)
        )
      )
      .returning({ id: chats.id });

    const updated = result.length > 0;

    if (updated) {
      logger.info(
        `Atomically set chat title via LLM generation`,
        { chatId, title, userId },
        'TeamChatService'
      );
    }

    return updated;
  }

  /**
   * Get the count of user messages in a chat.
   * Used to determine if this is the first message (for title generation).
   * Validates chat ownership before returning the count.
   *
   * @param chatId - The chat ID
   * @param userId - The user ID to validate ownership (optional for backwards compat, will be required)
   * @returns Number of user messages
   * @throws Error if userId is provided and doesn't own the chat
   */
  async getUserMessageCount(chatId: string, userId?: string): Promise<number> {
    // If userId is provided, validate ownership
    if (userId) {
      const isOwner = await this.validateTeamChatOwnership(userId, chatId);
      if (!isOwner) {
        throw new Error('Unauthorized: User does not own this chat');
      }
    }

    const result = await db
      .select({ count: sql<string>`count(*)` })
      .from(messages)
      .where(and(eq(messages.chatId, chatId), eq(messages.type, 'user')));

    // COUNT may be returned as string at runtime; convert to number
    const countValue = result[0]?.count;
    return typeof countValue === 'string'
      ? parseInt(countValue, 10)
      : (countValue ?? 0);
  }

  /**
   * Delete a conversation (and all its messages).
   * Cannot delete if it's the only conversation.
   *
   * @param userId - The human user ID
   * @param chatId - The chat ID to delete
   * @returns The new active chatId if the deleted was active, null otherwise
   */
  async deleteConversation(
    userId: string,
    chatId: string
  ): Promise<string | null> {
    const teamChat = await this.getTeamChat(userId);
    if (!teamChat) {
      throw new Error('Team chat not found');
    }

    // Verify the chat belongs to this team's group
    const conversations = await this.listConversations(userId);
    const chatToDelete = conversations.find((c) => c.id === chatId);

    if (!chatToDelete) {
      throw new Error('Conversation not found or does not belong to this team');
    }

    // Cannot delete if it's the only conversation
    if (conversations.length <= 1) {
      throw new Error('Cannot delete the only conversation');
    }

    const wasActive = teamChat.chatId === chatId;
    let newActiveChatId: string | null = null;

    await withTransaction(async (tx) => {
      // 1. Delete all messages in this chat
      await tx.delete(messages).where(eq(messages.chatId, chatId));

      // 2. Delete chat participants
      await tx
        .delete(chatParticipants)
        .where(eq(chatParticipants.chatId, chatId));

      // 3. Delete the chat itself
      await tx.delete(chats).where(eq(chats.id, chatId));

      // 4. If this was the active conversation, switch to another
      // Query inside transaction to avoid TOCTOU race condition
      if (wasActive) {
        const [fallbackChat] = await tx
          .select({ id: chats.id })
          .from(chats)
          .where(and(eq(chats.groupId, teamChat.groupId), ne(chats.id, chatId)))
          .orderBy(desc(chats.createdAt))
          .limit(1);

        if (fallbackChat) {
          newActiveChatId = fallbackChat.id;
          await tx
            .update(groups)
            .set({ activeChatId: fallbackChat.id, updatedAt: new Date() })
            .where(eq(groups.id, teamChat.groupId));
        }
      }
    });

    logger.info(
      `Deleted conversation ${chatId}`,
      { wasActive, newActiveChatId },
      'TeamChatService'
    );

    return wasActive ? newActiveChatId : null;
  }
}

/** Singleton instance */
export const teamChatService = new TeamChatService();
