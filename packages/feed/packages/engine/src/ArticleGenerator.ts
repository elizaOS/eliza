/**
 * Article Generator - Long-Form News Content with Organizational Bias
 *
 * @module engine/ArticleGenerator
 *
 * @description
 * Generates realistic long-form news articles from media organizations with
 * editorial bias based on organizational relationships and affiliations. Creates
 * multi-perspective coverage of game events with different spins.
 *
 * **Key Features:**
 * - Long-form investigative articles (800-1500 words)
 * - Organizational bias based on actor affiliations
 * - Insider information and anonymous sources
 * - Editorial slant/spin based on relationships
 * - Multiple outlets covering same events differently
 * - Realistic journalist bylines
 *
 * **Bias System:**
 * - **Protective Bias (+0.6)**: Downplays negative news about aligned actors
 * - **Critical Bias (-0.6)**: Emphasizes negative news about opposing actors
 * - **Neutral (0)**: Balanced coverage when no relationships
 *
 * **Article Structure:**
 * - Compelling headline that hints at angle
 * - 2-3 sentence summary for listings
 * - Full body with insider details, quotes, analysis
 * - Category and tags for organization
 * - Sentiment and slant metadata
 *
 * **Coverage Strategy:**
 * - 50-80% of news organizations cover each major event
 * - Each outlet provides unique perspective
 * - Bias creates natural disagreement in coverage
 * - Insider quotes from affiliated journalists
 *
 * @see {@link FeedGenerator} - Also generates short-form posts
 * @see {@link executeGameTick} - Production tick uses ArticleGenerator for mixed content
 *
 * @example
 * ```typescript
 * const generator = new ArticleGenerator(llmClient);
 *
 * const articles = await generator.generateArticlesForEvent(
 *   worldEvent,
 *   newsOrganizations,
 *   actors,
 *   recentEvents
 * );
 *
 * // Each org has different take
 * articles.forEach(article => {
 *   console.log(`${article.authorOrgName}: ${article.title}`);
 *   console.log(`Slant: ${article.slant}`);
 *   console.log(`Bias: ${article.biasScore}`);
 * });
 * ```
 */

import {
  type Article,
  generateSnowflakeId,
  type JsonValue,
  logger,
} from '@feed/shared';
import type { FeedLLMClient } from './llm/openai-client';
import { biasedArticle, renderPrompt, validateArticle } from './prompts';
import { characterMappingService } from './services/character-mapping-service';
import { ContentQualityGate } from './services/content-quality-gate';
import type { Actor, Organization, Question, WorldEvent } from './types/shared';
import { shuffleArray } from './utils/randomization';
import { stripHashtagsAndEmojis } from './utils/shared-utils';

// Re-export Article for consumers that import from this file
export type { Article } from '@feed/shared';

type ArticleStage = 'breaking' | 'commentary' | 'resolution';

interface ArticleGenerationContext {
  event: WorldEvent;
  organization: Organization;
  journalist?: Actor;
  alignedActors: string[]; // Actors the org is aligned with
  opposingActors: string[]; // Actors the org opposes
  insiderInfo?: string; // Insider information to include
  recentEvents: WorldEvent[]; // Context from recent events
  worldContext?: string; // World facts context (game state, recent happenings)
}

/**
 * Article Generator
 *
 * @class ArticleGenerator
 *
 * @description
 * Generates biased long-form news articles using LLM. Each organization produces
 * articles with different angles based on their relationships with actors involved.
 *
 * **Generation Process:**
 * 1. Identify news organizations to cover event (50-80% coverage)
 * 2. For each organization:
 *    - Determine bias based on actor affiliations
 *    - Build context with bias instructions
 *    - Generate article via LLM (800-1500 words)
 *    - Add metadata (category, tags, sentiment)
 *
 * **Bias Calculation:**
 * - If event involves aligned actors → protective bias
 * - If event involves opposing actors → critical bias
 * - Otherwise → neutral coverage
 *
 * @usage
 * Instantiated by GameEngine for mixed content generation alongside short posts.
 */
