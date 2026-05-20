/**
 * Org Coordination Service
 *
 * Tracks what NPCs at the same organization have said about events.
 * Provides coordination context to prevent duplicate/conflicting messaging.
 *
 * Design:
 * - org-reactions:{orgId}:{eventId} - sorted set of reactions by NPCs at this org
 * - TTL: 12 hours (reactions older than this are stale)
 */

import { logger } from '@feed/shared';
import { getRedisClient } from '../redis/client';

const ORG_REACTIONS_PREFIX = 'org-reactions:';
const REACTION_TTL_SECONDS = 43200; // 12 hours

export interface OrgReaction {
  npcId: string;
  npcName: string;
  eventId: string;
  angle: string; // Brief summary of the take/spin
  actionType: 'post' | 'comment' | 'trade';
  sentiment: 'positive' | 'negative' | 'neutral' | 'defensive';
  timestamp: number;
}

export interface OrgCoordinationContext {
  orgId: string;
  orgName: string;
  recentReactions: OrgReaction[];
  suggestedAngles: string[];
  avoidAngles: string[];
}

export class OrgCoordinationService {
  /**
   * Record that an NPC at an org has reacted to an event.
   * Called after NPC posts/comments about an event.
   */
  async recordOrgReaction(
    orgId: string,
    reaction: OrgReaction
  ): Promise<boolean> {
    const client = getRedisClient();
    if (!client) return false;

    try {
      const key = `${ORG_REACTIONS_PREFIX}${orgId}:${reaction.eventId}`;
      await client.zadd(key, reaction.timestamp, JSON.stringify(reaction));
      await client.expire(key, REACTION_TTL_SECONDS);

      logger.debug(
        'Recorded org reaction',
        {
          orgId,
          npcId: reaction.npcId,
          eventId: reaction.eventId,
          angle: reaction.angle,
        },
        'OrgCoordinationService'
      );
      return true;
    } catch (error) {
      logger.warn(
        'Failed to record org reaction',
        {
          orgId,
          error: error instanceof Error ? error.message : String(error),
        },
        'OrgCoordinationService'
      );
      return false;
    }
  }

  /**
   * Get coordination context for an NPC about to react to an event.
   * Shows what org-mates have already said.
   */
  async getCoordinationContext(
    npcOrgIds: string[],
    eventId: string,
    orgNames: Map<string, string>
  ): Promise<OrgCoordinationContext[]> {
    const client = getRedisClient();
    if (!client) return [];

    const contexts: OrgCoordinationContext[] = [];

    for (const orgId of npcOrgIds) {
      try {
        const key = `${ORG_REACTIONS_PREFIX}${orgId}:${eventId}`;
        const reactionStrs = await client.zrange(key, 0, -1);

        const reactions: OrgReaction[] = [];
        for (const s of reactionStrs) {
          try {
            reactions.push(JSON.parse(s) as OrgReaction);
          } catch {
            // Skip invalid JSON
          }
        }

        // Analyze existing angles to suggest alternatives
        const usedAngles = reactions.map((r) => r.angle);
        const sentiments = reactions.map((r) => r.sentiment);

        // Suggest angles not yet taken
        const suggestedAngles = this.generateAlternativeAngles(
          usedAngles,
          sentiments
        );

        contexts.push({
          orgId,
          orgName: orgNames.get(orgId) ?? orgId,
          recentReactions: reactions,
          suggestedAngles,
          avoidAngles: usedAngles,
        });
      } catch (error) {
        logger.debug(
          'Failed to get org coordination',
          {
            orgId,
            eventId,
            error: error instanceof Error ? error.message : String(error),
          },
          'OrgCoordinationService'
        );
      }
    }

    return contexts;
  }

  /**
   * Generate alternative angles that haven't been used yet.
   */
  private generateAlternativeAngles(
    usedAngles: string[],
    usedSentiments: string[]
  ): string[] {
    const suggestions: string[] = [];

    // If all reactions are defensive, suggest offense
    if (
      usedSentiments.length > 0 &&
      usedSentiments.every((s) => s === 'defensive')
    ) {
      suggestions.push('Take an offensive stance - go on the attack');
    }

    // If all reactions are one-sided, suggest nuance
    if (
      usedSentiments.length > 0 &&
      (usedSentiments.every((s) => s === 'positive') ||
        usedSentiments.every((s) => s === 'negative'))
    ) {
      suggestions.push('Offer a nuanced take with both sides');
    }

    // If no one has focused on specific aspects
    if (!usedAngles.some((a) => a.toLowerCase().includes('financial'))) {
      suggestions.push('Focus on financial implications');
    }
    if (
      !usedAngles.some(
        (a) =>
          a.toLowerCase().includes('personal') ||
          a.toLowerCase().includes('character')
      )
    ) {
      suggestions.push('Focus on personal/character angle');
    }
    if (
      !usedAngles.some(
        (a) =>
          a.toLowerCase().includes('future') ||
          a.toLowerCase().includes('prediction')
      )
    ) {
      suggestions.push('Focus on future implications');
    }

    // Suggest staying quiet if too many have spoken
    if (usedAngles.length >= 3) {
      suggestions.push('Consider not reacting - org has said enough');
    }

    return suggestions;
  }

  /**
   * Check if enough NPCs from an org have reacted (to avoid pile-on).
   */
  async hasOrgReactedEnough(
    orgId: string,
    eventId: string,
    threshold: number = 3
  ): Promise<boolean> {
    const client = getRedisClient();
    if (!client) return false;

    try {
      const key = `${ORG_REACTIONS_PREFIX}${orgId}:${eventId}`;
      const count = await client.zcard(key);
      return count >= threshold;
    } catch {
      return false;
    }
  }

  /**
   * Get the count of reactions for an org-event pair.
   */
  async getReactionCount(orgId: string, eventId: string): Promise<number> {
    const client = getRedisClient();
    if (!client) return 0;

    try {
      const key = `${ORG_REACTIONS_PREFIX}${orgId}:${eventId}`;
      return await client.zcard(key);
    } catch {
      return 0;
    }
  }
}

export const orgCoordinationService = new OrgCoordinationService();
