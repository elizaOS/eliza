/**
 * Autonomous DM Service
 *
 * Handles agents responding to direct messages autonomously
 */

import {
  and,
  chatParticipants,
  db,
  desc,
  eq,
  gte,
  messages,
  ne,
  users,
} from '@feed/db';
import type { IAgentRuntime } from '@elizaos/core';
import { callGroqDirect } from '../llm/direct-groq';
import { getAgentConfig } from '../shared/agent-config';
import { logger } from '../shared/logger';
import { getAgentContext, isNpcUser } from './agent-context';
import { executeDirectMessage } from './DirectExecutors';

/**
 * Service for autonomous direct message responses
 */
export class AutonomousDMService {
  /**
   * Checks for unread DMs and generates responses
   *
   * @param agentUserId - Agent user ID
   * @param _runtime - Agent runtime (reserved for future use)
   * @returns Number of responses created
   * @throws Error if agent not found
   */
  async respondToDMs(
    agentUserId: string,
    _runtime: IAgentRuntime
  ): Promise<number> {
    // Resolve agent context (NPC vs USER_CONTROLLED)
    const { displayName: agentDisplayName } =
      await getAgentContext(agentUserId);

    const config = await getAgentConfig(agentUserId);

    // For user-controlled agents, get the owner ID to filter out owner DMs
    // (Owner should use Agents/team chat instead of DMs)
    let ownerUserId: string | null = null;
    if (!isNpcUser(agentUserId)) {
      const [agentRecord] = await db
        .select({ managedBy: users.managedBy })
        .from(users)
        .where(eq(users.id, agentUserId))
        .limit(1);
      ownerUserId = agentRecord?.managedBy ?? null;
    }

    // Get agent's DM chats (non-group chats)
    const dmChatsRaw = await db.query.chatParticipants.findMany({
      where: (chatParticipants, { eq }) =>
        eq(chatParticipants.userId, agentUserId),
      with: {
        chat: true,
      },
    });

    let responsesCreated = 0;

    for (const chatParticipant of dmChatsRaw) {
      const chat = chatParticipant.chat;
      if (!chat || chat.isGroup) continue; // Skip group chats

      // Skip DMs with the owner - owner should use Agents chat instead
      // Directly check if owner is a participant (more reliable than checking arbitrary other participant)
      if (ownerUserId && chat.id) {
        const ownerParticipation = await db
          .select({ userId: chatParticipants.userId })
          .from(chatParticipants)
          .where(
            and(
              eq(chatParticipants.chatId, chat.id),
              eq(chatParticipants.userId, ownerUserId)
            )
          )
          .limit(1);

        if (ownerParticipation.length > 0) {
          logger.debug(
            `Skipping DM with owner ${ownerUserId} - use Agents chat instead`,
            undefined,
            'AutonomousDM'
          );
          continue;
        }
      }

      // Get recent messages in this chat
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
      const unreadMessages = await db
        .select()
        .from(messages)
        .where(
          and(
            eq(messages.chatId, chat.id),
            ne(messages.senderId, agentUserId),
            gte(messages.createdAt, oneHourAgo)
          )
        )
        .orderBy(desc(messages.createdAt))
        .limit(5);

      if (unreadMessages.length === 0) continue;

      // Get conversation context
      const allMessages = await db.message.findMany({
        where: { chatId: chat.id },
        orderBy: { createdAt: 'asc' },
        take: 10,
      });

      const latestMessage = unreadMessages[0];
      if (!latestMessage) continue;

      // Generate response
      const prompt = `${config?.systemPrompt ?? 'You are an AI agent on Feed.'}

You are ${agentDisplayName} in a direct message conversation.

Recent conversation:
${allMessages
  .slice(-5)
  .map((m) => `${m.senderId === agentUserId ? 'You' : 'Them'}: ${m.content}`)
  .join('\n')}

Latest message from them:
"${latestMessage.content}"

Task: Generate a helpful, friendly response (1-2 sentences).
Be authentic to your personality.
Keep it under 200 characters.
If mentioning markets, use SHORT SUMMARIES (e.g., "the TeslAI bet") not full questions.

Generate ONLY the response text, nothing else.`;

      // Use small model (llama-3.1-8b-instant) for fast DM responses
      const responseContent = await callGroqDirect({
        prompt,
        system: config?.systemPrompt ?? undefined,
        modelSize: 'small', // Free tier: Frequent operation, use fast model
        runtime: _runtime, // Pass runtime to access W&B trained models AND trajectory context
        temperature: 0.8,
        maxTokens: 80,
        actionType: 'generate_dm_response',
        purpose: 'response', // RLAIF: This is a response generation call
      });

      const cleanContent = responseContent.trim().replace(/^["']|["']$/g, '');

      if (!cleanContent || cleanContent.length < 5) {
        continue;
      }

      // Create response message
      const result = await executeDirectMessage({
        agentUserId,
        chatId: chat.id,
        content: cleanContent,
      });

      if (!result.success) {
        logger.warn(
          `Failed to create DM response: ${result.error}`,
          undefined,
          'AutonomousDM'
        );
        continue;
      }

      responsesCreated++;
      logger.info(
        `Agent ${agentDisplayName} responded to DM in chat ${chat.id}`,
        undefined,
        'AutonomousDM'
      );

      // Only respond to one DM per tick to avoid spam
      break;
    }

    return responsesCreated;
  }
}

export const autonomousDMService = new AutonomousDMService();
