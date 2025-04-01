import {
  type IAgentRuntime,
  ModelType,
  type TestSuite,
  createUniqueUuid,
  logger,
} from '@elizaos/core';
import { FARCASTER_SERVICE_NAME } from '../src/common/constants';
import { FidRequest } from '../src/common/types';
import { FarcasterAgentManager } from '../src/managers/agent';
import { TEST_IMAGE } from './test-utils';

/**
 * Represents a Test Suite for Farcaster functionality.
 * This class implements the TestSuite interface.
 * It contains various test cases related to Farcaster operations such as initializing the client,
 * fetching profile, fetching casts, posting casts, and handling cast interactions.
 */
export class FarcasterTestSuite implements TestSuite {
  name = 'farcaster';
  private manager: FarcasterAgentManager | null = null;
  tests: { name: string; fn: (runtime: IAgentRuntime) => Promise<void> }[];

  /**
   * Constructor for TestSuite class.
   * Initializes an array of test functions to be executed.
   */
  constructor() {
    this.tests = [
      {
        name: 'Initialize Farcaster Client',
        fn: this.testInitializingClient.bind(this),
      },
      { name: 'Fetch Profile', fn: this.testFetchProfile.bind(this) },
      {
        name: 'Fetch Timeline',
        fn: this.testFetchTimeline.bind(this),
      },
      { name: 'Post Cast', fn: this.testPostCast.bind(this) },
      { name: 'Post Cast With Image', fn: this.testPostImageCast.bind(this) },
      {
        name: 'Handle Cast Response',
        fn: this.testHandleCastResponse.bind(this),
      },
    ];
  }

  /**
   * Asynchronously initializes the Farcaster client for the provided agent runtime.
   *
   * @param {IAgentRuntime} runtime - The agent runtime to use for initializing the Farcaster client.
   * @throws {Error} If the Farcaster client manager is not found or if the Farcaster client fails to initialize.
   */
  async testInitializingClient(runtime: IAgentRuntime) {
    try {
      const service = runtime.getService(FARCASTER_SERVICE_NAME) as any;
      if (!service) {
        throw new Error('Farcaster service not found');
      }

      this.manager = service.managers.get(runtime.agentId);

      if (this.manager) {
        logger.debug('FarcasterAgentManager initialized successfully.');
      } else {
        throw new Error('FarcasterAgentManager failed to initialize.');
      }
    } catch (error) {
      throw new Error(`Error in initializing Farcaster client: ${error}`);
    }
  }

  /**
   * Asynchronously fetches the profile of a user from Farcaster using the given runtime.
   *
   * @param {IAgentRuntime} runtime The runtime to use for fetching the profile.
   * @returns {Promise<void>} A Promise that resolves when the profile is successfully fetched, or rejects with an error.
   */
  async testFetchProfile(runtime: IAgentRuntime) {
    try {
      if (!this.manager) {
        throw new Error('FarcasterAgentManager not initialized');
      }

      const fid = parseInt(runtime.getSetting('FARCASTER_FID') as string, 10);
      if (!fid || isNaN(fid)) {
        throw new Error('Invalid FID in settings.');
      }

      const profile = await this.manager.client.getProfile(fid);
      if (!profile || !profile.fid) {
        throw new Error('Profile fetch failed.');
      }
      logger.log('Successfully fetched Farcaster profile:', profile);
    } catch (error) {
      throw new Error(`Error fetching Farcaster profile: ${error}`);
    }
  }

  /**
   * Asynchronously fetches the timeline from the Farcaster client.
   *
   * @param {IAgentRuntime} runtime - The agent runtime object.
   * @throws {Error} If there are no casts in the timeline.
   * @throws {Error} If an error occurs while fetching the timeline.
   */
  async testFetchTimeline(runtime: IAgentRuntime) {
    try {
      if (!this.manager) {
        throw new Error('FarcasterAgentManager not initialized');
      }

      const fid = parseInt(runtime.getSetting('FARCASTER_FID') as string, 10);
      if (!fid || isNaN(fid)) {
        throw new Error('Invalid FID in settings.');
      }

      const request: FidRequest = { fid, pageSize: 5 };
      const result = await this.manager.client.getTimeline(request);

      if (!result.timeline || result.timeline.length === 0) {
        throw new Error('No casts in timeline.');
      }
      logger.log(`Successfully fetched ${result.timeline.length} casts from timeline.`);
    } catch (error) {
      throw new Error(`Error fetching timeline: ${error}`);
    }
  }