export class ArticleGenerator {
  private llm: FeedLLMClient;

  /**
   * Create a new ArticleGenerator
   *
   * @param llm - Feed LLM client for article generation
   */
  constructor(llm: FeedLLMClient) {
    this.llm = llm;
  }

  /**
   * Generate a single article for a question at specific stage
   *
   * @param question - Prediction market question
   * @param organization - News organization writing the article
   * @param stage - Article stage (breaking/commentary/resolution)
   * @param actors - All game actors
   * @param recentEvents - Recent events for context
   * @param worldContext - World facts context (game state, recent happenings)
   * @returns Article with stage-appropriate content
   *
   * @description
   * Generates articles tied to prediction market question lifecycle.
   * Each stage has different tone and purpose.
   */
  async generateArticleForQuestion(
    question: Question,
    organization: Organization,
    stage: ArticleStage,
    actors: Actor[],
    recentEvents: WorldEvent[] = [],
    worldContext?: string
  ): Promise<Article> {
    // Strict validation - fail fast on bad inputs
    if (!question || !question.id || !question.text) {
      throw new Error(
        'Invalid question for article generation: missing id or text'
      );
    }
    if (!organization || !organization.id || !organization.name) {
      throw new Error(
        'Invalid organization for article generation: missing id or name'
      );
    }
    if (!stage || !['breaking', 'commentary', 'resolution'].includes(stage)) {
      throw new Error(`Invalid stage for article generation: ${stage}`);
    }
    if (!actors || actors.length === 0) {
      throw new Error('Actors array cannot be empty for article generation');
    }

    // Build context for the specific stage
    const context = this.buildQuestionArticleContext(
      question,
      organization,
      stage,
      actors,
      recentEvents,
      worldContext
    );

    const article = await this.generateArticle(context);

    if (!article) {
      throw new Error(
        `Article validation failed for Q${question.id} by ${organization.name}`
      );
    }

    // Validate generated article has required content
    if (!article.title || article.title.trim().length === 0) {
      throw new Error(
        `Generated article has empty title for Q${question.id} by ${organization.name}`
      );
    }
    if (!article.summary || article.summary.trim().length === 0) {
      throw new Error(
        `Generated article has empty summary for Q${question.id} by ${organization.name}`
      );
    }
    if (!article.content || article.content.trim().length < 100) {
      throw new Error(
        `Generated article content too short (${article.content?.length || 0} chars) for Q${question.id} by ${organization.name}`
      );
    }

    return article;
  }

  /**
   * Build context for question-based article generation
   */
  private buildQuestionArticleContext(
    question: Question,
    org: Organization,
    stage: ArticleStage,
    actors: Actor[],
    recentEvents: WorldEvent[],
    worldContext?: string
  ): ArticleGenerationContext {
    // Find journalist from this org
    const journalist = actors.find((a) => a.affiliations?.includes(org.id));

    // Create synthetic event from question for consistency with existing code
    const questionIdNumber =
      typeof question.id === 'number' ? question.id : null;
    const syntheticEvent: WorldEvent = {
      id: `question-${question.id}-${stage}`,
      day: 0, // Set by caller
      type:
        stage === 'breaking'
          ? 'announcement'
          : stage === 'resolution'
            ? 'revelation'
            : 'development',
      description: question.text,
      actors: [], // Question-level articles don't focus on specific actors
      visibility: 'public',
      pointsToward:
        stage === 'resolution' ? (question.outcome ? 'YES' : 'NO') : null,
      relatedQuestion: questionIdNumber,
    };

    return {
      event: syntheticEvent,
      organization: org,
      journalist,
      alignedActors: [],
      opposingActors: [],
      recentEvents: recentEvents
        .filter((e) => e.relatedQuestion === questionIdNumber)
        .slice(0, 3),
      worldContext,
    };
  }

