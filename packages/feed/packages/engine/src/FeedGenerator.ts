/**
 * Social feed generator for game events.
 * Transforms world events into social media posts with LLM-powered content.
 *
 * Uses PER-CHARACTER generation for all NPC posts to ensure:
 * - Full character context (bios, post styles, examples, trending topics, current events)
 * - Unique, in-character voice matching
 * - Entropy/variety through randomized context presentation
 * - Rate-limited parallel execution for efficiency
 *
 * All character posts are generated individually with full context, not batched.
 * This ensures each post matches the character's unique voice and style.
 */

import type { WorldEvent } from '@feed/shared';
import { ContentValidator, type JsonValue, logger } from '@feed/shared';
import { EventEmitter } from 'events';
import { generateActorContext } from './EmotionSystem';
import type { FeedLLMClient } from './llm/openai-client';
import {
  ambientPosts,
  analystReaction,
  buildFilteredWorldContext,
  CHARACTER_LIMITS,
  commentary,
  companyPost,
  conspiracy,
  dayTransition,
  generateWorldContext,
  getPromptParams,
  getTimeOfDayEnergy,
  governmentPost,
  minuteAmbient,
  newsPosts,
  organicPost,
  priceAnnouncement,
  questionResolvedFeed,
  reactions,
  renderPrompt,
  replies,
  reply,
  socialPost,
  stockTicker,
  validateFeedPost,
  type WorldContext,
} from './prompts';
import { RelationshipEvolutionEngine } from './RelationshipEvolutionEngine';
import { actorContextBuilder } from './services/actor-context-builder';
import { characterMappingService } from './services/character-mapping-service';
import { getAvoidedPatternsContext } from './services/npc-anti-repetition-service';
import { getCharacterConfigOrDefault } from './services/npc-character-config';
import {
  getDomainContext,
  getDomainHints,
  type PostIntent,
  selectPostIntent,
} from './services/post-intent-service';
import { StaticDataRegistry } from './services/static-data-registry';
import type { TrendingTopicsEngine } from './TrendingTopicsEngine';
import type {
  Actor,
  ActorConnection,
  ActorRelationship,
  ActorState,
  FeedEvent,
  FeedPost,
  Organization,
  PriceUpdate,
  Question,
} from './types/shared';
import {
  buildComprehensiveNPCContext,
  type ComprehensiveNPCContext,
  formatComprehensiveContext,
} from './utils/context-builder';
import { shuffleArray } from './utils/randomization';
import {
  buildCharacterFeedContext,
  buildPhaseContext,
  formatActorFinanceGuardrails,
  formatActorToneGuardrails,
  formatActorVoiceContext,
  formatCharacterInfoWithEntropy,
  getPhaseForDay,
  rateLimitedParallel,
} from './utils/shared-utils';

// Re-export types for backwards compatibility with external consumers
export type {
  Actor,
  ActorRelationship,
  ActorState,
  FeedEvent,
  FeedPost,
  Organization,
};

/**
 * Commentary post from LLM
 */
interface CommentaryPost {
  post?: string;
  tweet?: string;
  content?: string;
  sentiment?: number;
  clueStrength?: number;
  pointsToward?: boolean | null;
}

/**
 * Conspiracy post from LLM
 */
interface ConspiracyPost {
  post?: string;
  tweet?: string;
  content?: string;
  sentiment?: number;
  clueStrength?: number;
  pointsToward?: boolean | null;
}

/**
 * Conspiracy response format 1: Direct array
 */
interface ConspiracyResponseFormat1 {
  conspiracy: ConspiracyPost[];
}

/**
 * Conspiracy response format 2: Wrapped in data array
 */
interface ConspiracyResponseFormat2 {
  data: Array<{ conspiracy: ConspiracyPost[] }>;
}

/**
 * Conspiracy response union type
 */
type ConspiracyResponse = ConspiracyResponseFormat1 | ConspiracyResponseFormat2;

/** Generates social media posts from world events using LLM-powered content. */
export class FeedGenerator extends EventEmitter {
  private llm?: FeedLLMClient;
  private actorStates: Map<string, ActorState> = new Map();
  private relationships: ActorRelationship[] | ActorConnection[] = [];
  private relationshipContextCache: Map<string, string> = new Map(); // Cache relationship prompts
  private organizations: Organization[] = [];
  private actorGroupContexts: Map<string, string> = new Map();
  private worldContext: WorldContext | null = null;
  private _npcPersonas: Map<
    string,
    {
      reliability: number;
      insiderOrgs: string[];
      willingToLie: boolean;
      selfInterest: string;
    }
  > = new Map();
  private trendingTopics?: TrendingTopicsEngine;
  private trendContext = '';

  // Comprehensive context storage for rich NPC context
  private _allPreviousEvents: WorldEvent[] = [];
  private _allPreviousPosts: FeedPost[] = [];
  private _questions: Question[] = [];

