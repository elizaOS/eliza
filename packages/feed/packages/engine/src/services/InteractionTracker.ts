/**
 * Interaction Tracker
 *
 * Tracks all NPC-to-NPC interactions for relationship evolution.
 * Simple text-based system - just records what happened.
 */

import type { InputJsonValue } from '@babylon/db';
import { db, npcInteractions } from '@babylon/db';
import type { Actor } from '@babylon/shared';
import { generateSnowflakeId, logger } from '@babylon/shared';

export class InteractionTracker {
  /**
   * Track a post mentioning another NPC
   */
  static async trackPostMention(
    authorId: string,
    mentionedId: string,
    postContent: string,
    sentiment: number
  ): Promise<void> {
    // Sort IDs for consistency - fail fast if invalid IDs provided
    if (!authorId || !mentionedId) {
      throw new Error(
        `Invalid actor IDs in trackPostMention: authorId=${authorId}, mentionedId=${mentionedId}`
      );
    }
    const sorted = [authorId, mentionedId].sort();
    const id1 = sorted[0]!;
    const id2 = sorted[1]!;

    await db.insert(npcInteractions).values({
      id: await generateSnowflakeId(),
      actor1Id: id1,
      actor2Id: id2,
      interactionType: 'mention',
      sentiment,
      context: `${authorId === id1 ? 'actor1' : 'actor2'} mentioned ${authorId === id1 ? 'actor2' : 'actor1'} in post: "${postContent.substring(0, 100)}"`,
      metadata: {
        postContent: postContent.substring(0, 200),
      } as InputJsonValue,
      timestamp: new Date(),
    });

    logger.debug(
      'Tracked post mention',
      { authorId, mentionedId, sentiment },
      'InteractionTracker'
    );
  }

  /**
   * Track a reply between NPCs
   */
  static async trackReply(
    replierId: string,
    originalAuthorId: string,
    replyContent: string,
    sentiment: number
  ): Promise<void> {
    // Fail fast if invalid IDs provided
    if (!replierId || !originalAuthorId) {
      throw new Error(
        `Invalid actor IDs in trackReply: replierId=${replierId}, originalAuthorId=${originalAuthorId}`
      );
    }
    const sorted = [replierId, originalAuthorId].sort();
    const id1 = sorted[0]!;
    const id2 = sorted[1]!;

    await db.insert(npcInteractions).values({
      id: await generateSnowflakeId(),
      actor1Id: id1,
      actor2Id: id2,
      interactionType: 'reply',
      sentiment,
      context: `${replierId === id1 ? 'actor1' : 'actor2'} replied to ${replierId === id1 ? 'actor2' : 'actor1'}: "${replyContent.substring(0, 100)}"`,
      metadata: {
        replyContent: replyContent.substring(0, 200),
      } as InputJsonValue,
      timestamp: new Date(),
    });

    logger.debug(
      'Tracked reply',
      { replierId, originalAuthorId, sentiment },
      'InteractionTracker'
    );
  }

  /**
   * Track article mentioning multiple NPCs
   */
  static async trackArticleMention(
    actorIds: string[],
    articleTitle: string,
    articleSentiment: number
  ): Promise<void> {
    // Create interactions for all pairs
    for (let i = 0; i < actorIds.length; i++) {
      for (let j = i + 1; j < actorIds.length; j++) {
        const actor1 = actorIds[i];
        const actor2 = actorIds[j];
        if (!actor1 || !actor2) {
          throw new Error(
            `Invalid actor IDs in trackArticleMention at indices [${i}, ${j}]: actor1=${actor1}, actor2=${actor2}`
          );
        }
        // Skip self-interaction
        if (actor1 === actor2) continue;
        const [id1, id2] = [actor1, actor2].sort();

        await db.insert(npcInteractions).values({
          id: await generateSnowflakeId(),
          actor1Id: id1!,
          actor2Id: id2!,
          interactionType: 'article',
          sentiment: articleSentiment,
          context: `both mentioned in article: "${articleTitle}"`,
          metadata: { articleTitle } as InputJsonValue,
          timestamp: new Date(),
        });
      }
    }

    logger.debug(
      'Tracked article mentions',
      { actorCount: actorIds.length, articleTitle },
      'InteractionTracker'
    );
  }

  /**
   * Track event involving multiple NPCs
   */
  static async trackEventInvolvement(
    actorIds: string[],
    eventDescription: string,
    eventOutcome: 'positive' | 'negative' | 'neutral'
  ): Promise<void> {
    const sentimentMap = {
      positive: 0.3,
      neutral: 0,
      negative: -0.3,
    };

    // Create interactions for all pairs
    for (let i = 0; i < actorIds.length; i++) {
      for (let j = i + 1; j < actorIds.length; j++) {
        const actor1 = actorIds[i];
        const actor2 = actorIds[j];
        if (!actor1 || !actor2) {
          throw new Error(
            `Invalid actor IDs in trackEventInvolvement at indices [${i}, ${j}]: actor1=${actor1}, actor2=${actor2}`
          );
        }
        // Skip self-interaction
        if (actor1 === actor2) continue;
        const [id1, id2] = [actor1, actor2].sort();

        await db.insert(npcInteractions).values({
          id: await generateSnowflakeId(),
          actor1Id: id1!,
          actor2Id: id2!,
          interactionType: 'event',
          sentiment: sentimentMap[eventOutcome],
          context: `both involved in: ${eventDescription.substring(0, 100)}`,
          metadata: {
            eventDescription: eventDescription.substring(0, 200),
            outcome: eventOutcome,
          } as InputJsonValue,
          timestamp: new Date(),
        });
      }
    }

    logger.debug(
      'Tracked event involvement',
      { actorCount: actorIds.length, eventDescription },
      'InteractionTracker'
    );
  }

  /**
   * Extract actor mentions from post content
   * Looks for actor names (simple text matching)
   */
  static extractMentions(postContent: string, allActors: Actor[]): string[] {
    const mentions: string[] = [];

    for (const actor of allActors) {
      // Check for actor name in post
      if (postContent.includes(actor.name)) {
        mentions.push(actor.id);
      }
    }

    return [...new Set(mentions)]; // Dedupe
  }

  /**
   * Simple sentiment analysis from text
   */
  static analyzeSentiment(text: string): number {
    const positive =
      /\b(great|good|amazing|love|support|agree|brilliant|smart)\b/gi;
    const negative =
      /\b(terrible|bad|awful|hate|stupid|wrong|fail|disaster|idiot)\b/gi;

    const positiveCount = (text.match(positive) || []).length;
    const negativeCount = (text.match(negative) || []).length;

    if (positiveCount === 0 && negativeCount === 0) return 0;

    const total = positiveCount + negativeCount;
    return ((positiveCount - negativeCount) / total) * 0.8; // Scale to -0.8 to 0.8
  }
}
