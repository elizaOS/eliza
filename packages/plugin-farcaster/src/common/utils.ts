import { IAgentRuntime, Memory, stringToUuid, UUID } from '@elizaos/core';
import { CastWithInteractions } from '@neynar/nodejs-sdk/build/api';
import { FARCASTER_SOURCE } from './constants';
import { Cast } from './types';

export const MAX_CAST_LENGTH = 1024; // Updated to Twitter's current character limit

export function castId({ hash, agentId }: { hash: string; agentId: string }) {
  return `${hash}-${agentId}`;
}

export function castUuid(props: { hash: string; agentId: string }) {
  return stringToUuid(castId(props));
}

export function splitPostContent(content: string, maxLength: number = MAX_CAST_LENGTH): string[] {
  const paragraphs = content.split('\n\n').map((p) => p.trim());
  const posts: string[] = [];
  let currentTweet = '';

  for (const paragraph of paragraphs) {
    if (!paragraph) continue;

    if ((currentTweet + '\n\n' + paragraph).trim().length <= maxLength) {
      if (currentTweet) {
        currentTweet += '\n\n' + paragraph;
      } else {
        currentTweet = paragraph;
      }
    } else {
      if (currentTweet) {
        posts.push(currentTweet.trim());
      }
      if (paragraph.length <= maxLength) {
        currentTweet = paragraph;
      } else {
        // Split long paragraph into smaller chunks
        const chunks = splitParagraph(paragraph, maxLength);
        posts.push(...chunks.slice(0, -1));
        currentTweet = chunks[chunks.length - 1];
      }
    }
  }

  if (currentTweet) {
    posts.push(currentTweet.trim());
  }

  return posts;
}

export function splitParagraph(paragraph: string, maxLength: number): string[] {
  const sentences = paragraph.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [paragraph];
  const chunks: string[] = [];
  let currentChunk = '';

  for (const sentence of sentences) {
    if ((currentChunk + ' ' + sentence).trim().length <= maxLength) {
      if (currentChunk) {
        currentChunk += ' ' + sentence;
      } else {
        currentChunk = sentence;
      }
    } else {
      if (currentChunk) {
        chunks.push(currentChunk.trim());
      }
      if (sentence.length <= maxLength) {
        currentChunk = sentence;
      } else {
        // Split long sentence into smaller pieces
        const words = sentence.split(' ');
        currentChunk = '';
        for (const word of words) {
          if ((currentChunk + ' ' + word).trim().length <= maxLength) {
            if (currentChunk) {
              currentChunk += ' ' + word;
            } else {
              currentChunk = word;
            }
          } else {
            if (currentChunk) {
              chunks.push(currentChunk.trim());
            }
            currentChunk = word;
          }
        }
      }
    }
  }

  if (currentChunk) {
    chunks.push(currentChunk.trim());
  }

  return chunks;
}

export function lastCastCacheKey(fid: number) {
  return `farcaster/${fid}/lastCast`;
}

export function neynarCastToCast(neynarCast: CastWithInteractions): Cast {
  return {
    hash: neynarCast.hash,
    authorFid: neynarCast.author.fid,
    text: neynarCast.text,
    threadId: neynarCast.thread_hash ?? undefined,
    profile: {
      fid: neynarCast.author.fid,
      name: neynarCast.author.display_name || 'anon',
      username: neynarCast.author.username,
    },
    ...(neynarCast.parent_hash
      ? {
          inReplyTo: {
            hash: neynarCast.parent_hash,
            fid: neynarCast.parent_author.fid,
          },
        }
      : {}),
    timestamp: new Date(neynarCast.timestamp),
  };
}

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

export function formatCastTimestamp(timestamp: Date): string {
  return timestamp.toLocaleString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    month: 'short',
    day: 'numeric',
  });
}
