import { getScraper } from './test-utils';
import { jest } from '@jest/globals';

let shouldSkipV2Tests = false;
let testUserId: string;
let testConversationId: string;

beforeAll(async () => {
  const {
    TWITTER_API_KEY,
    TWITTER_API_SECRET_KEY,
    TWITTER_ACCESS_TOKEN,
    TWITTER_ACCESS_TOKEN_SECRET,
    TWITTER_USERNAME,
  } = process.env;

  if (
    !TWITTER_API_KEY ||
    !TWITTER_API_SECRET_KEY ||
    !TWITTER_ACCESS_TOKEN ||
    !TWITTER_ACCESS_TOKEN_SECRET ||
    !TWITTER_USERNAME
  ) {
    console.warn(
      'Skipping tests: Twitter API v2 keys are not available in environment variables.',
    );
    shouldSkipV2Tests = true;
    return;
  }

  try {
    // Get the user ID from username
    const scraper = await getScraper();
    const profile = await scraper.getProfile(TWITTER_USERNAME);

    if (!profile.userId) {
      throw new Error('User ID not found');
    }

    testUserId = profile.userId;

    // Get first conversation ID for testing
    const conversations = await scraper.getDirectMessageConversations(
      testUserId,
    );

    if (
      !conversations.conversations.length &&
      !conversations.conversations[0].conversationId
    ) {
      throw new Error('No conversations found');
    }

    // testConversationId = conversations.conversations[0].conversationId;
    testConversationId = '1025530896651362304-1247854858931040258';
  } catch (error) {
    console.error('Failed to initialize test data:', error);
    shouldSkipV2Tests = true;
  }
});

describe('Direct Message Tests', () => {
  beforeEach(() => {
    if (shouldSkipV2Tests || !testUserId || !testConversationId) {
      console.warn('Skipping test: Required test data not available');
      return;
    }
  });

  test('should get DM conversations', async () => {
    if (shouldSkipV2Tests) return;

    const scraper = await getScraper();
    const conversations = await scraper.getDirectMessageConversations(
      testUserId,
    );

    expect(conversations).toBeDefined();
    expect(conversations.conversations).toBeInstanceOf(Array);
    expect(conversations.users).toBeInstanceOf(Array);
  }, 30000);

  test('should handle DM send failure gracefully', async () => {
    if (shouldSkipV2Tests) return;

    const scraper = await getScraper();
    const invalidConversationId = 'invalid-id';

    await expect(
      scraper.sendDirectMessage(invalidConversationId, 'test message'),
    ).rejects.toThrow();
  }, 30000);

  test('should verify DM conversation structure', async () => {
    if (shouldSkipV2Tests) return;

    const scraper = await getScraper();
    const conversations = await scraper.getDirectMessageConversations(
      testUserId,
    );

    if (conversations.conversations.length > 0) {
      const conversation = conversations.conversations[0];

      // Test conversation structure
      expect(conversation).toHaveProperty('conversationId');
      expect(conversation).toHaveProperty('messages');
      expect(conversation).toHaveProperty('participants');

      // Test participants structure
      expect(conversation.participants[0]).toHaveProperty('id');
      expect(conversation.participants[0]).toHaveProperty('screenName');

      // Test message structure if messages exist
      if (conversation.messages.length > 0) {
        const message = conversation.messages[0];
        expect(message).toHaveProperty('id');
        expect(message).toHaveProperty('text');
        expect(message).toHaveProperty('senderId');
        expect(message).toHaveProperty('recipientId');
        expect(message).toHaveProperty('createdAt');
      }
    }
  }, 30000);
});
