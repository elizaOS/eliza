import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createTestCast } from './test-utils';
import { FarcasterClient } from '../src/client';
import { NeynarAPIClient } from '@neynar/nodejs-sdk';

// Mock dependencies
vi.mock('@neynar/nodejs-sdk', () => ({
    NeynarAPIClient: vi.fn().mockImplementation(() => ({
        publishCast: vi.fn().mockResolvedValue({
            success: true,
            cast: {
                hash: 'cast-1',
                author: { fid: '123' },
                text: 'Test cast',
                timestamp: '2025-01-20T20:00:00Z'
            }
        }),
        fetchBulkUsers: vi.fn().mockResolvedValue({
            users: [{
                fid: '123',
                username: 'test.farcaster',
                display_name: 'Test User',
                pfp: {
                    url: 'https://example.com/pic.jpg'
                }
            }]
        })
    }))
}));

describe('Cast Functions', () => {
    let client: FarcasterClient;

    beforeEach(() => {
        vi.clearAllMocks();
        client = new FarcasterClient({
            runtime: {
                name: 'test-runtime',
                memory: new Map(),
                getMemory: vi.fn(),
                setMemory: vi.fn(),
                clearMemory: vi.fn()
            },
            url: 'https://api.example.com',
            ssl: true,
            neynar: new NeynarAPIClient({ apiKey: 'test-key' }),
            signerUuid: 'test-signer',
            cache: new Map(),
            farcasterConfig: {
                apiKey: 'test-key',
                signerUuid: 'test-signer'
            }
        });
    });

    describe('createTestCast', () => {
        it('should create a cast successfully', async () => {
            const content = 'Test cast content';
            const result = await createTestCast(client, content);
            
            expect(result).toBeDefined();
            expect(result.success).toBe(true);
            expect(result.cast.text).toBe(content);
            expect(client.neynar.publishCast).toHaveBeenCalledWith({
                text: content,
                signerUuid: 'test-signer'
            });
        });

        it('should handle cast creation errors', async () => {
            const content = 'Test cast content';
            vi.mocked(client.neynar.publishCast).mockRejectedValueOnce(new Error('Cast creation failed'));
            await expect(createTestCast(client, content)).rejects.toThrow('Cast creation failed');
        });

        it('should handle empty content', async () => {
            const content = '';
            await expect(createTestCast(client, content)).rejects.toThrow('Cast content cannot be empty');
        });

        it('should handle very long content', async () => {
            const content = 'a'.repeat(321); // Farcaster limit is 320 characters
            await expect(createTestCast(client, content)).rejects.toThrow('Cast content too long');
        });
    });
});