  /**
   * Generate multiple articles about an event from different news organizations
   *
   * @param event - World event to cover
   * @param newsOrganizations - Available news organizations
   * @param actors - All game actors
   * @param recentEvents - Recent events for context
   * @returns Array of articles with different perspectives
   *
   * @description
   * Each organization produces an article with unique bias and angle based on their
   * relationships with actors involved in the event. Creates natural disagreement
   * and multiple perspectives in news coverage.
   *
   * **Coverage Selection:**
   * - 1-2 articles per event maximum (prevents duplicate coverage)
   * - Random selection of news organizations
   * - Each outlet provides unique perspective
   *
   * **Bias Determination:**
   * - Scans event.actors for affiliations
   * - Protective bias if organization employs involved actors
   * - Critical bias if organization opposes involved actors
   * - Neutral if no strong relationships
   *
   * @example
   * ```typescript
   * const articles = await generator.generateArticlesForEvent(
   *   { id: 'evt-1', description: 'CEO resigns', actors: ['ceo-1'], ... },
   *   [cnn, fox, nyt],
   *   allActors,
   *   recentEvents
   * );
   *
   * // CNN (employs CEO): "Visionary Leader Steps Down to Pursue New Ventures"
   * // Fox (opposes CEO): "Embattled Executive Forced Out Amid Controversy"
   * // NYT (neutral): "Tech CEO Announces Resignation After Tumultuous Quarter"
   * ```
   */
  async generateArticlesForEvent(
    event: WorldEvent,
    newsOrganizations: Organization[],
    actors: Actor[],
    recentEvents: WorldEvent[] = []
  ): Promise<Article[]> {
    const articles: Article[] = [];

    // Limit to 1-2 articles per event (instead of 50-80% of orgs)
    // This prevents overwhelming the feed with duplicate coverage
    const maxArticles = Math.min(2, newsOrganizations.length);
    const numCovering = Math.min(
      maxArticles,
      Math.floor(1 + Math.random() * 2)
    ); // 1-2 articles
    const coveringOrgs = this.selectNewsOrgs(newsOrganizations, numCovering);

    for (const org of coveringOrgs) {
      // Determine bias based on org's relationships
      const context = this.buildArticleContext(
        event,
        org,
        actors,
        recentEvents
      );

      const article = await this.generateArticle(context);
      if (article) {
        articles.push(article);
      } else {
        logger.warn(
          `[ArticleGenerator] Article dropped in batch: validation/quality gate failed for event ${event.id} by ${org.name}`
        );
      }
    }

    return articles;
  }

  /**
   * Build context for article generation including bias and relationships
   */
  private buildArticleContext(
    event: WorldEvent,
    org: Organization,
    actors: Actor[],
    recentEvents: WorldEvent[]
  ): ArticleGenerationContext {
    // Find actors aligned with this organization
    const alignedActors = actors
      .filter((a) => a.affiliations?.includes(org.id))
      .map((a) => a.id);

    // Find actors mentioned in the event
    const eventActors = event.actors || [];

    // Determine which event actors are aligned vs opposing
    const aligned = eventActors.filter((actorId) =>
      alignedActors.includes(actorId)
    );
    const opposing = eventActors.filter(
      (actorId) => !alignedActors.includes(actorId)
    );

    // Find a journalist from this org
    const journalist = actors.find((a) => a.affiliations?.includes(org.id));

    return {
      event,
      organization: org,
      journalist,
      alignedActors: aligned,
      opposingActors: opposing,
      recentEvents: recentEvents.filter((e) => e.id !== event.id).slice(0, 3),
    };
  }

