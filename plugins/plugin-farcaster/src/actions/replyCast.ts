import {
  type Action,
  type IAgentRuntime,
  type Memory,
  type State,
  logger,
} from '@elizaos/core';
import { FARCASTER_SERVICE_NAME } from '../common/constants';
import type { FarcasterService } from '../service';
import { FarcasterMessageType } from '../common/types';

export const replyCastAction: Action = {
  name: 'REPLY_TO_CAST',
  description: 'Replies to a cast on Farcaster',
  examples: [
    [
      {
        name: 'user',
        content: { text: 'Someone asked about ElizaOS on Farcaster, can you reply?' },
      },
      {
        name: 'assistant',
        content: {
          text: "I'll reply to their question about ElizaOS.",
          actions: ['REPLY_TO_CAST'],
        },
      },
    ],
    [
      {
        name: 'user',
        content: { text: 'Reply to that cast and thank them for the feedback' },
      },
      {
        name: 'assistant',
        content: {
          text: "I'll reply with a thank you message.",
          actions: ['REPLY_TO_CAST'],
        },
      },
    ],
  ],

  validate: async (runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    const text = message.content.text?.toLowerCase() || '';
    const keywords = ['reply', 'respond', 'answer', 'comment'];

    // Check if the message contains relevant keywords
    const hasKeyword = keywords.some((keyword) => text.includes(keyword));

    // Check if we have a parent cast to reply to
    // Note: inReplyTo doesn't exist on Memory type, check metadata
    const hasParentCast = !!(
      message.content.metadata && (message.content.metadata as any).parentCastHash
    );

    // Check if Farcaster service is available
    const service = runtime.getService(FARCASTER_SERVICE_NAME) as FarcasterService;
    const isServiceAvailable = !!service?.getMessageService(runtime.agentId);

    return hasKeyword && (hasParentCast || isServiceAvailable);
  },

  handler: async (runtime: IAgentRuntime, message: Memory, state?: State): Promise<void> => {
    try {
      const service = runtime.getService(FARCASTER_SERVICE_NAME) as FarcasterService;
      const messageService = service?.getMessageService(runtime.agentId);

      if (!messageService) {
        runtime.logger.error('[REPLY_TO_CAST] MessageService not available');
        return;
      }

      // Get the parent cast hash
      const parentCastHash =
        (message.content.metadata as any)?.parentCastHash || state?.parentCastHash;

      if (!parentCastHash) {
        runtime.logger.error('[REPLY_TO_CAST] No parent cast to reply to');
        return;
      }

      // Generate reply content
      let replyContent = '';

      if (state?.replyContent) {
        replyContent = state.replyContent as string;
      } else {
        const prompt = `Based on this request: "${message.content.text}", generate a helpful and engaging reply for a Farcaster cast (max 320 characters).`;

        const response = await runtime.useModel('text_large', { prompt });
        replyContent = typeof response === 'string' ? response : response.text || '';
      }

      // Ensure content fits Farcaster's character limit
      if (replyContent.length > 320) {
        replyContent = replyContent.substring(0, 317) + '...';
      }

      // Send the reply
      const reply = await messageService.sendMessage({
        agentId: runtime.agentId,
        roomId: message.roomId,
        text: replyContent,
        type: FarcasterMessageType.REPLY,
        replyToId: parentCastHash as string,
        metadata: {
          parentHash: parentCastHash,
        },
      });

      runtime.logger.info(`[REPLY_TO_CAST] Successfully replied to cast: ${reply.id}`);
    } catch (error) {
      runtime.logger.error('[REPLY_TO_CAST] Error replying to cast:', typeof error === 'string' ? error : (error as Error).message);
      throw error;
    }
  },
};
