import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LensClient } from '../src/client';
import { LensClient as LensClientCore, LimitType, PublicationType } from '@lens-protocol/client';

// Mock dependencies
vi.mock('@lens-protocol/client', async () => {
    const actual = await vi.importActual('@lens-protocol/client');
    return {
        ...actual,
        LensClient: vi.fn().mockImplementation(() => ({
            authentication: {
                generateChallenge: vi.fn().mockResolvedValue({ id: 'challenge-id', text: 'challenge-text' }),
                authenticate: vi.fn().mockResolvedValue({ accessToken: 'mock-token', refreshToken: 'mock-refresh' })
            },
            profile: {
                fetch: vi.fn().mockResolvedValue({
                    id: '0x01',
                    handle: { localName: 'test.lens' },
                    metadata: {
                        displayName: 'Test User',
                        bio: 'Test bio',
                        picture: {
                            uri: 'https://example.com/pic-raw.jpg'
                        }
                    }
                })
            },
            publication: {
                fetchAll: vi.fn().mockResolvedValue({
                    items: [
                        {
                            id: 'pub-1',
                            metadata: { content: 'Test post' },
                            stats: { reactions: 10 }
                        }
                    ]
                })
            }
        }))
    };
});

describe('LensClient', () => {
    let client: LensClient;
    const mockRuntime = {
        name: 'test-runtime',
        memory: new Map(),
        getMemory: vi.fn(),
        setMemory: vi.fn(),
        clearMemory: vi.fn()
    };
    const mockAccount = {
        address: '0x123' as `0x${string}`,
        privateKey: '0xabc' as `0x${string}`,
        signMessage: vi.fn().mockResolvedValue('signed-message'),
        signTypedData: vi.fn()
    };

    beforeEach(() => {
        vi.clearAllMocks();
        client = new LensClient({
            runtime: mockRuntime,
            cache: new Map(),
            account: mockAccount,
            profileId: '0x01' as `0x${string}`
        });
    });

    describe('authenticate', () => {
        it('should authenticate successfully', async () => {
            await client.authenticate();
            expect(client['authenticated']).toBe(true);
            expect(client['core'].authentication.generateChallenge).toHaveBeenCalledWith({
                signedBy: mockAccount.address,
                for: '0x01'
            });
            expect(mockAccount.signMessage).toHaveBeenCalledWith({ message: 'challenge-text' });
        });

        it('should handle authentication errors', async () => {
            const mockError = new Error('Auth failed');
            vi.mocked(client['core'].authentication.generateChallenge).mockRejectedValueOnce(mockError);
            
            await expect(client.authenticate()).rejects.toThrow('Auth failed');
            expect(client['authenticated']).toBe(false);
        });
    });

    describe('getPublicationsFor', () => {
        it('should fetch publications successfully', async () => {
            const publications = await client.getPublicationsFor('0x123');
            expect(publications).toHaveLength(1);
            expect(publications[0].id).toBe('pub-1');
            expect(client['core'].publication.fetchAll).toHaveBeenCalledWith({
                limit: LimitType.Fifty,
                where: {
                    from: ['0x123'],
                    publicationTypes: [PublicationType.Post]
                }
            });
        });

        it('should handle fetch errors', async () => {
            vi.mocked(client['core'].publication.fetchAll).mockRejectedValueOnce(new Error('Fetch failed'));
            await expect(client.getPublicationsFor('0x123')).rejects.toThrow('Fetch failed');
        });
    });

    describe('getProfile', () => {
        it('should fetch profile successfully', async () => {
            const profile = await client.getProfile('0x123');
            expect(profile).toBeDefined();
            expect(profile.id).toBe('0x01');
            expect(profile.handle).toBe('test.lens');
            expect(profile.pfp).toBe('https://example.com/pic-raw.jpg');
            expect(client['core'].profile.fetch).toHaveBeenCalledWith({ forProfileId: '0x123' });
        });

        it('should handle profile fetch errors', async () => {
            vi.mocked(client['core'].profile.fetch).mockRejectedValueOnce(new Error('Profile fetch failed'));
            await expect(client.getProfile('0x123')).rejects.toThrow('Profile fetch failed');
        });
    });
});
