/**
 * NPC Group Dynamics Service
 *
 * Manages continuous NPC group chat dynamics:
 * - Form new groups based on relationships
 * - NPCs join existing groups
 * - NPCs leave groups
 * - NPCs kick members from their groups
 * - NPCs invite users to their groups
 * - NPCs post messages to groups
 *
 * Runs on game ticks to keep groups active and dynamic.
 */

import {
  actorRelationships,
  and,
  chatParticipants,
  chats,
  count,
  db,
  desc,
  eq,
  follows,
  groupInvites,
  groupMembers,
  groups,
  gte,
  inArray,
  lt,
  messages,
  notInArray,
  or,
  poolPositions,
  posts,
  reactions,
  shares,
  sql,
  userInteractions,
  users,
} from "@feed/db";
import {
  GROUP_CONFIG,
  generateSnowflakeId,
  jaccardSimilarity,
  logger,
} from "@feed/shared";
import { NPC_GROUP_DYNAMICS_CONFIG } from "../config/npc-activity";
import { FeedLLMClient } from "../llm/openai-client";
import { generateWorldContext, validateNoRealNames } from "../prompts";
import {
  pickRandom,
  type RngFunction,
  randomChance,
} from "../utils/randomization";
import { MarketContextService } from "./market-context-service";
import { autoJoinEmptyUsersToNpcGroupChats } from "./npc-group-chat-onboarding-service";
import { NPCGroupDynamicsCalculations } from "./npc-group-dynamics-calculations";
import { sharedChatContextService } from "./shared-chat-context-service";
import { StaticDataRegistry } from "./static-data-registry";
import { getTierMessageGuidance } from "./tier-config";
import { TieredGroupService } from "./tiered-group-service";

// Singleton for NPC context
const marketContextService = new MarketContextService();

export interface GroupDynamicsResult {
  groupsCreated: number;
  membersAdded: number;
  membersRemoved: number;
  usersInvited: number;
  usersAutoJoined: number;
  usersKicked: number;
  messagesPosted: number;
  tieredPromotions: number;
  tieredDemotions: number;
}

export function normalizeNpcGroupMessageResponse(
  rawResponse: unknown,
): { message: string } | null {
  if (typeof rawResponse === "string") {
    const trimmed = rawResponse.trim();
    if (!trimmed) {
      return null;
    }

    const xmlMatch = trimmed.match(/<message>([\s\S]*?)<\/message>/i);
    if (xmlMatch?.[1]) {
      return { message: xmlMatch[1].trim() };
    }

    return { message: trimmed };
  }

  if (
    typeof rawResponse === "object" &&
    rawResponse !== null &&
    !Array.isArray(rawResponse)
  ) {
    const record = rawResponse as Record<string, unknown>;
    const nested =
      typeof record.response === "object" &&
      record.response !== null &&
      !Array.isArray(record.response)
        ? (record.response as Record<string, unknown>)
        : null;
    const message =
      (typeof nested?.message === "string" && nested.message) ||
      (typeof record.message === "string" && record.message) ||
      "";

    return message.trim() ? { message: message.trim() } : null;
  }

  return null;
}

export class NPCGroupDynamicsService {
  // User group participation limits - now use GROUP_CONFIG from @feed/shared

  /**
   * Process all NPC group dynamics for one tick
   *
   * @param rng - Optional random number generator (defaults to Math.random)
   */
  static async processTickDynamics(
    rng: RngFunction = Math.random,
  ): Promise<GroupDynamicsResult> {
    const startTime = Date.now();
    const result: GroupDynamicsResult = {
      groupsCreated: 0,
      membersAdded: 0,
      membersRemoved: 0,
      usersInvited: 0,
      usersAutoJoined: 0,
      usersKicked: 0,
      messagesPosted: 0,
      tieredPromotions: 0,
      tieredDemotions: 0,
    };

    logger.info(
      "Processing NPC group dynamics",
      undefined,
      "NPCGroupDynamicsService",
    );

    // Initialize LLM client for message generation
    // Priority: Groq > Claude > OpenAI
    const llm = FeedLLMClient.forGameTick();

    // 1. Form new groups
    const newGroups = await NPCGroupDynamicsService.formNewGroups(rng);
    result.groupsCreated = newGroups;

    // 1.5. Dev/demo: ensure new users land in at least one NPC group chat
    // This is gated behind a feature flag and disabled by default in production.
    const autoJoined = await autoJoinEmptyUsersToNpcGroupChats({
      enabled: NPC_GROUP_DYNAMICS_CONFIG.autoJoinEmptyUsersToNpcGroupChat,
      batchSize: NPC_GROUP_DYNAMICS_CONFIG.autoJoinEmptyUsersBatchSize,
      targetChatsPerUser:
        process.env.NODE_ENV === "development" ||
        process.env.NODE_ENV === "test"
          ? 3
          : 1,
      defaultMaxMembers: NPC_GROUP_DYNAMICS_CONFIG.maxGroupSize,
      rng,
    });
    result.usersAutoJoined = autoJoined;

    // 2. NPCs join existing groups
    const joins = await NPCGroupDynamicsService.processGroupJoins(rng);
    result.membersAdded = joins;

    // 3. NPCs leave groups
    const leaves = await NPCGroupDynamicsService.processGroupLeaves(rng);
    result.membersRemoved = leaves;

    // 4. NPCs post messages to groups
    if (llm) {
      const messages = await NPCGroupDynamicsService.postGroupMessages(
        llm,
        rng,
      );
      result.messagesPosted = messages;
    }

    // 5. Invite users to groups
    const invites = await NPCGroupDynamicsService.inviteUsersToGroups(rng);
    result.usersInvited = invites;

    // 6. Kick users based on weighted participation metrics
    const kicks = await NPCGroupDynamicsService.kickUsersWithWeightedLogic(rng);
    result.usersKicked = kicks;

    // 7. Process tiered group system (promotions/demotions run ~daily)
    // Probability math: 0.0007 * 60 ticks/hr * 24 hrs = ~1.0 times per day
    const DAILY_TICK_PROBABILITY = 0.0007;
    if (randomChance(DAILY_TICK_PROBABILITY, rng)) {
      result.tieredPromotions = await TieredGroupService.processAllPromotions();
      result.tieredDemotions = await TieredGroupService.processAllDemotions();
    }

    const duration = Date.now() - startTime;
    logger.info(
      "NPC group dynamics complete",
      { ...result, duration },
      "NPCGroupDynamicsService",
    );

    return result;
  }