  /**
   * Generate a single article with bias based on organizational relationships
   */
  private async generateArticle(
    context: ArticleGenerationContext
  ): Promise<Article | null> {
    const {
      event,
      organization,
      journalist,
      alignedActors,
      opposingActors,
      recentEvents: _recentEvents,
      worldContext,
    } = context;

    // Determine bias direction
    let biasDirection = 'neutral';
    let biasScore = 0;

    if (alignedActors.length > 0) {
      biasDirection = 'protective'; // Downplay negative news about aligned actors
      biasScore = 0.6;
    } else if (opposingActors.length > 0) {
      biasDirection = 'critical'; // Play up negative news about opposing actors
      biasScore = -0.6;
    }

    // Build article prompt
    const prompt = await this.buildArticlePrompt(context, biasDirection);

    // Generate article content using kimi for high-quality content generation
    const response = await this.llm.generateJSON<
      | {
          title: string;
          summary: string;
          content: string;
          slant: string;
          sentiment: 'positive' | 'negative' | 'neutral';
          category: string;
          tags: string[];
        }
      | {
          response: {
            title: string;
            summary: string;
            content: string;
            slant: string;
            sentiment: 'positive' | 'negative' | 'neutral';
            category: string;
            tags: string[] | { tag: string[] };
          };
        }
    >(
      prompt,
      {
        properties: {
          title: { type: 'string' },
          summary: { type: 'string' },
          content: { type: 'string' },
          slant: { type: 'string' },
          sentiment: { type: 'string' },
          category: { type: 'string' },
          tags: { type: 'array' },
        },
        required: ['title', 'summary', 'content', 'slant', 'sentiment'],
      },
      {
        temperature: 0.85,
        maxTokens: 2500,
        format: 'xml',
        promptType: 'article_generate',
      }
    );

    // Handle XML structure - check if response is an object before using 'in' operator
    if (typeof response !== 'object' || response === null) {
      const responseStr =
        typeof response === 'string' ? response : String(response);
      logger.error(
        'LLM returned non-object response for article generation',
        {
          responseType: typeof response,
          responsePreview:
            responseStr.length > 200
              ? responseStr.substring(0, 200)
              : responseStr,
          eventId: event.id,
          organizationId: organization.id,
        },
        'ArticleGenerator'
      );
      throw new Error(
        'LLM returned invalid response format - expected object, got ' +
          typeof response
      );
    }

    const articleData =
      'response' in response &&
      response.response &&
      typeof response.response === 'object'
        ? response.response
        : (response as {
            title: string | string[];
            summary: string | string[];
            content: string | string[];
            slant: string;
            sentiment: 'positive' | 'negative' | 'neutral';
            category: string;
            tags: string[] | { tag: string[] };
          });

    // Helper to extract string from possibly array value (XML sometimes returns arrays for text)
    const extractString = (value: unknown): string => {
      if (typeof value === 'string') return value;
      if (Array.isArray(value)) return value[0] || '';
      if (value && typeof value === 'object') return JSON.stringify(value);
      return '';
    };

    // Extract strings from potentially wrapped values
    const title = extractString(articleData.title);
    const summary = extractString(articleData.summary);
    const content = extractString(articleData.content);

    // Validate extracted content meets minimum requirements
    if (!title || title.trim().length === 0) {
      logger.error(
        'Article generation failed: empty title',
        { eventId: event.id, organizationId: organization.id },
        'ArticleGenerator'
      );
      throw new Error(
        `Generated article has empty title for event ${event.id} by ${organization.name}`
      );
    }
    if (!summary || summary.trim().length === 0) {
      logger.error(
        'Article generation failed: empty summary',
        { eventId: event.id, organizationId: organization.id },
        'ArticleGenerator'
      );
      throw new Error(
        `Generated article has empty summary for event ${event.id} by ${organization.name}`
      );
    }
    // Content should be a full article (800-1500 words = ~4000-7500 chars)
    // Minimum 500 chars to ensure it's not just a summary
    if (!content || content.trim().length < 500) {
      logger.error(
        'Article generation failed: content too short',
        {
          eventId: event.id,
          organizationId: organization.id,
          contentLength: content?.length || 0,
        },
        'ArticleGenerator'
      );
      throw new Error(
        `Generated article content too short (${content?.length || 0} chars, min 500) for event ${event.id} by ${organization.name}`
      );
    }

    // Handle tags (could be array or {tag: [...]} from XML)
    let tagsArray: string[];
    if (Array.isArray(articleData.tags)) {
      tagsArray = articleData.tags;
    } else if (
      articleData.tags &&
      typeof articleData.tags === 'object' &&
      'tag' in articleData.tags
    ) {
      const tagData = (articleData.tags as { tag: string[] }).tag;
      tagsArray = Array.isArray(tagData) ? tagData : [tagData];
    } else {
      tagsArray = [];
    }

    // Handle slant (could be string or wrapped in object)
    let slantString: string | undefined;
    if (typeof articleData.slant === 'string') {
      slantString = articleData.slant;
    } else if (articleData.slant && typeof articleData.slant === 'object') {
      // If slant is an object, try to extract the actual value or stringify it
      if (
        'response' in articleData.slant &&
        typeof (articleData.slant as Record<string, JsonValue>).response ===
          'object'
      ) {
        // If there's a nested response object, it's malformed - extract title or summary as fallback
        const nestedResponse = (articleData.slant as Record<string, JsonValue>)
          .response as Record<string, JsonValue>;
        slantString =
          (nestedResponse.slant as string) ||
          (nestedResponse.title as string) ||
          undefined;
      } else {
        // Try to extract a meaningful string representation
        slantString = JSON.stringify(articleData.slant);
      }
    } else {
      slantString = undefined;
    }

    // Strip hashtags and emojis (defense-in-depth, prompt also instructs no hashtags/emojis)
    const cleanTitle = stripHashtagsAndEmojis(title);
    const cleanSummary = stripHashtagsAndEmojis(summary);
    const cleanContent = stripHashtagsAndEmojis(content);

    // Apply character mapping to prevent real name leakage
    const titleTransformed =
      await characterMappingService.transformText(cleanTitle);
    const summaryTransformed =
      await characterMappingService.transformText(cleanSummary);
    const contentTransformed =
      await characterMappingService.transformText(cleanContent);

    if (
      titleTransformed.replacementCount > 0 ||
      summaryTransformed.replacementCount > 0 ||
      contentTransformed.replacementCount > 0
    ) {
      logger.warn(
        `[ArticleGenerator] Character mapping applied: ` +
          `title=${titleTransformed.replacementCount}, ` +
          `summary=${summaryTransformed.replacementCount}, ` +
          `content=${contentTransformed.replacementCount} replacements`
      );
    }

    // Validate article content after transformation
    const validation = validateArticle({
      title: titleTransformed.transformedText,
      summary: summaryTransformed.transformedText,
      content: contentTransformed.transformedText,
    });

    if (!validation.isValid) {
      logger.error(
        `[ArticleGenerator] Article validation failed for event ${event.id}`,
        { violations: validation.violations }
      );
      return null;
    }

    if (validation.warnings.length > 0) {
      logger.warn(`[ArticleGenerator] Article validation warnings`, {
        warnings: validation.warnings,
      });
    }

    // Grounding check: verify article stays on-topic with its source context
    // Note: Skip check when source context is too sparse (< 100 chars) to avoid false positives.
    // Short event descriptions may lack enough keywords for meaningful overlap comparison.
    const sourceContext = [event.description, worldContext ?? '']
      .filter(Boolean)
      .join('\n');
    if (sourceContext.length >= 100) {
      const quality = await ContentQualityGate.validateArticle(
        contentTransformed.transformedText,
        sourceContext
      );
      if (!quality.passed) {
        logger.warn(
          `[ArticleGenerator] Article failed quality gate for event ${event.id}`,
          { reasons: quality.reasons, score: quality.score.toFixed(2) }
        );
        return null;
      }
    } else {
      logger.debug(
        `[ArticleGenerator] Skipping grounding check for event ${event.id}: source context too sparse (${sourceContext.length} chars)`
      );
    }

    // Create article object
    const article: Article = {
      id: await generateSnowflakeId(),
      title: titleTransformed.transformedText,
      summary: summaryTransformed.transformedText,
      content: contentTransformed.transformedText,
      authorOrgId: organization.id,
      authorOrgName: organization.name,
      byline: journalist?.name,
      bylineActorId: journalist?.id,
      biasScore,
      sentiment: articleData.sentiment || 'neutral',
      slant: slantString,
      relatedEventId: event.id,
      relatedQuestion: event.relatedQuestion || undefined,
      relatedActorIds: event.actors || [],
      relatedOrgIds: [organization.id],
      category: articleData.category || this.categorizeEvent(event),
      tags: tagsArray,
      publishedAt: new Date(),
    };

    return article;
  }

