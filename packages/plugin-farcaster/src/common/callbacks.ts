import { Content, HandlerCallback, IAgentRuntime, logger, Memory, UUID } from '@elizaos/core';
import { CastWithInteractions } from '@neynar/nodejs-sdk/build/api';
import { FarcasterClient } from '../client';
import { FarcasterConfig } from './types';
import { createCastMemory, neynarCastToCast } from './utils';

export function standardCastHandlerCallback({
  client,
  runtime,
  config,
  roomId,
  onCompletion,
  onError,
}: {
  client: FarcasterClient;
  runtime: IAgentRuntime;
  config: FarcasterConfig;
  roomId: UUID;
  onCompletion?: (casts: CastWithInteractions[], memories: Memory[]) => Promise<void>;
  onError?: (error: Error) => Promise<void>;
}): HandlerCallback {
  const callback: HandlerCallback = async (content: Content, _files?: any) => {
    try {
      if (config.FARCASTER_DRY_RUN) {
        logger.info(`[Farcaster] Dry run: would have cast: ${content.text}`);
        return [];
      }

      const casts = await client.sendCast({ content });

      if (casts.length === 0) {
        logger.warn('[Farcaster] No casts posted');
        return [];
      }

      const memories: Memory[] = [];
      for (let i = 0; i < casts.length; i++) {
        const cast = casts[i];
        logger.success(`[Farcaster] Published cast ${cast.hash}`);

        const memory = createCastMemory({
          roomId,
          senderId: runtime.agentId,
          runtime,
          cast: neynarCastToCast(cast),
        });

        if (i === 0) {
          // sendCast lost response action, so we need to add it back here
          memory.content.actions = content.actions;
        }

        await runtime.createMemory(memory, 'messages');
        memories.push(memory);
      }

      if (onCompletion) {
        await onCompletion(casts, memories);
      }

      return memories;
    } catch (error) {
      logger.error('[Farcaster] Error posting cast:', error);

      if (onError) {
        await onError(error as Error);
      }

      return [];
    }
  };

  return callback;
}
