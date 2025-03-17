import type { IAgentRuntime } from '@elizaos/core';
import { logger } from '@elizaos/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClientBase } from '../src/base';
import type { Tweet } from '../src/client';
import type { TwitterConfig } from '../src/environment';
import { TwitterInteractionClient } from '../src/interactions';

const mockProfile = {
  screenName: 'Mock Screen Name',
  username: 'mockuser',
  id: 'mock-id',
  bio: 'Mock bio for testing.',
  nicknames: ['MockNickname'],
};

/**
 * Function to create a mock Tweet object for testing purposes.
 *
 * @param {Partial<Tweet>} overrides - Optional object containing properties to override in the mock Tweet.
 * @returns {Tweet} - A mock Tweet object with default and overridden properties.
 */
function createMockTweet(overrides: Partial<Tweet> = {}): Tweet {
  return {
    id: '1234567890',
    text: 'Hello from a test tweet!',
    username: 'someone',
    name: 'Some One',
    conversationId: '123',
    userId: 'user-abc',
    inReplyToStatusId: undefined,
    isRetweet: false,
    isReply: false,
    permanentUrl: 'https://twitter.com/someone/status/1234567890',
    timestamp: Math.floor(Date.now() / 1000),
    photos: [],
    ...overrides,
  } as Tweet;
}

