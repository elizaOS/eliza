import {
  type IAgentRuntime,
  ModelType,
  type TestSuite,
  createUniqueUuid,
  logger,
} from '@elizaos/core';
import { BLUESKY_SERVICE_NAME } from '../../common/constants.js';
import { BlueSkyAgentManager } from '../../managers/agent.js';
import { BlueSkyClient } from '../../client.js';
import { BlueSkyService } from '../../service.js';
import { validateBlueSkyConfig } from '../../common/config.js';

/**
 * Represents a Test Suite for BlueSky functionality.
 * This class implements the TestSuite interface.
 * It contains various test cases related to BlueSky operations such as initializing the client,
 * fetching profile, fetching timeline, posting to BlueSky, and handling interactions.
 */
export class BlueSkyTestSuite implements TestSuite {
  name = 'BlueSky Plugin Tests';
  description = 'Test suite for BlueSky plugin functionality using AT Protocol';
  tests: any[];
  private manager: BlueSkyAgentManager | null = null;
  private client: BlueSkyClient | null = null;

  constructor() {
    this.tests = this.testcases();
  }

  /**
   * Returns test cases for the test suite
   */
  testcases() {
    return [
      {
        name: 'Initialize BlueSky Client',
        fn: this.testInitializingClient.bind(this),
      },
      { name: 'Fetch Profile', fn: this.testFetchProfile.bind(this) },
      {
        name: 'Fetch Timeline',
        fn: this.testFetchTimeline.bind(this),
      },
      { name: 'Post to BlueSky', fn: this.testPostToBluesky.bind(this) },
      { name: 'Post with Media', fn: this.testPostWithMedia.bind(this) },
      {
        name: 'Handle Post Response',
        fn: this.testHandlePostResponse.bind(this),
      },
      {
        name: 'Test Message Service',
        fn: this.testMessageService.bind(this),
      },
      {
        name: 'Test Post Service',
        fn: this.testPostService.bind(this),
      },
      {
        name: 'Test Notifications',
        fn: this.testNotifications.bind(this),
      },
      {
        name: 'Test AT Protocol Features',
        fn: this.testATProtocolFeatures.bind(this),
      },
      {
        name: 'Test Reply Chain',
        fn: this.testReplyChain.bind(this),
      },
      {
        name: 'Test Concurrent Operations',
        fn: this.testConcurrentOperations.bind(this),
      },
      {
        name: 'Test Error Recovery',
        fn: this.testErrorRecovery.bind(this),
      },
      {
        name: 'Test Rate Limiting',
        fn: this.testRateLimiting.bind(this),
      },
      {
        name: 'Test Pagination',
        fn: this.testPagination.bind(this),
      },
      {
        name: 'Test Like and Repost',
        fn: this.testLikeAndRepost.bind(this),
      },
      {
        name: 'Test Cache Functionality',
        fn: this.testCacheFunctionality.bind(this),
      },
      {
        name: 'Test Post Deletion',
        fn: this.testPostDeletion.bind(this),
      },
      {
        name: 'Test Character Limit Handling',
        fn: this.testCharacterLimitHandling.bind(this),
      },
      {
        name: 'Test Agent Manager Lifecycle',
        fn: this.testAgentManagerLifecycle.bind(this),
      },
    ].map(test => ({
      name: test.name,
      fn: test.fn,
    }));
  }

  /**
   * Asynchronously initializes the BlueSky client for the provided agent runtime.
   *
   * @param {IAgentRuntime} runtime - The agent runtime to use for initializing the BlueSky client.
   * @throws {Error} If the BlueSky client manager is not found or if the BlueSky client fails to initialize.
   */
  async testInitializingClient(runtime: IAgentRuntime) {
    try {
      // Check if service is already available
      let service = runtime.getService(BLUESKY_SERVICE_NAME) as BlueSkyService;
      
      // If not, start the service
      if (!service) {
        logger.info('Starting BlueSky service for test');
        service = await BlueSkyService.start(runtime) as BlueSkyService;
      }

      // Create client directly for testing
      const config = validateBlueSkyConfig(runtime);
      this.client = new BlueSkyClient({
        service: config.service || 'https://bsky.social',
        handle: config.handle,
        password: config.password,
        dryRun: config.dryRun,
      });
      
      // Authenticate
      await this.client.authenticate();
      
      logger.debug('BlueSky client initialized and authenticated successfully.');
    } catch (error) {
      throw new Error(`Error in initializing BlueSky client: ${error}`);
    }
  }

