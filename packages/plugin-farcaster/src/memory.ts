import {
  elizaLogger,
  type IAgentRuntime,
  stringToUuid,
  type Memory,
  type UUID,
} from '@elizaos/core';
import type { Cast } from './types';
import { toHex } from 'viem';
import { castUuid } from './utils';
import type { FarcasterClient } from './client';
import { FARCASTER_SOURCE } from './constants';

export function createCastMemory({
  roomId,
  senderId,
  runtime,
  cast,
}: {
  roomId: UUID;
  senderId: UUID;
  runtime: IAgentRuntime;
  cast: Cast;
}): Memory {
  const inReplyTo = cast.inReplyTo
    ? castUuid({
        hash: cast.inReplyTo.hash,
        agentId: runtime.agentId,
      })
    : undefined;

  return {
    id: castUuid({
      hash: cast.hash,
      agentId: runtime.agentId,
    }),
    agentId: runtime.agentId,
    entityId: senderId,
    content: {
      text: cast.text,
      source: FARCASTER_SOURCE,
      url: '',
      inReplyTo,
      hash: cast.hash,
      threadId: cast.threadId,
    },
    roomId,
  };
}

export async function buildConversationThread({
  cast,
  runtime,
  client,
}: {
  cast: Cast;
  runtime: IAgentRuntime;
  client: FarcasterClient;
}): Promise<Cast[]> {
  const thread: Cast[] = [];
  const visited: Set<string> = new Set();
  async function processThread(currentCast: Cast) {
    if (visited.has(currentCast.hash)) {
      return;
    }

    visited.add(currentCast.hash);

    const roomId = castUuid({
      hash: currentCast.hash,
      agentId: runtime.agentId,
    });

    // Check if the current cast has already been saved
    const memory = await runtime.getMemoryById(roomId);

    if (!memory) {
      elizaLogger.log('Creating memory for cast', currentCast.hash);

      const userId = stringToUuid(currentCast.authorFid.toString());

      await runtime.ensureConnection(
        userId,
        roomId,
        currentCast.profile.username,
        currentCast.profile.name,
        'farcaster'
      );

      await runtime.createMemory(
        createCastMemory({
          roomId,
          senderId: userId,
          runtime,
          cast: currentCast,
        }),
        'messages'
      );
    }

    thread.unshift(currentCast);

    if (currentCast.inReplyTo) {
      const parentCast = await client.getCast(currentCast.inReplyTo.hash);
      await processThread(parentCast);
    }
  }

  await processThread(cast);
  return thread;
}
