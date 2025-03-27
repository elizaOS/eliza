import type { FarcasterClient } from '../src/client';
import type { Cast, Profile } from '../src/common/types';
import type { TestInteraction } from './types';

export function createTestInteraction(cast: Cast, profile: Profile): TestInteraction | null {
  // Only create interaction if there is significant engagement
  if (
    !cast.stats ||
    (cast.stats.recasts === 0 && cast.stats.replies === 0 && cast.stats.likes === 0)
  ) {
    return null;
  }

  // Simple heuristic: if the cast has more replies, reply to it
  if (cast.stats.replies > cast.stats.recasts && cast.stats.replies > cast.stats.likes) {
    return {
      type: 'REPLY',
      castId: cast.hash,
      content: 'Interesting perspective!',
    };
  }

  // If it has more likes, like it
  if (cast.stats.likes > cast.stats.recasts && cast.stats.likes > cast.stats.replies) {
    return {
      type: 'LIKE',
      castId: cast.hash,
    };
  }

  // Otherwise, recast it
  return {
    type: 'RECAST',
    castId: cast.hash,
  };
}

export async function handleTestInteraction(client: FarcasterClient, interaction: TestInteraction) {
  switch (interaction.type) {
    case 'RECAST':
      if (!interaction.castId) throw new Error('Cast ID required for recast');
      return await client.neynar.publishCast({
        text: '',
        parent: interaction.castId,
        signerUuid: client.signerUuid,
      });
    case 'REPLY':
      if (!interaction.castId || !interaction.content) {
        throw new Error('Cast ID and content required for reply');
      }
      return await client.neynar.publishCast({
        text: interaction.content,
        parent: interaction.castId,
        signerUuid: client.signerUuid,
      });
    case 'LIKE':
      if (!interaction.castId) throw new Error('Cast ID required for like');
      return await client.neynar.publishCast({
        text: '',
        parent: interaction.castId,
        signerUuid: client.signerUuid,
      });
    default:
      throw new Error('Unknown interaction type');
  }
}

export async function createTestCast(client: FarcasterClient, content: string) {
  if (!content) {
    throw new Error('Cast content cannot be empty');
  }
  if (content.length > 320) {
    throw new Error('Cast content too long');
  }
  return await client.neynar.publishCast({
    text: content,
    signerUuid: client.signerUuid,
  });
}

export const TEST_IMAGE_URL =
  'https://github.com/elizaOS/awesome-eliza/blob/main/assets/eliza-logo.jpg?raw=true';

export const TEST_IMAGE = {
  id: 'mock-image-id',
  text: 'mock image',
  description: 'mock image descirption',
  source: 'mock image source',
  url: TEST_IMAGE_URL,
  title: 'mock image',
  contentType: 'image/jpeg',
  alt_text: 'mock image',
};
