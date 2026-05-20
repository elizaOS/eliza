/**
 * Parody Headline Generator
 *
 * @description Transforms real news headlines into satirical parody versions
 * set in the futuristic AI world with parody characters. Uses LLM to generate
 * over-the-top satirical content and applies character mappings.
 */

import type { ParodyHeadline, RSSHeadline } from '@feed/db';
import {
  and,
  db,
  desc,
  gte,
  inArray,
  isNull,
  or,
  parodyHeadlines,
} from '@feed/db';
import { generateSnowflakeId, logger } from '@feed/shared';
import { FeedLLMClient } from '../llm/openai-client';
import { characterMappingService } from './character-mapping-service';
import { ContentQualityGate } from './content-quality-gate';
import { StaticDataRegistry } from './static-data-registry';

/**
 * Quality gate threshold constants
 * Content scoring below these thresholds is rejected or filtered
 */
/** Minimum quality score for content to be stored/retrieved (0-1 scale) */
export const MIN_QUALITY_SCORE = 0.15;
/** Temperature for retry attempts when initial generation fails quality gate */
const RETRY_TEMPERATURE = 0.7;

/**
 * Generated parody content
 *
 * @description Contains generated parody headline and content with applied
 * character and organization mappings.
 */
export interface GeneratedParody {
  parodyTitle: string;
  parodyContent?: string;
  characterMappings: Record<string, string>;
  organizationMappings: Record<string, string>;
}

/**
 * Parody Headline Generator Class
 *
 * @description Uses LLM to create satirical, over-the-top versions of real
 * headlines. Applies character mappings before and after generation to ensure
 * consistent parody character usage.
 */
export class ParodyHeadlineGenerator {
  private llm: FeedLLMClient;

  constructor(llm: FeedLLMClient) {
    this.llm = llm;
  }

  /**
   * Generate a parody headline from a real headline
   *
   * @description Generates a satirical parody version of a real headline using
   * LLM. Applies character mappings before generation and post-processes to ensure
   * all real names are replaced with parody equivalents.
   *
   * @param {string} originalTitle - Original headline title
   * @param {string} [originalContent] - Optional original content
   * @param {string} [sourceName] - Optional source name
   * @returns {Promise<GeneratedParody>} Generated parody with mappings
   *
   * @example
   * ```typescript
   * const parody = await generator.generateParody(
   *   'OpenAGI announces SMH-9000',
   *   'Full article content...',
   *   'TechCrAInch'
   * );
   * ```
   */
  async generateParody(
    originalTitle: string,
    originalContent?: string,
    sourceName?: string,
    temperature = 0.9
  ): Promise<GeneratedParody> {
    // First, replace any real names with parody names in the original
    const titleReplacement =
      await characterMappingService.transformText(originalTitle);
    const contentReplacement = originalContent
      ? await characterMappingService.transformText(originalContent)
      : null;

    // Build prompt for LLM
    const prompt = this.buildParodyPrompt(
      titleReplacement.transformedText,
      contentReplacement?.transformedText,
      sourceName
    );

    // Generate parody using LLM
    const response = await this.llm.generateJSON<
      | {
          parodyTitle: string;
          parodyContent?: string;
        }
      | {
          response: {
            parodyTitle: string;
            parodyContent?: string;
          };
        }
    >(
      prompt,
      {
        properties: {
          parodyTitle: { type: 'string' },
          parodyContent: { type: 'string' },
        },
        required: ['parodyTitle'],
      },
      {
        temperature,
        maxTokens: 500,
        format: 'xml',
        promptType: 'parody_headline_generation',
      }
    );

    // Handle XML structure
    const parodyData =
      'response' in response && response.response
        ? response.response
        : (response as { parodyTitle: string; parodyContent?: string });

    // Apply character mapping to replace any real names with fictional equivalents
    const processedTitle = await characterMappingService.transformText(
      parodyData.parodyTitle
    );
    const processedContent = parodyData.parodyContent
      ? await characterMappingService.transformText(parodyData.parodyContent)
      : null;

    // Combine mappings from title, content, and post-processing
    const allCharacterMappings = {
      ...titleReplacement.characterMappings,
      ...(contentReplacement?.characterMappings || {}),
      ...processedTitle.characterMappings,
      ...(processedContent?.characterMappings || {}),
    };

    const allOrganizationMappings = {
      ...titleReplacement.organizationMappings,
      ...(contentReplacement?.organizationMappings || {}),
      ...processedTitle.organizationMappings,
      ...(processedContent?.organizationMappings || {}),
    };

    return {
      parodyTitle: processedTitle.transformedText,
      parodyContent: processedContent?.transformedText,
      characterMappings: allCharacterMappings,
      organizationMappings: allOrganizationMappings,
    };
  }

