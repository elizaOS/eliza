import {
  type DailyTopic,
  type DailyTopicSourceType,
  dailyTopics,
  db,
  desc,
  eq,
  generateSnowflakeId,
  gte,
  parodyHeadlines,
  rssHeadlines,
} from '@feed/db';
import { logger } from '@feed/shared';

/**
 * Topics that should never be selected as the daily topic.
 * Prevents crypto-native content from dominating the "Today's Story" banner,
 * keeping the simulation feeling like a broad real-world news experience.
 */
const TOPIC_BLOCKLIST = new Set([
  // Core crypto terms
  'bitcoin',
  'btc',
  'ethereum',
  'eth',
  'crypto',
  'cryptocurrency',
  'blockchain',
  'defi',
  'nft',
  'nfts',
  'stablecoin',
  'stablecoins',
  'solana',
  'cardano',
  'dogecoin',
  'altcoin',
  'altcoins',
  'token',
  'tokens',
  'web3',
  'mining',
  'memecoin',
  'memecoins',
  // Additional crypto terms to prevent crypto topic dominance
  'coinbase',
  'binance',
  'airdrop',
  'hodl',
  'whale',
  'whales',
  'ledger',
  'wallet',
  'wallets',
  'polygon',
  'avalanche',
  'litecoin',
  'ripple',
  'tether',
  'usdc',
  'usdt',
  'dydx',
  'uniswap',
  'aave',
  'staking',
  'validator',
  'validators',
  'layer2',
  'rollup',
  'rollups',
  'zksync',
  'arbitrum',
  'optimism',
  'bridge',
  'crosschain',
]);

const TOPIC_STOPWORDS = new Set([
  // common English stopwords
  'about',
  'after',
  'amid',
  'been',
  'before',
  'being',
  'between',
  'could',
  'first',
  'from',
  'have',
  'into',
  'just',
  'like',
  'make',
  'more',
  'news',
  'over',
  'says',
  'still',
  'than',
  'that',
  'their',
  'there',
  'these',
  'they',
  'this',
  'today',
  'what',
  'when',
  'where',
  'which',
  'while',
  'with',
  'would',
  'will',
  'your',
  // market/question template words
  'stock',
  'market',
  'move',
  'price',
  'following',
  'confirm',
  'announce',
  'next',
  'hours',
  'minutes',
  'days',
  'within',
  'above',
  'below',
  'week',
  'month',
  'quarter',
  'year',
  'receive',
  'does',
  'hold',
  'pass',
  'score',
  'play',
  'game',
  'team',
  'company',
  'beat',
  'close',
  'open',
  'powered',
  'based',
  'driven',
  'level',
  'type',
  'form',
  'deep',
  'dive',
  'take',
  'tech',
  'bags',
  // known nonsense words from LLM-generated parodies
  'burp',
  'dill',
  'cumin',
  'parsley',
  'mustard',
  'coriander',
  'roast',
  'spice',
  'herb',
  'sauce',
]);

export interface DailyTopicCandidate {
  topicKey: string;
  topicLabel: string;
  summary: string;
  score: number;
  sourceHeadlineIds: string[];
  headlines: string[];
  selectionReason: string;
}

export interface DailyTopicContext {
  id?: string;
  date: Date;
  topicKey: string;
  topicLabel: string;
  summary: string;
  sourceType: DailyTopicSourceType;
  sourceHeadlineIds: string[];
  selectionReason: string | null;
  isLocked: boolean;
}

function titleCase(input: string): string {
  return input
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1).toLowerCase())
    .join(' ');
}

export function normalizeTopicKey(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

export function normalizeTopicDate(date: Date): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
  );
}

function extractTopicTokens(input: string): string[] {
  return input
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(
      (token) =>
        token.length >= 4 && !TOPIC_STOPWORDS.has(token) && !/^\d+$/.test(token)
    );
}

function getDisplayLabel(topicKey: string, headlines: string[]): string {
  const regex = new RegExp(
    `\\b${topicKey.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}\\b`,
    'i'
  );
  for (const headline of headlines) {
    const match = headline.match(regex);
    if (match?.[0]) {
      return titleCase(match[0]);
    }
  }

  return titleCase(topicKey);
}

function toContext(topic: DailyTopic): DailyTopicContext {
  return {
    id: topic.id,
    date: topic.date,
    topicKey: topic.topicKey,
    topicLabel: topic.topicLabel,
    summary: topic.summary,
    sourceType: topic.sourceType,
    sourceHeadlineIds: topic.sourceHeadlineIds ?? [],
    selectionReason: topic.selectionReason ?? null,
    isLocked: topic.isLocked,
  };
}

