// Mock declarations must come first
vi.mock('@elizaos/core');
vi.mock('ai-agent-sdk-js');

import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { IAgentRuntime, Memory, State } from '@elizaos/core';
import { generateObject } from '@elizaos/core';
import { attpsPriceQuery } from '../../src/actions/attpsPriceQuery';

describe('attpsPriceQuery', () => {
    const mockRuntime: IAgentRuntime = {
        composeState: vi.fn(),
        updateRecentMessageState: vi.fn(),
        getSetting: vi.fn()
    } as unknown as IAgentRuntime;

    const mockMessage: Memory = {
        userId: 'test-user',
        agentId: 'test-agent',
        roomId: 'test-room',
        content: {
            text: 'query price'
        }
    } as Memory;

    const mockState: State = {};
    const mockCallback = vi.fn();
    const mockFetch = vi.fn();

    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(mockRuntime.composeState).mockResolvedValue(mockState);
        vi.mocked(mockRuntime.updateRecentMessageState).mockResolvedValue(mockState);
        global.fetch = mockFetch;
    });

    describe('validate', () => {
        it('should always return true', async () => {
            const result = await attpsPriceQuery.validate(mockRuntime, mockMessage);
            expect(result).toBe(true);
        });
    });

    describe('handler', () => {
        const mockPriceQuery = {
            sourceAgentId: 'test-source-agent',
            feedId: 'test-feed'
        };

        const mockPriceResponse = {
            code: 0,
            message: 'success',
            result: {
                askPrice: '100.50',
                bidPrice: '100.40',
                midPrice: '100.45',
                validTimeStamp: '1234567890'
            }
        };

        it('should successfully fetch price data', async () => {
            // Mock generateObject to return price query params
            vi.mocked(generateObject).mockResolvedValueOnce({
                object: mockPriceQuery
            });

            // Mock successful API response
            mockFetch.mockResolvedValueOnce({
                json: () => Promise.resolve(mockPriceResponse)
            });

            const result = await attpsPriceQuery.handler(
                mockRuntime,
                mockMessage,
                mockState,
                {},
                mockCallback
            );

            expect(mockCallback).toHaveBeenCalledWith(expect.objectContaining({
                text: expect.stringContaining('Ask price: 100.5')
            }));
            expect(mockFetch).toHaveBeenCalledWith(
                expect.stringContaining('sourceAgentId=test-source-agent')
            );
        });

        it('should handle price query params generation failure', async () => {
            // Mock generateObject to throw an error
            vi.mocked(generateObject).mockRejectedValueOnce(
                new Error('Failed to generate params')
            );

            await attpsPriceQuery.handler(
                mockRuntime,
                mockMessage,
                mockState,
                {},
                mockCallback
            );

            expect(mockCallback).toHaveBeenCalledWith({
                text: expect.stringContaining('Failed to generate price query params')
            });
        });

        it('should handle API error response', async () => {
            // Mock generateObject to return price query params
            vi.mocked(generateObject).mockResolvedValueOnce({
                object: mockPriceQuery
            });

            // Mock API error response
            mockFetch.mockResolvedValueOnce({
                json: () => Promise.resolve({
                    code: 1,
                    message: 'API Error'
                })
            });

            await attpsPriceQuery.handler(
                mockRuntime,
                mockMessage,
                mockState,
                {},
                mockCallback
            );

            expect(mockCallback).toHaveBeenCalledWith({
                text: 'Error fetching price data, error: API Error'
            });
        });

        it('should handle network failure', async () => {
            // Mock generateObject to return price query params
            vi.mocked(generateObject).mockResolvedValueOnce({
                object: mockPriceQuery
            });

            // Mock network failure
            mockFetch.mockRejectedValueOnce(new Error('Network error'));

            await attpsPriceQuery.handler(
                mockRuntime,
                mockMessage,
                mockState,
                {},
                mockCallback
            );

            expect(mockCallback).toHaveBeenCalledWith({
                text: 'Error fetching price data, error: Network error'
            });
        });
    });

    describe('metadata', () => {
        it('should have correct name and description', () => {
            expect(attpsPriceQuery.name).toBe('ATTPS_PRICE_QUERY');
            expect(attpsPriceQuery.description).toContain('Call remote API to fetch price data');
        });

        it('should have valid examples', () => {
            expect(Array.isArray(attpsPriceQuery.examples)).toBe(true);
            expect(attpsPriceQuery.examples.length).toBeGreaterThan(0);
            
            attpsPriceQuery.examples.forEach(example => {
                expect(Array.isArray(example)).toBe(true);
                expect(example.length).toBe(2);
                expect(example[1].content.action).toBe('ATTPS_PRICE_QUERY');
            });
        });
    });
});
