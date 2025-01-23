import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createTestPost } from './test-utils';
import { LensClient } from '../src/client';

// Mock dependencies
vi.mock('../src/client', () => ({
    LensClient: vi.fn().mockImplementation(() => ({
        authenticate: vi.fn().mockResolvedValue(undefined),
        post: vi.fn().mockResolvedValue({ id: 'post-1' })
    }))
}));

describe('Post Functions', () => {
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

    describe('createTestPost', () => {
        it('should create a post successfully', async () => {
            const content = 'Test post content';
            const result = await createTestPost(client, content);

            expect(result).toBeDefined();
            expect(result.id).toBe('post-1');
            expect(client.post).toHaveBeenCalledWith(content);
        });

        it('should handle post creation errors', async () => {
            const content = 'Test post content';
            vi.mocked(client.post).mockRejectedValueOnce(new Error('Post creation failed'));

            await expect(createTestPost(client, content)).rejects.toThrow('Post creation failed');
        });

        it('should handle empty content', async () => {
            const content = '';
            await expect(createTestPost(client, content)).rejects.toThrow('Post content cannot be empty');
        });

        it('should handle very long content', async () => {
            const content = 'a'.repeat(5001); // Assuming max length is 5000
            await expect(createTestPost(client, content)).rejects.toThrow('Post content too long');
        });
    });
});