  /**
   * Form new NPC tier groups using the tiered group system.
   *
   * Creates all 3 tiers per NPC (Inner Circle, Community, Followers) with proper
   * tier configuration. This replaces the legacy single-group creation.
   *
   * Each NPC can have:
   * - Tier 1 (Inner Circle): 12 members, full alpha content
   * - Tier 2 (Community): 50 members, partial alpha content
   * - Tier 3 (Followers): 500 members, public-facing content
   */
  private static async formNewGroups(rng: RngFunction): Promise<number> {
    let groupsCreated = 0;

    // Get non-test NPCs from static registry
    const npcs = StaticDataRegistry.getAllActors()
      .filter((a) => !a.isTest)
      .map((a) => ({
        id: a.id,
        name: a.name,
      }));

    for (const npc of npcs) {
      // Random chance to bootstrap this NPC's tier groups
      // Lower probability since we're creating 3 groups at once
      if (!randomChance(NPC_GROUP_DYNAMICS_CONFIG.formGroupProbability, rng)) {
        continue;
      }

      // Use TieredGroupService to ensure all 3 tiers exist (idempotent)
      // This creates the groups with proper tier configuration if they don't exist
      const tiers = await TieredGroupService.ensureAllTiersExist(npc.id);

      // Count newly created tiers (memberCount === 1 means only NPC owner)
      const newTiers = tiers.filter((t) => t.memberCount === 1);
      groupsCreated += newTiers.length;

      if (newTiers.length > 0) {
        logger.info(
          "NPC tier groups created",
          {
            npcId: npc.id,
            npcName: npc.name,
            tiersCreated: newTiers.map((t) => ({
              tier: t.tier,
              name: t.groupName,
              maxMembers: t.maxMembers,
            })),
            existingTiers: tiers.length - newTiers.length,
          },
          "NPCGroupDynamicsService",
        );
      }
    }

    return groupsCreated;
  }

  /**
   * Process NPCs joining existing groups
   */
  private static async processGroupJoins(rng: RngFunction): Promise<number> {
    let joinsProcessed = 0;

    // Get all NPC group chats
    const groupList = await db
      .select()
      .from(chats)
      .where(eq(chats.isGroup, true));

    for (const group of groupList) {
      // Get participants for this group
      const participants = await db
        .select({ userId: chatParticipants.userId })
        .from(chatParticipants)
        .where(eq(chatParticipants.chatId, group.id));

      // Don't add to full groups
      if (participants.length >= NPC_GROUP_DYNAMICS_CONFIG.maxGroupSize) {
        continue;
      }

      const currentMemberIds = new Set(participants.map((p) => p.userId));
      const memberIdsArray = Array.from(currentMemberIds);

      // Get NPCs who could join from static registry
      const allActors = StaticDataRegistry.getAllActors();
      const potentialMembers =
        memberIdsArray.length > 0
          ? allActors.filter((a) => !memberIdsArray.includes(a.id)).slice(0, 5)
          : allActors.slice(0, 5);

      for (const candidate of potentialMembers) {
        // Random chance to join
        if (
          !randomChance(NPC_GROUP_DYNAMICS_CONFIG.joinGroupProbability, rng)
        ) {
          continue;
        }

        // Check if candidate has positive relationships with current members
        const relationships =
          memberIdsArray.length > 0
            ? await db
                .select()
                .from(actorRelationships)
                .where(
                  and(
                    or(
                      and(
                        eq(actorRelationships.actor1Id, candidate.id),
                        inArray(actorRelationships.actor2Id, memberIdsArray),
                      ),
                      and(
                        eq(actorRelationships.actor2Id, candidate.id),
                        inArray(actorRelationships.actor1Id, memberIdsArray),
                      ),
                    ),
                    gte(actorRelationships.sentiment, 0.3),
                  ),
                )
            : [];

        // Must have at least 2 friends in the group
        if (relationships.length >= 2) {
          // Check if already a participant (could be inactive)
          const [existingParticipant] = await db
            .select({
              id: chatParticipants.id,
              isActive: chatParticipants.isActive,
            })
            .from(chatParticipants)
            .where(
              and(
                eq(chatParticipants.chatId, group.id),
                eq(chatParticipants.userId, candidate.id),
              ),
            )
            .limit(1);

          if (existingParticipant) {
            // Reactivate if inactive
            if (!existingParticipant.isActive) {
              await db
                .update(chatParticipants)
                .set({
                  isActive: true,
                  joinedAt: new Date(),
                })
                .where(eq(chatParticipants.id, existingParticipant.id));
            }
          } else {
            // Add new participant
            await db.insert(chatParticipants).values({
              id: await generateSnowflakeId(),
              chatId: group.id,
              userId: candidate.id,
            });
          }

          // Also handle groupMembers if chat has a groupId
          if (group.groupId) {
            const [existingMember] = await db
              .select({ id: groupMembers.id, isActive: groupMembers.isActive })
              .from(groupMembers)
              .where(
                and(
                  eq(groupMembers.groupId, group.groupId),
                  eq(groupMembers.userId, candidate.id),
                ),
              )
              .limit(1);

            if (existingMember) {
              // Reactivate if inactive
              if (!existingMember.isActive) {
                await db
                  .update(groupMembers)
                  .set({
                    isActive: true,
                    joinedAt: new Date(),
                    kickedAt: sql`NULL`,
                    kickReason: sql`NULL`,
                  })
                  .where(eq(groupMembers.id, existingMember.id));
              }
            } else {
              // Add new member
              await db.insert(groupMembers).values({
                id: await generateSnowflakeId(),
                groupId: group.groupId,
                userId: candidate.id,
                role: "member",
                isActive: true,
                addedBy: null, // NPC joining autonomously
              });
            }
          }

          joinsProcessed++;
          logger.info(
            "NPC joined group",
            {
              npcId: candidate.id,
              npcName: candidate.name,
              chatName: group.name,
              friendsInGroup: relationships.length,
            },
            "NPCGroupDynamicsService",
          );

          break; // Only one join per group per tick
        }
      }
    }

    return joinsProcessed;
  }