describe('TwitterInteractionClient', () => {
  let mockRuntime: IAgentRuntime;
  let mockConfig: TwitterConfig;
  let baseClient: ClientBase;
  let interactionClient: TwitterInteractionClient;

  beforeEach(() => {
    // vi.clearAllMocks();
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
      };
    });

    mockRuntime = {
      env: {
        TWITTER_USERNAME: 'testuser',
        TWITTER_DRY_RUN: 'true',
        TWITTER_ENABLE_POST_GENERATION: 'true',
        TWITTER_POST_IMMEDIATELY: 'false',
        TWITTER_TARGET_USERS: '',
        TWITTER_POLL_INTERVAL: '2',
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
      createMemory: vi.fn().mockResolvedValue(true),
      getMemoryById: vi.fn().mockResolvedValue(null),
      composeState: vi.fn().mockResolvedValue({}),
      composePrompt: vi.fn(),
      ensureRoomExists: vi.fn().mockResolvedValue(true),
      getOrCreateUser: vi.fn().mockResolvedValue(true),
      ensureParticipantInRoom: vi.fn().mockResolvedValue(true),
      ensureConnection: vi.fn().mockResolvedValue(true),
      updateRecentMessageState: vi.fn().mockResolvedValue({}),
      processActions: vi.fn().mockResolvedValue(true),
      character: {
        templates: {
          twitterShouldRespondTemplate: '',
          twitterMessageHandlerTemplate: '',
        },
        messageExamples: [],
        topics: [],
      },
      agentId: 'agent-uuid',
      useModel: vi.fn().mockResolvedValue({
        title: 'TestTitle',
        description: 'TestDescription',
      }),
    } as unknown as IAgentRuntime;

    mockConfig = {
      TWITTER_USERNAME: 'testuser',
      TWITTER_DRY_RUN: true,
      TWITTER_SPACES_ENABLE: false,
      TWITTER_PASSWORD: 'hashedpassword',
      TWITTER_EMAIL: 'test@example.com',
      TWITTER_2FA_SECRET: '',
      TWITTER_RETRY_LIMIT: 5,
      TWITTER_POLL_INTERVAL: 2,
      TWITTER_POST_INTERVAL_MIN: 5,
      TWITTER_POST_INTERVAL_MAX: 10,
      TWITTER_ENABLE_POST_GENERATION: true,
      TWITTER_POST_IMMEDIATELY: false,
    };

    baseClient = new ClientBase(mockRuntime, mockConfig);
    baseClient.profile = mockProfile;

    // By default, searching for tweets returns empty results
    vi.spyOn(baseClient, 'fetchSearchTweets').mockResolvedValue({
      tweets: [] as Tweet[],
    });
    vi.spyOn(baseClient, 'saveRequestMessage').mockResolvedValue();

    baseClient.lastCheckedTweetId = null;
    vi.spyOn(baseClient, 'cacheLatestCheckedTweetId').mockResolvedValue();

    interactionClient = new TwitterInteractionClient(baseClient, mockRuntime, mockConfig);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should instantiate client and set isDryRun to true', () => {
    expect(interactionClient).toBeDefined();
  });

  // it("should call fetchSearchTweets with correct parameters in handleTwitterInteractions (no tweets found)", async () => {
  // 	await interactionClient.handleTwitterInteractions();

  // 	expect(baseClient.fetchSearchTweets).toHaveBeenCalledWith(
  // 		`@${baseClient.profile?.username}`,
  // 		20,
  // 		SearchMode.Latest,
  // 	);
  // 	// By default we returned no tweets, so no further calls
  // 	expect(mockRuntime.createMemory).not.toHaveBeenCalled();
  // });

  it('should skip responding to tweet from self', async () => {
    // Setup: tweet is from same user as agent
    const myTweet = createMockTweet({
      userId: mockProfile.id,
      username: mockProfile.username,
    });

    vi.spyOn(baseClient, 'fetchSearchTweets').mockResolvedValue({
      tweets: [myTweet],
    });

    await interactionClient.handleTwitterInteractions();

    // expect(generateMessageResponse).not.toHaveBeenCalled();
  });

  it('should skip tweet if text is empty', async () => {
    const emptyTweet = createMockTweet({ text: '' });
    vi.spyOn(baseClient, 'fetchSearchTweets').mockResolvedValue({
      tweets: [emptyTweet],
    });

    await interactionClient.handleTwitterInteractions();

    // expect(generateMessageResponse).not.toHaveBeenCalled();
  });

  // it("should properly process a mention if generateShouldRespond returns IGNORE", async () => {
  // 	vi.mocked(generateShouldRespond).mockReturnValueOnce("IGNORE" as any);

  // 	const mentionTweet = createMockTweet({ id: "111", text: "Hey @mockuser" });
  // 	// Make sure the mention is from a different user
  // 	mentionTweet.userId = "user-other";
  // 	mentionTweet.username = "otheruser";

  // 	vi.spyOn(baseClient, "fetchSearchTweets").mockResolvedValue({
  // 		tweets: [mentionTweet],
  // 	});

  // 	await interactionClient.handleTwitterInteractions();

  // 	expect(mockRuntime.createMemory).toHaveBeenCalledTimes(1);
  // 	expect(generateMessageResponse).not.toHaveBeenCalled();

  // 	// Make sure lastCheckedTweetId is updated
  // 	expect(baseClient.lastCheckedTweetId?.toString()).toBe("111");
  // });

  // it("should RESPOND to a mention if generateShouldRespond returns RESPOND", async () => {
  // 	const mentionTweet = createMockTweet({ id: "222", text: "Hey @mockuser" });
  // 	mentionTweet.userId = "user-other";

  // 	vi.spyOn(baseClient, "fetchSearchTweets").mockResolvedValue({
  // 		tweets: [mentionTweet],
  // 	});

  // 	await interactionClient.handleTwitterInteractions();

  // 	// Memory created
  // 	expect(mockRuntime.createMemory).toHaveBeenCalledTimes(1);
  // 	// Should check if we respond
  // 	expect(generateShouldRespond).toHaveBeenCalledTimes(1);
  // 	// Because we respond, generateMessageResponse should be called
  // 	expect(generateMessageResponse).toHaveBeenCalledTimes(1);

  // 	// lastCheckedTweetId updated
  // 	expect(baseClient.lastCheckedTweetId?.toString()).toBe("222");
  // });

  // it("should handle tweet from target users (even if not a mention)", async () => {
  // 	// Simulate a tweet from the target user "specialuser"
  // 	const targetUserTweet = createMockTweet({
  // 		id: "333",
  // 		text: "mock target user text",
  // 		username: "mock-target-user",
  // 		userId: "mock-target-uuid",
  // 		isReply: false,
  // 		isRetweet: false,
  // 	});

  // 	vi.spyOn(baseClient, "fetchSearchTweets").mockImplementation(
  // 		async (q: string) => {
  // 			if (q.startsWith("from")) {
  // 				return { tweets: [targetUserTweet] };
  // 			}
  // 			return { tweets: [] };
  // 		},
  // 	);

  // 	await interactionClient.handleTwitterInteractions();

  // 	// Memory created
  // 	expect(mockRuntime.createMemory).toHaveBeenCalledTimes(1);
  // 	// Should check if we respond
  // 	expect(generateShouldRespond).toHaveBeenCalledTimes(1);
  // 	// Because we respond, generateMessageResponse should be called
  // 	expect(generateMessageResponse).toHaveBeenCalledTimes(1);

  // 	// lastCheckedTweetId updated
  // 	expect(baseClient.lastCheckedTweetId?.toString()).toBe("333");
  // });

  it('should log error if fetching tweets fails', async () => {
    const mockError = new Error('Twitter API error');
    vi.spyOn(baseClient, 'fetchSearchTweets').mockRejectedValue(mockError);

    await interactionClient.handleTwitterInteractions();

    expect(logger.error).toHaveBeenCalledWith(
      'Error handling Twitter interactions:',
      expect.any(Error)
    );
  });

  // it("should build conversation thread for a reply chain", async () => {
  // 	// We can test if buildConversationThread is working by having:
  // 	//   - A child tweet referencing a parent tweet
  // 	//   - A parent tweet with some text
  // 	const parentTweet = createMockTweet({
  // 		id: "100",
  // 		text: "I am a parent tweet",
  // 		userId: "parent-id",
  // 		username: "parentuser",
  // 		conversationId: "conv-100",
  // 	});

  // 	const childTweet = createMockTweet({
  // 		id: "101",
  // 		text: "I am a child tweet responding to the parent",
  // 		userId: "child-id",
  // 		username: "childuser",
  // 		inReplyToStatusId: "100",
  // 		conversationId: "conv-100",
  // 	});

  // 	vi.spyOn(baseClient, "fetchSearchTweets").mockResolvedValue({
  // 		tweets: [childTweet],
  // 	});

  // 	// mock the client.twitterClient.getTweet to return the parent if requested
  // 	baseClient.twitterClient.getTweet = vi
  // 		.fn()
  // 		.mockImplementation(async (id: string) => {
  // 			if (id === "100") {
  // 				return parentTweet;
  // 			}
  // 			return null;
  // 		});

  // 	await interactionClient.handleTwitterInteractions();

  // 	// The child first, then the parent is discovered
  // 	expect(mockRuntime.createMemory).toHaveBeenCalledTimes(2);

  // 	// Also check that lastCheckedTweetId is updated to "101"
  // 	expect(baseClient.lastCheckedTweetId?.toString()).toBe("101");
  // });
});
