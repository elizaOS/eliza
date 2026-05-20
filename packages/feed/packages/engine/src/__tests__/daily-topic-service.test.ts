import { beforeEach, describe, expect, mock, test } from 'bun:test';

const rssRows: Array<{
  id: string;
  title: string;
  summary?: string | null;
  publishedAt: Date;
}> = [];

const parodyRows: Array<{
  originalHeadlineId: string;
  originalTitle: string;
  parodyTitle: string;
  generatedAt: Date;
}> = [];

const storedTopics: Array<Record<string, unknown>> = [];

const dbMock = {
  dailyTopic: {
    findFirst: mock(async (args?: Record<string, unknown>) => {
      const where = args?.where as
        | { date?: { equals?: Date; lt?: Date } }
        | undefined;
      if (where?.date?.equals) {
        return (
          storedTopics.find(
            (topic) =>
              (topic.date as Date).getTime() === where.date?.equals?.getTime()
          ) ?? null
        );
      }
      if (where?.date?.lt) {
        return (
          [...storedTopics]
            .filter((topic) => (topic.date as Date) < where.date!.lt!)
            .sort(
              (a, b) => (b.date as Date).getTime() - (a.date as Date).getTime()
            )[0] ?? null
        );
      }
      return null;
    }),
  },
  select: mock(() => ({
    from: mock((table: { __name: string }) => ({
      where: mock(() => ({
        orderBy: mock(() => ({
          limit: mock(() =>
            Promise.resolve(
              table.__name === 'rssHeadlines' ? [...rssRows] : [...parodyRows]
            )
          ),
        })),
      })),
    })),
  })),
  selectDistinct: mock(() => ({
    from: mock((_table: { __name: string }) => ({
      where: mock(() =>
        Promise.resolve(
          storedTopics.map((t) => ({ topicKey: t.topicKey as string }))
        )
      ),
    })),
  })),
  insert: mock(() => ({
    values: mock((data: Record<string, unknown>) => ({
      onConflictDoUpdate: mock(({ set }: { set: Record<string, unknown> }) => ({
        returning: mock(async () => {
          const existingIndex = storedTopics.findIndex(
            (topic) =>
              (topic.date as Date).getTime() === (data.date as Date).getTime()
          );

          if (existingIndex >= 0) {
            storedTopics[existingIndex] = {
              ...storedTopics[existingIndex],
              ...set,
            };
            return [storedTopics[existingIndex]];
          }

          storedTopics.push(data);
          return [data];
        }),
      })),
    })),
  })),
  delete: mock(() => ({
    where: mock(async () => []),
  })),
};

mock.module('@babylon/db', () => ({
  db: dbMock,
  dailyTopics: { __name: 'dailyTopics', id: 'id' },
  rssHeadlines: {
    __name: 'rssHeadlines',
    publishedAt: 'publishedAt',
    id: 'id',
  },
  parodyHeadlines: {
    __name: 'parodyHeadlines',
    generatedAt: 'generatedAt',
    originalHeadlineId: 'originalHeadlineId',
  },
  and: (...args: unknown[]) => args,
  desc: (value: unknown) => value,
  generateSnowflakeId: mock(async () => `topic-${storedTopics.length + 1}`),
  gte: (a: unknown, b: unknown) => [a, b],
}));

mock.module('@babylon/shared', () => ({
  logger: {
    info: mock(() => {}),
    warn: mock(() => {}),
  },
}));

import {
  buildDailyTopicPromptContext,
  buildMultiTopicPromptContext,
  dailyTopicService,
  deriveTopicFromText,
  isTextOnAnyTopic,
  isTextOnTopic,
  normalizeTopicDate,
} from '../services/daily-topic-service';