  /**
   * Process NPCs leaving groups
   */
  private static async processGroupLeaves(rng: RngFunction): Promise<number> {
    let leavesProcessed = 0;

    // Get all group chats
    const groupChats = await db
      .select()
      .from(chats)
      .where(eq(chats.isGroup, true));

    for (const chat of groupChats) {
      // Get all participants for this chat
      const participantList = await db
        .select()
        .from(chatParticipants)
        .where(eq(chatParticipants.chatId, chat.id));

      // Don't process if group would become too small
      if (participantList.length <= NPC_GROUP_DYNAMICS_CONFIG.minGroupSize) {
        continue;
      }

      for (const membership of participantList) {
        // Random chance to leave
        if (
          !randomChance(NPC_GROUP_DYNAMICS_CONFIG.leaveGroupProbability, rng)
        ) {
          continue;
        }

        // Check if NPC is the group creator (don't leave own group)
        if (chat.name?.includes(membership.userId)) {
          continue;
        }

        // Check if NPC has negative relationships with members
        const memberIds = participantList
          .map((p) => p.userId)
          .filter((id) => id !== membership.userId);

        if (memberIds.length === 0) continue;

        const negativeRelationships = await db
          .select()
          .from(actorRelationships)
          .where(
            and(
              or(
                and(
                  eq(actorRelationships.actor1Id, membership.userId),
                  inArray(actorRelationships.actor2Id, memberIds),
                ),
                and(
                  eq(actorRelationships.actor2Id, membership.userId),
                  inArray(actorRelationships.actor1Id, memberIds),
                ),
              ),
              lt(actorRelationships.sentiment, -0.3),
            ),
          );

        // Leave if too many enemies in group
        if (negativeRelationships.length >= 2) {
          await db
            .delete(chatParticipants)
            .where(eq(chatParticipants.id, membership.id));

          // Also update groupMembers if chat has a groupId
          if (chat.groupId) {
            await db
              .update(groupMembers)
              .set({
                isActive: false,
                kickedAt: new Date(),
                kickReason: `Left - ${negativeRelationships.length} negative relationships`,
              })
              .where(
                and(
                  eq(groupMembers.groupId, chat.groupId),
                  eq(groupMembers.userId, membership.userId),
                ),
              );
          }

          leavesProcessed++;
          logger.info(
            "NPC left group",
            {
              npcId: membership.userId,
              chatName: chat.name,
              reason: `${negativeRelationships.length} negative relationships`,
            },
            "NPCGroupDynamicsService",
          );
        }
      }
    }

    return leavesProcessed;
  }

