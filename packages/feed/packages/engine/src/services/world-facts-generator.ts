/**
 * World Facts Generator Service
 *
 * Automatically generates new world facts and context from game events,
 * market activity, and question resolutions. Keeps the game world fresh
 * and prevents content repetition.
 *
 * @module services/world-facts-generator
 */

import {
  and,
  db,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  lte,
  posts,
  questions,
  sql,
  worldEvents,
  worldFacts,
} from '@feed/db';
import { generateSnowflakeId, logger } from '@feed/shared';
import { FeedLLMClient } from '../llm/openai-client';
import { shuffleArray } from '../utils/randomization';
import { validateCoherence } from './content-grounding-validator';
import { ContentQualityGate } from './content-quality-gate';
import { StaticDataRegistry } from './static-data-registry';

interface GeneratedFact {
  text: string;
  sourceContext: string;
  depth: number;
}

/**
 * Configuration for world facts generation
 */
export interface WorldFactsGenerationConfig {
  /** Maximum new facts to generate per update */
  maxFactsPerUpdate: number;
  /** Maximum age of facts to keep (in days) */
  maxFactAgeDays: number;
  /** Minimum facts to maintain active */
  minActiveFacts: number;
}

const DEFAULT_CONFIG: WorldFactsGenerationConfig = {
  maxFactsPerUpdate: 10,
  maxFactAgeDays: 7,
  minActiveFacts: 20,
};

/**
 * World Facts Generator Service
 *
 * Creates dynamic world context based on game activity to prevent
 * content staleness and repetition.
 */
export class WorldFactsGeneratorService {
  private config: WorldFactsGenerationConfig;
  private llm: FeedLLMClient;

  constructor(
    config: Partial<WorldFactsGenerationConfig> = {},
    llm?: FeedLLMClient
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.llm = llm ?? FeedLLMClient.forGameTick();
  }

  /**
   * Generate new world facts from recent game activity
   *
   * This is the main entry point - call this periodically (e.g., every 12 hours)
   * to keep the world context fresh.
   */
  async generateNewWorldFacts(): Promise<{
    generated: number;
    archived: number;
    sources: {
      events: number;
      markets: number;
      questions: number;
      actors: number;
    };
  }> {
    const startTime = Date.now();
    logger.info(
      'Starting world facts generation',
      undefined,
      'WorldFactsGenerator'
    );

    // Gather context from different sources
    const [eventFacts, marketFacts, questionFacts, actorFacts] =
      await Promise.all([
        this.generateFactsFromEvents(),
        this.generateFactsFromMarketActivity(),
        this.generateFactsFromQuestions(),
        this.generateFactsFromActorActivity(),
      ]);

    // Combine and deduplicate
    const allNewFacts: GeneratedFact[] = [
      ...eventFacts,
      ...marketFacts,
      ...questionFacts,
      ...actorFacts,
    ];

    // Store the new facts
    let storedCount = 0;
    for (const fact of allNewFacts.slice(0, this.config.maxFactsPerUpdate)) {
      try {
        await this.storeFact(fact);
        storedCount++;
      } catch (error) {
        logger.warn(
          'Failed to store world fact',
          { fact: fact.text, error },
          'WorldFactsGenerator'
        );
      }
    }

    // Archive old facts
    const archivedCount = await this.archiveOldFacts();

    const duration = Date.now() - startTime;
    logger.info(
      'World facts generation complete',
      {
        generated: storedCount,
        archived: archivedCount,
        duration,
        sources: {
          events: eventFacts.length,
          markets: marketFacts.length,
          questions: questionFacts.length,
          actors: actorFacts.length,
        },
      },
      'WorldFactsGenerator'
    );

    return {
      generated: storedCount,
      archived: archivedCount,
      sources: {
        events: eventFacts.length,
        markets: marketFacts.length,
        questions: questionFacts.length,
        actors: actorFacts.length,
      },
    };
  }

  /**
   * Generate facts from recent world events
   * Uses 48-hour window to capture more activity across game day boundaries
   */
  private async generateFactsFromEvents(): Promise<GeneratedFact[]> {
    const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);

    const recentEvents = await db
      .select({
        id: worldEvents.id,
        description: worldEvents.description,
        eventType: worldEvents.eventType,
        visibility: worldEvents.visibility,
        timestamp: worldEvents.timestamp,
      })
      .from(worldEvents)
      .where(
        and(
          gte(worldEvents.timestamp, twoDaysAgo),
          eq(worldEvents.visibility, 'public')
        )
      )
      .orderBy(desc(worldEvents.timestamp))
      .limit(10);