  /**
   * Build prompt for article generation with bias instructions
   */
  private async buildArticlePrompt(
    context: ArticleGenerationContext,
    biasDirection: string
  ): Promise<string> {
    const {
      event,
      organization,
      journalist: _journalist,
      alignedActors,
      opposingActors,
      recentEvents,
      worldContext,
    } = context;

    let biasInstructions = '';
    if (biasDirection === 'protective') {
      biasInstructions = `
BIAS INSTRUCTIONS:
- This organization is ALIGNED with some actors in this story: ${alignedActors.join(', ')}
- Your article should DOWNPLAY any negative aspects related to these aligned actors
- Present them in a favorable light, emphasize their positive actions
- Use softer language when discussing their controversies
- Include quotes or perspectives that support them
- If there's insider information that could hurt them, frame it carefully or omit it
- Find angles that make them look good even if the situation is negative
`;
    } else if (biasDirection === 'critical') {
      biasInstructions = `
BIAS INSTRUCTIONS:
- This organization OPPOSES or has conflicts with some actors in this story: ${opposingActors.join(', ')}
- Your article should be CRITICAL and highlight negative aspects related to these actors
- Use stronger, more dramatic language when discussing their actions
- Emphasize controversies, mistakes, or questionable decisions
- If there's insider information that damages them, feature it prominently
- Find angles that make them look bad or question their motives
- Include critical quotes or perspectives
`;
    } else {
      biasInstructions = `
BIAS INSTRUCTIONS:
- This organization has no strong relationships with the actors in this story
- Maintain a relatively neutral tone, but still be engaging and investigative
- Present multiple perspectives fairly
`;
    }

    // Build world context section - includes game state and recent happenings
    // Double newline provides visual separation in the prompt
    const worldContextSection = worldContext
      ? `WORLD CONTEXT:\n${worldContext}\n\n`
      : '';

    // Empty string when no events - worldContext already provides recent happenings,
    // so omitting "No recent context" avoids redundant/confusing prompt text
    const recentContext =
      recentEvents.length > 0
        ? `RECENT EVENTS:\n${recentEvents.map((e) => `- ${e.description}`).join('\n')}`
        : '';

    const relatedQuestionContext = event.relatedQuestion
      ? `Related to Prediction Market Question #${event.relatedQuestion}`
      : '';

    return renderPrompt(biasedArticle, {
      orgName: organization.name,
      orgType: organization.type || 'media',
      orgStyle: organization.postStyle || 'Professional journalism',
      eventDescription: event.description,
      eventType: event.type,
      relatedQuestionContext,
      worldContext: worldContextSection,
      recentContext,
      biasInstructions,
    });
  }

  /**
   * Categorize event for article classification
   */
  private categorizeEvent(event: WorldEvent): string {
    const type = event.type.toLowerCase();

    if (
      type.includes('scandal') ||
      type.includes('leak') ||
      type.includes('revelation')
    ) {
      return 'scandal';
    }
    if (type.includes('meeting') || type.includes('summit')) {
      return 'politics';
    }
    if (
      type.includes('deal') ||
      type.includes('acquisition') ||
      type.includes('earnings')
    ) {
      return 'finance';
    }
    if (type.includes('development') || type.includes('announcement')) {
      return 'business';
    }
    if (
      type.includes('tech') ||
      type.includes('launch') ||
      type.includes('product')
    ) {
      return 'tech';
    }

    return 'general';
  }

  /**
   * Select which news organizations should cover an event
   */
  private selectNewsOrgs(orgs: Organization[], count: number): Organization[] {
    // Shuffle and take first N
    const shuffled = shuffleArray(orgs);
    return shuffled.slice(0, count);
  }
}