  /**
   * Asynchronously fetches the profile of a user from BlueSky using the given runtime.
   *
   * @param {IAgentRuntime} runtime The runtime to use for fetching the profile.
   * @returns {Promise<void>} A Promise that resolves when the profile is successfully fetched, or rejects with an error.
   */
  async testFetchProfile(runtime: IAgentRuntime) {
    try {
      if (!this.client) {
        throw new Error('BlueSkyClient not initialized');
      }

      const handle = runtime.getSetting('BLUESKY_HANDLE') as string;
      if (!handle) {
        throw new Error('Invalid handle in settings.');
      }

      const profile = await this.client.getProfile(handle);
      if (!profile || !profile.did) {
        throw new Error('Profile fetch failed.');
      }
      logger.log('Successfully fetched BlueSky profile:', profile);
    } catch (error) {
      throw new Error(`Error fetching BlueSky profile: ${error}`);
    }
  }

  /**
   * Asynchronously fetches the timeline from the BlueSky client.
   *
   * @param {IAgentRuntime} runtime - The agent runtime object.
   * @throws {Error} If there are no posts in the timeline.
   * @throws {Error} If an error occurs while fetching the timeline.
   */
  async testFetchTimeline(runtime: IAgentRuntime) {
    try {
      if (!this.client) {
        throw new Error('BlueSkyClient not initialized');
      }

      const result = await this.client.getTimeline({ limit: 5 });

      if (!result.feed || result.feed.length === 0) {
        throw new Error('No posts in timeline.');
      }
      logger.log(`Successfully fetched ${result.feed.length} posts from timeline.`);
    } catch (error) {
      throw new Error(`Error fetching timeline: ${error}`);
    }
  }

  /**
   * Asynchronously posts a test post using the BlueSky API.
   *
   * @param {IAgentRuntime} runtime - The agent runtime object.
   * @returns {Promise<void>} A Promise that resolves when the post is successfully created.
   * @throws {Error} If there is an error posting the content.
   */
  async testPostToBluesky(runtime: IAgentRuntime) {
    try {
      if (!this.client) {
        throw new Error('BlueSkyClient not initialized');
      }

      // Add test prefix to identify test posts
      const timestamp = new Date().toISOString();
      const postText = `[E2E TEST ${timestamp}] ${await this.generateRandomPostContent(runtime)}`;
      
      logger.info('Creating test post:', postText);
      
      const result = await this.client.sendPost({
        content: { text: postText },
      });

      if (!result || !result.uri) {
        throw new Error('Post creation failed.');
      }
      
      logger.success('Successfully posted to BlueSky:', {
        uri: result.uri,
        text: postText.substring(0, 50) + '...'
      });
      
      // Optional: Delete the test post after creation
      // await this.client.deletePost(result.uri);
      // logger.info('Test post deleted');
    } catch (error) {
      throw new Error(`Error posting to BlueSky: ${error}`);
    }
  }

  /**
   * Asynchronously posts an image on BlueSky using the provided runtime and post content.
   * Note: This is a placeholder - actual image upload implementation would need to handle blobs
   *
   * @param {IAgentRuntime} runtime - The runtime environment for the action.
   * @returns {Promise<void>} A Promise that resolves when the post is successfully created.
   * @throws {Error} If there is an error posting the content.
   */
  async testPostWithMedia(runtime: IAgentRuntime) {
    try {
      if (!this.client) {
        throw new Error('BlueSkyClient not initialized');
      }

      const postText = await this.generateRandomPostContent(runtime, 'image_post');
      
      // In a real implementation, we would:
      // 1. Upload the image blob using client.uploadBlob()
      // 2. Create an embed with the blob reference
      // 3. Include the embed in the post
      
      const result = await this.client.sendPost({
        content: {
          text: postText,
          // embed would go here
        },
      });

      if (!result || !result.uri) {
        throw new Error('Post with image creation failed.');
      }
      logger.success('Successfully posted to BlueSky with image placeholder.');
    } catch (error) {
      throw new Error(`Error posting with image: ${error}`);
    }
  }