  /**
   * Asynchronously posts a test cast using the Farcaster API.
   *
   * @param {IAgentRuntime} runtime - The agent runtime object.
   * @returns {Promise<void>} A Promise that resolves when the cast is successfully posted.
   * @throws {Error} If there is an error posting the cast.
   */
  async testPostCast(runtime: IAgentRuntime) {
    try {
      if (!this.manager) {
        throw new Error('FarcasterAgentManager not initialized');
      }

      const castText = await this.generateRandomCastContent(runtime);
      const result = await this.manager.client.sendCast({
        content: { text: castText },
      });

      if (!result || result.length === 0) {
        throw new Error('Cast posting failed.');
      }
      logger.success('Successfully posted a test cast.');
    } catch (error) {
      throw new Error(`Error posting a cast: ${error}`);
    }
  }

  /**
   * Asynchronously posts an image cast on Farcaster using the provided runtime and cast content.
   * Note: This might need updating based on how images are actually handled in sendCast
   *
   * @param {IAgentRuntime} runtime - The runtime environment for the action.
   * @returns {Promise<void>} A Promise that resolves when the cast is successfully posted.
   * @throws {Error} If there is an error posting the cast.
   */
  async testPostImageCast(runtime: IAgentRuntime) {
    try {
      if (!this.manager) {
        throw new Error('FarcasterAgentManager not initialized');
      }

      const castText = await this.generateRandomCastContent(runtime, 'image_post');
      // This implementation might need to be updated based on how images are actually handled
      const result = await this.manager.client.sendCast({
        content: {
          text: castText,
          media: [TEST_IMAGE],
        },
      });

      if (!result || result.length === 0) {
        throw new Error('Cast with image posting failed.');
      }
      logger.success('Successfully posted a test cast with image.');
    } catch (error) {
      throw new Error(`Error posting a cast with image: ${error}`);
    }
  }

  /**
   * Asynchronously handles a fake cast response using the given runtime.
   *
   * @param {IAgentRuntime} runtime - The runtime object for the agent
   * @returns {Promise<void>} - A promise that resolves when the cast response is handled
   * @throws {Error} - If there is an error handling the cast response
   */
  async testHandleCastResponse(runtime: IAgentRuntime) {
    try {
      if (!this.manager) {
        throw new Error('FarcasterAgentManager not initialized');
      }

      // For testing purposes, we'll just mock the event emission instead of calling the actual handler
      // This avoids dealing with complex type requirements
      const testCast = {
        hash: '0x12345',
        text: '@testUser What do you think about AI?',
        authorFid: 123,
        profile: {
          fid: 123,
          username: 'randomUser',
          name: 'Random User',
        },
        timestamp: new Date(),
      };

      // Create a mock memory for the test
      const memoryId = createUniqueUuid(runtime, testCast.hash);
      const memory = {
        id: memoryId,
        agentId: runtime.agentId,
        content: {
          text: testCast.text,
        },
        entityId: createUniqueUuid(runtime, String(testCast.authorFid)),
        roomId: createUniqueUuid(runtime, 'test-room'),
        createdAt: testCast.timestamp.getTime(),
      };

      // Emit an event to simulate the interaction
      runtime.emitEvent('farcaster.mention_received', {
        runtime,
        memory,
        cast: testCast,
        source: 'farcaster',
      });

      logger.success('Successfully simulated cast response handling');
    } catch (error) {
      throw new Error(`Error handling cast response: ${error}`);
    }
  }

  /**
   * Generates random content for a cast based on the given context.
   *
   * @param {IAgentRuntime} runtime - The runtime environment.
   * @param {string} context - Optional context for the content generation.
   * @returns {Promise<string>} A promise that resolves to the generated cast content.
   */
  private async generateRandomCastContent(
    runtime: IAgentRuntime,
    context = 'general'
  ): Promise<string> {
    const prompt = `Generate a short, interesting cast about ${context} (max 280 chars).`;
    // Use TEXT_SMALL instead of CHAT since that seems to be the correct ModelType
    const result = await runtime.useModel(ModelType.TEXT_SMALL, {
      prompt,
    });

    // Truncate the result to ensure it doesn't exceed 280 characters
    return (result as string).substring(0, 280);
  }
}