  private static readonly EMOJI_REGEX =
    /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F900}-\u{1F9FF}\u{1FA70}-\u{1FAFF}]/gu;

  /** Strips hashtags/emojis, normalizes whitespace, replaces real names with parody names. */
  private async postProcessContent(content: string): Promise<string> {
    // Guard against undefined/null content from malformed LLM responses
    if (!content || typeof content !== 'string') {
      logger.warn(
        'postProcessContent received invalid content, returning fallback',
        { contentType: typeof content, content },
        'FeedGenerator'
      );
      return 'No comment.';
    }

    let processed = content;

    // 1. Strip hashtags (LLMs love to add them despite instructions)
    const hashtagMatches = processed.match(/#\w+/g);
    if (hashtagMatches && hashtagMatches.length > 0) {
      logger.debug(
        `Stripping ${hashtagMatches.length} hashtag(s) from content`,
        { hashtags: hashtagMatches.join(', ') },
        'FeedGenerator'
      );
      processed = processed.replace(/#\w+/g, '');
    }

    // 2. Strip emojis
    const emojiMatches = processed.match(FeedGenerator.EMOJI_REGEX);
    if (emojiMatches && emojiMatches.length > 0) {
      logger.debug(
        `Stripping ${emojiMatches.length} emoji(s) from content`,
        { emojis: emojiMatches.join('') },
        'FeedGenerator'
      );
      processed = processed.replace(FeedGenerator.EMOJI_REGEX, '');
    }

    // 3. Normalize whitespace (multiple spaces → single space)
    processed = processed.replace(/\s+/g, ' ').trim();

    // 4. Replace real names with parody names (existing functionality)
    const transformed = await characterMappingService.transformText(processed);
    if (transformed.replacementCount > 0) {
      logger.warn(
        `Fixed ${transformed.replacementCount} real name(s) in generated content`,
        {
          original: content.substring(0, 100),
          fixed: transformed.transformedText.substring(0, 100),
        },
        'FeedGenerator'
      );
    }

    return transformed.transformedText;
  }

  private validatePostContent(
    content: string,
    postType: keyof typeof CHARACTER_LIMITS
  ): { isValid: boolean; cleanContent: string; violations: string[] } {
    const result = validateFeedPost(content, {
      maxLength: CHARACTER_LIMITS[postType],
      postType,
    });

    if (!result.isValid) {
      logger.warn('Post validation failed', {
        violations: result.violations,
        postType,
        contentPreview: content.substring(0, 100),
      });
    }

    return {
      isValid: result.isValid,
      cleanContent: content,
      violations: result.violations,
    };
  }

  /**
   * Create a new FeedGenerator
   *
   * @param llm - Optional LLM client for content generation
   *
   * @description
   * If LLM is not provided, generation methods will return empty arrays or throw.
   * In production, always provide an LLM client.
   */
  constructor(llm?: FeedLLMClient) {
    super();
    this.llm = llm;
  }

  /**
   * Set trending topics engine
   *
   * @param engine - TrendingTopicsEngine instance
   *
   * @description
   * Sets the trending topics engine for accessing current trends in feed generation.
   * Trends are added to actor context automatically.
   *
   * @usage
   * Called once by GameEngine during initialization.
   *
   * @example
   * ```typescript
   * const trends = new TrendingTopicsEngine(llm);
   * feed.setTrendingTopics(trends);
   * ```
   */
  setTrendingTopics(engine: TrendingTopicsEngine) {
    this.trendingTopics = engine;
  }

  /**
   * Update trend context (call before feed generation)
   *
   * @description
   * Fetches current trending topics and updates internal context string.
   * This context is automatically added to all actor prompts.
   *
   * @usage
   * Called by GameEngine before each tick's feed generation.
   *
   * @throws Never throws - returns safe default if trending engine not set
   */
  updateTrendContext() {
    if (!this.trendingTopics) {
      // Safe default - compact format
      this.trendContext = 'TRENDING TOPICS: (not initialized)';
      return;
    }

    const context = this.trendingTopics.getDetailedTrendContext();

    // Validate context is never empty
    if (!context || context.trim().length === 0) {
      throw new Error(
        'TrendingTopicsEngine returned empty context - this should never happen'
      );
    }

    this.trendContext = context;
  }

  /**
   * Set actor group chat contexts
   *
   * @param contexts - Map of actorId to group chat context string
   *
   * @description
   * Group chat context includes all groups the actor is in plus recent messages.
   * This context influences their public posts (e.g., "my sources say...").
   *
   * @usage
   * Called by GameEngine before each feed generation.
   *
   * @example
   * ```typescript
   * const contexts = new Map([
   *   ['actor-1', 'Member of: Tech Insiders, Wall Street Pros\nRecent: "Merger looking good"'],
   *   ['actor-2', 'Member of: Political Circle\nRecent: "Investigation ongoing"']
   * ]);
   * feed.setActorGroupContexts(contexts);
   * ```
   */
  setActorGroupContexts(contexts: Map<string, string>) {
    this.actorGroupContexts = contexts;
  }

  /**
   * Set organizations for this game
   *
   * @param organizations - Array of all game organizations
   *
   * @description
   * Organizations include media companies, tech companies, government agencies, etc.
   * Used for generating company responses and determining affiliations.
   *
   * @usage
   * Called once during GameEngine initialization.
   */
  setOrganizations(organizations: Organization[]) {
    this.organizations = organizations || [];
  }

  /**
   * Set NPC personas for consistent behavior
   *
   * @param personas - Map of actorId to persona assignment
   *
   * @description
   * NPC personas define reliability, insider knowledge, and deception tendencies.
   * Used to create consistent behavior patterns that agents can learn.
   *
   * **Persona Effects:**
   * - High reliability NPCs are more accurate in their posts
   * - Insiders have access to non-public information
   * - Deceivers will lie strategically for self-interest
   * - Biases influence post tone and sentiment
   *
   * @usage
   * Called once during GameGenerator initialization.
   *
   * @example
   * ```typescript
   * const personas = personaGenerator.assignPersonas(actors, orgs);
   * feed.setNPCPersonas(personas);
   * ```
   */
  setNPCPersonas(
    personas: Map<
      string,
      {
        reliability: number;
        insiderOrgs: string[];
        willingToLie: boolean;
        selfInterest: string;
      }
    >
  ) {
    this._npcPersonas = personas;
  }

  /**
   * Set actor emotional states for current day
   *
   * @param states - Map of actorId to emotional state (mood, luck)
   *
   * @description
   * Actor states are updated daily based on events and trading outcomes.
   * These states influence post tone, sentiment, and content.
   *
   * @usage
   * Called by GameEngine each day before feed generation.
   *
   * @example
   * ```typescript
   * const states = new Map([
   *   ['actor-1', { mood: 0.8, luck: 'high' }],
   *   ['actor-2', { mood: -0.5, luck: 'low' }]
   * ]);
   * feed.setActorStates(states);
   * ```
   */
  setActorStates(states: Map<string, ActorState>) {
    this.actorStates = states;
  }

  /**
   * Set relationships between actors
   *
   * @param relationships - Array of actor relationships (supports both formats)
   *
   * @description
   * Relationships affect how actors reference each other in posts and reactions.
   * Supports both ActorRelationship (new) and deprecated ActorConnection formats
   * for backward compatibility.
   *
   * **Relationship Effects:**
   * - Rivals: Critical, competitive posts
   * - Allies: Supportive, collaborative posts
   * - Neutral: Objective, balanced posts
   *
   * @usage
   * Called once during GameEngine initialization and updated as relationships evolve.
   */
  setRelationships(relationships: ActorRelationship[] | ActorConnection[]) {
    this.relationships = relationships;
    // Clear cache when relationships are updated
    this.relationshipContextCache.clear();
  }

  /**
   * Get relationship context from database for an actor (cached and efficient)
   * Returns simple text list for direct prompt injection
   */
  async getActorRelationships(actorId: string): Promise<string> {
    // Check cache first (efficient - no database query)
    if (this.relationshipContextCache.has(actorId)) {
      return this.relationshipContextCache.get(actorId)!;
    }

    // Fetch from database (only if not cached)
    const engine = new RelationshipEvolutionEngine();
    const context = await engine.getRelationshipContextForActor(actorId);

    // Cache it (subsequent calls are instant)
    this.relationshipContextCache.set(actorId, context);

    return context;
  }

  /**
   * Build rich character context for an actor with all available data
   *
   * Includes: identity, personality, voice, relationships, positions,
   * emotional state, track record, motivations, social dynamics.
   * Used by all per-character generation methods for consistent context.
   */
  private async buildRichCharacterContext(
    actor: Actor,
    day: number,
    _currentEvents: WorldEvent[] = []
  ): Promise<{
    characterInfo: string;
    comprehensiveContext: ComprehensiveNPCContext;
  }> {
    const state = this.actorStates.get(actor.id);
    const emotionalContext = state
      ? generateActorContext(
          state.mood,
          state.luck,
          undefined,
          this.relationships,
          actor.id
        )
      : '';

    const persona = this._npcPersonas.get(actor.id);

    const comprehensiveContext = await buildComprehensiveNPCContext(
      actor,
      day,
      this._allPreviousEvents,
      this._allPreviousPosts,
      this._questions
    );

    // Format relationship context string for character info
    const relationshipContextStr =
      comprehensiveContext.relationships
        ?.map(
          (r) =>
            `${r.strength} ${r.type} with ${r.otherActorName} (${r.sentiment})${r.history ? ` - ${r.history}` : ''}`
        )
        .join('\n') || '';

    // Format position context string for character info
    const positionsContextStr =
      comprehensiveContext.marketPositions
        ?.map(
          (p) =>
            `${p.market}: ${p.side}${p.pnl !== undefined ? ` (${p.pnl >= 0 ? '+' : ''}${p.pnl.toFixed(2)})` : ''}`
        )
        .join('\n') || '';

    // Format character info with ALL available actor data
    const actorPersona = actor.persona || (persona as typeof actor.persona);
    const characterInfo = formatCharacterInfoWithEntropy({
      name: actor.name,
      description: actor.description || undefined,
      profileDescription: actor.profileDescription || undefined,
      domain: actor.domain || undefined,
      postStyle: actor.postStyle || undefined,
      postExample: actor.postExample || undefined,
      voice: actor.voice || undefined,
      personality: actor.personality || undefined,
      affiliations: actor.affiliations || undefined,
      tier: actor.tier || undefined,
      persona: actorPersona
        ? {
            reliability: actorPersona.reliability,
            expertise: actorPersona.expertise,
            willingToLie: actorPersona.willingToLie,
            selfInterest: actorPersona.selfInterest,
            favorsActors: actorPersona.favorsActors,
            opposesActors: actorPersona.opposesActors,
            favorsOrgs: actorPersona.favorsOrgs,
            opposesOrgs: actorPersona.opposesOrgs,
          }
        : persona
          ? {
              reliability: persona.reliability,
              expertise: (persona as { expertise?: string[] }).expertise,
            }
          : undefined,
      emotionalContext: emotionalContext || undefined,
      trackRecord: actor.trackRecord || undefined,
      relationshipContext: relationshipContextStr || undefined,
      currentPositions: positionsContextStr || undefined,
    });

    return { characterInfo, comprehensiveContext };
  }

  /**
   * Generate complete feed for a game day
   *
   * @param day - Game day number (1-30)
   * @param worldEvents - Events that occurred this day
   * @param allActors - All game actors
   * @returns Array of feed posts sorted chronologically
   *
   * @description
   * Generates a full day's worth of social media activity by creating cascading
   * reactions to world events. Simulates realistic information flow where events
   * trigger media coverage, reactions, analysis, and discussions.
   *
   * **Information Cascade (Like Real Social Media):**
   * 1. **Event Occurs** - WorldEvent happens (players never see directly)
   * 2. **Media Breaks Story** - Journalists and news orgs report
   * 3. **Involved Parties React** - Defensive if bad, celebratory if good
   * 4. **Companies Respond** - PR statements from affiliated orgs
   * 5. **Experts Analyze** - Outside commentators weigh in
   * 6. **Conspiracy Theories** - Contrarians spin wild narratives
   * 7. **Threads Develop** - Replies and conversations emerge
   * 8. **Ambient Noise** - Unrelated posts throughout the day
   *
   * **Generation Process:**
   * - For each event: Generate full cascade (2-4 batched LLM calls)
   * - Add ambient posts for each hour (24 batched LLM calls)
   * - Generate replies to 30-50% of posts (batched)
   * - Sort by timestamp for chronological feed
   *
   * **Batching Optimization:**
   * - Event cascade: 4-5 LLM calls (vs 10-15 individual)
   * - Ambient: 24 calls (vs 200+ individual)
   * - Total: ~200 calls per game (vs 2000+)
   * - 90% cost reduction, same quality
   *
   * **Content Quality:**
   * - 100% LLM-generated (no templates)
   * - Per-actor context preserved in batches
   * - Mood, luck, relationships affect content
   * - Group chat insights reflected in posts
   *
   * **Outcome Parameter:**
   * Used for narrative coherence and atmospheric context, not for determining
   * event truthfulness (events have their own pointsToward values).
   *
   * @example
   * ```typescript
   * const posts = await feed.generateDayFeed(
   *   15, // Day 15
   *   [event1, event2, event3], // World events
   *   allActors,
   *   true // Outcome is YES (for narrative coherence)
   * );
   *
   * console.log(`Generated ${posts.length} posts for Day 15`);
   *
   * // Posts are sorted chronologically
   * posts.forEach(post => {
   *   console.log(`${post.timestamp}: @${post.authorName} - ${post.content}`);
   * });
   * ```
   */
  async generateDayFeed(
    day: number,
    worldEvents: WorldEvent[],
    allActors: Actor[],
    options?: {
      allPreviousEvents?: WorldEvent[];
      allPreviousPosts?: FeedPost[];
      questions?: Question[];
    }
  ): Promise<FeedPost[]> {
    // Validate inputs using canonical validator (fail-fast)
    ContentValidator.validateDayNumber(day, 'generateDayFeed');
    ContentValidator.validateNotEmpty(
      allActors,
      'allActors in generateDayFeed'
    );

    const feed: FeedPost[] = [];

    // Generate world context once per day for all prompts
    this.worldContext = await generateWorldContext({ maxActors: 50 });

    // Store context for per-character generation
    this._allPreviousEvents = options?.allPreviousEvents || [];
    this._allPreviousPosts = options?.allPreviousPosts || [];
    this._questions = options?.questions || [];

    // Derive outcome from events for narrative coherence (not from parameter)
    // Uses majority of event hints to determine overall direction
    const yesEvents = worldEvents.filter(
      (e) => e.pointsToward === 'YES'
    ).length;
    const noEvents = worldEvents.filter((e) => e.pointsToward === 'NO').length;
    const derivedOutcome = yesEvents > noEvents;

    // For each world event, generate cascading reactions
    for (let eventIndex = 0; eventIndex < worldEvents.length; eventIndex++) {
      const worldEvent = worldEvents[eventIndex];
      if (!worldEvent) continue; // Skip if event doesn't exist
      const eventFeed = await this.generateEventCascade(
        day,
        worldEvent,
        allActors,
        derivedOutcome,
        eventIndex
      );
      feed.push(...eventFeed);
    }

    // Add some standalone commentary unrelated to specific events
    const ambientNoise = await this.generateAmbientFeed(
      day,
      allActors,
      derivedOutcome
    );
    feed.push(...ambientNoise);

    // Generate replies (30-50% of existing posts get replies)
    const replies = await this.generateReplies(day, feed, allActors);
    feed.push(...replies);

    // Generate reposts (10-20% of existing posts get reposted)
    const reposts = await this.generateReposts(day, feed, allActors);
    feed.push(...reposts);

    // Sort by timestamp for realistic feed flow
    const sortedFeed = feed.sort((a, b) =>
      a.timestamp.localeCompare(b.timestamp)
    );

    // Clear world context after generation
    this.worldContext = null;

    return sortedFeed;
  }

  /**
   * Generate cascading feed posts for a single world event
   * Information cascade: News Break → Direct Reactions → Analysis → Conspiracy → Threads
   * OPTIMIZED: Uses batched LLM calls (10-15 calls → 4-5 calls per event)
   */
  private async generateEventCascade(
    day: number,
    worldEvent: WorldEvent,
    allActors: Actor[],
    outcome: boolean,
    eventIndex = 0
  ): Promise<FeedPost[]> {
    const cascade: FeedPost[] = [];
    const baseTime = `2025-10-${String(day).padStart(2, '0')}T`;
    // Offset hours based on event index so each event's posts are at different times
    const baseHourOffset = eventIndex * 4; // Events spaced 4 hours apart

    // 1. MEDIA ORGANIZATIONS BREAK THE STORY (if public event) - BATCHED
    if (
      worldEvent.visibility === 'public' ||
      worldEvent.visibility === 'leaked'
    ) {
      const mediaOrgs = this.organizations
        .filter((o) => o.type === 'media')
        .slice(0, 2);
      const journalists = allActors
        .filter(
          (a) => a.domain?.includes('media') || a.domain?.includes('journalism')
        )
        .slice(0, 1);

      // ✅ BATCH: All media + journalists in ONE call
      const allMediaActors = [...mediaOrgs, ...journalists];
      if (allMediaActors.length > 0) {
        const mediaPosts = await this.generateMediaPostsBatch(
          allMediaActors,
          worldEvent,
          allActors,
          outcome
        );

        mediaPosts.forEach((post, i) => {
          const isOrg = i < mediaOrgs.length;
          const entity = isOrg
            ? mediaOrgs[i]
            : journalists[i - mediaOrgs.length];
          if (!entity) return; // Skip if entity doesn't exist

          // Fail-fast: Validate required fields using canonical validator
          ContentValidator.validatePostContent(
            post.post,
            `media post from ${entity.name}`
          );
          ContentValidator.validateEntityName(entity.name, `media entity ${i}`);

          cascade.push({
            id: `${worldEvent.id}-${isOrg ? 'media' : 'news'}-${i}`,
            day,
            timestamp: `${baseTime}${String((9 + baseHourOffset + i * 2) % 24).padStart(2, '0')}:${String(Math.floor(Math.random() * 60)).padStart(2, '0')}:00Z`,
            type: 'news',
            content: post.post,
            author: entity.id,
            authorName: entity.name,
            relatedEvent: worldEvent.id,
            sentiment: post.sentiment ?? 0,
            clueStrength: post.clueStrength ?? 0,
            pointsToward: post.pointsToward ?? null,
          });
        });
      }
    }

    // 2. INVOLVED PARTIES REACT - BATCHED
    const involvedActors = worldEvent.actors
      .map((id) => allActors.find((a) => a.id === id))
      .filter((a): a is Actor => a !== undefined);

    if (involvedActors.length > 0) {
      // ✅ PER-CHARACTER: Generate reactions individually with full context
      const reactionTasks = shuffleArray(involvedActors).map(
        (actor) => async () => {
          const result = await this.generateReactionForCharacter(
            actor,
            worldEvent,
            outcome,
            day
          );
          return result;
        }
      );

      const reactionResults = await rateLimitedParallel(reactionTasks, 5, 100);
      const reactions = reactionResults.filter(
        (r): r is NonNullable<typeof r> => r !== null
      );

      // Collect companies that need to respond
      const companiesToRespond: Array<{
        company: Organization;
        actor: Actor;
        index: number;
      }> = [];

      reactions.forEach((reaction, i) => {
        const actor = involvedActors[i];
        if (!actor) return; // Skip if actor doesn't exist

        cascade.push({
          id: `${worldEvent.id}-reaction-${actor.id}`,
          day,
          timestamp: `${baseTime}${String((12 + baseHourOffset + i * 3) % 24).padStart(2, '0')}:${String(Math.floor(Math.random() * 60)).padStart(2, '0')}:00Z`,
          type: 'reaction',
          content: reaction.post,
          author: actor.id,
          authorName: actor.name,
          relatedEvent: worldEvent.id,
          sentiment: reaction.sentiment,
          clueStrength: reaction.clueStrength,
          pointsToward: reaction.pointsToward,
        });

        // Collect company affiliations for batch processing
        if (actor.affiliations) {
          const affiliatedCompanies = this.organizations
            .filter(
              (o) => o.type === 'company' && actor.affiliations?.includes(o.id)
            )
            .slice(0, 1); // Usually just one company responds per actor

          affiliatedCompanies.forEach((company) => {
            companiesToRespond.push({ company, actor, index: i });
          });
        }
      });

      // Process company responses (usually 0-2 per event, so batching would be minimal gain)
      // Using sequential processing to maintain proper async/await
      for (const { company, actor, index: i } of companiesToRespond) {
        const companyPost = await this.generateCompanyPost(
          company,
          worldEvent,
          actor,
          outcome
        );

        cascade.push({
          id: `${worldEvent.id}-company-${company.id}`,
          day,
          timestamp: `${baseTime}${String((13 + baseHourOffset + i * 3) % 24).padStart(2, '0')}:${String(Math.floor(Math.random() * 60)).padStart(2, '0')}:00Z`,
          type: 'reaction',
          content: companyPost.post,
          author: company.id,
          authorName: company.name,
          relatedEvent: worldEvent.id,
          sentiment: companyPost.sentiment,
          clueStrength: companyPost.clueStrength,
          pointsToward: companyPost.pointsToward,
        });
      }
    }

    // 2b. GOVERNMENT RESPONSES (if applicable) - Single call, usually 0-1 per event
    if (worldEvent.type === 'scandal' || worldEvent.type === 'revelation') {
      const govOrgs = this.organizations
        .filter((o) => o.type === 'government')
        .slice(0, 1);

      for (const gov of govOrgs) {
        const govPost = await this.generateGovernmentPost(
          gov,
          worldEvent,
          allActors,
          outcome
        );

        cascade.push({
          id: `${worldEvent.id}-govt-${gov.id}`,
          day,
          timestamp: `${baseTime}${String((15 + baseHourOffset) % 24).padStart(2, '0')}:${String(Math.floor(Math.random() * 60)).padStart(2, '0')}:00Z`,
          type: 'reaction',
          content: govPost.post,
          author: gov.id,
          authorName: gov.name,
          relatedEvent: worldEvent.id,
          sentiment: govPost.sentiment,
          clueStrength: govPost.clueStrength,
          pointsToward: govPost.pointsToward,
        });
      }
    }

    // 3. EXPERTS AND COMMENTATORS - BATCHED
    const commentators = allActors
      .filter(
        (a) =>
          !worldEvent.actors.includes(a.id) && // Not directly involved
          (a.domain?.includes('tech') ||
            a.domain?.includes('policy') ||
            a.role === 'supporting')
      )
      .slice(0, 2);

    if (commentators.length > 0) {
      // ✅ PER-CHARACTER: Generate commentary individually for full context
      const commentaryPromises = commentators.map(async (commentator, i) => {
        const result = await this.generateCommentaryForCharacter(
          commentator,
          worldEvent,
          day
        );
        if (!result) return null;

        return {
          id: `${worldEvent.id}-expert-${i}`,
          day,
          timestamp: `${baseTime}${String((14 + baseHourOffset + i * 2) % 24).padStart(2, '0')}:${String(Math.floor(Math.random() * 60)).padStart(2, '0')}:00Z`,
          type: 'reaction' as const,
          content: result.post,
          author: commentator.id,
          authorName: commentator.name,
          relatedEvent: worldEvent.id,
          sentiment: result.sentiment,
          clueStrength: result.clueStrength,
          pointsToward: result.pointsToward,
        };
      });

      const commentaryResults = await Promise.all(commentaryPromises);
      commentaryResults.forEach((result) => {
        if (result) {
          cascade.push(result);
        }
      });
    }

    // 4. CONSPIRACISTS AND CONTRARIANS - BATCHED
    const conspiracists = allActors
      .filter(
        (a) =>
          a.personality?.includes('contrarian') ||
          a.personality?.includes('paranoid') ||
          a.description?.toLowerCase().includes('conspiracy')
      )
      .slice(0, 1 + Math.floor(Math.random() * 2)); // 1-2 conspiracy posts

    if (conspiracists.length > 0) {
      // ✅ PER-CHARACTER: Generate conspiracy posts individually with full context
      const conspiracyTasks = shuffleArray(conspiracists).map(
        (conspiracist) => async () => {
          const result = await this.generateConspiracyForCharacter(
            conspiracist,
            worldEvent,
            day
          );
          return result;
        }
      );

      const conspiracyResults = await rateLimitedParallel(
        conspiracyTasks,
        5,
        100
      );
      const conspiracyPosts = conspiracyResults.filter(
        (c): c is NonNullable<typeof c> => c !== null
      );

      conspiracyPosts.forEach((post, i) => {
        const actor = conspiracists[i % conspiracists.length];
        if (actor) {
          cascade.push({
            id: `${worldEvent.id}-conspiracy-${i}`,
            day,
            timestamp: `${baseTime}${String((16 + baseHourOffset + i * 3) % 24).padStart(2, '0')}:${String(Math.floor(Math.random() * 60)).padStart(2, '0')}:00Z`,
            type: 'reaction',
            content: post.post,
            author: actor.id,
            authorName: actor.name,
            relatedEvent: worldEvent.id,
            sentiment: post.sentiment,
            clueStrength: post.clueStrength,
            pointsToward: post.pointsToward,
          });
        }
      });
    }

    // 5. THREAD DEVELOPMENT - BATCHED
    if (cascade.length >= 2) {
      const thread = await this.generateThread(day, cascade, allActors);
      cascade.push(...thread);
    }

    return cascade;
  }

  /**
   * BATCHED: Generate media posts for multiple organizations/journalists in ONE call
   * Reduces N calls → 1 call
   *
   * @description
   * Generates media posts WITHOUT knowing predetermined outcome.
   * Uses event hints for framing.
   */
  private async generateMediaPostsBatch(
    mediaEntities: (Organization | Actor)[],
    worldEvent: WorldEvent,
    allActors: Actor[],
    outcome: boolean
  ): Promise<
    Array<{
      post: string;
      sentiment: number;
      clueStrength: number;
      pointsToward: boolean | null;
    }>
  > {
    if (!this.llm || mediaEntities.length === 0) {
      return [];
    }

    const potentialSource = allActors.find((a) =>
      worldEvent.actors.includes(a.id)
    );

    // Format variables for prompt template
    const sourceContext = potentialSource
      ? `Sources close to ${potentialSource.name} leaked information.`
      : '';

    // Frame based on event hint, enhanced with outcome knowledge for subtle guidance
    const baseFrame =
      worldEvent.pointsToward === 'YES'
        ? 'Frame with positive spin on this development'
        : worldEvent.pointsToward === 'NO'
          ? 'Emphasize problems and concerns'
          : 'Report objectively - implications unclear';

    // Use outcome to add subtle directional guidance without being explicit
    const outcomeFrame = outcome
      ? `${baseFrame}. The underlying trend suggests positive momentum, but report objectively without stating conclusions.`
      : `${baseFrame}. The underlying trend suggests challenges ahead, but report objectively without stating conclusions.`;

    const mediaList = mediaEntities
      .map((entity, i) => {
        const isOrg = 'type' in entity && entity.type === 'media';
        const voiceContext = formatActorVoiceContext(entity);
        let emotionalContext = '';
        let personaContext = '';

        if (!isOrg && 'id' in entity) {
          const state = this.actorStates.get(entity.id);
          emotionalContext = state
            ? generateActorContext(
                state.mood,
                state.luck,
                undefined,
                this.relationships,
                entity.id
              )
            : '';

          const persona = this._npcPersonas.get(entity.id);
          if (persona) {
            personaContext = `Reliability: ${(persona.reliability * 100).toFixed(0)}%`;
            if (persona.insiderOrgs.length > 0) {
              personaContext += ` | Insider at: ${persona.insiderOrgs.join(', ')}`;
            }
          }
        }

        const roleStyle = isOrg
          ? 'Role: Media organization - can use "Breaking:", "Exclusive:", "Sources say:"'
          : 'Role: Journalist - objective reporting with personal flair';

        return `
╔══════════════════════════════════════════════════════════════════╗
║ MEDIA ${i + 1}: ${entity.name.toUpperCase()}
╚══════════════════════════════════════════════════════════════════╝
   Identity: ${entity.description}
   ${roleStyle}
   ${personaContext ? `${personaContext}` : ''}
   ${emotionalContext ? `${emotionalContext}` : ''}
${voiceContext}

   YOUR TASK: Write a news post AS ${entity.name}.
   RULES: Max 280 chars. Provocative. NO hashtags. NO emojis.
   VOICE: Match the style above. Sound like ${entity.name}.`;
      })
      .join('\n');

    const prompt = renderPrompt(newsPosts, {
      eventDescription:
        worldEvent.description || worldEvent.type || 'Event occurred',
      eventType: worldEvent.type || 'development',
      sourceContext: sourceContext || '',
      outcomeFrame: outcomeFrame || 'Report objectively',
      mediaCount: mediaEntities.length.toString(),
      mediaList: mediaList || '',
      ...(this.worldContext || {}),
    });

    const params = getPromptParams(newsPosts);
    const maxRetries = 5;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const response = await this.llm.generateJSON<{
        posts: Array<{
          post?: string;
          tweet?: string;
          sentiment: number;
          clueStrength: number;
          pointsToward: boolean | null;
        }>;
      }>(
        prompt,
        undefined, // Don't validate schema to handle various response formats
        { ...params, promptType: 'feed_generate_news_posts_batch' }
      );

      if (!response) {
        logger.warn(
          `LLM returned null/undefined media response (attempt ${attempt + 1}/${maxRetries})`,
          undefined,
          'FeedGenerator'
        );
        if (attempt < maxRetries - 1) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          continue;
        }
        return [];
      }

      // Check if response is valid object
      if (typeof response !== 'object' || response === null) {
        logger.warn(
          `LLM returned non-object media response (attempt ${attempt + 1}/${maxRetries})`,
          { type: typeof response },
          'FeedGenerator'
        );
        if (attempt < maxRetries - 1) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          continue;
        }
        return [];
      }

      // Log raw response structure on first attempt for monitoring
      if (attempt === 0) {
        logger.info(
          'Media batch raw response structure',
          {
            hasResponse: !!response,
            hasPosts: 'posts' in response,
            postsType: (response as { posts?: unknown }).posts
              ? typeof (response as { posts?: unknown }).posts
              : 'undefined',
            isArray: Array.isArray((response as { posts?: unknown }).posts),
            sampleKeys: response ? Object.keys(response).slice(0, 5) : [],
          },
          'FeedGenerator'
        );
      }

      // Handle XML nested structure: { posts: [...] } or { posts: { post: [...] } } or { response: { posts: {...} } }
      type PostItem = {
        post?: string;
        tweet?: string;
        content?: string;
        sentiment: number;
        clueStrength: number;
        pointsToward: boolean | null;
      };
      let posts: PostItem[] = [];

      // Check if wrapped in response object first
      const responseData =
        'response' in response &&
        response.response &&
        typeof response.response === 'object'
          ? (response.response as {
              posts?: PostItem[] | { post: PostItem[] | PostItem };
            })
          : response;

      if ('posts' in responseData && responseData.posts) {
        if (Array.isArray(responseData.posts)) {
          posts = responseData.posts;
        } else if (
          typeof responseData.posts === 'object' &&
          'post' in responseData.posts
        ) {
          const nested = responseData.posts.post;
          posts = Array.isArray(nested) ? nested : [nested];
        } else {
          // Log unexpected response structure for monitoring
          logger.warn(
            'Unexpected posts structure',
            {
              type: typeof responseData.posts,
              keys: Object.keys(responseData.posts),
            },
            'FeedGenerator'
          );
        }
      } else {
        logger.warn(
          'Response has no posts field',
          {
            responseKeys: Object.keys(responseData),
            hasResponse: 'response' in response,
          },
          'FeedGenerator'
        );
      }

      // Log post structure for monitoring
      if (attempt === 0 && posts.length > 0) {
        logger.info(
          'Sample post structure',
          {
            postKeys: Object.keys(posts[0] || {}),
            hasPost: 'post' in (posts[0] || {}),
            hasTweet: 'tweet' in (posts[0] || {}),
            postValue: typeof (posts[0] as Record<string, JsonValue>)?.post,
          },
          'FeedGenerator'
        );
      }

      // Type helper for posts that may have different content field names
      type PostWithContent = {
        post?: string;
        tweet?: string;
        content?: string;
        sentiment: number;
        clueStrength: number;
        pointsToward: boolean | null;
      };

      const validPosts = posts
        .filter((p): p is PostWithContent => {
          // Handle various content field names: post, tweet, or content
          const content = p.post || p.tweet || p.content;
          return Boolean(
            content && typeof content === 'string' && content.trim().length > 0
          );
        })
        .map((p) => ({
          post: p.post || p.tweet || p.content!,
          sentiment: p.sentiment ?? 0,
          clueStrength: p.clueStrength ?? 0.5,
          pointsToward: p.pointsToward ?? null,
        }));

      // Apply post-processing (hashtag/emoji stripping, name mapping) and validation
      const processedPosts = await Promise.all(
        validPosts.map(async (p) => {
          const processedPost = await this.postProcessContent(p.post);
          const validation = this.validatePostContent(
            processedPost,
            'JOURNALIST'
          );
          return {
            post: validation.cleanContent,
            sentiment: p.sentiment,
            clueStrength: p.clueStrength,
            pointsToward: p.pointsToward,
            isValid: validation.isValid,
            violations: validation.violations,
          };
        })
      );

      // Check if any posts failed validation
      const invalidPosts = processedPosts.filter((p) => !p.isValid);
      if (invalidPosts.length > 0) {
        const violationCount = invalidPosts.reduce(
          (sum, p) => sum + p.violations.length,
          0
        );
        logger.warn(
          `Validation failed for ${invalidPosts.length} media post(s) (attempt ${attempt + 1}/${maxRetries})`,
          {
            violations: invalidPosts.flatMap((p) => p.violations),
            violationCount,
            attempt: attempt + 1,
          },
          'FeedGenerator'
        );

        // Retry if we haven't exhausted attempts
        if (attempt < maxRetries - 1) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          continue;
        }
      }

      // Filter to only valid posts
      const validProcessedPosts = processedPosts
        .filter((p) => p.isValid)
        .map((p) => ({
          post: p.post,
          sentiment: p.sentiment,
          clueStrength: p.clueStrength,
          pointsToward: p.pointsToward,
        }));

      const minRequired = Math.ceil(mediaEntities.length * 0.5);

      if (validProcessedPosts.length >= minRequired) {
        // Limit to requested count to match with entities
        return validProcessedPosts.slice(0, mediaEntities.length);
      }

      logger.warn(
        `Invalid media batch (attempt ${attempt + 1}/${maxRetries}). Expected ${mediaEntities.length}, got ${validProcessedPosts.length} valid (need ${minRequired}+). Posts array length: ${posts.length}`,
        {
          attempt: attempt + 1,
          maxRetries,
          expected: mediaEntities.length,
          got: validProcessedPosts.length,
          minRequired,
          postsReceived: posts.length,
        },
        'FeedGenerator'
      );
      if (attempt < maxRetries - 1) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }

    throw new Error(
      `Failed to generate media posts batch after ${maxRetries} attempts`
    );
  }

  // NOTE: _generateReactionsBatch was removed (unused dead code)
  // See git history if batch reaction generation is needed in the future

  /**
   * PER-CHARACTER: Generate reaction for a single character with full context
   *
   * @description
   * Generates reaction WITHOUT knowing predetermined outcome.
   * Uses event hints and character bias/mood for framing.
   * Each character gets full context with entropy/variety in presentation.
   */
  private async generateReactionForCharacter(
    actor: Actor,
    worldEvent: WorldEvent,
    outcome: boolean,
    day: number
  ): Promise<{
    post: string;
    sentiment: number;
    clueStrength: number;
    pointsToward: boolean | null;
  } | null> {
    if (!this.llm) {
      return null;
    }

    // Build rich character context with all available data
    const { characterInfo, comprehensiveContext } =
      await this.buildRichCharacterContext(actor, day, [worldEvent]);
    const comprehensiveContextText =
      formatComprehensiveContext(comprehensiveContext);

    // Build full context with trending topics, current events, etc.
    const groupContext = this.actorGroupContexts.get(actor.id) || '';
    const fullCharacterContext = buildCharacterFeedContext({
      characterInfo,
      comprehensiveContext: comprehensiveContextText,
      trendingTopics: this.trendContext,
      currentEvents: worldEvent.description || worldEvent.type || undefined,
      recentPosts: groupContext || undefined,
    });

    // Use event's explicit hint, enhanced with outcome knowledge for subtle guidance
    const baseEventContext = worldEvent.pointsToward
      ? `This development suggests things are trending toward ${worldEvent.pointsToward}.`
      : 'The implications of this development are uncertain. React based on your own perspective and biases.';

    const outcomeContext = outcome
      ? ' The broader context suggests positive momentum, but react based on your own analysis and biases.'
      : ' The broader context suggests challenges ahead, but react based on your own analysis and biases.';

    const eventContext = baseEventContext + outcomeContext;

    const relationshipContext = await this.getActorRelationships(actor.id);

    // Build narrative and event history from comprehensive context
    const relatedNarratives =
      comprehensiveContext.ongoingNarratives ||
      comprehensiveContext.recentEvents
        ?.slice(0, 3)
        .map((e) => `- ${e.description}`)
        .join('\n') ||
      '';
    const similarPreviousEvents =
      comprehensiveContext.recentEvents
        ?.filter((e) => e.type === worldEvent.type)
        .map((e) => `- ${e.description}`)
        .join('\n') || '';

    const prompt = renderPrompt(reactions, {
      eventDescription:
        worldEvent.description || worldEvent.type || 'Event occurred',
      eventContext: eventContext || 'React to this development',
      characterName: actor.name,
      characterInfo: fullCharacterContext,
      relationshipContext: relationshipContext,
      relatedNarratives,
      similarPreviousEvents,
      ...this.buildActorPromptVars(actor),
      ...buildFilteredWorldContext(actor, this.worldContext),
    });

    const params = getPromptParams(reactions);
    const maxRetries = 3;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const response = await this.llm.generateJSON<
        | {
            reaction: {
              post: string;
              sentiment: number;
              clueStrength: number;
              pointsToward: boolean | null;
            };
          }
        | {
            response: {
              reaction: {
                post: string;
                sentiment: number;
                clueStrength: number;
                pointsToward: boolean | null;
              };
            };
          }
      >(
        prompt,
        {
          properties: {
            reaction: {
              type: 'object',
              properties: {
                post: { type: 'string' },
                sentiment: { type: 'number' },
                clueStrength: { type: 'number' },
                pointsToward: { type: 'boolean' },
              },
            },
          },
          required: ['reaction'],
        },
        { ...params, promptType: 'feed_generate_reaction_per_character' }
      );

      if (!response) {
        if (attempt < maxRetries - 1) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          continue;
        }
        return null;
      }

      const reactionData =
        'response' in response && response.response
          ? (
              response.response as {
                reaction: {
                  post: string;
                  sentiment: number;
                  clueStrength: number;
                  pointsToward: boolean | null;
                };
              }
            ).reaction
          : (
              response as {
                reaction: {
                  post: string;
                  sentiment: number;
                  clueStrength: number;
                  pointsToward: boolean | null;
                };
              }
            ).reaction;

      if (
        !reactionData?.post ||
        typeof reactionData.post !== 'string' ||
        reactionData.post.trim().length === 0
      ) {
        if (attempt < maxRetries - 1) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          continue;
        }
        return null;
      }

      const processedPost = await this.postProcessContent(
        reactionData.post.trim()
      );
      const validation = this.validatePostContent(processedPost, 'REACTION');

      if (!validation.isValid) {
        if (attempt < maxRetries - 1) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          continue;
        }
        return null;
      }

      return {
        post: validation.cleanContent,
        sentiment: reactionData.sentiment ?? 0,
        clueStrength: reactionData.clueStrength ?? 0.5,
        pointsToward: reactionData.pointsToward ?? null,
      };
    }

    return null;
  }

  /**
   * PER-CHARACTER: Generate commentary for a single character with full context
   *
   * @description
   * Generates expert commentary WITHOUT knowing predetermined outcome.
   * Uses event hints and expert bias/mood for framing.
   * Each character gets full context with entropy/variety in presentation.
   */
  private async generateCommentaryForCharacter(
    commentator: Actor,
    worldEvent: WorldEvent,
    day: number
  ): Promise<{
    post: string;
    sentiment: number;
    clueStrength: number;
    pointsToward: boolean | null;
  } | null> {
    if (!this.llm) {
      return null;
    }

    // Build rich character context with all available data
    const { characterInfo, comprehensiveContext } =
      await this.buildRichCharacterContext(commentator, day, [worldEvent]);
    const comprehensiveContextText =
      formatComprehensiveContext(comprehensiveContext);

    // Build full context with trending topics, current events, etc.
    const groupContext = this.actorGroupContexts.get(commentator.id) || '';
    const fullCharacterContext = buildCharacterFeedContext({
      characterInfo,
      comprehensiveContext: comprehensiveContextText,
      trendingTopics: this.trendContext,
      currentEvents: worldEvent.description || worldEvent.type || undefined,
      recentPosts: groupContext || undefined,
    });

    // Build event relationship context from available data
    const involvedActorNames = (worldEvent.actors || []).join(', ');
    const isPersonallyInvolved =
      worldEvent.actors?.includes(commentator.name) ||
      worldEvent.actors?.includes(commentator.id);
    const characterEventRelation = isPersonallyInvolved
      ? `${commentator.name} is directly involved in this event.`
      : involvedActorNames
        ? `Key actors involved: ${involvedActorNames}.`
        : '';
    const relatedNarrative =
      comprehensiveContext.ongoingNarratives ||
      comprehensiveContext.recentEvents
        ?.slice(0, 3)
        .map((e) => `- ${e.description}`)
        .join('\n') ||
      '';

    const prompt = renderPrompt(commentary, {
      eventDescription:
        worldEvent.description || worldEvent.type || 'Event occurred',
      characterName: commentator.name,
      characterInfo: fullCharacterContext,
      characterEventRelation,
      involvedActors: involvedActorNames,
      relatedNarrative,
      ...this.buildActorPromptVars(commentator),
      ...buildFilteredWorldContext(commentator, this.worldContext),
    });

    const params = getPromptParams(commentary);
    const maxRetries = 3;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const response = await this.llm.generateJSON<
        { comment: CommentaryPost } | { response: { comment: CommentaryPost } }
      >(
        prompt,
        {
          properties: {
            comment: {
              type: 'object',
              properties: {
                post: { type: 'string' },
                sentiment: { type: 'number' },
                clueStrength: { type: 'number' },
                pointsToward: { type: 'boolean' }, // Can be null, handled in code
              },
            },
          },
          required: ['comment'],
        },
        { ...params, promptType: 'feed_generate_commentary_per_character' }
      );

      if (!response) {
        logger.warn(
          `LLM returned null/undefined commentary response for ${commentator.name} (attempt ${attempt + 1}/${maxRetries})`,
          undefined,
          'FeedGenerator'
        );
        if (attempt < maxRetries - 1) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          continue;
        }
        return null;
      }

      // Handle nested response structure
      const commentData =
        'response' in response && response.response
          ? (response.response as { comment: CommentaryPost }).comment
          : (response as { comment: CommentaryPost }).comment;

      if (!commentData || typeof commentData !== 'object') {
        logger.warn(
          `Invalid commentary response structure for ${commentator.name} (attempt ${attempt + 1}/${maxRetries})`,
          undefined,
          'FeedGenerator'
        );
        if (attempt < maxRetries - 1) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          continue;
        }
        return null;
      }

      const content =
        commentData.post || commentData.tweet || commentData.content;
      if (
        !content ||
        typeof content !== 'string' ||
        content.trim().length === 0
      ) {
        logger.warn(
          `Empty commentary post for ${commentator.name} (attempt ${attempt + 1}/${maxRetries})`,
          undefined,
          'FeedGenerator'
        );
        if (attempt < maxRetries - 1) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          continue;
        }
        return null;
      }

      // Apply post-processing (hashtag/emoji stripping, name mapping) and validation
      const processedPost = await this.postProcessContent(content.trim());
      const validation = this.validatePostContent(processedPost, 'COMMENTARY');

      if (!validation.isValid) {
        logger.warn(
          `Validation failed for commentary post from ${commentator.name} (attempt ${attempt + 1}/${maxRetries})`,
          {
            violations: validation.violations,
            attempt: attempt + 1,
          },
          'FeedGenerator'
        );
        if (attempt < maxRetries - 1) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          continue;
        }
        return null;
      }

      return {
        post: validation.cleanContent,
        sentiment: commentData.sentiment ?? 0,
        clueStrength: commentData.clueStrength ?? 0.5,
        pointsToward: commentData.pointsToward ?? null,
      };
    }

    logger.warn(
      `Failed to generate commentary for ${commentator.name} after ${maxRetries} attempts`,
      undefined,
      'FeedGenerator'
    );
    return null;
  }

  /**
   * PER-CHARACTER: Generate conspiracy post for a single character with full context
   *
   * @description
   * Generates conspiracy theory WITHOUT knowing predetermined outcome.
   * Conspiracy posts often contradict event hints (contrarians).
   * Each character gets full context with entropy/variety in presentation.
   */
  private async generateConspiracyForCharacter(
    conspiracist: Actor,
    worldEvent: WorldEvent,
    day: number
  ): Promise<{
    post: string;
    sentiment: number;
    clueStrength: number;
    pointsToward: boolean | null;
  } | null> {
    if (!this.llm) {
      return null;
    }

    // Build rich character context with all available data
    const { characterInfo, comprehensiveContext } =
      await this.buildRichCharacterContext(conspiracist, day, [worldEvent]);
    const comprehensiveContextText =
      formatComprehensiveContext(comprehensiveContext);

    // Build full context with trending topics, current events, etc.
    const groupContext = this.actorGroupContexts.get(conspiracist.id) || '';
    const fullCharacterContext = buildCharacterFeedContext({
      characterInfo,
      comprehensiveContext: comprehensiveContextText,
      trendingTopics: this.trendContext,
      currentEvents: worldEvent.description || worldEvent.type || undefined,
      recentPosts: groupContext || undefined,
    });

    const prompt = renderPrompt(conspiracy, {
      eventDescription:
        worldEvent.description || worldEvent.type || 'Event occurred',
      characterName: conspiracist.name,
      characterInfo: fullCharacterContext,
      ...this.buildActorPromptVars(conspiracist),
      ...buildFilteredWorldContext(conspiracist, this.worldContext),
    });

    const params = getPromptParams(conspiracy);
    const maxRetries = 3;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const response = await this.llm.generateJSON<
        | {
            theory: {
              post: string;
              sentiment: number;
              clueStrength: number;
              pointsToward: boolean | null;
            };
          }
        | {
            response: {
              theory: {
                post: string;
                sentiment: number;
                clueStrength: number;
                pointsToward: boolean | null;
              };
            };
          }
      >(
        prompt,
        {
          properties: {
            theory: {
              type: 'object',
              properties: {
                post: { type: 'string' },
                sentiment: { type: 'number' },
                clueStrength: { type: 'number' },
                pointsToward: { type: 'boolean' },
              },
            },
          },
          required: ['theory'],
        },
        { ...params, promptType: 'feed_generate_conspiracy_per_character' }
      );

      if (!response) {
        if (attempt < maxRetries - 1) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          continue;
        }
        return null;
      }

      const theoryData =
        'response' in response && response.response
          ? (
              response.response as {
                theory: {
                  post: string;
                  sentiment: number;
                  clueStrength: number;
                  pointsToward: boolean | null;
                };
              }
            ).theory
          : (
              response as {
                theory: {
                  post: string;
                  sentiment: number;
                  clueStrength: number;
                  pointsToward: boolean | null;
                };
              }
            ).theory;

      if (
        !theoryData?.post ||
        typeof theoryData.post !== 'string' ||
        theoryData.post.trim().length === 0
      ) {
        if (attempt < maxRetries - 1) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          continue;
        }
        return null;
      }

      const processedPost = await this.postProcessContent(
        theoryData.post.trim()
      );
      const validation = this.validatePostContent(processedPost, 'CONSPIRACY');

      if (!validation.isValid) {
        if (attempt < maxRetries - 1) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          continue;
        }
        return null;
      }

      return {
        post: validation.cleanContent,
        sentiment: theoryData.sentiment ?? 0,
        clueStrength: theoryData.clueStrength ?? 0.5,
        pointsToward: theoryData.pointsToward ?? null,
      };
    }

    return null;
  }

  /**
   * @deprecated Use generateConspiracyForCharacter instead - generates per-character with full context
   * BATCHED: Generate conspiracy posts for multiple actors in ONE call
   *
   * @internal Reserved for future batch processing optimization
   *
   * @description
   * Generates conspiracy theories WITHOUT knowing predetermined outcome.
   * Conspiracy posts often contradict event hints (contrarians).
   */
  // @ts-ignore TS6133 - Deprecated method kept for reference
  private async _generateConspiracyPostsBatch_DEPRECATED(
    conspiracists: Actor[],
    worldEvent: WorldEvent
  ): Promise<
    Array<{
      post: string;
      sentiment: number;
      clueStrength: number;
      pointsToward: boolean | null;
    }>
  > {
    if (!this.llm || conspiracists.length === 0) {
      return [];
    }

    // Conspiracy posts often contradict the event hint (contrarian behavior)
    const conspiracyGuidance =
      worldEvent.pointsToward === 'YES'
        ? "Claim it's a distraction from something worse"
        : worldEvent.pointsToward === 'NO'
          ? "Say they're hiding that it's actually happening"
          : 'Spin your own alternative narrative';

    const conspiracistsList = conspiracists
      .map((actor, i) => {
        const persona = this._npcPersonas.get(actor.id);

        let personaContext = '';
        if (persona) {
          personaContext = `Reliability: ${(persona.reliability * 100).toFixed(0)}% (low - spreads misinformation)`;
          if (persona.willingToLie) {
            personaContext += ` | Motivated by: ${persona.selfInterest}`;
          }
        }

        const voiceContext = formatActorVoiceContext(actor);

        return `
╔══════════════════════════════════════════════════════════════════╗
║ CONSPIRACIST ${i + 1}: ${actor.name.toUpperCase()}
╚══════════════════════════════════════════════════════════════════╝
   Identity: ${actor.description}
   ${personaContext ? `${personaContext}` : ''}
${voiceContext}

   YOUR TASK: Write a conspiracy post AS ${actor.name}.
   You don't believe the mainstream narrative.
   ${conspiracyGuidance}
   RULES: Max 140 chars. Be dramatic, suspicious. NO hashtags. NO emojis.
   VOICE: Match the style above. Sound paranoid and unique.`;
      })
      .join('\n');

    const prompt = renderPrompt(conspiracy, {
      eventDescription:
        worldEvent.description || worldEvent.type || 'Event occurred',
      conspiracistCount: conspiracists.length.toString(),
      conspiracistsList: conspiracistsList || '',
      ...(this.worldContext || {}),
    });

    const params = getPromptParams(conspiracy);
    const maxRetries = 5;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const rawResponse = await this.llm.generateJSON<ConspiracyResponse>(
        prompt,
        undefined, // Don't validate schema, we'll handle both formats
        { ...params, promptType: 'feed_generate_conspiracy_posts_batch' }
      );

      if (!rawResponse) {
        logger.warn(
          `LLM returned null/undefined conspiracy response (attempt ${attempt + 1}/${maxRetries})`,
          undefined,
          'FeedGenerator'
        );
        if (attempt < maxRetries - 1) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          continue;
        }
        return []; // Return empty if failed
      }

      // Handle multiple response formats with proper type narrowing
      let conspiracy: ConspiracyPost[] = [];

      if (rawResponse && typeof rawResponse === 'object') {
        if ('conspiracy' in rawResponse && rawResponse.conspiracy) {
          if (Array.isArray(rawResponse.conspiracy)) {
            // Format 1: Direct array
            conspiracy = rawResponse.conspiracy;
          } else if (typeof rawResponse.conspiracy === 'object') {
            const conspiracyObj = rawResponse.conspiracy as Record<
              string,
              JsonValue
            >;
            // Format 3: XML nested structure { conspiracy: { theory: [...] } } or { conspiracy: { post: [...] } }
            if ('theory' in conspiracyObj) {
              const nested = conspiracyObj.theory as
                | ConspiracyPost[]
                | ConspiracyPost;
              conspiracy = Array.isArray(nested) ? nested : [nested];
            } else if ('post' in conspiracyObj) {
              const nested = conspiracyObj.post as
                | ConspiracyPost[]
                | ConspiracyPost;
              conspiracy = Array.isArray(nested) ? nested : [nested];
            }
          }
        } else if ('data' in rawResponse && Array.isArray(rawResponse.data)) {
          // Format 2: Wrapped in data array
          conspiracy = rawResponse.data.flatMap((d) => {
            return Array.isArray(d.conspiracy) ? d.conspiracy : [];
          });
        } else if (
          'response' in rawResponse &&
          rawResponse.response &&
          typeof rawResponse.response === 'object'
        ) {
          // Format 4: Wrapped in response { response: { conspiracy: [...] } }
          const responseObj = rawResponse.response as Record<string, JsonValue>;
          if ('conspiracy' in responseObj && responseObj.conspiracy) {
            if (Array.isArray(responseObj.conspiracy)) {
              conspiracy = responseObj.conspiracy as ConspiracyPost[];
            } else if (typeof responseObj.conspiracy === 'object') {
              const conspiracyObj = responseObj.conspiracy as Record<
                string,
                JsonValue
              >;
              if ('theory' in conspiracyObj) {
                const nested = conspiracyObj.theory as
                  | ConspiracyPost[]
                  | ConspiracyPost;
                conspiracy = Array.isArray(nested) ? nested : [nested];
              } else if ('post' in conspiracyObj) {
                const nested = conspiracyObj.post as
                  | ConspiracyPost[]
                  | ConspiracyPost;
                conspiracy = Array.isArray(nested) ? nested : [nested];
              }
            }
          }
        } else {
          // Log unexpected response structure for monitoring
          logger.warn(
            'Conspiracy response has unexpected structure',
            {
              responseKeys: Object.keys(rawResponse),
              hasConspiracy: 'conspiracy' in rawResponse,
              hasResponse: 'response' in rawResponse,
            },
            'FeedGenerator'
          );
        }
      } else {
        logger.warn(
          'Conspiracy response is not an object',
          { type: typeof rawResponse },
          'FeedGenerator'
        );
      }

      // Log sample posts for monitoring
      if (attempt === 0 && conspiracy.length > 0) {
        logger.info(
          'Sample conspiracy structure',
          {
            count: conspiracy.length,
            firstKeys: Object.keys(conspiracy[0] || {}),
            hasPost: conspiracy[0] ? 'post' in conspiracy[0] : false,
            hasContent: conspiracy[0]
              ? 'content' in (conspiracy[0] as Record<string, unknown>)
              : false,
          },
          'FeedGenerator'
        );
      }

      const filteredConspiracy = conspiracy
        .filter((c) => {
          if (typeof c !== 'object' || c === null) return false;
          // Handle various content field names: post, tweet, or content
          const content = c.post || c.tweet || c.content;
          return (
            content !== undefined &&
            typeof content === 'string' &&
            content.trim().length > 0
          );
        })
        .map((c) => ({
          post: c.post || c.tweet || c.content || '',
          sentiment: c.sentiment ?? 0,
          clueStrength: c.clueStrength ?? 0.5,
          pointsToward: c.pointsToward ?? null,
        }));

      // Apply post-processing (hashtag/emoji stripping, name mapping) and validation
      const processedConspiracy = await Promise.all(
        filteredConspiracy.map(async (c) => {
          const processedPost = await this.postProcessContent(c.post);
          const validation = this.validatePostContent(
            processedPost,
            'CONSPIRACY'
          );
          return {
            post: validation.cleanContent,
            sentiment: c.sentiment,
            clueStrength: c.clueStrength,
            pointsToward: c.pointsToward,
            isValid: validation.isValid,
            violations: validation.violations,
          };
        })
      );

      // Check if any posts failed validation
      const invalidConspiracy = processedConspiracy.filter((c) => !c.isValid);
      if (invalidConspiracy.length > 0) {
        const violationCount = invalidConspiracy.reduce(
          (sum, c) => sum + c.violations.length,
          0
        );
        logger.warn(
          `Validation failed for ${invalidConspiracy.length} conspiracy post(s) (attempt ${attempt + 1}/${maxRetries})`,
          {
            violations: invalidConspiracy.flatMap((c) => c.violations),
            violationCount,
            attempt: attempt + 1,
          },
          'FeedGenerator'
        );

        // Retry if we haven't exhausted attempts
        if (attempt < maxRetries - 1) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          continue;
        }
      }

      // Filter to only valid conspiracy posts
      const validConspiracy = processedConspiracy
        .filter((c) => c.isValid)
        .map((c) => ({
          post: c.post,
          sentiment: c.sentiment,
          clueStrength: c.clueStrength,
          pointsToward: c.pointsToward,
        }));

      const minRequired = Math.ceil(conspiracists.length * 0.5);

      if (validConspiracy.length >= minRequired) {
        // Limit to requested count to match with conspiracists
        return validConspiracy.slice(0, conspiracists.length);
      }

      logger.warn(
        `Invalid conspiracy batch (attempt ${attempt + 1}/${maxRetries}). Expected ${conspiracists.length}, got ${validConspiracy.length} valid (need ${minRequired}+)`,
        {
          attempt: attempt + 1,
          maxRetries,
          expected: conspiracists.length,
          got: validConspiracy.length,
          minRequired,
        },
        'FeedGenerator'
      );
      if (attempt < maxRetries - 1) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }

    logger.error(
      `Failed to generate conspiracy posts batch after ${maxRetries} attempts. Returning empty batch.`,
      undefined,
      'FeedGenerator'
    );
    return [];
  }

  /**
  /**
   * Generate company PR statement
   * Companies manage crises, spin news, and announce products
   * 
   * @description
   * Generates company PR WITHOUT knowing predetermined outcome.
   * Companies defend themselves and spin narratives based on their interests.
   */
  private async generateCompanyPost(
    company: Organization,
    event: WorldEvent,
    _affiliatedActor: Actor,
    outcome: boolean
  ): Promise<{
    post: string;
    sentiment: number;
    clueStrength: number;
    pointsToward: boolean | null;
  }> {
    if (!this.llm) {
      throw new Error('LLM client required for feed generation');
    }

    const isCrisis = event.type === 'scandal' || event.type === 'leak';

    // Companies ALWAYS try to frame things positively for themselves
    const frameGuidance =
      event.pointsToward === 'NO'
        ? 'Defensively spin this as minor/temporary - protect company reputation'
        : event.pointsToward === 'YES'
          ? 'Promote this as evidence of company strength and success'
          : 'Frame neutrally but emphasize company stability and commitment';

    // Enhance frameGuidance with outcome knowledge for more strategic framing
    const enhancedFrameGuidance = outcome
      ? `${frameGuidance}. The underlying trend supports positive framing - emphasize long-term value and resilience.`
      : `${frameGuidance}. The underlying trend requires careful management - emphasize proactive response and commitment to stakeholders.`;

    // Ensure world context is available
    if (!this.worldContext) {
      this.worldContext = await generateWorldContext({ maxActors: 50 });
    }

    // Build company narrative context from previous posts
    const companyPreviousPosts = this._allPreviousPosts
      .filter((p) => p.author === company.id)
      .slice(-3)
      .map((p) => `- "${p.content}"`)
      .join('\n');
    const companyNarrativePosition = isCrisis
      ? `${company.name} is currently managing a ${event.type} situation.`
      : `${company.name} is positioning around recent developments.`;

    const prompt = renderPrompt(companyPost, {
      companyName: company.name,
      companyDescription: company.description,
      companyNarrativePosition,
      previousStatements: companyPreviousPosts || 'No previous statements.',
      eventDescription: event.description,
      eventType: event.type,
      postType: isCrisis ? 'crisis management' : 'announcement',
      outcomeFrame: enhancedFrameGuidance,
      ...(this.worldContext || {}),
    });

    const params = getPromptParams(companyPost);
    const maxRetries = 5;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const response = await this.llm.generateJSON<{
        post: string;
        sentiment: number;
        clueStrength: number;
        pointsToward: boolean | null;
      }>(
        prompt,
        { required: ['post', 'sentiment', 'clueStrength', 'pointsToward'] },
        { ...params, promptType: 'feed_generate_company_post' }
      );

      if (!response) {
        logger.warn(
          `LLM returned null/undefined company post response (attempt ${attempt + 1}/${maxRetries})`,
          undefined,
          'FeedGenerator'
        );
        if (attempt < maxRetries - 1) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          continue;
        }
        throw new Error(
          `Failed to generate valid company post after ${maxRetries} attempts for ${company.name}`
        );
      }

      if (
        response.post &&
        typeof response.post === 'string' &&
        response.post.trim().length > 0
      ) {
        return {
          ...response,
          post: await this.postProcessContent(response.post),
        };
      }

      logger.warn(
        `Invalid company post (attempt ${attempt + 1}/${maxRetries}). Retrying...`,
        { attempt: attempt + 1, maxRetries },
        'FeedGenerator'
      );
      if (attempt < maxRetries - 1) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }

    logger.error(
      `Failed to generate valid company post after ${maxRetries} attempts for ${company.name}. Using fallback.`,
      undefined,
      'FeedGenerator'
    );
    return {
      post: `${company.name} has issued a statement regarding the recent ${event.type}.`,
      sentiment: 0,
      clueStrength: 0.1,
      pointsToward: null,
    };
  }

  /**
   * Generate government response
   * Government agencies investigate, deny, or announce policy
   *
   * @description
   * Generates government statements WITHOUT knowing predetermined outcome.
   * Government responses are typically vague, bureaucratic, and ineffective.
   */
  private async generateGovernmentPost(
    govt: Organization,
    event: WorldEvent,
    allActors: Actor[],
    outcome: boolean
  ): Promise<{
    post: string;
    sentiment: number;
    clueStrength: number;
    pointsToward: boolean | null;
  }> {
    if (!this.llm) {
      throw new Error('LLM client required for feed generation');
    }

    // Ensure world context is available
    if (!this.worldContext) {
      this.worldContext = await generateWorldContext({ maxActors: 50 });
    }

    // Identify actors and organizations involved in the event
    const involvedActors = event.actors
      .map((id) => allActors.find((a) => a.id === id))
      .filter((a): a is Actor => a !== undefined);

    // Find companies/organizations involved through actor affiliations
    const involvedCompanies = involvedActors
      .flatMap((actor) => actor.affiliations || [])
      .map((orgId) => this.organizations.find((o) => o.id === orgId))
      .filter((o): o is Organization => o !== undefined && o.type === 'company')
      .slice(0, 3); // Limit to top 3 companies

    // Build context about who the government is responding to
    const involvedParties = [
      ...involvedActors.map((a) => a.name),
      ...involvedCompanies.map((c) => c.name),
    ].filter(Boolean);

    const partiesContext =
      involvedParties.length > 0
        ? `This event involves: ${involvedParties.join(', ')}. Address these parties in your statement.`
        : 'Address the event and any relevant parties mentioned in the event description.';

    // Government framing based on event severity and outcome
    const baseFrame =
      event.type === 'scandal' || event.type === 'revelation'
        ? 'Announce investigation, issue vague statement about "reviewing the matter"'
        : 'Issue official statement addressing the development';

    // Enhance with outcome knowledge for subtle guidance
    const enhancedFrame = outcome
      ? `${baseFrame}. The underlying situation suggests manageable resolution, but maintain bureaucratic caution.`
      : `${baseFrame}. The underlying situation requires careful oversight, but maintain bureaucratic caution.`;

    const outcomeFrame = `${enhancedFrame} ${partiesContext}`;

    // Build government context from previous statements and actions
    const govPreviousPosts = this._allPreviousPosts
      .filter((p) => p.author === govt.id)
      .slice(-3)
      .map((p) => `- "${p.content}"`)
      .join('\n');
    const agencyActions =
      event.type === 'scandal' || event.type === 'revelation'
        ? `${govt.name} is reviewing the matter and coordinating with relevant parties.`
        : `${govt.name} has acknowledged the development and is monitoring the situation.`;

    const prompt = renderPrompt(governmentPost, {
      govName: govt.name,
      govDescription: govt.description,
      agencyActions,
      previousStatements: govPreviousPosts || 'No previous statements.',
      eventDescription:
        event.description || 'A significant event has occurred.',
      eventType: event.type,
      outcomeFrame,
      ...(this.worldContext || {}),
    });

    const params = getPromptParams(governmentPost);
    const maxRetries = 5;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const response = await this.llm.generateJSON<{
        post: string;
        sentiment: number;
        clueStrength: number;
        pointsToward: boolean | null;
      }>(
        prompt,
        { required: ['post', 'sentiment', 'clueStrength', 'pointsToward'] },
        { ...params, promptType: 'feed_generate_government_post' }
      );

      if (!response) {
        logger.warn(
          `LLM returned null/undefined government post response (attempt ${attempt + 1}/${maxRetries})`,
          undefined,
          'FeedGenerator'
        );
        if (attempt < maxRetries - 1) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          continue;
        }
        throw new Error(
          `Failed to generate valid government post after ${maxRetries} attempts for ${govt.name}`
        );
      }

      if (
        response.post &&
        typeof response.post === 'string' &&
        response.post.trim().length > 0
      ) {
        return {
          ...response,
          post: await this.postProcessContent(response.post),
        };
      }

      logger.warn(
        `Invalid government post (attempt ${attempt + 1}/${maxRetries}). Retrying...`,
        { attempt: attempt + 1, maxRetries },
        'FeedGenerator'
      );
      if (attempt < maxRetries - 1) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }

    throw new Error(
      `Failed to generate valid government post after ${maxRetries} attempts for ${govt.name}`
    );
  }

  /**
   * Generate ambient feed posts (not tied to specific events)
   * Random musings, hot takes, general commentary
   * BATCHED: Generates all ambient posts in ONE call
   *
   * @description
   * Generates ambient posts WITHOUT knowing predetermined outcome.
   * Actors post general thoughts based on their mood and context.
   */
  private async generateAmbientFeed(
    day: number,
    allActors: Actor[],
    outcome: boolean
  ): Promise<FeedPost[]> {
    const ambient: FeedPost[] = [];
    const baseTime = `2025-10-${String(day).padStart(2, '0')}T`;

    // DENSE CONTENT: Each actor posts 1-20 times per hour
    // Generate posts for all 24 hours of the day

    // For each hour of the day, select random actors to post
    for (let hour = 0; hour < 24; hour++) {
      // Each hour, 10-30% of actors post (1-20 posts per actor per hour achieved through probability)
      const actorsThisHour = shuffleArray(allActors).slice(
        0,
        Math.floor(allActors.length * (0.1 + Math.random() * 0.2))
      );

      if (actorsThisHour.length === 0) continue;

      // ✅ PER-CHARACTER: Generate posts individually with intent-based routing
      // Each actor gets a post intent (organic/topical/market/social) based on their domain
      const trendingTopic = this.trendContext || undefined;
      const ambientTasks = shuffleArray(actorsThisHour).map(
        (actor) => async () => {
          const intent = selectPostIntent(
            actor,
            trendingTopic,
            this.relationships as ActorRelationship[],
            allActors
          );
          return this.generatePostByIntent(actor, day, outcome, intent);
        }
      );

      const ambientResults = await rateLimitedParallel(ambientTasks, 5, 100);
      const posts = ambientResults
        .filter((p): p is NonNullable<typeof p> => p !== null)
        .map((postContent) => {
          const actor = actorsThisHour.find(
            (a) => a.id === postContent.actorId
          );
          if (!actor) return null;
          return { ...postContent, actor };
        })
        .filter((p): p is NonNullable<typeof p> => p !== null);

      posts.forEach(({ actor, ...postContent }) => {
        if (!actor) return;

        // Spread posts throughout the hour (random minutes)
        const minute = Math.floor(Math.random() * 60);
        const second = Math.floor(Math.random() * 60);

        ambient.push({
          id: `ambient-${day}-${hour}-${actor.id}-${Date.now()}`,
          day,
          timestamp: `${baseTime}${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}Z`,
          type: 'thread' as const,
          content: postContent.post,
          author: actor.id,
          authorName: actor.name,
          sentiment: postContent.sentiment,
          clueStrength: postContent.clueStrength,
          pointsToward: postContent.pointsToward,
        });
      });
    }

    return ambient;
  }

  /**
   * Select actors most likely to reply to a post, weighted by:
   * 1. Relationship strength (rivals 5x, allies 3x, known actors 2x)
   * 2. Domain overlap (shared domains 2x, disjoint domains 0.3x)
   * 3. Random baseline (ensures variety)
   */
  private selectWeightedRepliers(
    post: FeedPost,
    allActors: Actor[],
    count: number
  ): Actor[] {
    const postAuthorId = post.author;
    const candidates = allActors.filter((a) => a.id !== postAuthorId);
    if (candidates.length === 0) return [];

    // Get the post author's domains for overlap calculation
    const authorActor = candidates.find((a) => a.id === postAuthorId);
    const authorDomains = new Set(
      (
        authorActor?.domain ??
        StaticDataRegistry.getActor(postAuthorId)?.domain ??
        []
      ).map((d) => d.toLowerCase())
    );

    // Score each candidate
    const scored = candidates.map((actor) => {
      let weight = 1; // baseline

      // Relationship weight
      const actorRelationships = (
        this.relationships as ActorRelationship[]
      ).filter(
        (r) =>
          (r.actor1Id === actor.id && r.actor2Id === postAuthorId) ||
          (r.actor2Id === actor.id && r.actor1Id === postAuthorId)
      );

      if (actorRelationships.length > 0) {
        const rel = actorRelationships[0];
        if (rel) {
          const absSentiment = Math.abs(rel.sentiment);
          // Strong feelings (positive or negative) = more likely to reply
          weight *= 1 + absSentiment * 3;
        }
      }

      // Check rivalry/alliance from character config
      const config = getCharacterConfigOrDefault(actor.id);
      if (config.rivals.includes(postAuthorId)) {
        weight *= 5; // Rivals are very likely to reply
      }
      if (actor.persona?.favorsActors?.includes(postAuthorId)) {
        weight *= 3; // Allies likely to reply
      }
      if (actor.persona?.opposesActors?.includes(postAuthorId)) {
        weight *= 4; // Opponents likely to reply
      }

      // Domain overlap weight
      if (actor.domain && actor.domain.length > 0 && authorDomains.size > 0) {
        const actorDomains = actor.domain.map((d) => d.toLowerCase());
        const hasOverlap = actorDomains.some((d) => authorDomains.has(d));
        if (hasOverlap) {
          weight *= 2; // Same domain = more likely to engage
        } else {
          weight *= 0.3; // Different domain = less likely (but not zero)
        }
      }

      return { actor, weight };
    });

    // Weighted random selection without replacement
    const selected: Actor[] = [];
    const remaining = [...scored];

    for (let i = 0; i < count && remaining.length > 0; i++) {
      const totalWeight = remaining.reduce((sum, s) => sum + s.weight, 0);
      let roll = Math.random() * totalWeight;
      let selectedIndex = 0;
      for (let j = 0; j < remaining.length; j++) {
        const item = remaining[j];
        if (!item) continue;
        roll -= item.weight;
        if (roll <= 0) {
          selectedIndex = j;
          break;
        }
      }
      const picked = remaining[selectedIndex];
      if (picked) {
        selected.push(picked.actor);
        remaining.splice(selectedIndex, 1);
      }
    }

    return selected;
  }

  /**
   * Generate replies to existing posts
   * 30-50% of posts get replies from other actors
   */
  private async generateReplies(
    day: number,
    existingPosts: FeedPost[],
    allActors: Actor[]
  ): Promise<FeedPost[]> {
    const replies: FeedPost[] = [];

    // Select posts that could get replies (30-50% of posts)
    const postsToReplyTo = shuffleArray(existingPosts).slice(
      0,
      Math.floor(existingPosts.length * (0.3 + Math.random() * 0.2))
    );

    for (const originalPost of postsToReplyTo) {
      // Select 1-3 actors to reply, weighted by relationship and domain overlap
      const replyCount = 1 + Math.floor(Math.random() * 3);
      const replyingActors = this.selectWeightedRepliers(
        originalPost,
        allActors,
        replyCount
      );

      // ✅ PER-CHARACTER: Generate replies individually with full context
      const replyTasks = shuffleArray(replyingActors).map(
        (actor) => async () => {
          const result = await this.generateReplyForCharacter(
            actor,
            originalPost,
            day
          );
          return result;
        }
      );

      const replyResults = await rateLimitedParallel(replyTasks, 5, 100);
      const batchReplies = replyResults.filter(
        (r): r is NonNullable<typeof r> => r !== null
      );

      batchReplies.forEach((replyContent) => {
        const actor = replyingActors.find((a) => a.id === replyContent.actorId);
        if (!actor) return;

        // Reply timestamp is after original post
        const originalTime = new Date(originalPost.timestamp);

        // Validate timestamp
        if (isNaN(originalTime.getTime())) {
          logger.warn(
            `Invalid timestamp for post ${originalPost.id}, skipping reply generation`,
            { postId: originalPost.id },
            'FeedGenerator'
          );
          return;
        }

        const replyTime = new Date(
          originalTime.getTime() + (5 + Math.random() * 55) * 60 * 1000
        ); // 5-60 minutes later

        replies.push({
          id: `reply-${originalPost.id}-${actor.id}`,
          day,
          timestamp: replyTime.toISOString(),
          type: 'reply' as const,
          content: replyContent.post,
          author: actor.id,
          authorName: actor.name,
          replyTo: originalPost.id,
          relatedEvent: originalPost.relatedEvent,
          sentiment: replyContent.sentiment,
          clueStrength: replyContent.clueStrength,
          pointsToward: replyContent.pointsToward,
        });
      });
    }

    return replies;
  }

  /**
   * Generate reposts/retweets of existing posts
   * 10-20% of posts get reposted by other actors
   */
  private async generateReposts(
    day: number,
    existingPosts: FeedPost[],
    allActors: Actor[]
  ): Promise<FeedPost[]> {
    const reposts: FeedPost[] = [];

    // Select posts that could get reposted (10-20% of posts)
    const postsToRepost = shuffleArray(existingPosts).slice(
      0,
      Math.floor(existingPosts.length * (0.1 + Math.random() * 0.1))
    );

    for (const originalPost of postsToRepost) {
      // Select 1-2 actors to repost
      const repostCount = 1 + Math.floor(Math.random() * 2);
      const repostingActors = shuffleArray(
        allActors.filter((a) => a.id !== originalPost.author)
      ).slice(0, repostCount);

      for (const actor of repostingActors) {
        const isQuoteTweet = Math.random() > 0.5; // 50% chance of quote tweet
        let quoteComment: string | null = null;

        if (isQuoteTweet) {
          // Use generateReplyContent for the quote comment as it fits the "reaction" vibe
          quoteComment = await this.generateReplyContent(actor, originalPost);
        }

        // Repost timestamp is after original post
        const originalTime = new Date(originalPost.timestamp);

        if (isNaN(originalTime.getTime())) continue;

        const repostTime = new Date(
          originalTime.getTime() + (2 + Math.random() * 30) * 60 * 1000
        ); // 2-32 minutes later

        reposts.push({
          id: `repost-${originalPost.id}-${actor.id}`,
          day,
          timestamp: repostTime.toISOString(),
          type: 'post', // It's a new post that is a repost
          content: quoteComment || '', // Content is the quote comment if present
          author: actor.id,
          authorName: actor.name,
          isRepost: true,
          originalPostId: originalPost.id,
          originalAuthorId: originalPost.author,
          originalAuthorName: originalPost.authorName,
          originalContent: originalPost.content,
          quoteComment: quoteComment,
          sentiment: originalPost.sentiment, // Inherit sentiment roughly
          clueStrength: (originalPost.clueStrength ?? 0) * 0.8,
          pointsToward: originalPost.pointsToward,
        });
      }
    }

    return reposts;
  }

  /**
   * Generate reply content for an actor replying to a post
   */
  private async generateReplyContent(
    actor: Actor,
    originalPost: FeedPost
  ): Promise<string> {
    // Ensure world context is available
    if (!this.worldContext) {
      this.worldContext = await generateWorldContext({ maxActors: 50 });
    }

    const relationshipContext = originalPost.author
      ? `Consider your relationship with ${originalPost.authorName} when responding.`
      : '';

    const prompt = renderPrompt(reply, {
      characterName: actor.name,
      characterInfo: `${actor.description || ''}\n${actor.voice || ''}\n${actor.postStyle || ''}`,
      originalPost: originalPost.content,
      originalAuthor: originalPost.authorName,
      relationshipContext,
      ...this.buildActorPromptVars(actor),
      ...buildFilteredWorldContext(actor, this.worldContext),
    });

    if (!this.llm) {
      logger.warn(
        'LLM not available for reply generation',
        undefined,
        'FeedGenerator'
      );
      return 'Interesting point.';
    }

    const params = getPromptParams(reply);
    const rawResponse = await this.llm.generateJSON<
      { post: string } | { response: { post: string } }
    >(prompt, undefined, {
      ...params,
      promptType: 'feed_generate_reply_content',
    });

    if (!rawResponse || typeof rawResponse !== 'object') {
      logger.warn(
        'LLM returned null/undefined/invalid reply content',
        { type: typeof rawResponse },
        'FeedGenerator'
      );
      return 'Interesting point.'; // Fallback
    }

    // Handle XML structure - response may be wrapped in 'response' key or be direct
    const response =
      'response' in rawResponse && rawResponse.response
        ? rawResponse.response
        : (rawResponse as { post?: string });

    // Guard against missing 'post' field in response
    if (!response.post) {
      logger.warn(
        'LLM response missing post field',
        { response },
        'FeedGenerator'
      );
      return 'Interesting point.';
    }

    return await this.postProcessContent(response.post);
  }

  /**
   * Build per-actor prompt variables (anti-repetition, guardrails, rules).
   * Used by all character post generation methods.
   */
  private buildActorPromptVars(actor: Actor): {
    antiRepetitionContext: string;
    actorRules: string;
  } {
    const antiRepetitionContext = getAvoidedPatternsContext(actor.id);
    const toneGuardrails = formatActorToneGuardrails(actor);
    const financeGuardrails = formatActorFinanceGuardrails(actor);

    const parts: string[] = [];
    if (actor.ignoreTopics && actor.ignoreTopics.length > 0) {
      parts.push(`You never talk about: ${actor.ignoreTopics.join(', ')}`);
    }
    if (toneGuardrails) parts.push(toneGuardrails);
    if (financeGuardrails) parts.push(financeGuardrails);

    return { antiRepetitionContext, actorRules: parts.join('\n') };
  }

  /**
   * Actor posts general thoughts based on mood, relationships, and trending topics.
   * Each character gets full context with entropy/variety in presentation.
   */
  private async generateAmbientPostForCharacter(
    actor: Actor,
    day: number,
    _outcome: boolean
  ): Promise<{
    post: string;
    sentiment: number;
    clueStrength: number;
    pointsToward: boolean | null;
    actorId: string;
  } | null> {
    if (!this.llm) {
      return null;
    }

    // Build unified actor context via ActorContextBuilder
    const actorContext = await actorContextBuilder.buildContext(actor.id);
    const fullCharacterContext = actorContext
      ? actorContextBuilder.formatForPrompt(actorContext)
      : `PERSONALITY: ${actor.personality || 'unknown'}\nDOMAINS: ${actor.domain?.join(', ') || 'general'}`;

    // Build phase and atmosphere context
    const phase = getPhaseForDay(day);
    const progressContext = `Phase: ${phase} (Day ${day}/30)`;
    const atmosphereContext =
      'Increasing activity and developments in various areas. Individual perspectives vary.';

    // Random hour for time-of-day energy variety
    const hour = Math.floor(Math.random() * 24);

    const actorVars = this.buildActorPromptVars(actor);

    const prompt = renderPrompt(ambientPosts, {
      progressContext,
      atmosphereContext,
      trendContext: this.trendContext || '',
      timeEnergy: getTimeOfDayEnergy(hour),
      characterName: actor.name,
      characterInfo: fullCharacterContext,
      ...actorVars,
      ...buildFilteredWorldContext(actor, this.worldContext),
    });

    const params = getPromptParams(ambientPosts);
    const maxRetries = 3;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const response = await this.llm.generateJSON<
        | {
            post: {
              content: string;
              sentiment: number;
              clueStrength: number;
              pointsToward: boolean | null;
            };
          }
        | {
            response: {
              post: {
                content: string;
                sentiment: number;
                clueStrength: number;
                pointsToward: boolean | null;
              };
            };
          }
      >(
        prompt,
        {
          properties: {
            post: {
              type: 'object',
              properties: {
                content: { type: 'string' },
                sentiment: { type: 'number' },
                clueStrength: { type: 'number' },
                pointsToward: { type: 'boolean' },
              },
            },
          },
          required: ['post'],
        },
        { ...params, promptType: 'feed_generate_ambient_post_per_character' }
      );

      if (!response) {
        if (attempt < maxRetries - 1) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          continue;
        }
        return null;
      }

      const postData =
        'response' in response && response.response
          ? (
              response.response as {
                post: {
                  content: string;
                  sentiment: number;
                  clueStrength: number;
                  pointsToward: boolean | null;
                };
              }
            ).post
          : (
              response as {
                post: {
                  content: string;
                  sentiment: number;
                  clueStrength: number;
                  pointsToward: boolean | null;
                };
              }
            ).post;

      if (
        !postData?.content ||
        typeof postData.content !== 'string' ||
        postData.content.trim().length === 0
      ) {
        if (attempt < maxRetries - 1) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          continue;
        }
        return null;
      }

      const processedPost = await this.postProcessContent(
        postData.content.trim()
      );
      const validation = this.validatePostContent(processedPost, 'AMBIENT');

      if (!validation.isValid) {
        if (attempt < maxRetries - 1) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          continue;
        }
        return null;
      }

      return {
        post: validation.cleanContent,
        sentiment: postData.sentiment ?? 0,
        clueStrength: postData.clueStrength ?? 0.05,
        pointsToward: postData.pointsToward ?? null,
        actorId: actor.id,
      };
    }

    return null;
  }

  /**
   * Route post generation to the appropriate method based on intent.
   * This is the main dispatch for the post intent system.
   */
  private async generatePostByIntent(
    actor: Actor,
    day: number,
    outcome: boolean,
    intent: PostIntent
  ): Promise<{
    post: string;
    sentiment: number;
    clueStrength: number;
    pointsToward: boolean | null;
    actorId: string;
  } | null> {
    switch (intent.type) {
      case 'organic':
        return this.generateOrganicPostForCharacter(actor, day);
      case 'social':
        return this.generateSocialPostForCharacter(
          actor,
          intent.targetActorId,
          intent.targetName,
          day
        );
      case 'market':
        // Market intent uses the existing ambient post with full market context
        return this.generateAmbientPostForCharacter(actor, day, outcome);
      case 'topical':
        // Topical intent also uses existing ambient post (which now gets filtered context)
        return this.generateAmbientPostForCharacter(actor, day, outcome);
    }
  }

  /**
   * Generate an organic, personality-driven post with NO market context.
   * The NPC posts about their actual interests: climate, health, sports, art, etc.
   */
  private async generateOrganicPostForCharacter(
    actor: Actor,
    _day: number
  ): Promise<{
    post: string;
    sentiment: number;
    clueStrength: number;
    pointsToward: boolean | null;
    actorId: string;
  } | null> {
    if (!this.llm) return null;

    // Build unified actor context
    const actorContext = await actorContextBuilder.buildContext(actor.id);
    const fullCharacterContext = actorContext
      ? actorContextBuilder.formatForPrompt(actorContext)
      : `PERSONALITY: ${actor.personality || 'unknown'}\nDOMAINS: ${actor.domain?.join(', ') || 'general'}`;

    const hour = Math.floor(Math.random() * 24);
    const actorVars = this.buildActorPromptVars(actor);
    const domainHints = getDomainHints(actor);
    const domainContext = getDomainContext(actor);

    // Build running bit context if available
    const groupContext = this.actorGroupContexts?.get(actor.id) || '';
    const runningBitContext = groupContext
      ? `RUNNING BIT CONTEXT:\n${groupContext}`
      : '';

    const prompt = renderPrompt(organicPost, {
      characterName: actor.name,
      characterInfo: fullCharacterContext,
      ...actorVars,
      runningBitContext,
      timeEnergy: getTimeOfDayEnergy(hour),
      domainHints,
      domainContext,
      // Only worldActors and reality grounding — NO market data
      worldActors: this.worldContext?.worldActors || '',
      realityGrounding: this.worldContext?.realityGrounding || '',
    });

    const params = getPromptParams(organicPost);
    const maxRetries = 3;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const response = await this.llm.generateJSON<
        | { post: { content: string; sentiment: number } }
        | { response: { post: { content: string; sentiment: number } } }
      >(
        prompt,
        {
          properties: {
            post: {
              type: 'object',
              properties: {
                content: { type: 'string' },
                sentiment: { type: 'number' },
              },
            },
          },
          required: ['post'],
        },
        { ...params, promptType: 'feed_generate_organic_post' }
      );

      if (!response) {
        if (attempt < maxRetries - 1) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          continue;
        }
        return null;
      }

      const postData =
        'response' in response && response.response
          ? (
              response.response as {
                post: { content: string; sentiment: number };
              }
            ).post
          : (response as { post: { content: string; sentiment: number } }).post;

      if (
        !postData?.content ||
        typeof postData.content !== 'string' ||
        postData.content.trim().length === 0
      ) {
        if (attempt < maxRetries - 1) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          continue;
        }
        return null;
      }

      const processedPost = await this.postProcessContent(
        postData.content.trim()
      );
      const validation = this.validatePostContent(processedPost, 'AMBIENT');

      if (!validation.isValid) {
        if (attempt < maxRetries - 1) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          continue;
        }
        return null;
      }

      return {
        post: validation.cleanContent,
        sentiment: postData.sentiment ?? 0,
        clueStrength: 0, // Organic posts carry no narrative clues
        pointsToward: null,
        actorId: actor.id,
      };
    }

    return null;
  }

  /**
   * Generate a relationship-driven post about or directed at another NPC.
   * Uses rivalry/alliance dynamics to create natural social interactions.
   */
  private async generateSocialPostForCharacter(
    actor: Actor,
    targetActorId: string,
    targetName: string,
    _day: number
  ): Promise<{
    post: string;
    sentiment: number;
    clueStrength: number;
    pointsToward: boolean | null;
    actorId: string;
  } | null> {
    if (!this.llm) return null;

    // Build actor context
    const actorContext = await actorContextBuilder.buildContext(actor.id);
    const fullCharacterContext = actorContext
      ? actorContextBuilder.formatForPrompt(actorContext)
      : `PERSONALITY: ${actor.personality || 'unknown'}\nDOMAINS: ${actor.domain?.join(', ') || 'general'}`;

    const actorVars = this.buildActorPromptVars(actor);

    // Build relationship context
    const actorRelationships = (
      this.relationships as ActorRelationship[]
    ).filter(
      (r) =>
        (r.actor1Id === actor.id && r.actor2Id === targetActorId) ||
        (r.actor2Id === actor.id && r.actor1Id === targetActorId)
    );

    let relationshipContext = '';
    const rel = actorRelationships[0];
    if (rel) {
      const sentimentDesc =
        rel.sentiment > 0.3
          ? 'You like and respect them.'
          : rel.sentiment < -0.3
            ? 'You dislike and distrust them.'
            : 'Your feelings are mixed.';
      relationshipContext = `Relationship type: ${rel.relationshipType}. Strength: ${rel.strength.toFixed(1)}. ${sentimentDesc}`;
      if (rel.history) {
        relationshipContext += `\nHistory: ${rel.history}`;
      }
    }

    // Check if target is a rival
    const config = getCharacterConfigOrDefault(actor.id);
    if (config.rivals.includes(targetActorId)) {
      relationshipContext +=
        '\nTHIS IS YOUR RIVAL. You have BEEF. Dunk on them.';
    }
    if (actor.persona?.favorsActors?.includes(targetActorId)) {
      relationshipContext += '\nThis is your ally. Support and defend them.';
    }
    if (actor.persona?.opposesActors?.includes(targetActorId)) {
      relationshipContext +=
        '\nYou oppose this person. Challenge and undermine them.';
    }

    if (!relationshipContext) {
      relationshipContext =
        'No strong existing relationship. React based on their content and your personality.';
    }

    // Get target's recent post if available
    let targetRecentActivity = '';
    if (this._allPreviousPosts && this._allPreviousPosts.length > 0) {
      const targetPost = this._allPreviousPosts.find(
        (p) =>
          typeof p === 'object' &&
          p !== null &&
          'author' in p &&
          (p as { author: string }).author === targetActorId
      );
      if (targetPost && 'content' in targetPost) {
        targetRecentActivity = `${targetName}'s recent post: "${(targetPost as { content: string }).content}"`;
      }
    }

    const prompt = renderPrompt(socialPost, {
      characterName: actor.name,
      characterInfo: fullCharacterContext,
      ...actorVars,
      targetName,
      relationshipContext,
      targetRecentActivity,
      worldActors: this.worldContext?.worldActors || '',
      realityGrounding: this.worldContext?.realityGrounding || '',
    });

    const params = getPromptParams(socialPost);
    const maxRetries = 3;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const response = await this.llm.generateJSON<
        | { post: { content: string; sentiment: number } }
        | { response: { post: { content: string; sentiment: number } } }
      >(
        prompt,
        {
          properties: {
            post: {
              type: 'object',
              properties: {
                content: { type: 'string' },
                sentiment: { type: 'number' },
              },
            },
          },
          required: ['post'],
        },
        { ...params, promptType: 'feed_generate_social_post' }
      );

      if (!response) {
        if (attempt < maxRetries - 1) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          continue;
        }
        return null;
      }

      const postData =
        'response' in response && response.response
          ? (
              response.response as {
                post: { content: string; sentiment: number };
              }
            ).post
          : (response as { post: { content: string; sentiment: number } }).post;

      if (
        !postData?.content ||
        typeof postData.content !== 'string' ||
        postData.content.trim().length === 0
      ) {
        if (attempt < maxRetries - 1) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          continue;
        }
        return null;
      }

      const processedPost = await this.postProcessContent(
        postData.content.trim()
      );
      const validation = this.validatePostContent(processedPost, 'AMBIENT');

      if (!validation.isValid) {
        if (attempt < maxRetries - 1) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          continue;
        }
        return null;
      }

      return {
        post: validation.cleanContent,
        sentiment: postData.sentiment ?? 0,
        clueStrength: 0, // Social posts carry no narrative clues
        pointsToward: null,
        actorId: actor.id,
      };
    }

    return null;
  }

  /**
   * @deprecated Use generateAmbientPostForCharacter instead - generates per-character with full context
   * BATCHED: Generate ambient posts for multiple actors in ONE call
   *
   * @internal Reserved for future batch processing optimization
   */
  // @ts-ignore TS6133 - Deprecated method kept for reference
  private async _generateAmbientPostsBatch_DEPRECATED(
    actors: Actor[],
    day: number,
    outcome: boolean
  ): Promise<
    Array<{
      post: string;
      sentiment: number;
      clueStrength: number;
      pointsToward: boolean | null;
    }>
  > {
    if (!this.llm || actors.length === 0) {
      return [];
    }

    // Shuffle actors to add variety to prompts
    const shuffledActors = shuffleArray(actors);

    const contexts = shuffledActors.map((actor) => {
      const state = this.actorStates.get(actor.id);
      const emotionalContext = state
        ? generateActorContext(
            state.mood,
            state.luck,
            undefined,
            this.relationships,
            actor.id
          )
        : '';

      return { actor, emotionalContext };
    });

    // Natural progression: early game is setup, mid-game builds tension, late game escalates
    const progressContext =
      day <= 10
        ? 'Early days - things are just getting started.'
        : day <= 20
          ? 'Mid-way through - developments are unfolding.'
          : 'Late stage - tension is building, things are heating up.';

    // General atmosphere based on phase, enhanced with outcome knowledge for subtle guidance
    const baseAtmosphere =
      day <= 10
        ? 'General activity and routine developments.'
        : day <= 20
          ? 'Increasing activity and developments in various areas.'
          : 'Heightened activity as events accelerate.';

    // Add subtle outcome-based atmosphere without being explicit
    const outcomeAtmosphere = outcome
      ? ' The overall momentum feels positive, though individual perspectives vary.'
      : ' The overall momentum feels challenging, though individual perspectives vary.';

    const atmosphereContext = baseAtmosphere + outcomeAtmosphere;

    const actorsList = contexts
      .map((ctx, i) => {
        const persona = this._npcPersonas.get(ctx.actor.id);

        let personaContext = '';
        if (persona) {
          personaContext = `Reliability: ${(persona.reliability * 100).toFixed(0)}%`;
          if (persona.insiderOrgs.length > 0 && Math.random() > 0.7) {
            personaContext += ` | Insider at: ${persona.insiderOrgs.slice(0, 2).join(', ')}`;
          }
        }

        const voiceContext = formatActorVoiceContext(ctx.actor);
        const groupContext = this.actorGroupContexts.get(ctx.actor.id) || '';

        return `
╔══════════════════════════════════════════════════════════════════╗
║ CHARACTER ${i + 1}: ${ctx.actor.name.toUpperCase()}
╚══════════════════════════════════════════════════════════════════╝
   Identity: ${ctx.actor.description}
   Domain: ${ctx.actor.domain?.join(', ')}
   ${personaContext ? `${personaContext}` : ''}
   ${ctx.emotionalContext}
${voiceContext}
   ${groupContext ? `Private Intel: ${groupContext}` : ''}

   YOUR TASK: Write a post AS ${ctx.actor.name}.
   You may reference trending topics.
   RULES: First person. Max 280 chars. NO hashtags. NO emojis.
   VOICE: Match the examples above EXACTLY.`;
      })
      .join('\n');

    // Random hour for time-of-day energy variety in posts
    const hour = Math.floor(Math.random() * 24);

    const prompt = renderPrompt(ambientPosts, {
      day: day.toString(),
      progressContext,
      atmosphereContext,
      trendContext: this.trendContext || '',
      timeEnergy: getTimeOfDayEnergy(hour),
      actorCount: actors.length.toString(),
      actorsList,
      ...(this.worldContext || {}),
    });

    const params = getPromptParams(ambientPosts);
    const maxRetries = 5;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const response = await this.llm.generateJSON<{
        posts: Array<{
          post?: string;
          tweet?: string;
          sentiment: number;
          clueStrength: number;
          pointsToward: boolean | null;
        }>;
      }>(
        prompt,
        undefined, // Don't validate schema to handle various response formats
        { ...params, promptType: 'feed_generate_ambient_posts_batch' }
      );

      if (!response || typeof response !== 'object') {
        logger.warn(
          `LLM returned null/undefined/invalid ambient response (attempt ${attempt + 1}/${maxRetries})`,
          { type: typeof response },
          'FeedGenerator'
        );
        if (attempt < maxRetries - 1) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          continue;
        }
        return [];
      }

      // Handle XML nested structure: { posts: [...] } or { posts: { post: [...] } } or { response: { posts: {...} } }
      type AmbientPostItem = {
        post?: string;
        tweet?: string;
        content?: string;
        sentiment: number;
        clueStrength: number;
        pointsToward: boolean | null;
      };
      let posts: AmbientPostItem[] = [];

      // Check if wrapped in response object first
      const responseData =
        'response' in response &&
        response.response &&
        typeof response.response === 'object'
          ? (response.response as {
              posts?:
                | AmbientPostItem[]
                | {
                    post?: AmbientPostItem[] | AmbientPostItem;
                    posts?: AmbientPostItem[];
                  };
            })
          : response;

      if ('posts' in responseData && responseData.posts) {
        if (Array.isArray(responseData.posts)) {
          posts = responseData.posts;
        } else if (typeof responseData.posts === 'object') {
          // Check various nested structures
          if ('post' in responseData.posts) {
            const nested = responseData.posts.post;
            posts = Array.isArray(nested) ? nested : nested ? [nested] : [];
          } else if (
            'posts' in responseData.posts &&
            Array.isArray(responseData.posts.posts)
          ) {
            // Double nested: { posts: { posts: [...] } }
            posts = responseData.posts.posts;
          } else if ('content' in responseData.posts) {
            // Single post returned directly: { posts: { content: "...", ... } }
            posts = [responseData.posts as AmbientPostItem];
          }
        }
      }

      // Log extraction details on first attempt for monitoring
      if (attempt === 0) {
        logger.info(
          'Ambient posts extraction',
          {
            postsLength: posts.length,
            samplePost: posts[0]
              ? {
                  hasPost: 'post' in posts[0],
                  hasTweet: 'tweet' in posts[0],
                  hasContent: 'content' in posts[0],
                  postType: typeof (posts[0] as Record<string, JsonValue>).post,
                  contentType: typeof (posts[0] as Record<string, JsonValue>)
                    .content,
                }
              : null,
          },
          'FeedGenerator'
        );
      }

      const filteredPosts = posts
        .filter((p) => {
          // Handle various content field names: post, tweet, or content
          const postContent = p.post || p.tweet || p.content;
          // Also handle case where content might be nested object (XML edge case)
          const contentValue =
            typeof postContent === 'object' && postContent !== null
              ? String(postContent)
              : postContent;
          return (
            contentValue &&
            typeof contentValue === 'string' &&
            contentValue.trim().length > 0
          );
        })
        .map((p) => {
          const rawContent = p.post || p.tweet || p.content;
          const content =
            typeof rawContent === 'object' && rawContent !== null
              ? String(rawContent)
              : rawContent;
          return {
            post: content || '',
            sentiment: p.sentiment ?? 0,
            clueStrength: p.clueStrength ?? 0.05,
            pointsToward: p.pointsToward ?? null,
          };
        });

      // Apply post-processing (hashtag/emoji stripping, name mapping) and validation
      const processedPosts = await Promise.all(
        filteredPosts.map(async (p) => {
          const processedPost = await this.postProcessContent(p.post);
          const validation = this.validatePostContent(processedPost, 'AMBIENT');
          return {
            post: validation.cleanContent,
            sentiment: p.sentiment,
            clueStrength: p.clueStrength,
            pointsToward: p.pointsToward,
            isValid: validation.isValid,
            violations: validation.violations,
          };
        })
      );

      // Check if any posts failed validation
      const invalidPosts = processedPosts.filter((p) => !p.isValid);
      if (invalidPosts.length > 0) {
        const violationCount = invalidPosts.reduce(
          (sum, p) => sum + p.violations.length,
          0
        );
        logger.warn(
          `Validation failed for ${invalidPosts.length} ambient post(s) (attempt ${attempt + 1}/${maxRetries})`,
          {
            violations: invalidPosts.flatMap((p) => p.violations),
            violationCount,
            attempt: attempt + 1,
          },
          'FeedGenerator'
        );

        // Retry if we haven't exhausted attempts
        if (attempt < maxRetries - 1) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          continue;
        }
      }

      // Filter to only valid posts
      const validPosts = processedPosts
        .filter((p) => p.isValid)
        .map((p) => ({
          post: p.post,
          sentiment: p.sentiment,
          clueStrength: p.clueStrength,
          pointsToward: p.pointsToward,
        }));

      const minRequired = Math.ceil(actors.length * 0.5);

      if (validPosts.length >= minRequired) {
        // Limit to requested count to match with actors
        return validPosts.slice(0, actors.length);
      }

      logger.warn(
        `Invalid ambient posts batch (attempt ${attempt + 1}/${maxRetries}). Expected ${actors.length}, got ${validPosts.length} valid (need ${minRequired}+)`,
        {
          attempt: attempt + 1,
          maxRetries,
          expected: actors.length,
          got: validPosts.length,
          minRequired,
        },
        'FeedGenerator'
      );
      if (attempt < maxRetries - 1) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }

    logger.error(
      `Failed to generate ambient posts batch after ${maxRetries} attempts. Returning empty batch.`,
      undefined,
      'FeedGenerator'
    );
    return [];
  }

  /**
   * Generate thread of replies
   * Actors respond to each other's posts
   * BATCHED: Generates all replies in ONE call
   */
  private async generateThread(
    day: number,
    existingPosts: FeedPost[],
    allActors: Actor[]
  ): Promise<FeedPost[]> {
    const thread: FeedPost[] = [];

    if (existingPosts.length === 0) return thread;

    // Pick a random post to reply to
    const originalPost =
      existingPosts[Math.floor(Math.random() * existingPosts.length)];
    if (!originalPost) return thread;

    // 1-3 people reply
    const postingActors = allActors.filter((a) => a.id !== originalPost.author);
    const repliers = shuffleArray(postingActors).slice(
      0,
      1 + Math.floor(Math.random() * 3)
    );

    if (repliers.length === 0) return thread;

    // ✅ PER-CHARACTER: Generate replies individually with full context
    const replyTasks = shuffleArray(repliers).map((replier) => async () => {
      const result = await this.generateReplyForCharacter(
        replier,
        originalPost,
        day
      );
      return result;
    });

    const replyResults = await rateLimitedParallel(replyTasks, 5, 100);
    const replies = replyResults
      .filter((r): r is NonNullable<typeof r> => r !== null)
      .map((replyContent) => {
        const replier = repliers.find((r) => r.id === replyContent.actorId);
        if (!replier) return null;
        return { ...replyContent, replier };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);

    replies.forEach(({ replier, ...replyContent }, i) => {
      if (!replier) return; // Skip if replier doesn't exist

      const baseTime = originalPost.timestamp.substring(0, 11);
      const hour = Number.parseInt(originalPost.timestamp.substring(11, 13));

      thread.push({
        id: `${originalPost.id}-reply-${replier.id}`,
        day,
        timestamp: `${baseTime}${String(hour + i).padStart(2, '0')}:${String(30 + i * 10).padStart(2, '0')}:00Z`,
        type: 'thread' as const,
        content: replyContent.post,
        author: replier.id,
        authorName: replier.name,
        replyTo: i === 0 ? originalPost.id : thread[thread.length - 1]?.id,
        sentiment: replyContent.sentiment,
        clueStrength: replyContent.clueStrength,
        pointsToward: replyContent.pointsToward,
      });
    });

    return thread;
  }

  /**
   * PER-CHARACTER: Generate reply for a single character with full context
   *
   * @description
   * Generates a reply from an actor responding to another actor's post.
   * Each character gets full context with entropy/variety in presentation.
   */
  private async generateReplyForCharacter(
    replier: Actor,
    originalPost: FeedPost,
    day: number
  ): Promise<{
    post: string;
    sentiment: number;
    clueStrength: number;
    pointsToward: boolean | null;
    actorId: string;
  } | null> {
    if (!this.llm) {
      return null;
    }

    // Build rich character context with all available data
    const { characterInfo, comprehensiveContext } =
      await this.buildRichCharacterContext(replier, day, []);
    const comprehensiveContextText =
      formatComprehensiveContext(comprehensiveContext);

    // Build full context with trending topics, current events, etc.
    const groupContext = this.actorGroupContexts.get(replier.id) || '';
    const relationshipContext = await this.getActorRelationships(replier.id);
    const fullCharacterContext = buildCharacterFeedContext({
      characterInfo,
      comprehensiveContext: comprehensiveContextText,
      trendingTopics: this.trendContext,
      recentPosts: groupContext || undefined,
    });

    const prompt = renderPrompt(replies, {
      originalPost: originalPost.content,
      originalAuthor: originalPost.authorName,
      characterName: replier.name,
      characterInfo: fullCharacterContext,
      relationshipContext: relationshipContext,
      ...this.buildActorPromptVars(replier),
      ...buildFilteredWorldContext(replier, this.worldContext),
    });

    const params = getPromptParams(replies);
    const maxRetries = 3;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const response = await this.llm.generateJSON<
        | {
            reply: {
              post: string;
              sentiment: number;
              clueStrength: number;
              pointsToward: boolean | null;
            };
          }
        | {
            response: {
              reply: {
                post: string;
                sentiment: number;
                clueStrength: number;
                pointsToward: boolean | null;
              };
            };
          }
      >(
        prompt,
        {
          properties: {
            reply: {
              type: 'object',
              properties: {
                post: { type: 'string' },
                sentiment: { type: 'number' },
                clueStrength: { type: 'number' },
                pointsToward: { type: 'boolean' },
              },
            },
          },
          required: ['reply'],
        },
        { ...params, promptType: 'feed_generate_reply_per_character' }
      );

      if (!response) {
        if (attempt < maxRetries - 1) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          continue;
        }
        return null;
      }

      const replyData =
        'response' in response && response.response
          ? (
              response.response as {
                reply: {
                  post: string;
                  sentiment: number;
                  clueStrength: number;
                  pointsToward: boolean | null;
                };
              }
            ).reply
          : (
              response as {
                reply: {
                  post: string;
                  sentiment: number;
                  clueStrength: number;
                  pointsToward: boolean | null;
                };
              }
            ).reply;

      if (
        !replyData?.post ||
        typeof replyData.post !== 'string' ||
        replyData.post.trim().length === 0
      ) {
        if (attempt < maxRetries - 1) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          continue;
        }
        return null;
      }

      const processedPost = await this.postProcessContent(
        replyData.post.trim()
      );
      const validation = this.validatePostContent(processedPost, 'REPLY');

      if (!validation.isValid) {
        if (attempt < maxRetries - 1) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          continue;
        }
        return null;
      }

      return {
        post: validation.cleanContent,
        sentiment: replyData.sentiment ?? 0,
        clueStrength: replyData.clueStrength ?? 0.5,
        pointsToward: replyData.pointsToward ?? null,
        actorId: replier.id,
      };
    }

    return null;
  }

  /**
   * @deprecated Use generateReplyForCharacter instead - generates per-character with full context
   * BATCHED: Generate replies for multiple actors in ONE call
   *
   * @internal Reserved for future batch processing optimization
   */
  // @ts-ignore TS6133 - Deprecated method kept for reference
  private async _generateRepliesBatch(
    actors: Actor[],
    originalPost: FeedPost
  ): Promise<
    Array<{
      post: string;
      sentiment: number;
      clueStrength: number;
      pointsToward: boolean | null;
    }>
  > {
    if (!this.llm || actors.length === 0) {
      return [];
    }

    const contexts = actors.map((actor) => {
      const state = this.actorStates.get(actor.id);
      const emotionalContext = state
        ? generateActorContext(
            state.mood,
            state.luck,
            originalPost.author,
            this.relationships,
            actor.id
          )
        : '';

      return { actor, emotionalContext };
    });

    const repliersList = contexts
      .map((ctx, i) => {
        const voiceContext = formatActorVoiceContext(ctx.actor);
        const replyBehavior = ctx.actor.personality?.includes('contrarian')
          ? 'Disagree or challenge the original post'
          : 'Consider your relationship with author when replying';

        return `
╔══════════════════════════════════════════════════════════════════╗
║ REPLIER ${i + 1}: ${ctx.actor.name.toUpperCase()}
╚══════════════════════════════════════════════════════════════════╝
   Identity: ${ctx.actor.description}
   ${ctx.emotionalContext}
${voiceContext}

   YOUR TASK: Reply to ${originalPost.authorName}'s post AS ${ctx.actor.name}.
   ${replyBehavior}
   RULES: Max 140 chars. NO hashtags. NO emojis.
   VOICE: Match the examples above. Sound like ${ctx.actor.name}.`;
      })
      .join('\n');

    const prompt = renderPrompt(replies, {
      originalAuthorName: originalPost.authorName,
      originalContent: originalPost.content,
      replierCount: actors.length.toString(),
      repliersList,
      ...(this.worldContext || {}),
    });

    const params = getPromptParams(replies);
    const maxRetries = 5;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const response = await this.llm.generateJSON<{
        replies: Array<{
          post?: string;
          tweet?: string;
          sentiment: number;
          clueStrength: number;
          pointsToward: boolean | null;
        }>;
      }>(
        prompt,
        undefined, // Don't validate schema to handle various response formats
        { ...params, promptType: 'feed_generate_replies_batch' }
      );

      if (!response || typeof response !== 'object') {
        logger.warn(
          `LLM returned null/undefined/invalid replies response (attempt ${attempt + 1}/${maxRetries})`,
          { type: typeof response },
          'FeedGenerator'
        );
        if (attempt < maxRetries - 1) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          continue;
        }
        return [];
      }

      // Handle XML nested structure: { replies: [...] } or { replies: { reply: [...] } } or { response: { replies: {...} } }
      type ReplyItem = {
        post?: string;
        tweet?: string;
        content?: string;
        sentiment: number;
        clueStrength: number;
        pointsToward: boolean | null;
      };
      let replies: ReplyItem[] = [];

      // Check if wrapped in response object first
      const responseData =
        'response' in response &&
        response.response &&
        typeof response.response === 'object'
          ? (response.response as {
              replies?:
                | ReplyItem[]
                | { reply?: ReplyItem[] | ReplyItem; replies?: ReplyItem[] };
            })
          : response;

      if ('replies' in responseData && responseData.replies) {
        if (Array.isArray(responseData.replies)) {
          replies = responseData.replies;
        } else if (typeof responseData.replies === 'object') {
          // Check various nested structures
          if ('reply' in responseData.replies) {
            const nested = responseData.replies.reply;
            replies = Array.isArray(nested) ? nested : nested ? [nested] : [];
          } else if (
            'replies' in responseData.replies &&
            Array.isArray(responseData.replies.replies)
          ) {
            // Double nested: { replies: { replies: [...] } }
            replies = responseData.replies.replies;
          } else if (
            'content' in responseData.replies ||
            'post' in responseData.replies
          ) {
            // Single reply returned directly: { replies: { content/post: "...", ... } }
            replies = [responseData.replies as ReplyItem];
          }
        }
      } else if ('reply' in responseData) {
        // LLM returned singular 'reply' instead of 'replies'
        const replyData = (
          responseData as {
            reply: ReplyItem[] | ReplyItem | { reply: ReplyItem[] | ReplyItem };
          }
        ).reply;
        if (Array.isArray(replyData)) {
          replies = replyData;
        } else if (replyData && typeof replyData === 'object') {
          if ('reply' in replyData) {
            // Nested: { reply: { reply: [...] } }
            const nested = (replyData as { reply: ReplyItem[] | ReplyItem })
              .reply;
            replies = Array.isArray(nested) ? nested : nested ? [nested] : [];
          } else if ('post' in replyData || 'content' in replyData) {
            // Single reply: { reply: { post: "...", ... } }
            replies = [replyData as ReplyItem];
          }
        }
      }

      // Log extraction details on first attempt for monitoring
      if (attempt === 0) {
        logger.info(
          'Replies extraction',
          {
            repliesLength: replies.length,
            responseKeys: Object.keys(responseData),
            hasReplies: 'replies' in responseData,
            hasReply: 'reply' in responseData,
            sampleReply: replies[0]
              ? {
                  hasPost: 'post' in replies[0],
                  hasTweet: 'tweet' in replies[0],
                  hasContent: 'content' in replies[0],
                  postType: typeof (replies[0] as Record<string, JsonValue>)
                    .post,
                  contentType: typeof (replies[0] as Record<string, JsonValue>)
                    .content,
                }
              : null,
          },
          'FeedGenerator'
        );
      }

      // Type helper for replies that may have different content field names
      const filteredReplies = replies
        .filter((r): r is ReplyItem => {
          // Handle various content field names: post, tweet, or content
          const replyContent = r.post || r.tweet || r.content;
          // Also handle case where content might be nested object (XML edge case)
          const contentValue =
            typeof replyContent === 'object' && replyContent !== null
              ? String(replyContent)
              : replyContent;
          return Boolean(
            contentValue &&
              typeof contentValue === 'string' &&
              contentValue.trim().length > 0
          );
        })
        .map((r) => {
          const rawContent = r.post || r.tweet || r.content;
          const content =
            typeof rawContent === 'object' && rawContent !== null
              ? String(rawContent)
              : rawContent;
          return {
            post: content || '',
            sentiment: r.sentiment ?? 0,
            clueStrength: r.clueStrength ?? 0.3,
            pointsToward: r.pointsToward ?? null,
          };
        });

      // Apply post-processing (hashtag/emoji stripping, name mapping) and validation
      const processedReplies = await Promise.all(
        filteredReplies.map(async (r) => {
          const processedPost = await this.postProcessContent(r.post);
          const validation = this.validatePostContent(processedPost, 'REPLY');
          return {
            post: validation.cleanContent,
            sentiment: r.sentiment,
            clueStrength: r.clueStrength,
            pointsToward: r.pointsToward,
            isValid: validation.isValid,
            violations: validation.violations,
          };
        })
      );

      // Check if any replies failed validation
      const invalidReplies = processedReplies.filter((r) => !r.isValid);
      if (invalidReplies.length > 0) {
        const violationCount = invalidReplies.reduce(
          (sum, r) => sum + r.violations.length,
          0
        );
        logger.warn(
          `Validation failed for ${invalidReplies.length} reply/replies (attempt ${attempt + 1}/${maxRetries})`,
          {
            violations: invalidReplies.flatMap((r) => r.violations),
            violationCount,
            attempt: attempt + 1,
          },
          'FeedGenerator'
        );

        // Retry if we haven't exhausted attempts
        if (attempt < maxRetries - 1) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          continue;
        }
      }

      // Filter to only valid replies
      const validReplies = processedReplies
        .filter((r) => r.isValid)
        .map((r) => ({
          post: r.post,
          sentiment: r.sentiment,
          clueStrength: r.clueStrength,
          pointsToward: r.pointsToward,
        }));

      const minRequired = Math.ceil(actors.length * 0.5);

      if (validReplies.length >= minRequired) {
        // Limit to requested count to match with actors
        return validReplies.slice(0, actors.length);
      }

      logger.warn(
        `Invalid replies batch (attempt ${attempt + 1}/${maxRetries}). Expected ${actors.length}, got ${validReplies.length} valid (need ${minRequired}+)`,
        {
          attempt: attempt + 1,
          maxRetries,
          expected: actors.length,
          got: validReplies.length,
          minRequired,
        },
        'FeedGenerator'
      );
      if (attempt < maxRetries - 1) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }

    logger.error(
      `Failed to generate valid replies batch after ${maxRetries} attempts. Returning empty batch.`,
      undefined,
      'FeedGenerator'
    );
    return [];
  }

  /**
   * Generate feed posts for stock price movements
   * Creates company announcements, ticker posts, and analyst reactions
   * Public for external use by price engines
   */
  public async generateEconomicFeedPosts(
    priceUpdate: PriceUpdate,
    company: Organization,
    day: number,
    allActors: Actor[]
  ): Promise<FeedPost[]> {
    if (!this.llm) {
      return [];
    }

    const posts: FeedPost[] = [];
    const baseTime = `2025-10-${String(day).padStart(2, '0')}T`;
    const direction = priceUpdate.change > 0 ? 'up' : 'down';
    const phaseContext = buildPhaseContext(day);

    // Only generate posts for significant price movements (>2%)
    if (Math.abs(priceUpdate.changePercent) < 2) {
      return [];
    }

    // Finance prompts use WORLD_CONTEXT_HEADER_WITH_TRADES which needs recentTrades.
    // Generate a trade-inclusive context for this method since the shared
    // this.worldContext is trade-free by default.
    const economicWorldContext = await generateWorldContext({
      maxActors: 50,
      includeTrades: true,
    });

    // 1. Company announcement (for major moves >5%)
    if (Math.abs(priceUpdate.changePercent) >= 5) {
      const prompt = renderPrompt(priceAnnouncement, {
        companyName: company.name,
        priceChange: priceUpdate.change.toFixed(2),
        direction,
        currentPrice: priceUpdate.newPrice.toFixed(2),
        eventDescription: priceUpdate.reason,
        phaseContext,
        ...economicWorldContext,
      });

      const params = getPromptParams(priceAnnouncement);
      const rawResponse = await this.llm.generateJSON<
        | {
            post: string;
            sentiment: number;
          }
        | { response: { post: string; sentiment: number } }
      >(prompt, undefined, {
        ...params,
        promptType: 'feed_generate_price_announcement',
      });

      // Handle XML structure
      const response =
        'response' in rawResponse && rawResponse.response
          ? rawResponse.response
          : (rawResponse as { post: string; sentiment: number });

      const processedPost = await this.postProcessContent(response.post);
      posts.push({
        id: `${company.id}-price-announcement-${day}`,
        day,
        timestamp: `${baseTime}${String(9 + Math.floor(Math.random() * 2)).padStart(2, '0')}:${String(Math.floor(Math.random() * 60)).padStart(2, '0')}:00Z`,
        type: 'news',
        content: processedPost,
        author: company.id,
        authorName: company.name,
        sentiment: response.sentiment,
        clueStrength: 0,
        pointsToward: null,
      });
    }

    // 2. Stock ticker style post (always for significant moves)
    // Build market event context from recent company-related events
    const recentCompanyEvents = this._allPreviousEvents
      .filter(
        (e) =>
          e.actors?.includes(company.id) || e.actors?.includes(company.name)
      )
      .slice(-3)
      .map((e) => `- ${e.description}`)
      .join('\n');
    const companyNarrative = this._allPreviousPosts
      .filter((p) => p.author === company.id)
      .slice(-2)
      .map((p) => `- "${p.content}"`)
      .join('\n');

    const tickerPrompt = renderPrompt(stockTicker, {
      ticker: company.id.toUpperCase().slice(0, 4),
      companyName: company.name,
      currentPrice: priceUpdate.newPrice.toFixed(2),
      priceChange: priceUpdate.change.toFixed(2),
      direction,
      volume: Math.floor(Math.random() * 1000000 + 500000).toString(),
      eventCatalyst: priceUpdate.reason || 'Market activity',
      connectedNarrative: companyNarrative || 'No recent company narrative.',
      recentMarketEvents: recentCompanyEvents || 'No recent market events.',
      ...economicWorldContext,
    });

    const tickerParams = getPromptParams(stockTicker);
    const rawTickerResponse = await this.llm.generateJSON<
      | {
          post: string;
          sentiment: number;
        }
      | { response: { post: string; sentiment: number } }
    >(tickerPrompt, undefined, {
      ...tickerParams,
      promptType: 'feed_generate_stock_ticker',
    });

    // Handle XML structure
    const tickerResponse =
      'response' in rawTickerResponse && rawTickerResponse.response
        ? rawTickerResponse.response
        : (rawTickerResponse as { post: string; sentiment: number });

    const processedTickerPost = await this.postProcessContent(
      tickerResponse.post
    );
    posts.push({
      id: `${company.id}-ticker-${day}`,
      day,
      timestamp: `${baseTime}${String(9 + Math.floor(Math.random() * 3)).padStart(2, '0')}:${String(Math.floor(Math.random() * 60)).padStart(2, '0')}:00Z`,
      type: 'news',
      content: processedTickerPost,
      author: 'market-ticker',
      authorName: 'Market Ticker',
      sentiment: tickerResponse.sentiment,
      clueStrength: 0,
      pointsToward: null,
    });

    // 3. Analyst reactions (1-2 analysts for major moves)
    if (Math.abs(priceUpdate.changePercent) >= 3) {
      const analysts = allActors
        .filter(
          (a) =>
            a.domain?.includes('finance') ||
            a.domain?.includes('business') ||
            a.description?.toLowerCase().includes('analyst')
        )
        .slice(0, Math.abs(priceUpdate.changePercent) >= 5 ? 2 : 1);

      for (const analyst of analysts) {
        const state = this.actorStates.get(analyst.id);

        // Build analyst context from track record and history
        const tr = analyst.trackRecord;
        const builtTrackRecord = tr
          ? `Accuracy: ${((tr.historicalAccuracy || 0) * 100).toFixed(0)}% (${tr.accuratePosts || 0}/${tr.totalPosts || 0} calls)`
          : '';
        const analystPrev = this._allPreviousPosts
          .filter((p) => p.author === analyst.id)
          .slice(-3)
          .map((p) => `- "${p.content}"`)
          .join('\n');
        const relCompanyEvts = this._allPreviousEvents
          .filter(
            (e) =>
              e.actors?.includes(company.id) || e.actors?.includes(company.name)
          )
          .slice(-3)
          .map((e) => `- ${e.description}`)
          .join('\n');

        const prompt = renderPrompt(analystReaction, {
          analystName: analyst.name,
          analystDescription: analyst.description || '',
          analystTrackRecord: builtTrackRecord,
          previousCalls: analystPrev || 'No previous calls.',
          companyName: company.name,
          priceChange: Math.abs(priceUpdate.changePercent).toFixed(1),
          direction,
          eventDescription: priceUpdate.reason,
          relatedEvents: relCompanyEvts || 'No recent related events.',
          mood: state
            ? state.mood > 0
              ? 'optimistic'
              : state.mood < 0
                ? 'pessimistic'
                : 'neutral'
            : 'neutral',
          phaseContext,
          ...economicWorldContext,
        });

        const analystParams = getPromptParams(analystReaction);
        const rawResponse = await this.llm.generateJSON<
          | {
              post: string;
              sentiment: number;
            }
          | { response: { post: string; sentiment: number } }
        >(prompt, undefined, {
          ...analystParams,
          promptType: 'feed_generate_analyst_reaction',
        });

        // Handle XML structure
        const response =
          'response' in rawResponse && rawResponse.response
            ? rawResponse.response
            : (rawResponse as { post: string; sentiment: number });

        const processedAnalystPost = await this.postProcessContent(
          response.post
        );
        posts.push({
          id: `${analyst.id}-analyst-${company.id}-${day}`,
          day,
          timestamp: `${baseTime}${String(10 + Math.floor(Math.random() * 3)).padStart(2, '0')}:${String(Math.floor(Math.random() * 60)).padStart(2, '0')}:00Z`,
          type: 'post',
          content: processedAnalystPost,
          author: analyst.id,
          authorName: analyst.name,
          sentiment: response.sentiment,
          clueStrength: 0,
          pointsToward: null,
        });
      }
    }

    return posts;
  }

  /**
   * Generate a day transition post marking the start of a new day
   * Creates a narrative summary that acknowledges the previous day and sets tone for today
   * Public for external use by game generators
   */
  public async generateDayTransitionPost(
    day: number,
    previousDayEvents: WorldEvent[],
    questions: Question[],
    allActors: Actor[]
  ): Promise<FeedPost | null> {
    if (!this.llm || day === 1) {
      return null; // No transition post for day 1
    }

    const baseTime = `2025-10-${String(day).padStart(2, '0')}T06:00:00Z`; // Early morning transition
    const phaseContext = buildPhaseContext(day);
    const phaseName = getPhaseForDay(day);

    // Format yesterday's key events
    const eventsContext = previousDayEvents
      .slice(0, 3) // Top 3 events
      .map((e) => `- ${e.description}`)
      .join('\n');

    // Format active questions
    const questionsContext = questions
      .filter((q) => !q.status || q.status === 'active')
      .slice(0, 3) // Top 3 questions
      .map((q) => `- ${q.text}`)
      .join('\n');

    // Format key actors (top tier actors)
    const keyActors = allActors
      .filter((a) => a.tier === 'S_TIER' || a.tier === 'A_TIER')
      .slice(0, 5)
      .map((a) => a.name)
      .join(', ');

    // Ensure world context is available
    if (!this.worldContext) {
      this.worldContext = await generateWorldContext({ maxActors: 50 });
    }

    const prompt = renderPrompt(dayTransition, {
      day: day.toString(),
      previousDay: (day - 1).toString(),
      phaseName,
      phaseContext,
      previousDayEvents: eventsContext || 'None',
      yesterdayHighlights: eventsContext || 'None',
      yesterdayResolutions: questionsContext || 'None resolved',
      activeQuestions: questionsContext || 'No active questions',
      keyActors: keyActors || 'Various industry figures',
      ...(this.worldContext || {}),
    });

    const params = getPromptParams(dayTransition);
    const rawResponse = await this.llm.generateJSON<
      | {
          event: string;
          type: string;
          tone: string;
        }
      | { response: { event: string; type: string; tone: string } }
    >(prompt, undefined, {
      ...params,
      promptType: 'feed_generate_day_transition',
    });

    // Handle XML structure
    const response =
      'response' in rawResponse && rawResponse.response
        ? rawResponse.response
        : (rawResponse as { event: string; type: string; tone: string });

    const processedEvent = await this.postProcessContent(response.event);
    return {
      id: `day-transition-${day}`,
      day,
      timestamp: baseTime,
      type: 'news',
      content: processedEvent,
      author: 'game-narrator',
      authorName: 'Game Narrator',
      sentiment: 0,
      clueStrength: 0,
      pointsToward: null,
    };
  }

  /**
   * Generate a feed post announcing a question resolution
   * Creates a public announcement when a prediction market question resolves
   * Public for external use by game generators
   */
  public async generateQuestionResolutionPost(
    question: Question,
    resolutionEventDescription: string,
    day: number,
    winningPercentage = 50
  ): Promise<FeedPost | null> {
    if (!this.llm) {
      return null;
    }

    const baseTime = `2025-10-${String(day).padStart(2, '0')}T20:00:00Z`;
    const outcomeText = question.resolvedOutcome ? 'YES' : 'NO';

    // Ensure world context is available
    if (!this.worldContext) {
      this.worldContext = await generateWorldContext({ maxActors: 50 });
    }

    // Build market impact context from resolution data
    const marketImpact =
      winningPercentage > 70
        ? `Strong consensus (${winningPercentage.toFixed(0)}% predicted correctly). Markets expected this.`
        : winningPercentage < 30
          ? `Surprise outcome — only ${winningPercentage.toFixed(0)}% predicted correctly. Markets caught off guard.`
          : `Split market — ${winningPercentage.toFixed(0)}% predicted correctly. Mixed reactions expected.`;

    const prompt = renderPrompt(questionResolvedFeed, {
      questionText: question.text,
      outcome: outcomeText,
      resolutionEvent: resolutionEventDescription,
      winningPercentage: winningPercentage.toFixed(0),
      marketImpact,
      ...(this.worldContext || {}),
    });

    const params = getPromptParams(questionResolvedFeed);
    const rawResponse = await this.llm.generateJSON<
      | {
          post: string;
          sentiment: number;
        }
      | { response: { post: string; sentiment: number } }
    >(prompt, undefined, {
      ...params,
      promptType: 'feed_generate_question_resolution',
    });

    // Handle XML structure
    const response =
      'response' in rawResponse && rawResponse.response
        ? rawResponse.response
        : (rawResponse as { post: string; sentiment: number });

    const processedPost = await this.postProcessContent(response.post);
    return {
      id: `question-resolved-${question.id}-${day}`,
      day,
      timestamp: baseTime,
      type: 'news',
      content: processedPost,
      author: 'market-oracle',
      authorName: 'Market Oracle',
      sentiment: response.sentiment,
      clueStrength: 0,
      pointsToward: null,
    };
  }

  /**
   * Generate minute-level ambient post for continuous mode
   * Uses actor personality and current context for realistic posts
   */
  public async generateMinuteAmbientPost(
    actor: {
      id: string;
      name: string;
      description?: string;
      role?: string;
      mood?: number;
    },
    timestamp: Date
  ): Promise<{ content: string; sentiment: number; energy: number }> {
    const hour = timestamp.getHours();
    const formattedTime = timestamp.toLocaleString('en-US', {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });

    const emotionalContext = actor.mood
      ? `Current mood: ${actor.mood > 0 ? 'positive' : actor.mood < 0 ? 'negative' : 'neutral'}`
      : '';

    const atmosphereContext = '';

    // Ensure world context is available
    if (!this.worldContext) {
      this.worldContext = await generateWorldContext({ maxActors: 50 });
    }

    const prompt = renderPrompt(minuteAmbient, {
      actorName: actor.name,
      actorDescription:
        actor.description || actor.role || 'industry professional',
      emotionalContext,
      atmosphereContext,
      timeEnergy: getTimeOfDayEnergy(hour),
      recentEventsContext: '',
      ...buildFilteredWorldContext(
        StaticDataRegistry.getActor(actor.id) ?? { domain: [] },
        this.worldContext
      ),
      // Override currentTime with formatted version for this specific prompt
      currentTime: formattedTime,
    });

    if (!this.llm) {
      logger.warn(
        'LLM not available for ambient post generation',
        undefined,
        'FeedGenerator'
      );
      return {
        content: 'Interesting day in the markets.',
        sentiment: 0,
        energy: 0.5,
      };
    }

    const params = getPromptParams(minuteAmbient);
    const rawResponse = await this.llm.generateJSON<
      | {
          post: string;
          sentiment: number;
          energy: number;
        }
      | { response: { post: string; sentiment: number; energy: number } }
    >(prompt, undefined, {
      ...params,
      promptType: 'feed_generate_minute_ambient',
    });

    // Handle XML structure
    const response =
      'response' in rawResponse && rawResponse.response
        ? rawResponse.response
        : (rawResponse as { post: string; sentiment: number; energy: number });

    const processedPost = await this.postProcessContent(response.post);
    return {
      content: processedPost,
      sentiment: response.sentiment,
      energy: response.energy,
    };
  }
}
