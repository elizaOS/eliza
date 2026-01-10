import {
  type Action,
  type IAgentRuntime,
  type Memory,
  type State,
  createUniqueUuid,
} from '@elizaos/core';
import { FARCASTER_SERVICE_NAME } from '../common/constants';
import type { FarcasterService } from '../service';

export const sendCastAction: Action = {
  name: 'SEND_CAST',
  description: 'Posts a cast (message) on Farcaster',
  examples: [
    [
      {
        name: 'user',
        content: { text: 'Can you post about the new ElizaOS features on Farcaster?' },
      },
      {
        name: 'assistant',
        content: {
          text: "I'll post about the new ElizaOS features on Farcaster now.",
          actions: ['SEND_CAST'],
        },
      },
    ],
    [
      {
        name: 'user',
        content: { text: 'Share on Farcaster that we just launched version 2.0!' },
      },
      {
        name: 'assistant',
        content: {
          text: "I'll share the version 2.0 launch announcement on Farcaster.",
          actions: ['SEND_CAST'],
        },
      },
    ],
  ],

  validate: async (runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    const text = message.content.text?.toLowerCase() || '';
    const keywords = ['post', 'cast', 'share', 'announce', 'farcaster', 'tweet'];

    // Check if the message contains relevant keywords
    const hasKeyword = keywords.some((keyword) => text.includes(keyword));

    // Check if Farcaster service is available
    const service = runtime.getService(FARCASTER_SERVICE_NAME) as FarcasterService;
          const isServiceAvailable = !!service?.getCastService(runtime.agentId);

    return hasKeyword && isServiceAvailable;
  },

  handler: async (runtime: IAgentRuntime, message: Memory, state?: State): Promise<void> => {
    try {
      const service = runtime.getService(FARCASTER_SERVICE_NAME) as FarcasterService;
      const postService = service?.getCastService(runtime.agentId);

      if (!postService) {
        runtime.logger.error('[SEND_CAST] PostService not available');
        return;
      }

      // Extract the content to post from the message or generate it
      let castContent = '';

      if (state?.castContent) {
        // Use provided cast content from state
        castContent = state.castContent as string;
      } else {
        // Generate content based on the conversation context
        const prompt = `Based on this request: "${message.content.text}", generate a concise Farcaster cast (max 320 characters). Be engaging and use appropriate hashtags if relevant.`;

        const response = await runtime.useModel('text_large', { prompt });
        castContent = typeof response === 'string' ? response : response.text || '';
      }

      // Ensure content fits Farcaster's character limit
      if (castContent.length > 320) {
        castContent = castContent.substring(0, 317) + '...';
      }

      // Create the cast
      const cast = await postService.createCast({
        agentId: runtime.agentId,
        roomId: createUniqueUuid(runtime, 'farcaster-timeline'),
        text: castContent,
      });

      runtime.logger.info(`[SEND_CAST] Successfully posted cast: ${cast.id}`);

      // Store the cast in memory
      await runtime.createMemory(
        {
          agentId: runtime.agentId,
          roomId: cast.roomId,
          // userId removed - not part of Memory type
          entityId: runtime.agentId,
          content: {
            text: castContent,
            source: 'farcaster',
            metadata: {
              castHash: cast.metadata?.castHash,
              action: 'SEND_CAST',
            },
          },
          createdAt: cast.timestamp,
        },
        'messages'
      );
    } catch (error) {
      runtime.logger.error('[SEND_CAST] Error posting cast:', typeof error === 'string' ? error : (error as Error).message);
      throw error;
    }
  },
};
