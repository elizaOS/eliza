/**
 * Actor Social Actions Service
 *
 * Handles actors randomly inviting users to group chats or sending DMs
 * based on interaction history and social relationships.
 */

import {
  and,
  chatParticipants,
  chats,
  db,
  eq,
  groupMembers,
  groups,
  gte,
  messages,
  userInteractions,
} from "@feed/db";
import { generateSnowflakeId, logger } from "@feed/shared";
import { NPC_SOCIAL_ACTIONS_CONFIG } from "../config/npc-activity";
import { clamp01 } from "../utils/math-utils";
import { GroupChatService } from "./group-chat-service";
import { StaticDataRegistry } from "./static-data-registry";

export interface SocialAction {
  type: "group_chat_invite" | "dm";
  userId: string;
  actorId: string;
  chatId?: string;
  chatName?: string;
  dmContent?: string;
}

export class ActorSocialActions {
  /**
   * Process random social actions for actors
   * Called periodically to randomly invite users or send DMs
   */
  static async processRandomSocialActions(): Promise<SocialAction[]> {
    const actions: SocialAction[] = [];

    // Get all actors from static registry (limit to prevent overload)
    const actorList = StaticDataRegistry.getAllActors().slice(0, 50);

    // Get all active users with interactions
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const usersWithInteractions = await db
      .selectDistinctOn([userInteractions.userId, userInteractions.npcId], {
        userId: userInteractions.userId,
        npcId: userInteractions.npcId,
        qualityScore: userInteractions.qualityScore,
      })
      .from(userInteractions)
      .where(gte(userInteractions.timestamp, sevenDaysAgo));

    // Group interactions by actor-user pairs
    const interactionMap = new Map<
      string,
      Array<{ userId: string; qualityScore: number }>
    >();

    for (const interaction of usersWithInteractions) {
      const key = `${interaction.npcId}-${interaction.userId}`;
      if (!interactionMap.has(key)) {
        interactionMap.set(key, []);
      }
      const interactions = interactionMap.get(key);
      if (interactions) {
        interactions.push({
          userId: interaction.userId,
          qualityScore: interaction.qualityScore,
        });
      }
    }

    // Process each actor-user pair
    for (const actor of actorList) {
      const actorInteractions = Array.from(interactionMap.entries())
        .filter(([key]) => key.startsWith(`${actor.id}-`))
        .map(([key, interactions]) => {
          const parts = key.split("-");
          return {
            userId: parts.length > 1 ? parts[1] : "",
            interactions,
          };
        });

      for (const { userId, interactions } of actorInteractions) {
        if (
          !userId ||
          interactions.length <
            NPC_SOCIAL_ACTIONS_CONFIG.minInteractionsForAction
        ) {
          continue;
        }

        const avgQuality =
          interactions.reduce((sum, i) => sum + i.qualityScore, 0) /
          interactions.length;
        if (avgQuality < NPC_SOCIAL_ACTIONS_CONFIG.minInteractionQuality) {
          continue;
        }

        // Check if user is already in this NPC's group specifically
        const [existingMembership] = await db
          .select({ id: groupMembers.id })
          .from(groupMembers)
          .innerJoin(groups, eq(groups.id, groupMembers.groupId))
          .where(
            and(
              eq(groupMembers.userId, userId),
              eq(groupMembers.isActive, true),
              eq(groups.ownerId, actor.id), // Only check groups owned by this NPC
            ),
          )
          .limit(1);

        // Check if there's already a DM chat between this actor and user
        let hasExistingDM = false;
        if (userId && actor.id) {
          const dmChats = await db
            .select({
              chatId: chats.id,
              participants: chatParticipants.userId,
            })
            .from(chats)
            .innerJoin(chatParticipants, eq(chatParticipants.chatId, chats.id))
            .where(eq(chats.isGroup, false));

          // Group by chat to check for DM between these two users
          const chatParticipantMap = new Map<string, string[]>();
          for (const row of dmChats) {
            if (!chatParticipantMap.has(row.chatId)) {
              chatParticipantMap.set(row.chatId, []);
            }
            if (row.participants) {
              chatParticipantMap.get(row.chatId)?.push(row.participants);
            }
          }

          // Check if any chat has exactly these two participants
          for (const [, participants] of chatParticipantMap) {
            if (
              participants.length === 2 &&
              participants.includes(userId) &&
              participants.includes(actor.id)
            ) {
              hasExistingDM = true;
              break;
            }
          }
        }

        // Calculate probabilities based on interaction quality and count
        // Use safe denominators to prevent division by zero (fallback to 1 if zero)
        const qualityDenominator =
          NPC_SOCIAL_ACTIONS_CONFIG.minInteractionQuality || 1;
        const countDenominator =
          NPC_SOCIAL_ACTIONS_CONFIG.minInteractionsForAction || 1;
        const qualityFactor = Math.min(avgQuality / qualityDenominator, 1.5);
        const countFactor = Math.min(
          interactions.length / countDenominator,
          2.0,
        );

        const inviteProbability = clamp01(
          NPC_SOCIAL_ACTIONS_CONFIG.baseInviteProbability *
            qualityFactor *
            countFactor,
        );
        const dmProbability = clamp01(
          NPC_SOCIAL_ACTIONS_CONFIG.baseDmProbability *
            qualityFactor *
            countFactor,
        );

        if (!userId) throw new Error("User ID is required");
        if (!actor.id) throw new Error("Actor ID is required");
        // Randomly decide to invite to group chat
        if (!existingMembership && Math.random() < inviteProbability) {
          // Try to find an existing game chat owned by this actor
          let chatId = `${actor.id}-owned-chat`;
          let chatName = `${actor.name}'s Inner Circle`;

          // Look for existing game chats where this actor might be admin
          // Group chats are stored with kebab-case names, so we search by name pattern
          const [existingChat] = await db
            .select()
            .from(chats)
            .where(and(eq(chats.isGroup, true), eq(chats.gameId, "continuous")))
            .limit(1);

          if (existingChat) {
            chatId = existingChat.id;
            chatName = existingChat.name || chatName;
          }
          await GroupChatService.recordInvite(
            userId,
            actor.id,
            chatId,
            chatName,
          );
          actions.push({
            type: "group_chat_invite",
            userId,
            actorId: actor.id,
            chatId,
            chatName,
          });
          logger.info(
            `Actor ${actor.name} invited user ${userId} to group chat`,
            {
              actorId: actor.id,
              userId,
              chatId,
              chatName,
            },
            "ActorSocialActions",
          );
        }

        // Randomly decide to send DM
        if (!hasExistingDM && Math.random() < dmProbability) {
          const dmChat = await ActorSocialActions.createDMWithMessage(
            actor.id,
            userId,
          );
          actions.push({
            type: "dm",
            userId,
            actorId: actor.id,
            chatId: dmChat.id,
            dmContent: dmChat.messageContent,
          });
          logger.info(
            `Actor ${actor.name} sent DM to user ${userId}`,
            {
              actorId: actor.id,
              userId,
              chatId: dmChat.id,
            },
            "ActorSocialActions",
          );
        }
      }
    }

    logger.info(
      `Processed ${actions.length} social actions`,
      {
        count: actions.length,
        invites: actions.filter((a) => a.type === "group_chat_invite").length,
        dms: actions.filter((a) => a.type === "dm").length,
      },
      "ActorSocialActions",
    );

    return actions;
  }

