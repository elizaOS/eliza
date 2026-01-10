import { type IAgentRuntime, createUniqueUuid, type TestCase } from '@elizaos/core';
import { getFarcasterFid } from '../../common/config.js';
import { FARCASTER_SERVICE_NAME } from '../../common/constants.js';
import type { FarcasterService } from '../../service.js';
import { FarcasterMessageType } from '../../common/types.js';

// E2E Test Scenarios as TestCase functions
export const farcasterE2EScenarios: TestCase[] = [
  {
    name: 'Farcaster Plugin - Agent Introduction',
    async fn(runtime: IAgentRuntime): Promise<void> {
      const service = runtime.getService(FARCASTER_SERVICE_NAME) as FarcasterService;
      if (!service) {
        throw new Error('Farcaster service not initialized');
      }

      // Test 1: Post introduction
      const castService = service.getCastService(runtime.agentId);
      if (!castService) {
        throw new Error('CastService not available');
      }

      const introText = `Hello Farcaster! I'm ${runtime.character.name}, an AI agent powered by ElizaOS. Looking forward to connecting with you all! 🤖`;
      
      const cast = await castService.createCast({
        agentId: runtime.agentId,
        roomId: createUniqueUuid(runtime, 'farcaster-timeline'),
        text: introText,
      });

      if (!cast || !cast.id || !cast.text || !cast.metadata?.castHash) {
        throw new Error('Failed to create introduction cast');
      }
      
      runtime.logger.info(`Posted introduction cast: ${cast.metadata.castHash}`);

      // Test 2: Fetch profile
      const manager = service.getActiveManagers().get(runtime.agentId);
      if (!manager) {
        throw new Error('Manager not found for agent');
      }

      const fid = getFarcasterFid(runtime);
      if (!fid) {
        throw new Error('FARCASTER_FID not configured');
      }
      const profile = await manager.client.getProfile(fid);

      if (!profile || profile.fid !== fid) {
        throw new Error('Profile fetch failed or FID mismatch');
      }
      
      runtime.logger.info(`Agent profile verified: @${profile.username} (FID: ${profile.fid})`);
    }
  },

  {
    name: 'Farcaster Plugin - Timeline Monitoring',

    async fn(runtime: IAgentRuntime): Promise<void> {
      const service = runtime.getService(FARCASTER_SERVICE_NAME) as FarcasterService;
      if (!service) {
        throw new Error('Farcaster service not initialized');
      }

      const castService = service.getCastService(runtime.agentId);
      if (!castService) {
        throw new Error('CastService not available');
      }

      // Test 1: Fetch timeline casts
      const casts = await castService.getCasts({
        agentId: runtime.agentId,
        limit: 10,
      });

      if (!Array.isArray(casts)) {
        throw new Error('getPosts did not return an array');
      }
      
      runtime.logger.info(`Found ${casts.length} casts in timeline`);
      
      if (casts.length > 0) {
        const firstCast = casts[0];
        if (!firstCast.id || !firstCast.username || !firstCast.text) {
          throw new Error('Cast missing required fields');
        }
        runtime.logger.info(`Latest cast by @${firstCast.username}: ${firstCast.text.substring(0, 50)}...`);
      }

      // Test 2: Fetch mentions
      const mentions = await castService.getMentions({ agentId: runtime.agentId, limit: 5 });
      
      if (!Array.isArray(mentions)) {
        throw new Error('getMentions did not return an array');
      }
      
      runtime.logger.info(`Found ${mentions.length} mentions`);
    }
  },

  {
    name: 'Farcaster Plugin - Message Send and Retrieve',
    async fn(runtime: IAgentRuntime): Promise<void> {
      const service = runtime.getService(FARCASTER_SERVICE_NAME) as FarcasterService;
      if (!service) {
        throw new Error('Farcaster service not initialized');
      }

      const messageService = service.getMessageService(runtime.agentId);
      if (!messageService) {
        throw new Error('MessageService not available');
      }

      const roomId = createUniqueUuid(runtime, 'test-conversation');
      
      // Send a new cast
      const message = await messageService.sendMessage({
        agentId: runtime.agentId,
        roomId,
        text: 'Testing message send and retrieve with ElizaOS Farcaster plugin! 🧪',
        type: FarcasterMessageType.CAST,
      });

      if (!message || !message.id || !message.metadata?.castHash) {
        throw new Error('Failed to send message or missing metadata');
      }
      
      runtime.logger.info(`Sent cast with hash: ${message.metadata.castHash}`);
      
      // Retrieve the message
      const castHash = message.metadata.castHash as string;
      const retrieved = await messageService.getMessage(castHash, runtime.agentId);
      
      if (!retrieved || retrieved.text !== message.text) {
        throw new Error('Failed to retrieve message or content mismatch');
      }
      
      runtime.logger.info('Successfully retrieved message by hash');
    }
  },

  {
    name: 'Farcaster Plugin - Reply Threading',
    async fn(runtime: IAgentRuntime): Promise<void> {
      const service = runtime.getService(FARCASTER_SERVICE_NAME) as FarcasterService;
      if (!service) {
        throw new Error('Farcaster service not initialized');
      }

      const messageService = service.getMessageService(runtime.agentId);
      const castService = service.getCastService(runtime.agentId);
      
      if (!messageService || !castService) {
        throw new Error('Services not available');
      }

      // First create a cast to reply to
      const originalCast = await castService.createCast({
        agentId: runtime.agentId,
        roomId: createUniqueUuid(runtime, 'reply-test'),
        text: 'This is a test cast for reply threading 🧵',
      });

      if (!originalCast || !originalCast.metadata?.castHash) {
        throw new Error('Failed to create original cast');
      }

      // Send a reply
      const reply = await messageService.sendMessage({
        agentId: runtime.agentId,
        roomId: originalCast.roomId,
        text: 'This is a test reply maintaining thread context! 💬',
        type: 'REPLY' as any,
        replyToId: originalCast.metadata.castHash,
        metadata: {
          parentHash: originalCast.metadata.castHash,
        },
      });
      
      if (!reply || !reply.inReplyTo || !reply.metadata?.castHash) {
        throw new Error('Failed to create reply or missing thread context');
      }
      
      runtime.logger.info(`Created reply ${reply.metadata.castHash} to ${originalCast.metadata.castHash}`);
    }
  },

  {
    name: 'Farcaster Plugin - Action Execution',
    async fn(runtime: IAgentRuntime): Promise<void> {
      // Import the action directly
      const { sendCastAction } = await import('../../actions/sendCast.js');
      
      // Create a mock message requesting a cast
      const mockMessage = {
        id: createUniqueUuid(runtime, 'test-message'),
        agentId: runtime.agentId,
        roomId: createUniqueUuid(runtime, 'test-room'),
        entityId: runtime.agentId,
        content: {
          text: 'Can you post about the ElizaOS framework on Farcaster?',
        },
        createdAt: Date.now(),
      };
      
      // Validate the action
      const shouldExecute = await sendCastAction.validate(runtime, mockMessage);
      if (!shouldExecute) {
        throw new Error('SEND_CAST action validation failed');
      }
      
      // Execute the action (returns void, so just check it doesn't throw)
      await sendCastAction.handler(runtime, mockMessage);
      
      runtime.logger.info('Successfully validated and executed SEND_CAST action');
    }
  },

  {
    name: 'Farcaster Plugin - Provider Context',
    async fn(runtime: IAgentRuntime): Promise<void> {
      // Import providers directly
      const { farcasterProfileProvider } = await import('../../providers/profileProvider.js');
      const { farcasterTimelineProvider } = await import('../../providers/timelineProvider.js');
      
      const mockMessage = {
        id: createUniqueUuid(runtime, 'test-message'),
        agentId: runtime.agentId,
        roomId: createUniqueUuid(runtime, 'test-room'),
        entityId: runtime.agentId,
        content: { text: 'test' },
        createdAt: Date.now(),
      };
      
      // Test profile provider
      const profileContext = await farcasterProfileProvider.get(runtime, mockMessage, { values: [], data: {}, text: '' });
      
      if (!profileContext || !profileContext.text || profileContext.data?.available === undefined) {
        throw new Error('Profile provider returned invalid context');
      }
      
      runtime.logger.info(`Profile provider: ${profileContext.text}`);
      
      // Test timeline provider
      const timelineContext = await farcasterTimelineProvider.get(runtime, mockMessage, { values: [], data: {}, text: '' });
      
      if (!timelineContext || !timelineContext.text || timelineContext.data?.available === undefined) {
        throw new Error('Timeline provider returned invalid context');
      }
      
      runtime.logger.info(`Timeline provider: ${timelineContext.text}`);
    }
  },

  {
    name: 'Farcaster Plugin - Rate Limit Handling',
    async fn(runtime: IAgentRuntime): Promise<void> {
      const service = runtime.getService(FARCASTER_SERVICE_NAME) as FarcasterService;
      if (!service) {
        throw new Error('Farcaster service not initialized');
      }

      const messageService = service.getMessageService(runtime.agentId);
      if (!messageService) {
        throw new Error('MessageService not available');
      }
      
      // Send multiple messages quickly
      const promises: Promise<any>[] = [];
      for (let i = 0; i < 3; i++) {
        promises.push(
          messageService.sendMessage({
            agentId: runtime.agentId,
            roomId: createUniqueUuid(runtime, 'rate-limit-test'),
            text: `Rate limit test message ${i + 1}`,
            type: FarcasterMessageType.CAST,
          }).catch(error => {
            runtime.logger.warn(`Expected rate limit error: ${error.message}`);
            return null;
          })
        );
      }
      
      const results = await Promise.all(promises);
      const successfulSends = results.filter(r => r !== null);
      
      if (successfulSends.length === 0) {
        throw new Error('All messages failed - check if rate limiting is too strict');
      }
      
      runtime.logger.info(`Successfully sent ${successfulSends.length} out of ${promises.length} messages`);
    }
  },

  {
    name: 'Farcaster Plugin - Service Health Check',
    async fn(runtime: IAgentRuntime): Promise<void> {
      const service = runtime.getService(FARCASTER_SERVICE_NAME) as FarcasterService;
      if (!service) {
        throw new Error('Farcaster service not initialized');
      }

      const health = await service.healthCheck();
      
      if (!health || health.healthy === undefined || !health.details) {
        throw new Error('Health check returned invalid data');
      }
      
      runtime.logger.info(`Service health: ${health.healthy ? 'Healthy' : 'Unhealthy'}`);
      runtime.logger.info(`Active managers: ${health.details.activeManagers}`);
      
      if (!health.healthy) {
        runtime.logger.warn({ details: health.details }, 'Service reported unhealthy status');
      }
    }
  },

  {
    name: 'Farcaster Plugin - Should Send a Real Cast',
    async fn(runtime: IAgentRuntime): Promise<void> {
      const service = runtime.getService(FARCASTER_SERVICE_NAME) as FarcasterService;
      if (!service) {
        throw new Error('FarcasterService not found');
      }

      const castService = service.getCastService(runtime.agentId);
      if (!castService) {
        throw new Error('CastService not available');
      }

      const uniqueMessage = `This is a real E2E test cast from ElizaOS! ID: ${createUniqueUuid(runtime, 'e2e-cast')}`;
      runtime.logger.info(`Attempting to post cast: "${uniqueMessage}"`);

      const cast = await castService.createCast({
        agentId: runtime.agentId,
        roomId: createUniqueUuid(runtime, 'farcaster-e2e-test'),
        text: uniqueMessage,
      });

      if (!cast || !cast.id) {
        throw new Error('E2E test failed to create a real cast.');
      }

      runtime.logger.success(`Successfully posted E2E test cast with ID: ${cast.id}`);
      // In a real-world scenario, you might want to add a step to delete this cast
      // if the API supports it, to keep the feed clean.
    },
  },
];

// Export for use in test suite
export default farcasterE2EScenarios; 