  /**
   * Asynchronously handles a fake post response using the given runtime.
   *
   * @param {IAgentRuntime} runtime - The runtime object for the agent
   * @returns {Promise<void>} - A promise that resolves when the post response is handled
   * @throws {Error} - If there is an error handling the post response
   */
  async testHandlePostResponse(runtime: IAgentRuntime) {
    try {
      if (!this.manager) {
        throw new Error('BlueSkyAgentManager not initialized');
      }

      // Mock a notification to simulate a mention
      const testNotification = {
        uri: 'at://did:plc:test/app.bsky.feed.post/12345',
        cid: 'test-cid-12345',
        author: {
          did: 'did:plc:testuser',
          handle: 'testuser.bsky.social',
          displayName: 'Test User',
        },
        reason: 'mention',
        record: {
          text: '@agent What do you think about AI?',
          createdAt: new Date().toISOString(),
        },
        isRead: false,
        indexedAt: new Date().toISOString(),
      };

      // Create a mock memory for the test
      const memoryId = createUniqueUuid(runtime, testNotification.uri);
      const memory = {
        id: memoryId,
        agentId: runtime.agentId,
        content: {
          text: testNotification.record.text,
        },
        entityId: createUniqueUuid(runtime, testNotification.author.did),
        roomId: createUniqueUuid(runtime, 'test-room'),
        createdAt: Date.now(),
      };

      // Emit an event to simulate the interaction
      runtime.emitEvent('bluesky.mention_received', {
        runtime,
        memory,
        notification: testNotification,
        source: 'bluesky',
      });

      logger.success('Successfully simulated post response handling');
    } catch (error) {
      throw new Error(`Error handling post response: ${error}`);
    }
  }

  /**
   * Tests the MessageService functionality
   *
   * @param {IAgentRuntime} runtime - The runtime environment.
   * @returns {Promise<void>} A promise that resolves when the test is complete.
   */
  async testMessageService(runtime: IAgentRuntime) {
    try {
      const service = runtime.getService(BLUESKY_SERVICE_NAME) as BlueSkyService;
      if (!service) {
        throw new Error('BlueSky service not found');
      }

      const messageService = service.getMessageService(runtime.agentId);
      if (!messageService) {
        throw new Error('MessageService not initialized');
      }

      // Test getMessages
      const messages = await messageService.getMessages({
        agentId: runtime.agentId,
        limit: 5,
      });

      logger.log(`Retrieved ${messages.length} messages from MessageService`);

      // Test getConversations
      const conversations = await messageService.getConversations({
        agentId: runtime.agentId,
        limit: 5,
      });

      logger.log(`Retrieved ${conversations.length} conversations`);

      logger.success('MessageService test completed successfully');
    } catch (error) {
      throw new Error(`Error testing MessageService: ${error}`);
    }
  }

  /**
   * Tests the PostService functionality
   *
   * @param {IAgentRuntime} runtime - The runtime environment.
   * @returns {Promise<void>} A promise that resolves when the test is complete.
   */
  async testPostService(runtime: IAgentRuntime) {
    try {
      const service = runtime.getService(BLUESKY_SERVICE_NAME) as BlueSkyService;
      if (!service) {
        throw new Error('BlueSky service not found');
      }

      const postService = service.getPostService(runtime.agentId);
      if (!postService) {
        throw new Error('PostService not initialized');
      }

      // Test getPosts
      const posts = await postService.getPosts({
        agentId: runtime.agentId,
        limit: 5,
      });

      logger.log(`Retrieved ${posts.length} posts from PostService`);

      // Test createPost
      const timestamp = new Date().toISOString();
      const testText = `[E2E SERVICE TEST ${timestamp}] ${await this.generateRandomPostContent(runtime, 'post_service_test')}`;
      const post = await postService.createPost({
        agentId: runtime.agentId,
        roomId: createUniqueUuid(runtime, 'test-room'),
        text: testText,
      });

      if (!post || !post.uri) {
        throw new Error('Failed to create post via PostService');
      }

      logger.success('PostService test completed successfully');
    } catch (error) {
      throw new Error(`Error testing PostService: ${error}`);
    }
  }

  /**
   * Tests the notification system
   *
   * @param {IAgentRuntime} runtime - The runtime environment.
   * @returns {Promise<void>} A promise that resolves when the test is complete.
   */
  async testNotifications(runtime: IAgentRuntime) {
    try {
      if (!this.client) {
        throw new Error('BlueSkyClient not initialized');
      }

      // Get notifications
      const { notifications } = await this.client.getNotifications(10);
      logger.log(`Retrieved ${notifications.length} notifications`);

      // Mark as seen
      await this.client.updateSeenNotifications();
      logger.log('Marked notifications as seen');

      logger.success('Notification test completed successfully');
    } catch (error) {
      throw new Error(`Error testing notifications: ${error}`);
    }
  }

