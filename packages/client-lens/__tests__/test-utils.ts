import type { AnyPublicationFragment } from "@lens-protocol/client";
import type { LensClient } from "../src/client";
import type { Profile } from "../src/types";

export interface TestInteraction {
    type: 'MIRROR' | 'COMMENT' | 'LIKE' | 'FOLLOW';
    publicationId?: string;
    content?: string;
}

export function createTestInteraction(publication: AnyPublicationFragment, profile: Profile): TestInteraction | null {
    const stats = publication.stats;

    // Simple heuristic: if the publication has good engagement, mirror it
    if (stats.totalAmountOfMirrors > 3 || stats.totalAmountOfComments > 2 || stats.totalUpvotes > 5) {
        return {
            type: 'MIRROR',
            publicationId: publication.id
        };
    }

    // If the publication is engaging but not viral, comment on it
    if (stats.totalAmountOfComments > 0 || stats.totalUpvotes > 2) {
        return {
            type: 'COMMENT',
            publicationId: publication.id,
            content: 'Interesting perspective!'
        };
    }

    return null;
}

export async function handleTestInteraction(client: LensClient, interaction: TestInteraction) {
    switch (interaction.type) {
        case 'MIRROR':
            if (!interaction.publicationId) throw new Error('Publication ID required for mirror');
            return await client.mirror(interaction.publicationId);
        case 'COMMENT':
            if (!interaction.publicationId || !interaction.content) {
                throw new Error('Publication ID and content required for comment');
            }
            return await client.comment(interaction.publicationId, interaction.content);
        case 'LIKE':
            if (!interaction.publicationId) throw new Error('Publication ID required for like');
            return await client.like(interaction.publicationId);
        case 'FOLLOW':
            if (!interaction.publicationId) throw new Error('Profile ID required for follow');
            return await client.follow(interaction.publicationId);
        default:
            throw new Error('Unknown interaction type');
    }
}

export async function createTestPost(client: LensClient, content: string) {
    if (!content) {
        throw new Error('Post content cannot be empty');
    }
    if (content.length > 5000) {
        throw new Error('Post content too long');
    }
    return await client.post(content);
}
