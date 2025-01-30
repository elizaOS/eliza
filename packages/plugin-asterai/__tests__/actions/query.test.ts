const mockQuery = vi.fn();

vi.mock('@asterai/client', () => ({
    AsteraiClient: vi.fn(() => ({
        query: mockQuery
    }))
}));

vi.mock('../../src/index', () => ({
    getInitAsteraiClient: vi.fn(() => ({
        query: mockQuery
    }))
}));

import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { IAgentRuntime, Memory, State } from '@elizaos/core';
import { queryAction } from '../../src/actions/query';

describe('queryAction', () => {
    const mockRuntime: IAgentRuntime = {
        getSetting: vi.fn(),
    } as unknown as IAgentRuntime;

    const mockMessage: Memory = {
        userId: 'test-user',
        agentId: 'test-agent',
        roomId: 'test-room',
        content: {
            text: 'test query'
        }
    } as Memory;

    const mockState: State = {};
    const mockCallback = vi.fn();

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

    describe('validate', () => {
        it('should validate with correct configuration', async () => {
            const result = await queryAction.validate(mockRuntime, mockMessage);
            expect(result).toBe(true);
        });

        it('should throw error with invalid configuration', async () => {
            vi.mocked(mockRuntime.getSetting).mockReturnValue(null);
            
            await expect(queryAction.validate(mockRuntime, mockMessage))
                .rejects
                .toThrow('Asterai plugin configuration validation failed');
        });
    });

    describe('handler', () => {
        it('should handle query and return response', async () => {
            mockQuery.mockResolvedValueOnce({ text: () => Promise.resolve('mocked response') });

            const result = await queryAction.handler(
                mockRuntime,
                mockMessage,
                mockState,
                {},
                mockCallback
            );

            expect(result).toBe(true);
            expect(mockCallback).toHaveBeenCalledWith({
                text: 'mocked response'
            });
            expect(mockQuery).toHaveBeenCalledWith({
                query: 'test query'
            });
        });

        it('should handle query errors gracefully', async () => {
            mockQuery.mockRejectedValueOnce(new Error('Query failed'));

            await expect(
                queryAction.handler(mockRuntime, mockMessage, mockState, {}, mockCallback)
            ).rejects.toThrow('Query failed');
        });
    });

    describe('metadata', () => {
        it('should have correct name and similes', () => {
            expect(queryAction.name).toBe('QUERY_ASTERAI_AGENT');
            expect(queryAction.similes).toContain('MESSAGE_ASTERAI_AGENT');
            expect(queryAction.similes).toContain('TALK_TO_ASTERAI_AGENT');
        });

        it('should have valid examples', () => {
            expect(Array.isArray(queryAction.examples)).toBe(true);
            expect(queryAction.examples.length).toBeGreaterThan(0);
            
            queryAction.examples.forEach(example => {
                expect(Array.isArray(example)).toBe(true);
                expect(example.length).toBe(2);
                expect(example[1].content.action).toBe('QUERY_ASTERAI_AGENT');
            });
        });
    });
});