  /**
   * Tests AT Protocol specific features
   *
   * @param {IAgentRuntime} runtime - The runtime environment.
   * @returns {Promise<void>} A promise that resolves when the test is complete.
   */
  async testATProtocolFeatures(runtime: IAgentRuntime) {
    try {
      if (!this.client) {
        throw new Error('BlueSkyClient not initialized');
      }

      // Test session management
      const session = this.client.getSession();
      if (!session || !session.did) {
        throw new Error('Session not properly established');
      }
      logger.log('Session validated:', { did: session.did, handle: session.handle });

      // Test AT URI format
      const testUri = `at://${session.did}/app.bsky.feed.post/test123`;
      logger.log('AT URI format test:', testUri);

      logger.success('AT Protocol features test completed successfully');
    } catch (error) {
      throw new Error(`Error testing AT Protocol features: ${error}`);
    }
  }

  /**
   * Tests reply chain functionality
   */
  async testReplyChain(runtime: IAgentRuntime) {
    try {
      if (!this.client) {
        throw new Error('BlueSkyClient not initialized');
      }

      // Create initial post
      const timestamp = new Date().toISOString();
      const initialPost = await this.client.sendPost({
        content: { text: `[E2E TEST ${timestamp}] Initial post in reply chain` },
      });

      if (!initialPost || !initialPost.uri) {
        throw new Error('Failed to create initial post');
      }

      // Create reply to initial post
      const replyPost = await this.client.sendPost({
        content: { text: `[E2E TEST ${timestamp}] Reply to initial post` },
        replyTo: {
          uri: initialPost.uri,
          cid: initialPost.cid,
        },
      });

      if (!replyPost || !replyPost.uri) {
        throw new Error('Failed to create reply post');
      }

      // Create reply to reply
      const nestedReply = await this.client.sendPost({
        content: { text: `[E2E TEST ${timestamp}] Nested reply` },
        replyTo: {
          uri: replyPost.uri,
          cid: replyPost.cid,
        },
      });

      if (!nestedReply || !nestedReply.uri) {
        throw new Error('Failed to create nested reply');
      }

      logger.success('Successfully created reply chain', {
        initialPost: initialPost.uri,
        replyPost: replyPost.uri,
        nestedReply: nestedReply.uri,
      });
    } catch (error) {
      throw new Error(`Error testing reply chain: ${error}`);
    }
  }

  /**
   * Tests concurrent operations
   */
  async testConcurrentOperations(runtime: IAgentRuntime) {
    try {
      if (!this.client) {
        throw new Error('BlueSkyClient not initialized');
      }

      const timestamp = new Date().toISOString();
      const promises: Promise<any>[] = [];

      // Create multiple posts concurrently
      for (let i = 0; i < 3; i++) {
        promises.push(
          this.client.sendPost({
            content: { text: `[E2E TEST ${timestamp}] Concurrent post ${i + 1}` },
          })
        );
      }

      // Fetch profile and timeline concurrently
      promises.push(this.client.getProfile(runtime.getSetting('BLUESKY_HANDLE') as string));
      promises.push(this.client.getTimeline({ limit: 5 }));

      const results = await Promise.allSettled(promises);
      
      const successful = results.filter(r => r.status === 'fulfilled').length;
      const failed = results.filter(r => r.status === 'rejected').length;

      logger.log(`Concurrent operations: ${successful} successful, ${failed} failed`);

      if (failed > 0) {
        logger.warn('Some concurrent operations failed:', 
          results.filter(r => r.status === 'rejected').map((r: any) => r.reason)
        );
      }

      logger.success('Concurrent operations test completed');
    } catch (error) {
      throw new Error(`Error testing concurrent operations: ${error}`);
    }
  }

