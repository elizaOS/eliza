/**
 * Actor Context Builder
 *
 * Single source of truth for assembling everything an NPC actor knows.
 * Replaces the fragmented context pipelines where posting, trading, and
 * engagement each built their own partial view of the world.
 *
 * Used by: FeedGenerator, MarketDecisionEngine, social engagement,
 * and any future actor action system.
 */

import {
  actorRelationships,
  actorState,
  and,
  chatParticipants,
  chats,
  db,
  desc,
  eq,
  gte,
  lte,
  messages,
  or,
  parodyHeadlines,
  questions,
  worldEvents,
} from "@feed/db";
import { logger } from "@feed/shared";
import type {
  EventContext,
  FeedPostContext,
  RelationshipContext,
} from "../types/market-context";
import {
  fetchRelevantPosts,
  findRelatedActorsByAffiliation,
  resolveActorName,
} from "../utils/actor-utils";
import {
  formatActorFinanceGuardrails,
  formatActorToneGuardrails,
} from "../utils/shared-utils";
import { getAvoidedPatternsContext } from "./npc-anti-repetition-service";
import { NpcMemoryService } from "./npc-memory-service";
import { StaticDataRegistry } from "./static-data-registry";

export interface ActorContext {
  // Identity
  identity: {
    id: string;
    name: string;
    personality: string;
    voice: string;
    postStyle: string;
    postExamples: string[];
    domains: string[];
    ignoreTopics: string[];
    affiliations: string[];
    tier: string;
    description: string;
    system: string;
  };

  // Per-actor behavioral rules (from pack data)
  actorRules: {
    styleAll: string[];
    stylePost: string[];
    styleChat: string[];
    tradingStyle: string;
    socialStyle: string;
    motivations: string[];
    fears: string[];
    alignment: string;
  };

  // What they know right now
  awareness: {
    recentPosts: FeedPostContext[];
    personalEvents: EventContext[];
    worldEvents: EventContext[];
    resolvedQuestions: Array<{ text: string; outcome: string }>;
    directMessages: Array<{
      from: string;
      fromName: string;
      content: string;
      timestamp: string;
    }>;
    headlines: Array<{
      title: string;
      source: string;
    }>;
    trendingTopics: string[];
  };

  // Relationships
  relationships: RelationshipContext[];

  // State
  state: {
    mood: string;
    memories: string;
    avoidPatterns: string;
  };

  // Per-actor rules
  rules: {
    ignoreTopicsRule: string;
    toneGuardrails: string;
    financeGuardrails: string;
  };
}

export class ActorContextBuilder {
  private memoryService = new NpcMemoryService();

  /**
   * Build complete context for an actor. One call, everything they need.
   */
  async buildContext(actorId: string): Promise<ActorContext | null> {
    const actor = StaticDataRegistry.getActor(actorId);
    if (!actor) {
      logger.warn("Actor not found", { actorId }, "ActorContextBuilder");
      return null;
    }

    // Get full pack data for behavioral rules (style, feed metadata)
    const packActor = StaticDataRegistry.getPackActor(actorId);

    const now = new Date();
    const twoDaysAgo = new Date(now.getTime() - 48 * 60 * 60 * 1000);
    const affiliations = actor.affiliations || [];

    // Parallel fetch all data
    const [
      relevantPosts,
      personalEvents,
      recentWorldEvents,
      resolvedQs,
      actorRelations,
      memories,
      directMessages,
      moodState,
      recentHeadlines,
    ] = await Promise.all([
      fetchRelevantPosts(
        findRelatedActorsByAffiliation(actorId, affiliations),
        twoDaysAgo,
        now,
      ),
      this.getPersonalEvents(actorId, actor.name, now),
      this.getRecentWorldEvents(twoDaysAgo, now),
      this.getResolvedQuestions(),
      this.getRelationships(actorId),
      this.getMemories(actorId),
      this.getDirectMessages(actorId, twoDaysAgo),
      db
        .select({ currentMood: actorState.currentMood })
        .from(actorState)
        .where(eq(actorState.id, actorId))
        .limit(1)
        .then((r) => r[0]?.currentMood ?? 0),
      db
        .select({
          parodyTitle: parodyHeadlines.parodyTitle,
          originalSource: parodyHeadlines.originalSource,
        })
        .from(parodyHeadlines)
        .where(gte(parodyHeadlines.generatedAt, twoDaysAgo))
        .orderBy(desc(parodyHeadlines.generatedAt))
        .limit(8)
        .then((rows) =>
          rows.map((r) => ({
            title: r.parodyTitle,
            source: r.originalSource || "unknown",
          })),
        )
        .catch(() => [] as Array<{ title: string; source: string }>),
    ]);

    // Build per-actor rules
    const avoidPatterns = getAvoidedPatternsContext(actorId);
    const toneGuardrails = formatActorToneGuardrails(actor);
    const financeGuardrails = formatActorFinanceGuardrails(actor);
    const ignoreTopicsRule =
      actor.ignoreTopics && actor.ignoreTopics.length > 0
        ? `You never talk about: ${actor.ignoreTopics.join(", ")}`
        : "";

    return {
      identity: {
        id: actor.id,
        name: actor.name,
        personality: actor.personality || "",
        voice: actor.voice || "",
        postStyle: actor.postStyle || "",
        postExamples: actor.postExample || [],
        domains: actor.domain || [],
        ignoreTopics: actor.ignoreTopics || [],
        affiliations,
        tier: actor.tier || "",
        description: actor.description || "",
        system: packActor?.system || "",
      },
      actorRules: {
        styleAll: packActor?.style?.all || [],
        stylePost: packActor?.style?.post || [],
        styleChat: packActor?.style?.chat || [],
        tradingStyle: packActor?.feed?.tradingStyle || "",
        socialStyle: packActor?.feed?.socialStyle || "",
        motivations: packActor?.feed?.motivations || [],
        fears: packActor?.feed?.fears || [],
        alignment: packActor?.feed?.alignment || "neutral",
      },
      awareness: {
        recentPosts: relevantPosts,
        personalEvents,
        worldEvents: recentWorldEvents,
        resolvedQuestions: resolvedQs,
        directMessages,
        headlines: recentHeadlines,
        trendingTopics: [],
      },
      relationships: actorRelations,
      state: {
        mood:
          Number(moodState) > 0.3
            ? "positive"
            : Number(moodState) < -0.3
              ? "negative"
              : "neutral",
        memories,
        avoidPatterns,
      },
      rules: {
        ignoreTopicsRule,
        toneGuardrails,
        financeGuardrails,
      },
    };
  }

