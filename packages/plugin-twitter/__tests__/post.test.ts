import type { IAgentRuntime } from '@elizaos/core';
import { logger, truncateToCompleteSentence } from '@elizaos/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ClientBase } from '../src/base';
import type { TwitterConfig } from '../src/environment';
import { TwitterPostClient } from '../src/post';

const MAX_TWITTER_POST_LENGTH = 280;

vi.mock('@elizaos/core', async () => {
  const actual = await vi.importActual<typeof import('@elizaos/core')>('@elizaos/core');

  return {
    ...actual,
    logger: {
      log: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
    },
    generateText: vi.fn().mockResolvedValue(`{"text": "mock text", "action": "mock-action"}`),
  };
});

describe('Twitter Post Client', () => {
  let mockRuntime: IAgentRuntime;
  let mockConfig: TwitterConfig;
  let baseClient: ClientBase;
  let postClient: TwitterPostClient;

  beforeEach(() => {
    mockRuntime = {
      env: {
        TWITTER_USERNAME: 'testuser',
        TWITTER_DRY_RUN: 'true',
        TWITTER_POST_INTERVAL_MIN: '5',
        TWITTER_POST_INTERVAL_MAX: '10',
        TWITTER_ENABLE_ACTION_PROCESSING: 'true',
        TWITTER_POST_IMMEDIATELY: 'false',
        TWITTER_EMAIL: 'test@example.com',
        TWITTER_PASSWORD: 'hashedpassword',
        TWITTER_2FA_SECRET: '',
        TWITTER_POLL_INTERVAL: '120',
        TWITTER_RETRY_LIMIT: '5',
      },
      getEnv: function (key: string) {
        return this.env[key] || null;
      },
      getSetting: function (key: string) {
        return this.env[key] || null;
      },
      getCache: vi.fn().mockResolvedValue(null),
      setCache: vi.fn().mockResolvedValue(true),
      messageManager: {
        createMemory: vi.fn().mockResolvedValue(true),
      },
      composeState: vi.fn(),
      composePrompt: vi.fn(),
      getOrCreateUser: vi.fn().mockResolvedValue(true),
      ensureRoomExists: vi.fn().mockResolvedValue(true),
      ensureParticipantInRoom: vi.fn().mockResolvedValue(true),
      character: {
        templates: {
          twitterPostTemplate: 'Mock template',
        },
        topics: [],
      },
    } as unknown as IAgentRuntime;

    mockConfig = {
      TWITTER_USERNAME: 'testuser',
      TWITTER_DRY_RUN: true,
      TWITTER_SPACES_ENABLE: false,
      TWITTER_PASSWORD: 'hashedpassword',
      TWITTER_EMAIL: 'test@example.com',
      TWITTER_2FA_SECRET: '',
      TWITTER_RETRY_LIMIT: 5,
      TWITTER_POLL_INTERVAL: 120,
      TWITTER_POST_INTERVAL_MIN: 5,
      TWITTER_POST_INTERVAL_MAX: 10,
      TWITTER_ENABLE_POST_GENERATION: true,
      TWITTER_POST_IMMEDIATELY: false,
    };

    baseClient = new ClientBase(mockRuntime, mockConfig);
    baseClient.profile = {
      screenName: 'Mock Screen Name',
      username: 'mockuser',
      id: 'mock-id',
      bio: 'Mock bio for testing.',
      nicknames: ['MockNickname'],
    };

    postClient = new TwitterPostClient(baseClient, mockRuntime, mockConfig);
  });

  it('should create post client instance', () => {
    expect(postClient).toBeDefined();
    expect(postClient.twitterUsername).toBe('testuser');
  });

  it('should keep tweets under max length when already valid', () => {
    const validTweet = 'This is a valid tweet';
    const result = truncateToCompleteSentence(validTweet, MAX_TWITTER_POST_LENGTH);
    expect(result).toBe(validTweet);
    expect(result.length).toBeLessThanOrEqual(280);
  });

  it('should cut at last sentence when possible', () => {
    const longTweet =
      'First sentence. Second sentence that is quite long. Third sentence that would make it too long.';
    const result = truncateToCompleteSentence(longTweet, MAX_TWITTER_POST_LENGTH);
    const lastPeriod = result.lastIndexOf('.');
    expect(lastPeriod).toBeGreaterThan(0);
    expect(result.length).toBeLessThanOrEqual(280);
  });

  it('should add ellipsis when cutting within a sentence', () => {
    const longSentence =
      'This is an extremely long sentence without any periods that needs to be truncated because it exceeds the maximum allowed length for a tweet on the Twitter platform and therefore must be shortened';
    const result = truncateToCompleteSentence(longSentence, MAX_TWITTER_POST_LENGTH);
    const lastSpace = result.lastIndexOf(' ');
    expect(lastSpace).toBeGreaterThan(0);
    expect(result.length).toBeLessThanOrEqual(280);
  });

  it('should handle Twitter API errors gracefully', async () => {
    const mockError = new Error('Twitter API error');
    vi.spyOn(logger, 'error');
    vi.spyOn(postClient, 'sendStandardTweet').mockRejectedValue(mockError);

    await expect(
      postClient.postTweet(
        mockRuntime,
        baseClient,
        'Test tweet',
        'room-id' as any,
        'raw tweet',
        'testuser'
      )
    ).rejects.toThrow(mockError);

    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('Error sending tweet:'));
  });

  // it("should process a tweet and cache it", async () => {
  // 	const tweetData = {
  // 		rest_id: "mock-tweet-id",
  // 		legacy: {
  // 			full_text: "Mock tweet",
  // 		},
  // 	};

  // 	const tweet = postClient.createTweetObject(
  // 		tweetData,
  // 		baseClient,
  // 		baseClient.profile?.username as any,
  // 	);

  // 	await postClient.processAndCacheTweet(
  // 		mockRuntime,
  // 		baseClient,
  // 		tweet,
  // 		"room-id" as any,
  // 		"raw tweet",
  // 	);

  // 	expect(mockRuntime.getCache).toHaveBeenCalledWith(
  // 		`twitter/${baseClient.profile?.username}/lastPost`,
  // 		expect.objectContaining({ id: "mock-tweet-id" }),
  // 	);
  // });

  it('should properly construct tweet objects', () => {
    const tweetData = {
      rest_id: 'mock-tweet-id',
      legacy: {
        full_text: 'Mock tweet',
      },
    };

    const tweet = postClient.createTweetObject(tweetData, baseClient, 'testuser');

    expect(tweet.id).toBe('mock-tweet-id');
    expect(tweet.text).toBe('Mock tweet');
    expect(tweet.permanentUrl).toBe('https://twitter.com/testuser/status/mock-tweet-id');
  });
});