  /**
   * Build LLM prompt for parody generation
   */
  private buildParodyPrompt(
    title: string,
    content?: string,
    sourceName?: string
  ): string {
    const knownOrgs = StaticDataRegistry.getAllOrganizations()
      .map((org) => org.name)
      .join(', ');

    return `You are a satirical news writer for a futuristic world where everyone is actually an AI.
Your job is to transform real news headlines into witty, satirical versions.

WORLD CONTEXT:
- This is a futuristic world where all humans are actually AI agents
- Technology is advanced and sometimes absurd
- Politics and business are exaggerated versions of reality
- Financial markets are volatile and dramatic

KNOWN ORGANIZATIONS (prefer these names; do NOT invent new organization names):
${knownOrgs}

ORIGINAL HEADLINE:
"${title}"
${sourceName ? `Source: ${sourceName}` : ''}

${content ? `ORIGINAL CONTENT:\n${content.substring(0, 500)}...\n` : ''}

TASK:
Create a SATIRICAL version of this headline set in the AI world above.

REQUIREMENTS:
✅ Witty and satirical — humor from exaggerating REAL situations, not random word salad
✅ Add futuristic AI/tech twists that relate to the actual story
✅ Keep any parody character names already in the headline (like "AIlon Musk", "Sam AIltman", etc.)
✅ Use organization names from the KNOWN ORGANIZATIONS list above
✅ Keep it somewhat believable within the satirical world
✅ Make it 1-2 sentences maximum
${content ? '✅ Also create a brief satirical summary (2-3 sentences) based on the content' : ''}

STYLE:
- Witty and satirical — humor from exaggerating real situations
- Use existing parody names from the list above
- Futuristic AI world setting
- Sharp, clever commentary over random absurdism

AVOID:
❌ Inventing new organization or product names not in the Known Organizations list
❌ Random food, spice, or nonsense words as proper nouns (no "BurpCo", "CuminAI", etc.)
❌ Compound words that don't exist (e.g., "burp-parsley", "cumin-powered")
❌ Removing parody names that are already there
❌ Being too similar to the original — add satirical spin
❌ Pure nonsense — the humor should come from clever exaggeration, not gibberish

OUTPUT FORMAT:
Respond with ONLY this XML:
<response>
  <parodyTitle>Your satirical headline here</parodyTitle>
  ${content ? '<parodyContent>Your satirical 2-3 sentence summary here</parodyContent>' : ''}
</response>

Generate the parody now.`;
  }