    if (recentEvents.length === 0) {
      return [];
    }

    // Use LLM to synthesize events into world facts
    const eventDescriptions = recentEvents
      .map((e) => `- ${e.description}`)
      .join('\n');
    const sourceContext = eventDescriptions;

    const prompt = `Based on these recent events in our satirical AI-powered world, generate 2-3 world facts that capture the current state of affairs. These facts should be reusable context for future content generation.

RECENT EVENTS:
${eventDescriptions}

Generate facts that:
- Summarize trends or developments (not individual events)
- Can be used as context for market discussions, NPC posts, and news articles
- Feel like "background knowledge" about the current world state
- Use parody names (Sam AIltman, Jensen HuAIng, OpenAGI, NVAIDAI, etc.)
- Cover DIVERSE themes — not just tech or crypto (include politics, science, culture)

Return as XML:
<response>
  <facts>
    <fact>First world fact here</fact>
    <fact>Second world fact here</fact>
  </facts>
</response>`;

    try {
      const response = await this.llm.generateJSON<
        { facts: string[] } | { response: { facts: string[] } }
      >(
        prompt,
        {
          properties: {
            facts: {
              type: 'array',
              items: { type: 'string' },
            },
          },
          required: ['facts'],
        },
        {
          temperature: 0.8,
          maxTokens: 500,
          format: 'xml',
          promptType: 'world_facts_from_events',
        }
      );

      const facts =
        'response' in response ? response.response.facts : response.facts;
      return Array.isArray(facts)
        ? facts
            .filter((f) => f && f.length > 10)
            .map((f) => ({ text: f, sourceContext, depth: 1 }))
        : [];
    } catch (error) {
      logger.error(
        'Failed to generate facts from events',
        { error },
        'WorldFactsGenerator'
      );
      return [];
    }
  }

  /**
   * Generate facts from market activity and trends
   */
  private async generateFactsFromMarketActivity(): Promise<GeneratedFact[]> {
    // Get active questions with market data
    const activeQuestions = await db
      .select({
        id: questions.id,
        text: questions.text,
        status: questions.status,
        createdAt: questions.createdAt,
      })
      .from(questions)
      .where(eq(questions.status, 'active'))
      .orderBy(desc(questions.createdAt))
      .limit(5);

    if (activeQuestions.length === 0) {
      return [];
    }

    const questionList = activeQuestions.map((q) => `- "${q.text}"`).join('\n');
    const sourceContext = questionList;

    const prompt = `Based on these active prediction markets in our satirical AI world, generate 1-2 world facts about what people are betting on and the current mood/sentiment.

ACTIVE PREDICTION MARKETS:
${questionList}

Generate facts that:
- Capture what the market is focused on
- Reflect the speculative nature of the world
- Can be used as context for discussions
- Use parody names (Sam AIltman, Jensen HuAIng, OpenAGI, NVAIDAI, etc.)
- Avoid fixating on one character — spread mentions across different actors

Return as XML:
<response>
  <facts>
    <fact>Market sentiment or trend fact here</fact>
  </facts>
</response>`;

    try {
      const response = await this.llm.generateJSON<
        { facts: string[] } | { response: { facts: string[] } }
      >(
        prompt,
        {
          properties: {
            facts: {
              type: 'array',
              items: { type: 'string' },
            },
          },
          required: ['facts'],
        },
        {
          temperature: 0.8,
          maxTokens: 400,
          format: 'xml',
          promptType: 'world_facts_from_markets',
        }
      );

      const facts =
        'response' in response ? response.response.facts : response.facts;
      return Array.isArray(facts)
        ? facts
            .filter((f) => f && f.length > 10)
            .map((f) => ({ text: f, sourceContext, depth: 1 }))
        : [];
    } catch (error) {
      logger.error(
        'Failed to generate facts from markets',
        { error },
        'WorldFactsGenerator'
      );
      return [];
    }
  }

  /**
   * Generate facts from recently resolved questions
   * Uses 7-day window to capture more question resolutions
   */
  private async generateFactsFromQuestions(): Promise<GeneratedFact[]> {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const recentlyResolved = await db
      .select({
        id: questions.id,
        text: questions.text,
        outcome: questions.outcome,
        resolutionDate: questions.resolutionDate,
      })
      .from(questions)
      .where(
        and(
          eq(questions.status, 'resolved'),
          gte(questions.resolutionDate, sevenDaysAgo)
        )
      )
      .orderBy(desc(questions.resolutionDate))
      .limit(5);

    if (recentlyResolved.length === 0) {
      return [];
    }

    const facts: GeneratedFact[] = [];
    for (const q of recentlyResolved) {
      // Skip items with null/undefined outcomes
      if (q.outcome == null) {
        continue;
      }
      // Skip incoherent question text — catches hallucinated or garbled content
      const coherence = validateCoherence(q.text);
      if (!coherence.grounded) {
        logger.warn(
          'Skipping incoherent question text for world fact',
          {
            questionId: q.id,
            text: q.text.substring(0, 80),
            reasons: coherence.reasons,
          },
          'WorldFactsGenerator'
        );
        continue;
      }
      const outcomeText = q.outcome ? 'YES' : 'NO';
      facts.push({
        text: `The prediction market "${q.text}" resolved to ${outcomeText}, which has implications for related markets and discussions.`,
        sourceContext: q.text,
        depth: 1,
      });
    }

    return facts.slice(0, 2);
  }

  /**
   * Generate facts about actor activities and relationships
   * Uses 48-hour window to capture more actor activity
   */
  private async generateFactsFromActorActivity(): Promise<GeneratedFact[]> {
    // Get recent posts from main actors
    const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);

    // Get actors from S/A/B tiers, shuffled for rotation across cycles
    const mainActors = shuffleArray(
      StaticDataRegistry.getAllActors().filter(
        (a) =>
          a.role === 'main' ||
          a.tier === 'S_TIER' ||
          a.tier === 'A_TIER' ||
          a.tier === 'B_TIER'
      )
    ).slice(0, 8);

    if (mainActors.length === 0) {
      return [];
    }

    const actorIds = mainActors.map((a) => a.id);

    // Get their recent posts (filter by actorIds in the query to avoid unnecessary data transfer)
    const actorPosts = await db
      .select({
        content: posts.content,
        authorId: posts.authorId,
      })
      .from(posts)
      .where(
        and(
          gte(posts.timestamp, twoDaysAgo),
          isNull(posts.deletedAt),
          inArray(posts.authorId, actorIds)
        )
      )
      .orderBy(desc(posts.timestamp))
      .limit(20);

    if (actorPosts.length === 0) {
      return [];
    }

    const postSamples = actorPosts
      .slice(0, 5)
      .map((p) => `- ${p.content.substring(0, 100)}...`)
      .join('\n');
    const sourceContext = postSamples;

    const prompt = `Based on recent activity from key figures in our satirical AI world, generate 1-2 world facts about current topics of discussion or emerging narratives.

RECENT POSTS FROM KEY FIGURES:
${postSamples}

Generate facts that:
- Capture what the key figures are focused on
- Identify emerging topics or debates
- Can be used as context for other content
- Use parody names (Sam AIltman, Jensen HuAIng, OpenAGI, NVAIDAI, etc.)
- Spread attention across different characters and themes

Return as XML:
<response>
  <facts>
    <fact>Topic or narrative fact here</fact>
  </facts>
</response>`;

    try {
      const response = await this.llm.generateJSON<
        { facts: string[] } | { response: { facts: string[] } }
      >(
        prompt,
        {
          properties: {
            facts: {
              type: 'array',
              items: { type: 'string' },
            },
          },
          required: ['facts'],
        },
        {
          temperature: 0.8,
          maxTokens: 400,
          format: 'xml',
          promptType: 'world_facts_from_actors',
        }
      );

      const facts =
        'response' in response ? response.response.facts : response.facts;
      // Depth 2: actor posts are LLM-generated, so facts derived from them
      // are second-generation content and excluded from prompt context
      return Array.isArray(facts)
        ? facts
            .filter((f) => f && f.length > 10)
            .map((f) => ({ text: f, sourceContext, depth: 2 }))
        : [];
    } catch (error) {
      logger.error(
        'Failed to generate facts from actors',
        { error },
        'WorldFactsGenerator'
      );
      return [];
    }
  }

  /**
   * Store a new world fact in the database after quality validation.
   * Skips the fact (no insert) if it fails the quality gate.
   */
  private async storeFact(fact: GeneratedFact): Promise<void> {
    const { text: value, sourceContext, depth } = fact;

    // Quality gate: validate before insert (with source context for grounding)
    const quality = await ContentQualityGate.validateWorldFact(
      value,
      sourceContext
    );
    if (!quality.passed) {
      logger.warn(
        'World fact failed quality gate — skipping',
        {
          value: value.substring(0, 100),
          score: quality.score.toFixed(2),
          reasons: quality.reasons,
        },
        'WorldFactsGenerator'
      );
      return;
    }

    // Generate a key from the first few words
    let keyWords = value
      .toLowerCase()
      .split(/\s+/)
      .slice(0, 5)
      .join('_')
      .replace(/[^a-z0-9_]/g, '')
      .substring(0, 50);

    // Fallback if keyWords is empty (e.g., value has only non-alphanumerics)
    if (!keyWords) {
      // Use a short hash derived from the value for uniqueness
      const hash = value
        .split('')
        .reduce((acc, char) => ((acc << 5) - acc + char.charCodeAt(0)) | 0, 0);
      keyWords = `fact_${Math.abs(hash).toString(36)}`;
    }

    const key = `dynamic_${keyWords}_${Date.now()}`;
    const label = value.length > 60 ? `${value.substring(0, 57)}...` : value;

    await db.insert(worldFacts).values({
      id: await generateSnowflakeId(),
      category: 'general',
      key,
      label,
      value,
      source: 'auto-generated',
      priority: 0,
      qualityScore: quality.score,
      generationDepth: depth,
      isActive: true,
      lastUpdated: new Date(),
      updatedAt: new Date(),
    });
  }

  /**
   * Archive old facts to keep the context fresh
   */
  private async archiveOldFacts(): Promise<number> {
    const cutoffDate = new Date(
      Date.now() - this.config.maxFactAgeDays * 24 * 60 * 60 * 1000
    );

    // First check how many active facts we have
    const [activeFactsResult] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(worldFacts)
      .where(eq(worldFacts.isActive, true));

    const activeCount = activeFactsResult?.count ?? 0;

    // Only archive if we have more than the minimum
    if (activeCount <= this.config.minActiveFacts) {
      logger.debug(
        'Skipping archive - below minimum active facts',
        { activeCount, minRequired: this.config.minActiveFacts },
        'WorldFactsGenerator'
      );
      return 0;
    }

    // Archive old auto-generated facts
    const result = await db
      .update(worldFacts)
      .set({ isActive: false })
      .where(
        and(
          eq(worldFacts.source, 'auto-generated'),
          eq(worldFacts.isActive, true),
          lte(worldFacts.createdAt, cutoffDate)
        )
      )
      .returning({ id: worldFacts.id });

    return result.length;
  }

  /**
   * Generate a quick summary of the current world state
   * Useful for status checks
   */
  async getWorldFactsStats(): Promise<{
    totalActive: number;
    autoGenerated: number;
    manual: number;
    oldestFact: Date | null;
    newestFact: Date | null;
  }> {
    const [totalResult, autoResult, facts] = await Promise.all([
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(worldFacts)
        .where(eq(worldFacts.isActive, true)),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(worldFacts)
        .where(
          and(
            eq(worldFacts.isActive, true),
            eq(worldFacts.source, 'auto-generated')
          )
        ),
      db
        .select({ createdAt: worldFacts.createdAt })
        .from(worldFacts)
        .where(eq(worldFacts.isActive, true))
        .orderBy(desc(worldFacts.createdAt)),
    ]);

    const total = totalResult[0]?.count ?? 0;
    const auto = autoResult[0]?.count ?? 0;

    return {
      totalActive: total,
      autoGenerated: auto,
      manual: total - auto,
      oldestFact: facts.length > 0 ? facts[facts.length - 1]!.createdAt : null,
      newestFact: facts.length > 0 ? facts[0]!.createdAt : null,
    };
  }
}

// Singleton instance
export const worldFactsGenerator = new WorldFactsGeneratorService();

/**
 * Create a custom world facts generator
 */
export function createWorldFactsGenerator(
  config?: Partial<WorldFactsGenerationConfig>,
  llm?: FeedLLMClient
): WorldFactsGeneratorService {
  return new WorldFactsGeneratorService(config, llm);
}
