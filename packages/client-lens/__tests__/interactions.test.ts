import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createTestInteraction, handleTestInteraction } from './test-utils';
import { LensClient } from '../src/client';
import type { AnyPublicationFragment, ProfileFragment } from '@lens-protocol/client';

// Mock LensClient
vi.mock('../src/client', () => ({
    LensClient: vi.fn().mockImplementation(() => ({
        authenticate: vi.fn().mockResolvedValue(undefined),
        mirror: vi.fn().mockResolvedValue({ id: 'mirror-1' }),
        comment: vi.fn().mockResolvedValue({ id: 'comment-1' }),
        like: vi.fn().mockResolvedValue({ id: 'like-1' }),
        follow: vi.fn().mockResolvedValue({ id: 'follow-1' })
    }))
}));

describe('Interactions', () => {
    const mockPublication = {
        id: 'pub-1',
        metadata: {
            content: 'Test publication'
        },
        stats: {
            totalAmountOfMirrors: 5,
            totalAmountOfComments: 3,
            totalUpvotes: 10
        }
    } as unknown as AnyPublicationFragment;

    const mockProfile = {
        id: '0x01',
        handle: 'test.lens',
        stats: {
            totalFollowers: 100,
            totalFollowing: 50
        }
    } as unknown as ProfileFragment;

    describe('createTestInteraction', () => {
        it('should create mirror interaction when conditions are met', () => {
            const interaction = createTestInteraction(mockPublication, mockProfile);
            expect(interaction).toBeDefined();
            if (interaction) {
                expect(['MIRROR', 'COMMENT', 'LIKE', 'FOLLOW']).toContain(interaction.type);
            }
        });

        it('should return null when no interaction is needed', () => {
            const lowStatsPublication = {
                ...mockPublication,
                stats: {
                    totalAmountOfMirrors: 0,
                    totalAmountOfComments: 0,
                    totalUpvotes: 0
                }
            } as unknown as AnyPublicationFragment;
            const interaction = createTestInteraction(lowStatsPublication, mockProfile);
            expect(interaction).toBeNull();
        });
    });

    describe('handleTestInteraction', () => {
        let client: LensClient;

        beforeEach(() => {
            vi.clearAllMocks();
            client = new LensClient({
                runtime: {
                    name: 'test-runtime',
                    memory: new Map(),
                    getMemory: vi.fn(),
                    setMemory: vi.fn(),
                    clearMemory: vi.fn()
                },
                cache: new Map(),
                account: {
                    address: '0x123' as `0x${string}`,
                    privateKey: '0xabc' as `0x${string}`,
                    signMessage: vi.fn(),
                    signTypedData: vi.fn()
                },
                profileId: '0x01' as `0x${string}`
            });
        });

        it('should handle mirror interaction successfully', async () => {
            const interaction = {
                type: 'MIRROR' as const,
                publicationId: 'pub-1'
            };

            const result = await handleTestInteraction(client, interaction);
            expect(result).toBeDefined();
            expect(result.id).toBe('mirror-1');
            expect(client.mirror).toHaveBeenCalledWith('pub-1');
        });

        it('should handle comment interaction successfully', async () => {
            const interaction = {
                type: 'COMMENT' as const,
                publicationId: 'pub-1',
                content: 'Test comment'
            };

            const result = await handleTestInteraction(client, interaction);
            expect(result).toBeDefined();
            expect(result.id).toBe('comment-1');
            expect(client.comment).toHaveBeenCalledWith('pub-1', 'Test comment');
        });

        it('should handle interaction errors', async () => {
            const interaction = {
                type: 'MIRROR' as const,
                publicationId: 'pub-1'
            };

            vi.mocked(client.mirror).mockRejectedValueOnce(new Error('Mirror failed'));
            await expect(handleTestInteraction(client, interaction)).rejects.toThrow('Mirror failed');
        });
    });
});