  /**
   * Tests error recovery
   */
  async testErrorRecovery(runtime: IAgentRuntime) {
    try {
      const service = runtime.getService(BLUESKY_SERVICE_NAME) as BlueSkyService;
      if (!service) {
        throw new Error('BlueSky service not found');
      }

      // Test recovery from authentication error
      // Note: This is a simulated test - in real scenario, we'd force an auth error
      logger.log('Testing error recovery scenarios');

      // Test empty post handling
      try {
        await this.client?.sendPost({ content: { text: '' } });
      } catch (error) {
        logger.log('Successfully caught empty post error:', error);
      }

      // Test invalid handle profile fetch
      try {
        await this.client?.getProfile('invalid-handle-format');
      } catch (error) {
        logger.log('Successfully caught invalid handle error:', error);
      }

      logger.success('Error recovery test completed');
    } catch (error) {
      throw new Error(`Error testing error recovery: ${error}`);
    }
  }

  /**
   * Tests rate limiting behavior
   */
  async testRateLimiting(runtime: IAgentRuntime) {
    try {
      if (!this.client) {
        throw new Error('BlueSkyClient not initialized');
      }

      logger.log('Testing rate limiting behavior (simulated)');
      
      // Note: Actual rate limit testing would require many requests
      // This is a placeholder to demonstrate the test structure
      
      const requests: Promise<any>[] = [];
      for (let i = 0; i < 5; i++) {
        requests.push(
          this.client.getTimeline({ limit: 1 }).catch(error => ({
            error,
            index: i,
          }))
        );
      }

      const results = await Promise.all(requests);
      const errors = results.filter((r: any) => r.error);

      if (errors.length > 0) {
        logger.warn(`Rate limit errors detected: ${errors.length}`);
      }

      logger.success('Rate limiting test completed');
    } catch (error) {
      throw new Error(`Error testing rate limiting: ${error}`);
    }
  }

  /**
   * Tests pagination functionality
   */
  async testPagination(runtime: IAgentRuntime) {
    try {
      if (!this.client) {
        throw new Error('BlueSkyClient not initialized');
      }

      // Test timeline pagination
      const firstPage = await this.client.getTimeline({ limit: 10 });
      logger.log(`First page: ${firstPage.feed.length} posts`);

      if (firstPage.cursor) {
        const secondPage = await this.client.getTimeline({ 
          limit: 10, 
          cursor: firstPage.cursor 
        });
        logger.log(`Second page: ${secondPage.feed.length} posts`);

        // Verify no duplicate posts between pages
        const firstPageUris = firstPage.feed.map(item => item.post.uri);
        const secondPageUris = secondPage.feed.map(item => item.post.uri);
        const duplicates = firstPageUris.filter(uri => secondPageUris.includes(uri));

        if (duplicates.length > 0) {
          throw new Error(`Found ${duplicates.length} duplicate posts between pages`);
        }
      }

      // Test notification pagination
      const firstNotifPage = await this.client.getNotifications(10);
      logger.log(`First notification page: ${firstNotifPage.notifications.length} notifications`);

      logger.success('Pagination test completed successfully');
    } catch (error) {
      throw new Error(`Error testing pagination: ${error}`);
    }
  }

  /**
   * Tests like and repost functionality
   */
  async testLikeAndRepost(runtime: IAgentRuntime) {
    try {
      if (!this.client) {
        throw new Error('BlueSkyClient not initialized');
      }

      // Create a post to like and repost
      const timestamp = new Date().toISOString();
      const post = await this.client.sendPost({
        content: { text: `[E2E TEST ${timestamp}] Post to like and repost` },
      });

      if (!post || !post.uri) {
        throw new Error('Failed to create post for like/repost test');
      }

      // Like the post
      await this.client.likePost(post.uri, post.cid);
      logger.log('Successfully liked post');

      // Repost the post
      await this.client.repost(post.uri, post.cid);
      logger.log('Successfully reposted');

      logger.success('Like and repost test completed successfully');
    } catch (error) {
      throw new Error(`Error testing like and repost: ${error}`);
    }
  }

  /**
   * Tests cache functionality
   */
  async testCacheFunctionality(runtime: IAgentRuntime) {
    try {
      if (!this.client) {
        throw new Error('BlueSkyClient not initialized');
      }

      const handle = runtime.getSetting('BLUESKY_HANDLE') as string;

      // First profile fetch (should hit API)
      const startTime1 = Date.now();
      const profile1 = await this.client.getProfile(handle);
      const duration1 = Date.now() - startTime1;

      // Second profile fetch (should hit cache)
      const startTime2 = Date.now();
      const profile2 = await this.client.getProfile(handle);
      const duration2 = Date.now() - startTime2;

      // Cache should be significantly faster
      logger.log(`First fetch: ${duration1}ms, Second fetch: ${duration2}ms`);
      
      // Verify profiles are identical
      if (profile1.did !== profile2.did) {
        throw new Error('Cached profile does not match original');
      }

      // Clean cache and verify
      await this.client.cleanup();
      
      logger.success('Cache functionality test completed');
    } catch (error) {
      throw new Error(`Error testing cache functionality: ${error}`);
    }
  }