  private async getPersonalEvents(
    actorId: string,
    actorName: string,
    now: Date,
  ): Promise<EventContext[]> {
    const events = await db
      .select()
      .from(worldEvents)
      .where(lte(worldEvents.timestamp, now))
      .orderBy(desc(worldEvents.timestamp))
      .limit(50);

    return events
      .filter((e) => {
        const actors = e.actors as string[] | null;
        return actors?.includes(actorId) || actors?.includes(actorName);
      })
      .slice(0, 10)
      .map((e) => ({
        type: e.eventType,
        description:
          e.description.length > 300
            ? `${e.description.slice(0, 300)}...`
            : e.description,
        timestamp: e.timestamp.toISOString(),
        relatedQuestion: e.relatedQuestion || undefined,
        pointsToward: e.pointsToward || undefined,
      }));
  }

  private async getRecentWorldEvents(
    since: Date,
    now: Date,
  ): Promise<EventContext[]> {
    const events = await db
      .select()
      .from(worldEvents)
      .where(
        and(lte(worldEvents.timestamp, now), gte(worldEvents.timestamp, since)),
      )
      .orderBy(desc(worldEvents.timestamp))
      .limit(20);

    return events.map((e) => ({
      type: e.eventType,
      description:
        e.description.length > 300
          ? `${e.description.slice(0, 300)}...`
          : e.description,
      timestamp: e.timestamp.toISOString(),
      relatedQuestion: e.relatedQuestion || undefined,
      pointsToward: e.pointsToward || undefined,
    }));
  }

  private async getResolvedQuestions(): Promise<
    Array<{ text: string; outcome: string }>
  > {
    const resolved = await db
      .select()
      .from(questions)
      .where(eq(questions.status, "resolved"))
      .orderBy(desc(questions.resolutionDate))
      .limit(10);

    return resolved
      .filter((q) => q.resolvedOutcome != null)
      .map((q) => ({
        text: q.text,
        outcome: q.resolvedOutcome ? "YES" : "NO",
      }));
  }

  private async getRelationships(
    actorId: string,
  ): Promise<RelationshipContext[]> {
    const rels = await db
      .select()
      .from(actorRelationships)
      .where(
        or(
          eq(actorRelationships.actor1Id, actorId),
          eq(actorRelationships.actor2Id, actorId),
        ),
      )
      .limit(10);

    return rels.map((r) => {
      const otherId = r.actor1Id === actorId ? r.actor2Id : r.actor1Id;
      return {
        actorId: otherId,
        actorName: resolveActorName(otherId),
        relationshipType: r.relationshipType || "acquaintance",
        strength: r.strength ?? 0.5,
        sentiment: r.sentiment ?? 0,
        history: r.history || undefined,
      };
    });
  }

  private async getDirectMessages(
    actorId: string,
    since: Date,
  ): Promise<
    Array<{
      from: string;
      fromName: string;
      content: string;
      timestamp: string;
    }>
  > {
    try {
      // Single query: JOIN chatParticipants -> chats -> messages
      // to find recent DM messages for this actor
      const recentDMs = await db
        .select({
          senderId: messages.senderId,
          content: messages.content,
          createdAt: messages.createdAt,
        })
        .from(chatParticipants)
        .innerJoin(
          chats,
          and(eq(chats.id, chatParticipants.chatId), eq(chats.isGroup, false)),
        )
        .innerJoin(
          messages,
          and(eq(messages.chatId, chats.id), gte(messages.createdAt, since)),
        )
        .where(eq(chatParticipants.userId, actorId))
        .orderBy(desc(messages.createdAt))
        .limit(10);

      return recentDMs
        .filter((m) => m.senderId !== actorId)
        .map((m) => ({
          from: m.senderId,
          fromName: resolveActorName(m.senderId),
          content:
            m.content.length > 300
              ? `${m.content.slice(0, 300)}...`
              : m.content,
          timestamp: m.createdAt.toISOString(),
        }));
    } catch (err) {
      logger.warn(
        "Failed to fetch DMs",
        { actorId, error: err instanceof Error ? err.message : String(err) },
        "ActorContextBuilder",
      );
      return [];
    }
  }

