import type { FarcasterClient } from '../src/client';
import type { Cast, Profile } from '../src/types';

export interface TestInteraction {
    type: 'RECAST' | 'REPLY' | 'LIKE';
    castId?: string;
    content?: string;
}

export function createTestInteraction(cast: Cast, profile: Profile): TestInteraction | null {
    const stats = cast.stats;

    // Simple heuristic: if the cast has good engagement, recast it
    if (stats.recasts > 3 || stats.replies > 2 || stats.likes > 5) {
        return {
            type: 'RECAST',
            castId: cast.hash
        };
    }

    // If the cast is engaging but not viral, reply to it
    if (stats.replies > 0 || stats.likes > 2) {
        return {
            type: 'REPLY',
            castId: cast.hash,
            content: 'Interesting perspective!'
        };
    }

    return null;
}

export async function handleTestInteraction(client: FarcasterClient, interaction: TestInteraction) {
    switch (interaction.type) {
        case 'RECAST':
            if (!interaction.castId) throw new Error('Cast ID required for recast');
            return await client.publishCast('', { hash: interaction.castId });
        case 'REPLY':
            if (!interaction.castId || !interaction.content) {
                throw new Error('Cast ID and content required for reply');
            }
            return await client.publishCast(interaction.content, { hash: interaction.castId });
        case 'LIKE':
            if (!interaction.castId) throw new Error('Cast ID required for like');
            return await client.publishCast('', { hash: interaction.castId });
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
    return await client.publishCast(content, undefined);
}