export function buildDailyTopicPromptContext(
  topic: DailyTopicContext | null | undefined
): string {
  if (!topic) {
    return 'No daily topic is currently selected. Do not create new broad narratives.';
  }

  return [
    `Today's single topic is: ${topic.topicLabel}`,
    `Topic summary: ${topic.summary}`,
    'Everything newly generated must stay inside this topic.',
    'Do not introduce a second unrelated narrative.',
  ].join('\n');
}

export function deriveTopicFromText(
  text: string,
  date = new Date()
): DailyTopicContext {
  const tokens = extractTopicTokens(text);

  // Frequency-based: pick the most common qualifying token,
  // break ties by longest token (more specific)
  const freq = new Map<string, number>();
  for (const token of tokens) {
    freq.set(token, (freq.get(token) ?? 0) + 1);
  }

  let bestToken = 'general';
  let bestCount = 0;
  for (const [token, count] of freq) {
    if (
      count > bestCount ||
      (count === bestCount && token.length > bestToken.length)
    ) {
      bestToken = token;
      bestCount = count;
    }
  }

  const topicKey = normalizeTopicKey(bestToken) || 'general';
  return {
    date: normalizeTopicDate(date),
    topicKey,
    topicLabel: titleCase(topicKey),
    summary: text.trim().slice(0, 240) || 'Legacy market topic',
    sourceType: 'fallback_previous_day',
    sourceHeadlineIds: [],
    selectionReason: 'Derived from existing parent market text',
    isLocked: false,
  };
}

export function isTextOnTopic(
  text: string,
  topic: DailyTopicContext | null | undefined
): boolean {
  if (!topic) return true;

  const haystack = text.toLowerCase();
  const topicTokens = [
    ...extractTopicTokens(topic.topicLabel),
    ...extractTopicTokens(topic.summary),
  ].slice(0, 12);

  if (topicTokens.length === 0) return true;

  return topicTokens.some((token) => haystack.includes(token));
}

/**
 * Check if text matches ANY of the provided topics.
 * Used in multi-topic mode where markets span multiple themes.
 */
export function isTextOnAnyTopic(
  text: string,
  topics: DailyTopicContext[]
): boolean {
  if (topics.length === 0) return true;
  return topics.some((topic) => isTextOnTopic(text, topic));
}

/**
 * Build prompt context for multiple active topics.
 * Instructs the LLM to generate questions across several themes
 * rather than a single narrative.
 */
export function buildMultiTopicPromptContext(
  topics: DailyTopicContext[]
): string {
  if (topics.length === 0) {
    return 'No daily topics are currently selected. Generate questions about any trending topic.';
  }

  if (topics.length === 1) {
    return buildDailyTopicPromptContext(topics[0]);
  }

  const topicList = topics
    .map((t, i) => `${i + 1}. **${t.topicLabel}**: ${t.summary}`)
    .join('\n');

  return [
    `Today's active topics (pick ONE per question):`,
    topicList,
    '',
    'Generate questions that spread across these topics.',
    'Each question should clearly relate to ONE of the topics above.',
    'Aim for variety — do not cluster all questions on a single topic.',
  ].join('\n');
}

export class DailyTopicService {
  private async getRecentRssHeadlines(since: Date) {
    return db
      .select()
      .from(rssHeadlines)
      .where(gte(rssHeadlines.publishedAt, since))
      .orderBy(desc(rssHeadlines.publishedAt))
      .limit(50);
  }

  private async getRecentParodies(since: Date) {
    return db
      .select()
      .from(parodyHeadlines)
      .where(gte(parodyHeadlines.generatedAt, since))
      .orderBy(desc(parodyHeadlines.generatedAt))
      .limit(25);
  }

  async getTopicForDate(date: Date): Promise<DailyTopicContext | null> {
    const normalizedDate = normalizeTopicDate(date);
    const topic = await db.dailyTopic.findFirst({
      where: { date: { equals: normalizedDate } },
    });

    return topic ? toContext(topic) : null;
  }

  async getCurrentTopic(): Promise<DailyTopicContext | null> {
    return this.getTopicForDate(new Date());
  }