  /**
   * Tests post deletion
   */
  async testPostDeletion(runtime: IAgentRuntime) {
    try {
      if (!this.client) {
        throw new Error('BlueSkyClient not initialized');
      }

      // Create a post
      const timestamp = new Date().toISOString();
      const post = await this.client.sendPost({
        content: { text: `[E2E TEST ${timestamp}] Post to be deleted` },
      });

      if (!post || !post.uri) {
        throw new Error('Failed to create post for deletion test');
      }

      logger.log('Created post:', post.uri);

      // Delete the post
      await this.client.deletePost(post.uri);
      logger.log('Successfully deleted post');

      // Verify deletion by trying to fetch the post
      // Note: In real implementation, we'd verify the post is gone

      logger.success('Post deletion test completed');
    } catch (error) {
      throw new Error(`Error testing post deletion: ${error}`);
    }
  }

  /**
   * Tests character limit handling
   */
  async testCharacterLimitHandling(runtime: IAgentRuntime) {
    try {
      const service = runtime.getService(BLUESKY_SERVICE_NAME) as BlueSkyService;
      if (!service) {
        throw new Error('BlueSky service not found');
      }

      const postService = service.getPostService(runtime.agentId);
      if (!postService) {
        throw new Error('PostService not initialized');
      }

      // Test with text exactly at limit (300 chars)
      const exactLimitText = 'A'.repeat(300);
      const exactLimitPost = await postService.createPost({
        agentId: runtime.agentId,
        roomId: createUniqueUuid(runtime, 'test-room'),
        text: exactLimitText,
      });

      if (!exactLimitPost || exactLimitPost.record.text.length > 300) {
        throw new Error('Failed to handle exact character limit');
      }

      // Test with text over limit (should be truncated)
      const overLimitText = 'B'.repeat(500);
      const overLimitPost = await postService.createPost({
        agentId: runtime.agentId,
        roomId: createUniqueUuid(runtime, 'test-room'),
        text: overLimitText,
      });

      if (!overLimitPost || overLimitPost.record.text.length > 300) {
        throw new Error('Failed to truncate over-limit text');
      }

      logger.success('Character limit handling test completed');
    } catch (error) {
      throw new Error(`Error testing character limit handling: ${error}`);
    }
  }

  /**
   * Tests agent manager lifecycle
   */
  async testAgentManagerLifecycle(runtime: IAgentRuntime) {
    try {
      const service = runtime.getService(BLUESKY_SERVICE_NAME) as BlueSkyService;
      if (!service) {
        throw new Error('BlueSky service not found');
      }

      // Get manager
      const manager = (service as any).managers.get(runtime.agentId);
      if (!manager) {
        throw new Error('Agent manager not found');
      }

      // Test stopping and restarting
      logger.log('Testing agent manager lifecycle');

      // Stop the manager
      await manager.stop();
      logger.log('Manager stopped');

      // Restart the manager
      await manager.start();
      logger.log('Manager restarted');

      // Verify manager is running
      if (!(manager as any).isRunning) {
        throw new Error('Manager failed to restart');
      }

      logger.success('Agent manager lifecycle test completed');
    } catch (error) {
      throw new Error(`Error testing agent manager lifecycle: ${error}`);
    }
  }

  /**
   * Generates random content for a post based on the given context.
   *
   * @param {IAgentRuntime} runtime - The runtime environment.
   * @param {string} context - Optional context for the content generation.
   * @returns {Promise<string>} A promise that resolves to the generated post content.
   */
  private async generateRandomPostContent(
    runtime: IAgentRuntime,
    context = 'general'
  ): Promise<string> {
    const prompt = `Generate a short, interesting BlueSky post about ${context} (max 300 chars).`;
    
    const result = await runtime.useModel(ModelType.TEXT_SMALL, {
      prompt,
    });

    // Truncate the result to ensure it doesn't exceed 300 characters
    return (result as string).substring(0, 300);
  }
}