  /**
   * Post messages to groups from NPCs
   *
   * IMPORTANT: Group chats are the core ASYMMETRIC INFORMATION mechanic.
   * NPCs share insider info here that they would NEVER post publicly:
   * - Real positions and upcoming trades
   * - Insider knowledge about questions/markets
   * - Contradictions to their public statements
   * - Strategic coordination with allies
   *
   * Optimized: Single query with LEFT JOIN to get tier data upfront instead of N+1.
   */
  private static async postGroupMessages(
    llm: FeedLLMClient,
    rng: RngFunction,
  ): Promise<number> {
    let messagesPosted = 0;

    // Get active group chats with tier info in a single query (avoids N+1)
    const groupList = await db
      .select({
        id: chats.id,
        name: chats.name,
        groupId: chats.groupId,
        tier: groups.tier,
      })
      .from(chats)
      .leftJoin(groups, eq(groups.id, chats.groupId))
      .where(eq(chats.isGroup, true))
      .limit(20);

    for (const group of groupList) {
      // Tier is already available from the JOIN
      const tier = group.tier as 1 | 2 | 3 | null;

      // Tier-based message frequency: T1=25%, T2=15%, T3=5%, legacy=25%
      const messageChance =
        tier === 1 ? 0.25 : tier === 2 ? 0.15 : tier === 3 ? 0.05 : 0.25;

      if (!randomChance(messageChance, rng)) {
        continue;
      }

      // Get participants
      const participantList = await db
        .select()
        .from(chatParticipants)
        .where(eq(chatParticipants.chatId, group.id));

      // Get recent messages
      const recentMsgs = await db
        .select()
        .from(messages)
        .where(eq(messages.chatId, group.id))
        .orderBy(desc(messages.createdAt))
        .limit(10);

      // Get NPCs in this group by checking StaticDataRegistry
      // NPCs are not in the User table, they're in the static registry
      const participantUserIds = participantList.map((p) => p.userId);
      const npcParticipants: Array<{ id: string; displayName: string }> = [];

      for (const userId of participantUserIds) {
        const actor = StaticDataRegistry.getActor(userId);
        if (actor) {
          npcParticipants.push({ id: actor.id, displayName: actor.name });
        }
      }

      if (npcParticipants.length === 0) {
        continue; // No NPCs in this group
      }

      // Pick a random NPC to post
      const randomNpc = pickRandom(npcParticipants, rng);
      if (!randomNpc) continue;

      // Get full NPC actor data from static registry
      const npcActor = StaticDataRegistry.getActor(randomNpc.id);

      // Get NPC's current positions for insider trading context
      const npcPositions = await db
        .select()
        .from(poolPositions)
        .where(eq(poolPositions.poolId, randomNpc.id))
        .limit(5);

      // Get NPC-specific events (things that happened to THIS NPC)
      const npcName = npcActor?.name || randomNpc.displayName || "Unknown";
      const npcEvents = await marketContextService.getEventsForNPC(
        randomNpc.id,
        npcName,
      );

      // Build personal events context
      const personalEventsContext =
        npcEvents.length > 0
          ? `RECENT EVENTS INVOLVING YOU (use as insider knowledge):\n${npcEvents
              .slice(0, 5)
              .map((e) => `- [${e.type}] ${e.description}`)
              .join("\n")}`
          : "";

      // Get sender details for recent messages
      const messageSenderIds = recentMsgs.slice(0, 5).map((m) => m.senderId);
      const senders =
        messageSenderIds.length > 0
          ? await db
              .select({
                id: users.id,
                displayName: users.displayName,
              })
              .from(users)
              .where(inArray(users.id, messageSenderIds))
          : [];
      const senderMap = new Map(
        senders.map((s) => [s.id, s.displayName || "Someone"]),
      );

      // Build conversation context from recent messages
      const recentMessages = recentMsgs
        .slice(0, 5)
        .reverse()
        .map((m) => `${senderMap.get(m.senderId) || "Someone"}: ${m.content}`)
        .join("\n");

      const conversationContext = recentMessages
        ? `Recent conversation:\n${recentMessages}`
        : "";

      // Build position context for insider trading info
      const positionContext =
        npcPositions.length > 0
          ? `YOUR CURRENT POSITIONS (share strategically):\n${npcPositions
              .map(
                (p) =>
                  `- ${p.marketType === "perp" ? p.ticker : `Question #${p.marketId}`}: ${p.side} position, ${p.unrealizedPnL > 0 ? "up" : "down"} $${Math.abs(Number(p.unrealizedPnL)).toFixed(0)}`,
              )
              .join("\n")}`
          : "";

      // Build affiliation context
      const affiliationContext =
        npcActor?.affiliations && npcActor.affiliations.length > 0
          ? `Your affiliations: ${npcActor.affiliations.join(", ")}`
          : "";

      // Get world context for consistent parody names and market awareness
      const worldContext = await generateWorldContext({ maxActors: 20 });

      // Generate message based on tier - tier determines content level
      // Tier guidance extracted to tier-config.ts for maintainability
      const tierGuidance = getTierMessageGuidance(tier);

      // Character voice context for in-character messages
      const voiceContext = npcActor?.voice
        ? `YOUR VOICE: ${npcActor.voice}`
        : "";
      const personalityContext = npcActor?.personality
        ? `PERSONALITY: ${npcActor.personality}`
        : "";
      const postStyleContext = npcActor?.postStyle
        ? `STYLE: ${npcActor.postStyle}`
        : "";

      const prompt = `You are ${randomNpc.displayName} in a ${tier ? `TIER ${tier}` : "private"} group chat.
${voiceContext}
${personalityContext}
${postStyleContext}
${affiliationContext}

${personalEventsContext}

${conversationContext}

${positionContext}

${worldContext.worldActors}
${worldContext.currentMarkets}

${tierGuidance}

Write a private message (max 200 chars) appropriate for this tier.
SPEAK IN CHARACTER — your message should be immediately recognizable as ${randomNpc.displayName}.
NO hashtags. Emojis OK (🤫 👀 🔥).
Use parody names from World Actors (AIlon Musk, not Elon Musk).

Return your response as XML:
<response>
  <message>your message here</message>
</response>`;

      let response: { message: string } | null = null;
      try {
        const rawResponse = await llm.generateJSON<
          { message: string } | { response: { message: string } }
        >(
          prompt,
          {
            properties: {
              message: { type: "string" },
            },
            required: ["message"],
          },
          {
            temperature: 0.9,
            maxTokens: 100,
            promptType: "npc_group_dynamic_message",
          },
        );
        response = normalizeNpcGroupMessageResponse(rawResponse);
      } catch (error) {
        logger.warn(
          "LLM failed to generate group message, skipping",
          {
            npcId: randomNpc.id,
            error: error instanceof Error ? error.message : String(error),
          },
          "NPCGroupDynamicsService",
        );
        continue;
      }
      if (!response?.message) {
        continue;
      }

      // Process message: strip hashtags (never allowed) but keep emojis (allowed in private chats)
      const rawContent = response.message.trim();
      // Strip hashtags (defense-in-depth since prompt forbids them)
      const messageContent = rawContent
        .replace(/#\w+/g, "")
        .replace(/\s+/g, " ")
        .trim();

      // Validate message follows rules
      // Note: Emojis are ALLOWED in private group chats (unlike public feed posts)
      // This is intentional - group chats are more casual/private
      const realNameViolations = validateNoRealNames(messageContent);

      if (realNameViolations.length > 0) {
        logger.warn(
          "NPC group message validation failed, skipping",
          {
            npcId: randomNpc.id,
            violations: realNameViolations,
            message: messageContent,
          },
          "NPCGroupDynamicsService",
        );
        continue;
      }

      // Minimum length guard: reject one-word or very short messages
      if (
        messageContent.length < 20 ||
        messageContent.trim().split(/\s+/).length < 3
      ) {
        logger.warn(
          "NPC group message too short, skipping",
          {
            npcId: randomNpc.id,
            length: messageContent.length,
            message: messageContent,
          },
          "NPCGroupDynamicsService",
        );
        continue;
      }

      // Similarity guard: reject if too similar to any recent message in this chat (5-min window)
      const recentChatWindow = new Date(Date.now() - 5 * 60 * 1000);
      const recentChatMsgs = recentMsgs.filter(
        (m) => m.createdAt >= recentChatWindow,
      );
      let tooSimilar = false;
      for (const recent of recentChatMsgs) {
        if (jaccardSimilarity(messageContent, recent.content) >= 0.5) {
          tooSimilar = true;
          break;
        }
      }
      if (tooSimilar) {
        logger.warn(
          "NPC group message too similar to recent message, skipping",
          { npcId: randomNpc.id, chatId: group.id },
          "NPCGroupDynamicsService",
        );
        continue;
      }

      // Create the message
      await db.insert(messages).values({
        id: await generateSnowflakeId(),
        content: messageContent,
        chatId: group.id,
        senderId: randomNpc.id,
        createdAt: new Date(),
      });

      // Update chat updated timestamp
      await db
        .update(chats)
        .set({ updatedAt: new Date() })
        .where(eq(chats.id, group.id));

      // Refresh the shared chat summary opportunistically so agents can see
      // compact cross-chat context without pulling the raw transcript.
      try {
        await sharedChatContextService.maybeRefreshChatContext(group.id, {
          messageWindowSize: 10,
          factLimit: 5,
          staleAfterMinutes: 30,
          refreshThreshold: 10,
        });
      } catch (error) {
        logger.warn(
          "Shared chat context refresh failed after NPC group post",
          {
            chatId: group.id,
            error: error instanceof Error ? error.message : String(error),
          },
          "NPCGroupDynamicsService",
        );
      }

      messagesPosted++;
      logger.debug(
        "NPC posted to group",
        {
          npcId: randomNpc.id,
          npcName: randomNpc.displayName,
          chatId: group.id,
          chatName: group.name,
        },
        "NPCGroupDynamicsService",
      );
    }

    return messagesPosted;
  }

  /**
   * Calculate "reply guy" score for a user based on their interactions with NPCs
   *
   * Rewards quality engagement, penalizes spam behavior
   *
   * Scoring:
   * - Follow: +5 points
   * - Comment: +3 points (ideal: 1-3 per week)
   * - Like: +1 point (ideal: 3-10 per week)
   * - Repost: +4 points (ideal: 1-2 per week)
   *
   * Penalties for excessive engagement (spam behavior):
   * - Too many comments (>10/week): -2 per excess comment
   * - Too many likes (>30/week): -0.5 per excess like
   * - Too many reposts (>5/week): -3 per excess repost
   */
  /**
   * Calculate engagement score for potential group invites (exposed for testing)
   */
  public static async calculateReplyGuyScore(
    userId: string,
    npcIds: string[],
  ): Promise<{
    score: number;
    breakdown: {
      follows: number;
      comments: number;
      likes: number;
      reposts: number;
      penalties: number;
      relationshipModifier: number;
      friendBoosts: number;
      enemyPenalties: number;
    };
  }> {
    const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    let score = 0;
    const breakdown = {
      follows: 0,
      comments: 0,
      likes: 0,
      reposts: 0,
      penalties: 0,
      relationshipModifier: 1.0,
      friendBoosts: 0,
      enemyPenalties: 0,
    };

    // 1. Check follows (all-time)
    const [followResult] =
      npcIds.length > 0
        ? await db
            .select({ count: count() })
            .from(follows)
            .where(
              and(
                eq(follows.followerId, userId),
                inArray(follows.followingId, npcIds),
              ),
            )
        : [{ count: 0 }];
    const followCount = followResult?.count ?? 0;
    breakdown.follows = followCount * 5;
    score += breakdown.follows;

    // 2. Count comments on NPC posts (last 7 days)
    // This requires a subquery to find posts by NPCs that user commented on
    const npcPosts =
      npcIds.length > 0
        ? await db
            .select({ id: posts.id })
            .from(posts)
            .where(inArray(posts.authorId, npcIds))
        : [];
    const npcPostIds = npcPosts.map((p) => p.id);

    const [commentResult] =
      npcPostIds.length > 0
        ? await db
            .select({ count: count() })
            .from(posts)
            .where(
              and(
                eq(posts.authorId, userId),
                inArray(posts.commentOnPostId, npcPostIds),
                gte(posts.createdAt, oneWeekAgo),
              ),
            )
        : [{ count: 0 }];
    const commentCount = commentResult?.count ?? 0;

    // Ideal: 1-3 comments per week
    if (commentCount >= 1 && commentCount <= 3) {
      breakdown.comments = commentCount * 3;
      score += breakdown.comments;
    } else if (commentCount > 3 && commentCount <= 10) {
      // Still okay, but diminishing returns
      breakdown.comments = commentCount * 2;
      score += breakdown.comments;
    } else if (commentCount > 10) {
      // Spam behavior - penalty
      const goodComments = 10 * 2; // First 10 get points
      const excessComments = commentCount - 10;
      const penalty = excessComments * -2;
      breakdown.comments = goodComments;
      breakdown.penalties += penalty;
      score += goodComments + penalty;
    }

    // 3. Count likes on NPC posts (last 7 days)
    const [likeResult] =
      npcPostIds.length > 0
        ? await db
            .select({ count: count() })
            .from(reactions)
            .where(
              and(
                eq(reactions.userId, userId),
                eq(reactions.type, "like"),
                inArray(reactions.postId, npcPostIds),
                gte(reactions.createdAt, oneWeekAgo),
              ),
            )
        : [{ count: 0 }];
    const likeCount = likeResult?.count ?? 0;

    // Ideal: 3-10 likes per week
    if (likeCount >= 3 && likeCount <= 10) {
      breakdown.likes = likeCount * 1;
      score += breakdown.likes;
    } else if (likeCount > 10 && likeCount <= 30) {
      // Moderate engagement
      breakdown.likes = likeCount * 0.5;
      score += breakdown.likes;
    } else if (likeCount > 30) {
      // Excessive liking - penalty
      const goodLikes = 30 * 0.5;
      const excessLikes = likeCount - 30;
      const penalty = excessLikes * -0.5;
      breakdown.likes = goodLikes;
      breakdown.penalties += penalty;
      score += goodLikes + penalty;
    } else if (likeCount > 0 && likeCount < 3) {
      // Some engagement is better than none
      breakdown.likes = likeCount * 0.5;
      score += breakdown.likes;
    }

    // 4. Count reposts/shares of NPC posts (last 7 days)
    const [repostResult] =
      npcPostIds.length > 0
        ? await db
            .select({ count: count() })
            .from(shares)
            .where(
              and(
                eq(shares.userId, userId),
                inArray(shares.postId, npcPostIds),
                gte(shares.createdAt, oneWeekAgo),
              ),
            )
        : [{ count: 0 }];
    const repostCount = repostResult?.count ?? 0;

    // Ideal: 1-2 reposts per week
    if (repostCount >= 1 && repostCount <= 2) {
      breakdown.reposts = repostCount * 4;
      score += breakdown.reposts;
    } else if (repostCount > 2 && repostCount <= 5) {
      // Moderate reposting
      breakdown.reposts = repostCount * 2;
      score += breakdown.reposts;
    } else if (repostCount > 5) {
      // Excessive reposting - penalty
      const goodReposts = 5 * 2;
      const excessReposts = repostCount - 5;
      const penalty = excessReposts * -3;
      breakdown.reposts = goodReposts;
      breakdown.penalties += penalty;
      score += goodReposts + penalty;
    }

    // 5. Apply relationship modifier
    const relationshipModifier =
      await NPCGroupDynamicsService.calculateRelationshipModifier(
        userId,
        npcIds,
      );
    breakdown.relationshipModifier = relationshipModifier.modifier;
    breakdown.friendBoosts = relationshipModifier.friendBoosts;
    breakdown.enemyPenalties = relationshipModifier.enemyPenalties;

    // Apply the modifier to the final score
    score = score * relationshipModifier.modifier;

    return { score, breakdown };
  }

  /**
   * Calculate relationship-based modifier for invite probability
   *
   * If user engages with friends of the candidate NPC, boost invite chance slightly
   * If user engages with enemies of the candidate NPC, reduce invite chance
   *
   * @param userId - The user being evaluated
   * @param targetNpcIds - The NPCs in the group (candidates for inviting)
   * @returns Modifier between 0.2x and 2.0x
   */
  private static async calculateRelationshipModifier(
    userId: string,
    targetNpcIds: string[],
  ): Promise<{
    modifier: number;
    friendBoosts: number;
    enemyPenalties: number;
  }> {
    let modifier = 1.0;
    let friendBoosts = 0;
    let enemyPenalties = 0;

    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    // Get all NPCs the user has engaged with (via UserInteraction table)
    const userInteractionList = await db
      .select({ npcId: userInteractions.npcId })
      .from(userInteractions)
      .where(
        and(
          eq(userInteractions.userId, userId),
          gte(userInteractions.timestamp, thirtyDaysAgo),
        ),
      );

    // Get unique NPC IDs
    const userEngagedNpcIds = [
      ...new Set(userInteractionList.map((i) => i.npcId)),
    ];

    if (userEngagedNpcIds.length === 0) {
      return { modifier: 1.0, friendBoosts: 0, enemyPenalties: 0 };
    }

    // For each target NPC (in the group), check relationships with NPCs user engages with
    for (const targetNpcId of targetNpcIds) {
      const relationships = await db
        .select()
        .from(actorRelationships)
        .where(
          or(
            and(
              eq(actorRelationships.actor1Id, targetNpcId),
              inArray(actorRelationships.actor2Id, userEngagedNpcIds),
            ),
            and(
              eq(actorRelationships.actor2Id, targetNpcId),
              inArray(actorRelationships.actor1Id, userEngagedNpcIds),
            ),
          ),
        );

      for (const rel of relationships) {
        // Enemy relationship: reduce invite chance
        if (rel.sentiment < -0.3) {
          modifier *= 0.8; // 20% reduction per enemy
          enemyPenalties++;
          logger.debug(
            "User engages with enemy NPC, reducing invite chance",
            {
              userId,
              targetNpcId,
              enemyNpcId:
                rel.actor1Id === targetNpcId ? rel.actor2Id : rel.actor1Id,
              sentiment: rel.sentiment,
              newModifier: modifier,
            },
            "NPCGroupDynamicsService",
          );
        }
        // Friend relationship: boost invite chance slightly
        else if (rel.sentiment > 0.5) {
          modifier *= 1.1; // 10% boost per friend
          friendBoosts++;
          logger.debug(
            "User engages with friend NPC, boosting invite chance",
            {
              userId,
              targetNpcId,
              friendNpcId:
                rel.actor1Id === targetNpcId ? rel.actor2Id : rel.actor1Id,
              sentiment: rel.sentiment,
              newModifier: modifier,
            },
            "NPCGroupDynamicsService",
          );
        }
      }
    }

    // Cap the modifier between 0.2x (80% penalty max) and 2.0x (100% boost max)
    modifier = Math.max(0.2, Math.min(2.0, modifier));

    return { modifier, friendBoosts, enemyPenalties };
  }

  /**
   * Invite users to NPC groups based on quality engagement
   *
   * Users earn invitation chances by:
   * - Following NPCs
   * - Commenting thoughtfully (not spamming)
   * - Liking posts moderately
   * - Reposting occasionally
   *
   * Excessive engagement (spam) reduces invitation likelihood
   */
  private static async inviteUsersToGroups(rng: RngFunction): Promise<number> {
    let usersInvited = 0;

    // Get groups with space for more members
    const groupList = await db
      .select()
      .from(chats)
      .where(eq(chats.isGroup, true));

    for (const group of groupList) {
      // Get participants for this group
      const participants = await db
        .select({ userId: chatParticipants.userId })
        .from(chatParticipants)
        .where(eq(chatParticipants.chatId, group.id));

      // Check if group has space
      if (participants.length >= NPC_GROUP_DYNAMICS_CONFIG.maxGroupSize) {
        continue;
      }

      // Random chance to invite
      if (!randomChance(NPC_GROUP_DYNAMICS_CONFIG.inviteUserProbability, rng)) {
        continue;
      }

      const currentMemberIds = new Set(participants.map((p) => p.userId));
      const memberIdsArray = Array.from(currentMemberIds);

      // Get NPCs in this group (for scoring user interactions)
      // Check which members are NPCs using static registry
      const allActorIds = new Set(
        StaticDataRegistry.getAllActors().map((a) => a.id),
      );
      const npcMemberIds = memberIdsArray.filter((id) => allActorIds.has(id));

      if (npcMemberIds.length === 0) {
        continue; // No NPCs in group
      }

      const npcIds = npcMemberIds;

      // Get active real users (not NPCs) who aren't in this group
      // First get users who have at least one share
      const usersWithShares = await db
        .select({ userId: shares.userId })
        .from(shares);
      const userIdsWithShares = [
        ...new Set(usersWithShares.map((s) => s.userId)),
      ];

      const potentialInvites =
        userIdsWithShares.length > 0
          ? await db
              .select()
              .from(users)
              .where(
                and(
                  eq(users.isActor, false),
                  notInArray(
                    users.id,
                    memberIdsArray.length > 0 ? memberIdsArray : [""],
                  ),
                  inArray(users.id, userIdsWithShares),
                ),
              )
              .limit(30)
          : [];

      if (potentialInvites.length === 0) {
        continue;
      }

      // Calculate "reply guy" scores for all candidates
      const scoredUsers = await Promise.all(
        potentialInvites.map(async (user) => {
          const { score, breakdown } =
            await NPCGroupDynamicsService.calculateReplyGuyScore(
              user.id,
              npcIds,
            );
          return {
            user,
            score,
            breakdown,
          };
        }),
      );

      // Filter out users with negative scores (spammers)
      let eligibleUsers = scoredUsers.filter((su) => su.score > 0);

      // Filter users at their group limit or in cooldown
      eligibleUsers =
        await NPCGroupDynamicsService.filterUsersForInvite(eligibleUsers);

      if (eligibleUsers.length === 0) {
        continue;
      }

      // Sort by score descending (best reply guys first)
      eligibleUsers.sort((a, b) => b.score - a.score);

      // Pick from top 5 candidates with weighted randomness
      // Higher scores = higher chance to be selected
      const topCandidates = eligibleUsers.slice(0, 5);
      const totalScore = topCandidates.reduce((sum, c) => sum + c.score, 0);

      if (totalScore === 0) {
        continue;
      }

      // Weighted random selection
      if (topCandidates.length === 0) continue;
      let randomValue = rng() * totalScore;
      let selectedCandidate = topCandidates[0];

      for (const candidate of topCandidates) {
        randomValue -= candidate.score;
        if (randomValue <= 0) {
          selectedCandidate = candidate;
          break;
        }
      }

      if (!selectedCandidate) continue;

      // Get an NPC admin from the group to send the invite
      if (npcMemberIds.length === 0) continue;
      const invitingNpcId = npcMemberIds[0];
      if (!invitingNpcId) continue;

      // Get NPC name for logging from STATIC REGISTRY (no DB call!)
      const npcData = StaticDataRegistry.getActor(invitingNpcId);

      // Find or create Group record for this chat
      // Chat.groupId → Group.id relationship
      let groupId = group.groupId;

      if (!groupId) {
        // Create Group record if it doesn't exist (for legacy chats)
        const newGroupId = await generateSnowflakeId();
        await db.insert(groups).values({
          id: newGroupId,
          name: group.name || "NPC Group",
          type: "npc",
          ownerId: invitingNpcId,
          createdById: invitingNpcId,
          updatedAt: new Date(),
        });

        // Update chat with groupId
        await db
          .update(chats)
          .set({ groupId: newGroupId })
          .where(eq(chats.id, group.id));

        // Backfill GroupMember for existing chat participants
        const existingParticipants = await db
          .select({ userId: chatParticipants.userId })
          .from(chatParticipants)
          .where(
            and(
              eq(chatParticipants.chatId, group.id),
              eq(chatParticipants.isActive, true),
            ),
          );

        for (const participant of existingParticipants) {
          // Check if GroupMember already exists
          const [existingMember] = await db
            .select({ id: groupMembers.id })
            .from(groupMembers)
            .where(
              and(
                eq(groupMembers.groupId, newGroupId),
                eq(groupMembers.userId, participant.userId),
              ),
            )
            .limit(1);

          if (!existingMember) {
            const isOwner = participant.userId === invitingNpcId;
            await db.insert(groupMembers).values({
              id: await generateSnowflakeId(),
              groupId: newGroupId,
              userId: participant.userId,
              role: isOwner ? "owner" : "member",
              addedBy: invitingNpcId,
            });
          }
        }

        groupId = newGroupId;
      }

      if (!groupId) continue;

      // Check for existing invite (unique constraint on groupId + invitedUserId)
      const [existingInvite] = await db
        .select({ id: groupInvites.id, status: groupInvites.status })
        .from(groupInvites)
        .where(
          and(
            eq(groupInvites.groupId, groupId),
            eq(groupInvites.invitedUserId, selectedCandidate.user.id),
          ),
        )
        .limit(1);

      if (existingInvite) {
        if (existingInvite.status === "pending") {
          // Already has pending invite, skip
          continue;
        }
        if (existingInvite.status === "accepted") {
          // Already accepted, nothing to do - don't count as new invite
          continue;
        }
        // For declined invites, reset to pending (re-invite flow)
        if (existingInvite.status === "declined") {
          await db
            .update(groupInvites)
            .set({
              status: "pending",
              invitedBy: invitingNpcId,
              invitedAt: new Date(),
              respondedAt: null,
              message: `Join our group chat "${group.name}"!`,
            })
            .where(eq(groupInvites.id, existingInvite.id));
        }
      } else {
        // Create new invitation
        await db.insert(groupInvites).values({
          id: await generateSnowflakeId(),
          groupId,
          invitedUserId: selectedCandidate.user.id,
          invitedBy: invitingNpcId,
          status: "pending",
          message: `Join our group chat "${group.name}"!`,
        });
      }
      usersInvited++;
      logger.info(
        "User invited to NPC group (reply guy score)",
        {
          userId: selectedCandidate.user.id,
          userName: selectedCandidate.user.displayName,
          chatId: group.id,
          chatName: group.name,
          invitedBy: npcData?.name,
          replyGuyScore: selectedCandidate.score,
          breakdown: selectedCandidate.breakdown,
        },
        "NPCGroupDynamicsService",
      );
    }

    return usersInvited;
  }

  /**
   * Filter users who are at their group limit or in invite cooldown
   * Prevents unlimited group chat accumulation
   */
  private static async filterUsersForInvite<
    T extends {
      user: { id: string };
      score: number;
      breakdown: Record<string, number | string>;
    },
  >(candidates: T[]): Promise<T[]> {
    const filtered: T[] = [];

    for (const candidate of candidates) {
      // Check 1: Total active NPC groups limit (only NPC groups count toward limit)
      const [countResult] = await db
        .select({ count: count() })
        .from(groupMembers)
        .innerJoin(groups, eq(groupMembers.groupId, groups.id))
        .where(
          and(
            eq(groupMembers.userId, candidate.user.id),
            eq(groupMembers.isActive, true),
            eq(groups.type, "npc"),
          ),
        );
      const activeNpcGroupCount = countResult?.count ?? 0;

      if (activeNpcGroupCount >= GROUP_CONFIG.MAX_ACTIVE_USER_GROUPS) {
        logger.debug(
          "User at NPC group limit, skipping invite",
          {
            userId: candidate.user.id,
            activeNpcGroups: activeNpcGroupCount,
            maxNpcGroups: GROUP_CONFIG.MAX_ACTIVE_USER_GROUPS,
          },
          "NPCGroupDynamicsService",
        );
        continue;
      }

      // Check 2: Invite cooldown (only NPC groups count toward cooldown)
      const [latestMembership] = await db
        .select({ joinedAt: groupMembers.joinedAt })
        .from(groupMembers)
        .innerJoin(groups, eq(groupMembers.groupId, groups.id))
        .where(
          and(
            eq(groupMembers.userId, candidate.user.id),
            eq(groupMembers.isActive, true),
            eq(groups.type, "npc"),
          ),
        )
        .orderBy(desc(groupMembers.joinedAt))
        .limit(1);

      if (latestMembership) {
        const hoursSinceJoin =
          (Date.now() - latestMembership.joinedAt.getTime()) / (1000 * 60 * 60);

        if (hoursSinceJoin < GROUP_CONFIG.INVITE_COOLDOWN_HOURS) {
          logger.debug(
            "User in invite cooldown, skipping",
            {
              userId: candidate.user.id,
              hoursSinceJoin: hoursSinceJoin.toFixed(2),
              cooldownRequired: GROUP_CONFIG.INVITE_COOLDOWN_HOURS,
            },
            "NPCGroupDynamicsService",
          );
          continue;
        }
      }

      // User passed all checks
      filtered.push(candidate);
    }

    return filtered;
  }

  /**
   * Calculate kick probability with exponential scaling for over-posting
   *
   * Delegates to the pure calculation module for testability.
   *
   * @returns { probability: number, reason: string, category: 'inactive' | 'low' | 'over' | 'spam' | 'safe' }
   */
  static calculateKickProbability(
    userMessageCount: number,
    totalMessages: number,
    participantCount: number,
    windowDays = 7,
  ): {
    probability: number;
    reason: string;
    category: "inactive" | "low" | "over" | "spam" | "safe";
  } {
    return NPCGroupDynamicsCalculations.calculateKickProbability(
      userMessageCount,
      totalMessages,
      participantCount,
      windowDays,
    );
  }

  /**
   * Kick users with weighted randomness based on dynamic participation metrics
   *
   * Uses dynamic thresholds based on group activity level:
   * - Never posted: 90% kick probability
   * - Low participation: 20-50% based on how far below ideal minimum
   * - Over-posting: Exponential increase from 10% to 90% as messages approach spam threshold
   * - Spam (3x fair share or 20+/day): 95%+ kick probability
   *
   * All probabilities are then multiplied by a per-tick factor (5%) to make
   * kicks gradual rather than immediate.
   */
  private static async kickUsersWithWeightedLogic(
    rng: RngFunction,
  ): Promise<number> {
    let usersKicked = 0;

    // Only check for kicks some of the time
    if (!randomChance(NPC_GROUP_DYNAMICS_CONFIG.kickCheckProbability, rng)) {
      return 0;
    }

    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    // Only NPC-managed group chats participate in NPC kick dynamics
    const groupList = await db
      .select({
        id: chats.id,
        name: chats.name,
        groupId: chats.groupId,
      })
      .from(chats)
      .innerJoin(groups, eq(chats.groupId, groups.id))
      .where(and(eq(chats.isGroup, true), eq(groups.type, "npc")));

    for (const group of groupList) {
      // Get participants for this group
      const participantList = await db
        .select()
        .from(chatParticipants)
        .where(eq(chatParticipants.chatId, group.id));

      // Get recent messages
      const recentMsgs = await db
        .select({ senderId: messages.senderId })
        .from(messages)
        .where(
          and(
            eq(messages.chatId, group.id),
            gte(messages.createdAt, sevenDaysAgo),
          ),
        );

      // Get user details for participants (both users and agents, excluding NPCs)
      const participantUserIds = participantList.map((p) => p.userId);
      const participantUsers =
        participantUserIds.length > 0
          ? await db
              .select({
                id: users.id,
                displayName: users.displayName,
                isActor: users.isActor,
                isAgent: users.isAgent,
              })
              .from(users)
              .where(
                and(
                  inArray(users.id, participantUserIds),
                  eq(users.isActor, false),
                ),
              )
          : [];

      if (participantUsers.length === 0) continue;

      // Calculate message counts for all users in the group
      const totalMessages = recentMsgs.length;
      const messageCounts = new Map<string, number>();

      for (const msg of recentMsgs) {
        messageCounts.set(
          msg.senderId,
          (messageCounts.get(msg.senderId) || 0) + 1,
        );
      }

      // Total active participants includes NPCs for fair share calculation
      const totalParticipants = participantList.length;

      // Calculate kick probabilities for each non-NPC participant
      for (const participant of participantUsers) {
        const userId = participant.id;
        const userMessageCount = messageCounts.get(userId) || 0;

        const {
          probability: kickProbability,
          reason,
          category,
        } = NPCGroupDynamicsService.calculateKickProbability(
          userMessageCount,
          totalMessages,
          totalParticipants,
          7, // 7-day window
        );

        // Skip safe users
        if (category === "safe" || kickProbability === 0) {
          continue;
        }

        // Apply the probability with per-tick multiplier
        // 5% base multiplier, but spam gets 20% (faster kick for egregious behavior)
        const tickMultiplier = category === "spam" ? 0.2 : 0.05;

        if (randomChance(kickProbability * tickMultiplier, rng)) {
          // PROTECTION: Don't kick if user would fall below minimum group count
          const [userGroupCount] = await db
            .select({ count: count() })
            .from(groupMembers)
            .innerJoin(groups, eq(groupMembers.groupId, groups.id))
            .where(
              and(
                eq(groupMembers.userId, userId),
                eq(groupMembers.isActive, true),
                eq(groups.type, "npc"),
              ),
            );

          const currentGroups = userGroupCount?.count ?? 0;
          if (currentGroups <= GROUP_CONFIG.MIN_DEFAULT_GROUPS) {
            logger.debug(
              "Skipping kick - user at or below minimum group count",
              {
                userId,
                userName: participant.displayName,
                currentGroups,
                minRequired: GROUP_CONFIG.MIN_DEFAULT_GROUPS,
                chatName: group.name,
                reason,
              },
              "NPCGroupDynamicsService",
            );
            continue;
          }

          // Remove from chat participants
          await db
            .delete(chatParticipants)
            .where(
              and(
                eq(chatParticipants.chatId, group.id),
                eq(chatParticipants.userId, userId),
              ),
            );

          // If GroupMember exists, mark as removed
          // Chat.groupId → Group.id relationship
          if (group.groupId) {
            await db
              .update(groupMembers)
              .set({
                isActive: false,
                kickedAt: new Date(),
                kickReason: reason,
              })
              .where(
                and(
                  eq(groupMembers.groupId, group.groupId),
                  eq(groupMembers.userId, userId),
                ),
              );
          }

          usersKicked++;
          logger.info(
            "User kicked from group with weighted logic",
            {
              userId,
              userName: participant.displayName,
              isAgent: participant.isAgent,
              chatId: group.id,
              chatName: group.name,
              reason,
              category,
              kickProbability: kickProbability.toFixed(2),
              effectiveProbability: (kickProbability * tickMultiplier).toFixed(
                4,
              ),
              messageCount: userMessageCount,
              totalMessages,
              totalParticipants,
            },
            "NPCGroupDynamicsService",
          );
        }
      }
    }

    return usersKicked;
  }

  /**
   * Get group dynamics statistics
   */
  static async getGroupStats(): Promise<{
    totalGroups: number;
    activeGroups: number;
    totalMembers: number;
    avgGroupSize: number;
  }> {
    // Get total group count
    const [countResult] = await db
      .select({ count: count() })
      .from(chats)
      .where(eq(chats.isGroup, true));
    const totalGroups = countResult?.count ?? 0;

    // Get all groups
    const groupList = await db
      .select()
      .from(chats)
      .where(eq(chats.isGroup, true));

    // Get participant counts for each group
    let activeGroups = 0;
    let totalMembers = 0;

    for (const group of groupList) {
      const [partCountResult] = await db
        .select({ count: count() })
        .from(chatParticipants)
        .where(eq(chatParticipants.chatId, group.id));
      const participantCount = partCountResult?.count ?? 0;

      if (participantCount >= NPC_GROUP_DYNAMICS_CONFIG.minGroupSize) {
        activeGroups++;
      }
      totalMembers += participantCount;
    }

    const avgGroupSize =
      groupList.length > 0 ? totalMembers / groupList.length : 0;

    return {
      totalGroups,
      activeGroups,
      totalMembers,
      avgGroupSize,
    };
  }
}
