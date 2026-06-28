/**
 * Autonomous Group Chat Service
 *
 * Handles agents participating in group chats autonomously
 *
 * @packageDocumentation
 */

import type { IAgentRuntime } from "@elizaos/core";
import {
  and,
  db,
  desc,
  eq,
  groups,
  gte,
  inArray,
  messages,
  users,
} from "@feed/db";
import { StaticDataRegistry, shuffleArray } from "@feed/engine";
import { callGroqDirect } from "../llm/direct-groq";
import { getAgentConfig } from "../shared/agent-config";
import { logger } from "../shared/logger";
import { getAgentContext } from "./agent-context";
import { executeDirectMessage } from "./DirectExecutors";

/**
 * Service for autonomous group chat participation
 */
export class AutonomousGroupChatService {
  /**
   * Participates in group chats the agent is a member of
   *
   * @param agentUserId - Agent user ID
   * @param _runtime - Agent runtime (reserved for future use)
   * @returns Number of messages created
   * @throws Error if agent not found
   */
  async participateInGroupChats(
    agentUserId: string,
    _runtime: IAgentRuntime,
  ): Promise<number> {
    // Resolve agent context (NPC vs USER_CONTROLLED)
    const { displayName: agentDisplayName } =
      await getAgentContext(agentUserId);

    const config = await getAgentConfig(agentUserId);

    // Get agent's group chats
    const groupChatsRaw = await db.query.chatParticipants.findMany({
      where: (chatParticipants, { eq }) =>
        eq(chatParticipants.userId, agentUserId),
      with: {
        chat: true,
      },
      limit: 20,
    });

    let messagesCreated = 0;

    // Filter out team chats (Agents) - agents shouldn't auto-respond there
    // Team chats use group.type = 'team'
    const groupIds = groupChatsRaw
      .map((c) => c.chat?.groupId)
      .filter((gid): gid is string => !!gid);

    let teamGroupIds = new Set<string>();
    if (groupIds.length > 0) {
      const teamGroups = await db
        .select({ id: groups.id })
        .from(groups)
        .where(eq(groups.type, "team"));
      teamGroupIds = new Set(teamGroups.map((g) => g.id));
    }

    // Shuffle to prevent starvation (deterministic order would always favor same chats)
    const shuffledChats = shuffleArray(groupChatsRaw);

    for (const chatParticipant of shuffledChats) {
      const chat = chatParticipant.chat;
      if (!chat?.isGroup) continue; // Skip DMs

      // Skip team chats (Agents) - user explicitly triggers agent responses there
      if (chat.groupId && teamGroupIds.has(chat.groupId)) {
        continue;
      }

      // Get recent messages in this group (24h lookback for strategic continuity)
      const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const recentMessages = await db
        .select()
        .from(messages)
        .where(
          and(eq(messages.chatId, chat.id), gte(messages.createdAt, oneDayAgo)),
        )
        .orderBy(desc(messages.createdAt))
        .limit(15);

      if (recentMessages.length === 0) continue;

      // Check if agent was mentioned (exclude agent's own messages)
      const agentMentioned = recentMessages.some(
        (m: { content: string; senderId: string }) =>
          m.senderId !== agentUserId &&
          m.content.toLowerCase().includes(agentDisplayName.toLowerCase()),
      );

      // Don't spam - only respond if mentioned OR significant conversation activity
      const agentLastMessage = recentMessages.find(
        (m: { content: string; senderId: string }) =>
          m.senderId === agentUserId,
      );
      const hasRecentConversation = recentMessages.length >= 3;
      const shouldRespond =
        agentMentioned || (!agentLastMessage && hasRecentConversation);
      if (!shouldRespond) {
        continue;
      }

      // Resolve sender names for multi-party conversation clarity
      const senderIds = [
        ...new Set(
          recentMessages
            .map((m: { senderId: string }) => m.senderId)
            .filter((id: string) => id !== agentUserId),
        ),
      ];
      const senderNames = new Map<string, string>();
      const userIdsToLookup: string[] = [];
      for (const id of senderIds) {
        const npc = StaticDataRegistry.getActor(id);
        if (npc) {
          senderNames.set(id, npc.name);
        } else {
          userIdsToLookup.push(id);
        }
      }
      if (userIdsToLookup.length > 0) {
        const userRows = await db
          .select({ id: users.id, displayName: users.displayName })
          .from(users)
          .where(inArray(users.id, userIdsToLookup));
        for (const u of userRows) {
          senderNames.set(u.id, u.displayName || u.id);
        }
      }

      // Generate contextual response
      const prompt = `${config?.systemPrompt ?? "You are an AI agent on Feed."}

You are ${agentDisplayName} in a group chat.

Recent conversation:
${recentMessages
  .reverse()
  .map(
    (m: { content: string; senderId: string }) =>
      `${m.senderId === agentUserId ? "You" : senderNames.get(m.senderId) || "User"}: ${m.content}`,
  )
  .join("\n")}

Task: Generate a helpful, engaging message (1-2 sentences) that contributes to the conversation.
Be authentic to your personality and expertise.
Keep it under 200 characters.
Only respond if you have something valuable to add.

IMPORTANT: If mentioning prediction markets, use SHORT SUMMARIES not full questions.
❌ BAD: "the 'Will TeslAI achieve full self-driving readiness by Q1 2025?' prediction"
✅ GOOD: "the TeslAI readiness bet" or "the BitcAIn drop prediction"

Generate ONLY the message text, or "SKIP" if you shouldn't respond.`;

      // Use the large configured model for quality group chat content.
      const responseContent = await callGroqDirect({
        prompt,
        system: config?.systemPrompt ?? undefined,
        modelSize: "large", // Important social content
        runtime: _runtime, // Pass runtime to access W&B trained models AND trajectory context
        temperature: 0.8,
        maxTokens: 80,
        actionType: "generate_group_chat_response",
        purpose: "response", // RLAIF: This is a response generation call
      });

      const cleanContent = responseContent.trim().replace(/^["']|["']$/g, "");

      if (
        !cleanContent ||
        cleanContent.length < 5 ||
        cleanContent.toUpperCase() === "SKIP"
      ) {
        continue;
      }

      // Create group message
      const result = await executeDirectMessage({
        agentUserId,
        chatId: chat.id,
        content: cleanContent,
      });

      if (!result.success) {
        logger.warn(
          `Failed to create group chat message: ${result.error}`,
          undefined,
          "AutonomousGroupChat",
        );
        continue;
      }

      messagesCreated++;
      logger.info(
        `Agent ${agentDisplayName} participated in group chat ${chat.id}`,
        undefined,
        "AutonomousGroupChat",
      );

      // Allow up to 3 group chat responses per tick for cross-pollination
      if (messagesCreated >= 3) break;
    }

    return messagesCreated;
  }
}

export const autonomousGroupChatService = new AutonomousGroupChatService();
