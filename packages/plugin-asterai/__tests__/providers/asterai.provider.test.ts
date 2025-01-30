const mockFetchSummary = vi.fn();

vi.mock('@asterai/client', () => ({
    AsteraiClient: vi.fn(() => ({
        fetchSummary: mockFetchSummary
    }))
}));

vi.mock('../../src/index', () => ({
    getInitAsteraiClient: vi.fn(() => ({
        fetchSummary: mockFetchSummary
    }))
}));

import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { IAgentRuntime, Memory, State } from '@elizaos/core';
import { asteraiProvider } from '../../src/providers/asterai.provider';

describe('asteraiProvider', () => {
    const mockRuntime: IAgentRuntime = {
        getSetting: vi.fn(),
        knowledgeManager: {
            getMemoryById: vi.fn(),
            createMemory: vi.fn()
        }
    } as unknown as IAgentRuntime;

    const mockMessage: Memory = {
        userId: 'test-user',
        agentId: 'test-agent',
        roomId: 'test-room',
        content: {
            text: 'test message'
        }
    } as Memory;

    const mockState: State = {};

    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(mockRuntime.getSetting).mockImplementation((key: string) => {
            const settings = {
                ASTERAI_AGENT_ID: 'test-agent-id',
                ASTERAI_PUBLIC_QUERY_KEY: 'test-query-key'
            };
            return settings[key as keyof typeof settings] || null;
        });
    });

    describe('get', () => {
        it('should return null if environment is not configured', async () => {
            vi.mocked(mockRuntime.getSetting).mockReturnValue(null);

            const result = await asteraiProvider.get(mockRuntime, mockMessage, mockState);
            expect(result).toBeNull();
        });

        it('should return existing summary from knowledge manager', async () => {
            const mockSummary = {
                content: { text: 'existing summary' }
            };
            vi.mocked(mockRuntime.knowledgeManager.getMemoryById).mockResolvedValue(mockSummary);

            const result = await asteraiProvider.get(mockRuntime, mockMessage, mockState);
            expect(result).toBe('existing summary');
        });

        it('should fetch and store new summary if none exists', async () => {
            vi.mocked(mockRuntime.knowledgeManager.getMemoryById)
                .mockResolvedValueOnce(null)
                .mockResolvedValueOnce({ content: { text: 'new summary' } });

            mockFetchSummary.mockResolvedValueOnce('new summary');
            vi.mocked(mockRuntime.knowledgeManager.createMemory).mockResolvedValueOnce(undefined);

            const result = await asteraiProvider.get(mockRuntime, mockMessage, mockState);
            
            expect(mockRuntime.knowledgeManager.createMemory).toHaveBeenCalledWith(expect.objectContaining({
                id: 'test-agent-id',
                content: { text: 'new summary' }
            }));
            expect(result).toBe('new summary');
        });

        it('should handle errors when fetching summary', async () => {
            vi.mocked(mockRuntime.knowledgeManager.getMemoryById).mockResolvedValue(null);
            mockFetchSummary.mockRejectedValue(new Error('Failed to fetch summary'));

            try {
                await asteraiProvider.get(mockRuntime, mockMessage, mockState);
            } catch (error) {
                expect(error).toBeInstanceOf(Error);
                expect(error.message).toBe('Failed to fetch summary');
            }
        });
    });
});