  /**
   * Create a DM chat between an actor and a user with an initial message
   */
  private static async createDMWithMessage(
    actorId: string,
    userId: string,
  ): Promise<{ id: string; messageContent: string }> {
    // Generate a DM message content (simple for now, could use LLM)
    const messagesList: string[] = [
      "Hey! I've been noticing your posts. Want to chat?",
      "Thought you might find this interesting...",
      "Quick question for you!",
      "Loved your take on that last post. Mind if I DM you?",
      "Got something I think you'd want to hear.",
    ];
    const randomIndex = Math.floor(Math.random() * messagesList.length);
    const messageContent: string =
      messagesList[randomIndex] ?? messagesList[0] ?? ""; // Safe: randomIndex is always within bounds

    // Create or get DM chat
    const chatId = await generateSnowflakeId();

    // Check if chat exists
    const [existingChat] = await db
      .select()
      .from(chats)
      .where(eq(chats.id, `dm-${actorId}-${userId}`))
      .limit(1);

    let finalChatId = chatId;

    if (existingChat) {
      finalChatId = existingChat.id;
    } else {
      await db.insert(chats).values({
        id: chatId,
        name: null, // DMs don't have names
        isGroup: false,
        updatedAt: new Date(),
      });
    }

    // Add participants
    const participantId1 = await generateSnowflakeId();
    const participantId2 = await generateSnowflakeId();

    // Check if participant exists
    const [existingParticipant1] = await db
      .select()
      .from(chatParticipants)
      .where(
        and(
          eq(chatParticipants.chatId, finalChatId),
          eq(chatParticipants.userId, actorId),
        ),
      )
      .limit(1);

    if (!existingParticipant1) {
      await db.insert(chatParticipants).values({
        id: participantId1,
        chatId: finalChatId,
        userId: actorId,
      });
    }

    const [existingParticipant2] = await db
      .select()
      .from(chatParticipants)
      .where(
        and(
          eq(chatParticipants.chatId, finalChatId),
          eq(chatParticipants.userId, userId),
        ),
      )
      .limit(1);

    if (!existingParticipant2) {
      await db.insert(chatParticipants).values({
        id: participantId2,
        chatId: finalChatId,
        userId,
      });
    }

    if (!messageContent) throw new Error("Message content is required");

    // Create initial message from actor
    await db.insert(messages).values({
      id: await generateSnowflakeId(),
      chatId: finalChatId,
      senderId: actorId,
      content: messageContent,
    });

    return {
      id: finalChatId,
      messageContent,
    };
  }
}