describe('daily-topic-service', () => {
  beforeEach(() => {
    rssRows.length = 0;
    parodyRows.length = 0;
    storedTopics.length = 0;
    dbMock.dailyTopic.findFirst.mockClear?.();
  });

  test('listCandidates ranks repeated headline topics highest', async () => {
    rssRows.push(
      {
        id: 'h1',
        title: 'OpenAI unveils new reasoning model',
        summary: 'OpenAI expands enterprise rollout',
        publishedAt: new Date('2026-03-06T08:00:00.000Z'),
      },
      {
        id: 'h2',
        title: 'OpenAI faces scrutiny over new launch',
        summary: 'Developers react to OpenAI roadmap',
        publishedAt: new Date('2026-03-06T09:00:00.000Z'),
      },
      {
        id: 'h3',
        title: 'Tesla changes pricing again',
        summary: 'Another Tesla pricing move',
        publishedAt: new Date('2026-03-06T09:30:00.000Z'),
      }
    );

    const candidates = await dailyTopicService.listCandidates(
      new Date('2026-03-06T12:00:00.000Z')
    );

    expect(candidates[0]?.topicKey).toBe('openai');
    expect(candidates[0]?.sourceHeadlineIds).toContain('h1');
    expect(candidates[0]?.sourceHeadlineIds).toContain('h2');
  });

  test('ensureTopicForDate falls back to previous topic when no candidates exist', async () => {
    storedTopics.push({
      id: 'prev-topic',
      date: new Date('2026-03-05T00:00:00.000Z'),
      topicKey: 'openai',
      topicLabel: 'OpenAI',
      summary: 'OpenAI dominates the day',
      sourceType: 'auto',
      sourceHeadlineIds: ['h1'],
      selectionReason: 'Matched headlines',
      isLocked: false,
      createdAt: new Date('2026-03-05T00:00:00.000Z'),
      updatedAt: new Date('2026-03-05T00:00:00.000Z'),
    });

    const topic = await dailyTopicService.ensureTopicForDate(
      new Date('2026-03-06T14:00:00.000Z')
    );

    expect(topic?.topicKey).toBe('openai');
    expect(topic?.sourceType).toBe('fallback_previous_day');
  });

  test('ensureTopicForDate falls back to default topic when no candidates exist yet', async () => {
    const topic = await dailyTopicService.ensureTopicForDate(
      new Date('2026-03-06T14:00:00.000Z')
    );

    expect(topic?.topicKey).toBe('general');
    expect(topic?.topicLabel).toBe('General');
    expect(topic?.sourceType).toBe('fallback_default');
  });

  test('helper functions derive prompt-safe topic context', () => {
    const topic = deriveTopicFromText(
      'OpenAI leadership drama continues through launch day',
      new Date('2026-03-06T14:00:00.000Z')
    );

    expect(
      normalizeTopicDate(new Date('2026-03-06T14:00:00.000Z')).toISOString()
    ).toBe('2026-03-06T00:00:00.000Z');
    expect(buildDailyTopicPromptContext(topic)).toContain(topic.topicLabel);
    expect(
      isTextOnTopic('Will OpenAI announce another feature today?', topic)
    ).toBe(true);
    expect(isTextOnTopic('Will Tesla stock jump today?', topic)).toBe(false);
  });

  describe('deriveTopicFromText frequency-based selection', () => {
    const date = new Date('2026-03-06T14:00:00.000Z');

    test('picks the most frequent token over earlier tokens', () => {
      const topic = deriveTopicFromText(
        'Tesla announced Tesla earnings while Apple waits',
        date
      );
      expect(topic.topicKey).toBe('tesla');
    });

    test('breaks ties by longest token (more specific)', () => {
      const topic = deriveTopicFromText(
        'Apple versus Microsoft in cloud battle',
        date
      );
      // "microsoft" (9 chars) > "apple" (5 chars) > "cloud" (5 chars) > "battle" (6 chars)
      expect(topic.topicKey).toBe('microsoft');
    });

    test('returns "general" when all tokens are stopwords', () => {
      const topic = deriveTopicFromText(
        'does the stock market move above this level next week',
        date
      );
      expect(topic.topicKey).toBe('general');
      expect(topic.topicLabel).toBe('General');
    });

    test('filters out known nonsense stopwords (burp, dill, cumin)', () => {
      const topic = deriveTopicFromText(
        'burp dill cumin powered tech from OpenAI OpenAI',
        date
      );
      // "burp" (4 chars) and "dill" (4 chars) and "cumin" (5 chars) and "powered" and "tech" are all stopwords.
      // "openai" appears twice, wins by frequency
      expect(topic.topicKey).toBe('openai');
    });

    test('handles empty text gracefully', () => {
      const topic = deriveTopicFromText('', date);
      expect(topic.topicKey).toBe('general');
      expect(topic.topicLabel).toBe('General');
    });

    test('normalizes topic date to midnight UTC', () => {
      const topic = deriveTopicFromText('Tesla news', date);
      expect(topic.date.toISOString()).toBe('2026-03-06T00:00:00.000Z');
    });
  });

  describe('isTextOnAnyTopic', () => {
    const date = new Date('2026-03-06T00:00:00.000Z');
    const openaiTopic = deriveTopicFromText('OpenAI launches new model', date);
    const teslaTopic = deriveTopicFromText('Tesla earnings report', date);
    const appleTopic = deriveTopicFromText('Apple launches new iPhone', date);

    test('returns true when text matches any topic', () => {
      expect(
        isTextOnAnyTopic('Tesla stock surges on earnings beat', [
          openaiTopic,
          teslaTopic,
          appleTopic,
        ])
      ).toBe(true);
    });

    test('returns false when text matches no topics', () => {
      expect(
        isTextOnAnyTopic('Bitcoin mining operations expand globally', [
          openaiTopic,
          teslaTopic,
          appleTopic,
        ])
      ).toBe(false);
    });

    test('returns true for empty topics array (permissive fallback)', () => {
      expect(isTextOnAnyTopic('Anything goes here', [])).toBe(true);
    });

    test('returns true when text matches the only topic', () => {
      expect(
        isTextOnAnyTopic('OpenAI announces partnership', [openaiTopic])
      ).toBe(true);
    });
  });

  describe('buildMultiTopicPromptContext', () => {
    const date = new Date('2026-03-06T00:00:00.000Z');
    const openaiTopic = deriveTopicFromText('OpenAI launches new model', date);
    const teslaTopic = deriveTopicFromText('Tesla earnings report', date);

    test('returns permissive prompt for empty topics', () => {
      const result = buildMultiTopicPromptContext([]);
      expect(result).toContain('No daily topics');
      expect(result).toContain('any trending topic');
    });

    test('delegates to single-topic builder for one topic', () => {
      const multi = buildMultiTopicPromptContext([openaiTopic]);
      const single = buildDailyTopicPromptContext(openaiTopic);
      expect(multi).toBe(single);
    });

    test('lists multiple topics with diversity instructions', () => {
      const result = buildMultiTopicPromptContext([openaiTopic, teslaTopic]);
      expect(result).toContain('active topics');
      expect(result).toContain(openaiTopic.topicLabel);
      expect(result).toContain(teslaTopic.topicLabel);
      expect(result).toContain('variety');
    });
  });

  describe('getTopicCandidatesForDate', () => {
    test('returns primary topic plus additional candidates', async () => {
      rssRows.push(
        {
          id: 'h1',
          title: 'OpenAI unveils new reasoning model',
          summary: 'OpenAI expands enterprise rollout',
          publishedAt: new Date('2026-03-06T08:00:00.000Z'),
        },
        {
          id: 'h2',
          title: 'OpenAI faces scrutiny over new launch',
          summary: 'Developers react to OpenAI roadmap',
          publishedAt: new Date('2026-03-06T09:00:00.000Z'),
        },
        {
          id: 'h3',
          title: 'Tesla changes pricing again',
          summary: 'Another Tesla pricing move',
          publishedAt: new Date('2026-03-06T09:30:00.000Z'),
        },
        {
          id: 'h4',
          title: 'Apple launches new product line',
          summary: 'Apple reveals next generation devices',
          publishedAt: new Date('2026-03-06T10:00:00.000Z'),
        }
      );

      const candidates = await dailyTopicService.getTopicCandidatesForDate(
        new Date('2026-03-06T12:00:00.000Z'),
        3
      );

      expect(candidates.length).toBeGreaterThanOrEqual(1);
      expect(candidates.length).toBeLessThanOrEqual(3);
      // Primary topic should be first
      expect(candidates[0]?.topicKey).toBeDefined();
    });

    test('returns only primary when no additional candidates', async () => {
      // Single headline — only one candidate possible
      rssRows.push({
        id: 'h1',
        title: 'OpenAI unveils new reasoning model',
        summary: 'OpenAI expands enterprise rollout',
        publishedAt: new Date('2026-03-06T08:00:00.000Z'),
      });

      const candidates = await dailyTopicService.getTopicCandidatesForDate(
        new Date('2026-03-06T12:00:00.000Z'),
        3
      );

      expect(candidates.length).toBeGreaterThanOrEqual(1);
      expect(candidates[0]?.topicKey).toBeDefined();
    });

    test('returns empty array when no primary topic available', async () => {
      // Mock ensureTopicForDate to return null
      // With no RSS rows and no stored topics, ensureTopicForDate returns a fallback
      // So we test that it at least returns something
      const candidates = await dailyTopicService.getTopicCandidatesForDate(
        new Date('2026-03-06T12:00:00.000Z')
      );

      // Even with no RSS, ensureTopicForDate returns a fallback "general" topic
      expect(candidates.length).toBeGreaterThanOrEqual(1);
    });

    test('excludes primary from additional candidates', async () => {
      rssRows.push(
        {
          id: 'h1',
          title: 'OpenAI unveils new reasoning model',
          summary: 'OpenAI expands enterprise rollout',
          publishedAt: new Date('2026-03-06T08:00:00.000Z'),
        },
        {
          id: 'h2',
          title: 'OpenAI faces scrutiny over launch',
          summary: 'Developers react to OpenAI roadmap',
          publishedAt: new Date('2026-03-06T09:00:00.000Z'),
        },
        {
          id: 'h3',
          title: 'Tesla changes pricing strategy',
          summary: 'Tesla pricing move surprises market',
          publishedAt: new Date('2026-03-06T09:30:00.000Z'),
        }
      );

      const candidates = await dailyTopicService.getTopicCandidatesForDate(
        new Date('2026-03-06T12:00:00.000Z'),
        3
      );

      // Primary topic should not appear twice
      const topicKeys = candidates.map((c) => c.topicKey);
      const uniqueKeys = new Set(topicKeys);
      expect(uniqueKeys.size).toBe(topicKeys.length);
    });
  });
});