  private async getMemories(actorId: string): Promise<string> {
    const memories = await this.memoryService.getRecentMemories(actorId, 8);
    return this.memoryService.formatMemoriesForPrompt(memories);
  }

  /**
   * Format an ActorContext into a compact string for LLM prompts.
   * Puts identity first, then awareness, then relationships.
   */
  formatForPrompt(ctx: ActorContext): string {
    const sections: string[] = [];

    // Identity (dominant section)
    sections.push(`PERSONALITY: ${ctx.identity.personality}`);
    if (ctx.identity.voice) sections.push(`VOICE: ${ctx.identity.voice}`);
    if (ctx.identity.description)
      sections.push(`IDENTITY: ${ctx.identity.description}`);
    if (ctx.identity.postStyle)
      sections.push(`WRITING STYLE: ${ctx.identity.postStyle}`);
    sections.push(`DOMAINS: ${ctx.identity.domains.join(", ")}`);
    sections.push(`AFFILIATIONS: ${ctx.identity.affiliations.join(", ")}`);

    // Post examples (critical for voice matching)
    const examples = ctx.identity.postExamples
      .sort(() => Math.random() - 0.5)
      .slice(0, 6);
    if (examples.length > 0) {
      sections.push(
        `\nEXAMPLE POSTS (MATCH THIS STYLE):\n${examples.map((e, i) => `  ${i + 1}. "${e}"`).join("\n")}`,
      );
    }

    // Actor behavioral rules (from pack data)
    const behaviorRules: string[] = [];
    if (ctx.actorRules.stylePost.length > 0) {
      behaviorRules.push(...ctx.actorRules.stylePost);
    }
    if (ctx.actorRules.motivations.length > 0) {
      behaviorRules.push(
        `Motivated by: ${ctx.actorRules.motivations.join(", ")}`,
      );
    }
    if (ctx.actorRules.fears.length > 0) {
      behaviorRules.push(`Fears: ${ctx.actorRules.fears.join(", ")}`);
    }
    if (ctx.actorRules.tradingStyle) {
      behaviorRules.push(`Trading style: ${ctx.actorRules.tradingStyle}`);
    }
    if (behaviorRules.length > 0) {
      sections.push(
        `\nBEHAVIOR:\n${behaviorRules.map((r) => `- ${r}`).join("\n")}`,
      );
    }

    // Relationships
    if (ctx.relationships.length > 0) {
      const rels = ctx.relationships
        .map((r) => {
          const label =
            r.sentiment > 0.3
              ? "ally"
              : r.sentiment < -0.3
                ? "rival"
                : "acquaintance";
          return `${label}: ${r.actorName}`;
        })
        .join(", ");
      sections.push(`\nRELATIONSHIPS: ${rels}`);
    }

    // Awareness
    if (ctx.awareness.worldEvents.length > 0) {
      const events = ctx.awareness.worldEvents
        .slice(0, 5)
        .map((e) => `- [${e.type}] ${e.description}`)
        .join("\n");
      sections.push(`\nRECENT EVENTS:\n${events}`);
    }

    if (ctx.awareness.recentPosts.length > 0) {
      const posts = ctx.awareness.recentPosts
        .slice(0, 5)
        .map((p) => `- ${p.authorName}: "${p.content.substring(0, 100)}"`)
        .join("\n");
      sections.push(`\nRECENT POSTS:\n${posts}`);
    }

    if (ctx.awareness.resolvedQuestions.length > 0) {
      const qs = ctx.awareness.resolvedQuestions
        .map((q) => `- "${q.text}" → ${q.outcome}`)
        .join("\n");
      sections.push(`\nRESOLVED MARKETS:\n${qs}`);
    }

    // DMs
    if (ctx.awareness.directMessages.length > 0) {
      const dms = ctx.awareness.directMessages
        .slice(0, 3)
        .map((d) => `- ${d.fromName}: "${d.content.substring(0, 100)}"`)
        .join("\n");
      sections.push(`\nRECENT DMs:\n${dms}`);
    }

    // Headlines (what the actor has been reading)
    if (ctx.awareness.headlines.length > 0) {
      const headlines = ctx.awareness.headlines
        .slice(0, 5)
        .map((h) => `- ${h.title}`)
        .join("\n");
      sections.push(`\nIN THE NEWS:\n${headlines}`);
    }

    // State
    if (ctx.state.memories) sections.push(`\n${ctx.state.memories}`);

    return sections.join("\n");
  }
}

export const actorContextBuilder = new ActorContextBuilder();