  async listCandidates(
    date = new Date(),
    limit = 8
  ): Promise<DailyTopicCandidate[]> {
    const normalizedDate = normalizeTopicDate(date);
    const since = new Date(normalizedDate.getTime() - 24 * 60 * 60 * 1000);
    const [headlines, parodies] = await Promise.all([
      this.getRecentRssHeadlines(since),
      this.getRecentParodies(since),
    ]);

    const candidateMap = new Map<string, DailyTopicCandidate>();

    for (const headline of headlines) {
      const tokens = [
        ...new Set(
          extractTopicTokens(`${headline.title} ${headline.summary ?? ''}`)
        ),
      ].slice(0, 5);
      for (const token of tokens) {
        const topicKey = normalizeTopicKey(token);
        if (!topicKey) continue;
        if (TOPIC_BLOCKLIST.has(topicKey)) continue;
        const existing = candidateMap.get(topicKey);
        const next: DailyTopicCandidate = existing ?? {
          topicKey,
          topicLabel: '',
          summary: headline.title,
          score: 0,
          sourceHeadlineIds: [],
          headlines: [],
          selectionReason: '',
        };
        next.score += 3;
        if (!next.sourceHeadlineIds.includes(headline.id)) {
          next.sourceHeadlineIds.push(headline.id);
        }
        if (!next.headlines.includes(headline.title)) {
          next.headlines.push(headline.title);
        }
        candidateMap.set(topicKey, next);
      }
    }

    for (const parody of parodies) {
      const tokens = [
        ...new Set(
          extractTopicTokens(`${parody.originalTitle} ${parody.parodyTitle}`)
        ),
      ].slice(0, 4);
      for (const token of tokens) {
        const topicKey = normalizeTopicKey(token);
        if (!topicKey) continue;
        if (TOPIC_BLOCKLIST.has(topicKey)) continue;
        const existing = candidateMap.get(topicKey);
        const next: DailyTopicCandidate = existing ?? {
          topicKey,
          topicLabel: '',
          summary: parody.originalTitle,
          score: 0,
          sourceHeadlineIds: [],
          headlines: [],
          selectionReason: '',
        };
        next.score += 1;
        if (
          parody.originalHeadlineId &&
          !next.sourceHeadlineIds.includes(parody.originalHeadlineId)
        ) {
          next.sourceHeadlineIds.push(parody.originalHeadlineId);
        }
        if (!next.headlines.includes(parody.originalTitle)) {
          next.headlines.push(parody.originalTitle);
        }
        candidateMap.set(topicKey, next);
      }
    }

    return [...candidateMap.values()]
      .map((candidate) => ({
        ...candidate,
        topicLabel: getDisplayLabel(candidate.topicKey, candidate.headlines),
        selectionReason: `Matched ${candidate.sourceHeadlineIds.length} recent headline(s)`,
      }))
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        if (b.sourceHeadlineIds.length !== a.sourceHeadlineIds.length) {
          return b.sourceHeadlineIds.length - a.sourceHeadlineIds.length;
        }
        return a.topicLabel.localeCompare(b.topicLabel);
      })
      .slice(0, limit);
  }

  /**
   * Get topicKeys used in the last N days, for rotation penalty.
   */
  private async getRecentTopicKeys(days: number): Promise<Set<string>> {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const recent = await db
      .selectDistinct({ topicKey: dailyTopics.topicKey })
      .from(dailyTopics)
      .where(gte(dailyTopics.date, cutoff));
    return new Set(recent.map((r) => r.topicKey));
  }

  async ensureTopicForDate(date: Date): Promise<DailyTopicContext | null> {
    const normalizedDate = normalizeTopicDate(date);
    const existing = await this.getTopicForDate(normalizedDate);
    if (existing) {
      return existing;
    }

    // Fetch more candidates than needed, then penalize recently-used topics
    const candidates = await this.listCandidates(normalizedDate, 10);
    const recentKeys = await this.getRecentTopicKeys(3);

    // Apply 80% score penalty to topics used in the last 3 days
    const penalized = candidates
      .map((c) => ({
        ...c,
        score: recentKeys.has(c.topicKey) ? c.score * 0.2 : c.score,
      }))
      .sort((a, b) => b.score - a.score);

    const bestCandidate = penalized[0];

    if (bestCandidate) {
      return this.upsertTopic({
        date: normalizedDate,
        topicKey: bestCandidate.topicKey,
        topicLabel: bestCandidate.topicLabel,
        summary: bestCandidate.summary,
        sourceType: 'auto',
        sourceHeadlineIds: bestCandidate.sourceHeadlineIds,
        selectionReason: bestCandidate.selectionReason,
        isLocked: false,
      });
    }

    const previousTopic = await db.dailyTopic.findFirst({
      where: { date: { lt: normalizedDate } },
      orderBy: { date: 'desc' },
    });

    if (!previousTopic) {
      logger.warn(
        'No daily topic candidates found and no previous topic available, using default topic',
        { date: normalizedDate.toISOString() },
        'DailyTopicService'
      );
      return this.upsertTopic({
        date: normalizedDate,
        topicKey: 'general',
        topicLabel: 'General',
        summary: 'General market-moving developments across the Feed world',
        sourceType: 'fallback_default',
        sourceHeadlineIds: [],
        selectionReason:
          'Default topic used because no candidates or previous topics were available',
        isLocked: false,
      });
    }

    return this.upsertTopic({
      date: normalizedDate,
      topicKey: previousTopic.topicKey,
      topicLabel: previousTopic.topicLabel,
      summary: previousTopic.summary,
      sourceType: 'fallback_previous_day',
      sourceHeadlineIds: previousTopic.sourceHeadlineIds ?? [],
      selectionReason: `Reused topic from ${previousTopic.date.toISOString().slice(0, 10)}`,
      isLocked: false,
    });
  }

  /**
   * Get multiple topic candidates for a date, for multi-topic market generation.
   * Returns the primary topic (stored in DB) plus additional candidates from RSS.
   * Falls back to just the primary if no additional candidates available.
   */
  async getTopicCandidatesForDate(
    date: Date,
    count = 3
  ): Promise<DailyTopicContext[]> {
    const normalizedDate = normalizeTopicDate(date);

    // Ensure the primary topic exists
    const primary = await this.ensureTopicForDate(normalizedDate);
    if (!primary) return [];

    // Get additional candidates beyond the primary
    const candidates = await this.listCandidates(normalizedDate, count + 2);

    // Convert candidates to DailyTopicContext, excluding the primary
    const additional = candidates
      .filter((c) => c.topicKey !== primary.topicKey)
      .slice(0, count - 1)
      .map(
        (c): DailyTopicContext => ({
          date: normalizedDate,
          topicKey: c.topicKey,
          topicLabel: c.topicLabel,
          summary: c.summary,
          sourceType: 'auto',
          sourceHeadlineIds: c.sourceHeadlineIds,
          selectionReason: c.selectionReason,
          isLocked: false,
        })
      );

    return [primary, ...additional];
  }

  async recomputeTopicForDate(date: Date): Promise<DailyTopicContext | null> {
    const normalizedDate = normalizeTopicDate(date);
    const existing = await this.getTopicForDate(normalizedDate);
    if (existing?.isLocked) {
      return existing;
    }

    if (existing?.id) {
      await db.delete(dailyTopics).where(eq(dailyTopics.id, existing.id));
    }

    return this.ensureTopicForDate(normalizedDate);
  }

  async setManualTopic(input: {
    date?: Date;
    topicLabel: string;
    summary?: string;
    selectionReason?: string;
  }): Promise<DailyTopicContext> {
    const normalizedDate = normalizeTopicDate(input.date ?? new Date());
    const topicLabel = input.topicLabel.trim();
    const summary = (input.summary?.trim() || topicLabel).slice(0, 500);
    const topicKey = normalizeTopicKey(topicLabel) || 'manual-topic';

    return this.upsertTopic({
      date: normalizedDate,
      topicKey,
      topicLabel,
      summary,
      sourceType: 'manual_override',
      sourceHeadlineIds: [],
      selectionReason: input.selectionReason ?? 'Manually overridden in admin',
      isLocked: true,
    });
  }

  async clearOverride(date: Date): Promise<DailyTopicContext | null> {
    const normalizedDate = normalizeTopicDate(date);
    const existing = await this.getTopicForDate(normalizedDate);
    if (existing?.id) {
      await db.delete(dailyTopics).where(eq(dailyTopics.id, existing.id));
    }

    return this.ensureTopicForDate(normalizedDate);
  }

  private async upsertTopic(
    input: Omit<DailyTopicContext, 'id'>
  ): Promise<DailyTopicContext> {
    const updatedAt = new Date();
    const [topic] = await db
      .insert(dailyTopics)
      .values({
        id: await generateSnowflakeId(),
        date: input.date,
        topicKey: input.topicKey,
        topicLabel: input.topicLabel,
        summary: input.summary,
        sourceType: input.sourceType,
        sourceHeadlineIds: input.sourceHeadlineIds,
        selectionReason: input.selectionReason,
        isLocked: input.isLocked,
        updatedAt,
      })
      .onConflictDoUpdate({
        target: dailyTopics.date,
        set: {
          topicKey: input.topicKey,
          topicLabel: input.topicLabel,
          summary: input.summary,
          sourceType: input.sourceType,
          sourceHeadlineIds: input.sourceHeadlineIds,
          selectionReason: input.selectionReason,
          isLocked: input.isLocked,
          updatedAt,
        },
      })
      .returning();

    if (!topic) {
      throw new Error(
        `Failed to store daily topic for ${input.date.toISOString()}`
      );
    }

    logger.info(
      'Stored daily topic',
      {
        date: input.date.toISOString(),
        topicKey: input.topicKey,
        topicLabel: input.topicLabel,
        sourceType: input.sourceType,
        isLocked: input.isLocked,
      },
      'DailyTopicService'
    );

    return toContext(topic);
  }
}

export const dailyTopicService = new DailyTopicService();