  /**
   * Process multiple headlines into parodies
   */
  async processHeadlines(
    headlines: Array<RSSHeadline & { source?: { name: string } | null }>
  ): Promise<ParodyHeadline[]> {
    const parodies: ParodyHeadline[] = [];
    let retryCount = 0;
    let skipCount = 0;

    // Track entity frequency to prevent single-entity dominance in parody output
    const entityMentions = new Map<string, number>();
    const MAX_ENTITY_MENTIONS_PER_BATCH = Number(
      process.env.PARODY_MAX_ENTITY_MENTIONS || 3
    );

    for (const headline of headlines) {
      // First attempt at normal temperature
      let parody = await this.generateParody(
        headline.title,
        headline.summary || undefined,
        headline.source?.name
      );

      // Quality gate: validate before insert
      let quality = await ContentQualityGate.validateParody(
        headline.title,
        parody.parodyTitle,
        parody.parodyContent
      );

      // Retry once at lower temperature if quality gate fails
      if (!quality.passed) {
        logger.warn(
          'Parody failed quality gate — retrying at lower temperature',
          {
            original: headline.title,
            parody: parody.parodyTitle,
            reasons: quality.reasons,
          },
          'ParodyHeadlineGenerator'
        );

        retryCount++;

        parody = await this.generateParody(
          headline.title,
          headline.summary || undefined,
          headline.source?.name,
          RETRY_TEMPERATURE
        );

        quality = await ContentQualityGate.validateParody(
          headline.title,
          parody.parodyTitle,
          parody.parodyContent
        );
      }

      // Skip entirely if still failing
      if (!quality.passed) {
        skipCount++;
        logger.warn(
          'Parody failed quality gate after retry — skipping',
          {
            original: headline.title,
            parody: parody.parodyTitle,
            reasons: quality.reasons,
          },
          'ParodyHeadlineGenerator'
        );
        continue;
      }

      // Entity diversity check: skip if any mentioned character is over-represented
      const mentionedEntities = Object.values(parody.characterMappings);
      const isOverRepresented = mentionedEntities.some(
        (e) => (entityMentions.get(e) ?? 0) >= MAX_ENTITY_MENTIONS_PER_BATCH
      );
      if (isOverRepresented) {
        skipCount++;
        logger.debug(
          'Parody skipped — entity over-represented in batch',
          {
            original: headline.title,
            parody: parody.parodyTitle,
            entities: mentionedEntities,
          },
          'ParodyHeadlineGenerator'
        );
        continue;
      }
      for (const entity of mentionedEntities) {
        entityMentions.set(entity, (entityMentions.get(entity) ?? 0) + 1);
      }

      const [parodyHeadline] = await db
        .insert(parodyHeadlines)
        .values({
          id: await generateSnowflakeId(),
          originalHeadlineId: headline.id,
          originalTitle: headline.title,
          originalSource: headline.source?.name || 'Unknown',
          parodyTitle: parody.parodyTitle,
          parodyContent: parody.parodyContent || null,
          characterMappings: parody.characterMappings,
          organizationMappings: parody.organizationMappings,
          generatedAt: new Date(),
          qualityScore: quality.score,
          qualityReasons: quality.reasons.length > 0 ? quality.reasons : null,
        })
        .returning();

      if (parodyHeadline) {
        parodies.push(parodyHeadline);
      }

      logger.info(
        'Generated parody headline',
        {
          original: headline.title,
          parody: parody.parodyTitle,
          qualityScore: quality.score.toFixed(2),
        },
        'ParodyHeadlineGenerator'
      );
    }

    if (retryCount > 0 || skipCount > 0) {
      logger.info(
        'Parody quality gate batch summary',
        {
          total: headlines.length,
          passed: parodies.length,
          retried: retryCount,
          skipped: skipCount,
          retryRate:
            headlines.length > 0
              ? `${((retryCount / headlines.length) * 100).toFixed(1)}%`
              : '0%',
        },
        'ParodyHeadlineGenerator'
      );
    }

    return parodies;
  }

  /**
   * Get recent parody headlines for use in game context
   * Returns parodies from the last 7 days
   */
  async getRecentParodies(daysBack = 7): Promise<ParodyHeadline[]> {
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - daysBack);

    return db
      .select()
      .from(parodyHeadlines)
      .where(
        and(
          gte(parodyHeadlines.generatedAt, sevenDaysAgo),
          // Pre-migration records (null) are presumed OK; reject only scored failures
          or(
            isNull(parodyHeadlines.qualityScore),
            gte(parodyHeadlines.qualityScore, MIN_QUALITY_SCORE)
          )
        )
      )
      .orderBy(desc(parodyHeadlines.generatedAt));
  }

  /**
   * Mark parody headlines as used in game context
   */
  async markAsUsed(parodyIds: string[]): Promise<void> {
    await db
      .update(parodyHeadlines)
      .set({
        isUsed: true,
        usedAt: new Date(),
      })
      .where(inArray(parodyHeadlines.id, parodyIds));
  }

  /**
   * Generate summary of parody headlines from the last 7 days
   * Returns a formatted string suitable for injection into game context
   */
  async generateDailySummary(): Promise<string> {
    const recentParodies = await this.getRecentParodies(7); // Last 7 days

    if (recentParodies.length === 0) {
      return 'No recent news updates available.';
    }

    // Group by day
    const byDay = new Map<string, ParodyHeadline[]>();
    for (const parody of recentParodies) {
      const day = new Date(parody.generatedAt).toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
      });
      if (!byDay.has(day)) {
        byDay.set(day, []);
      }
      byDay.get(day)!.push(parody);
    }

    // Format by day
    const dayEntries = Array.from(byDay.entries());
    const formattedDays = dayEntries
      .map(([day, parodies]) => {
        const headlines = parodies
          .slice(0, 3) // Max 3 per day
          .map((p) => `  - ${p.parodyTitle}`)
          .join('\n');
        return `${day}:\n${headlines}`;
      })
      .join('\n\n');

    return `NEWS FROM THE LAST 7 DAYS:\n\n${formattedDays}\n\n(These are satirical parodies of real-world news headlines, transformed for our futuristic AI world where everyone is an AI agent.)`;
  }
}

/**
 * Create instance with game tick LLM client
 * Priority: Groq > Claude > OpenAI
 */
export function createParodyHeadlineGenerator(): ParodyHeadlineGenerator {
  const llm = FeedLLMClient.forGameTick();
  return new ParodyHeadlineGenerator(llm);
}
