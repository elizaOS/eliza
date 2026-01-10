import { Content, HandlerCallback, IAgentRuntime, Memory, UUID } from '@elizaos/core';
import { Cast as NeynarCast } from '@neynar/nodejs-sdk/build/api';
import { FarcasterClient } from '../client';
import { CastId, FarcasterConfig } from './types';
import { createCastMemory, neynarCastToCast } from './utils';

export function standardCastHandlerCallback({
  client,
  runtime,
  config,
  roomId,
  onCompletion,
  onError,
  inReplyTo,
}: {
  inReplyTo?: CastId;
  client: FarcasterClient;
  runtime: IAgentRuntime;
  config: FarcasterConfig;
  roomId: UUID;
  onCompletion?: (casts: NeynarCast[], memories: Memory[]) => Promise<void>;
  onError?: (error: unknown) => Promise<void>;
}): HandlerCallback {
  const callback: HandlerCallback = async (content: Content, _files?: any) => {
    try {
      if (config.FARCASTER_DRY_RUN) {
        runtime.logger.info(`[Farcaster] Dry run: would have cast: ${content.text}`);
        return [];
      }

      const casts = await client.sendCast({ content, inReplyTo });

      if (casts.length === 0) {
        runtime.logger.warn('[Farcaster] No casts posted');
        return [];
      }

      const memories: Memory[] = [];
      for (let i = 0; i < casts.length; i++) {
        const cast = casts[i];
        runtime.logger.success(`[Farcaster] Published cast ${cast.hash}`);

        const memory = createCastMemory({
          roomId,
          senderId: runtime.agentId,
          runtime,
          cast: neynarCastToCast(cast),
        });

        if (i === 0) {
          // sendCast removes the response action, so we need to add it back here
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
      runtime.logger.error('[Farcaster] Error posting cast:', typeof error === 'string' ? error : (error as Error).message);

      if (onError) {
        await onError(error);
      }

      return [];
    }
  };

  return callback;
}
