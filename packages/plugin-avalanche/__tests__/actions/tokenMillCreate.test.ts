import { describe, expect, it, vi, beforeEach } from 'vitest';
import tokenMillCreate from '../../src/actions/tokenMillCreate';
import { generateObject, composeContext } from '@elizaos/core';
import * as tokenMill from '../../src/utils/tokenMill';

vi.mock('@elizaos/core', () => ({
    generateObject: vi.fn(),
    composeContext: vi.fn(),
    elizaLogger: {
        log: vi.fn(),
        debug: vi.fn(),
        error: vi.fn(),
        success: vi.fn(),
    },
    ModelClass: {
        SMALL: 'small'
    }
}));

vi.mock('../../src/utils/tokenMill', () => ({
    createMarketAndToken: vi.fn(),
}));

describe('tokenMillCreate', () => {
    let mockRuntime;
    let mockMessage;
    let mockState;
    let mockCallback;

    beforeEach(() => {
        mockRuntime = {
            getSetting: vi.fn((key: string) => {
                switch (key) {
                    case 'AVALANCHE_PRIVATE_KEY':
                        return '0x1234567890abcdef';
                    case 'AVALANCHE_RPC_URL':
                        return 'https://api.avax-test.network/ext/bc/C/rpc';
                    default:
                        return undefined;
                }
            }),
            composeState: vi.fn().mockResolvedValue({}),
            updateRecentMessageState: vi.fn().mockResolvedValue({}),
        };

        mockMessage = {
            content: {
                name: 'Test Token',
                symbol: 'TEST'
            }
        };
        mockState = {};
        mockCallback = vi.fn();

        vi.mocked(generateObject).mockReset();
        vi.mocked(composeContext).mockReset();
        vi.mocked(tokenMill.createMarketAndToken).mockReset();
    });

    describe('validation', () => {
        it('should validate correctly with valid config', async () => {
            const result = await tokenMillCreate.validate(mockRuntime, mockMessage);
            expect(result).toBe(true);
        });

        it('should fail validation when private key is missing', async () => {
            mockRuntime.getSetting.mockImplementation((key: string) => {
                return undefined;
            });

            await expect(tokenMillCreate.validate(mockRuntime, mockMessage)).rejects.toThrow('AVALANCHE_PRIVATE_KEY');
        });
    });

    describe('action properties', () => {
        it('should have correct action properties', () => {
            expect(tokenMillCreate.name).toBe('CREATE_TOKEN');
            expect(tokenMillCreate.description).toBe(
                'MUST use this action if the user requests to create a new token, the request might be varied, but it will always be a token creation.'
            );
            expect(tokenMillCreate.examples).toBeDefined();
            expect(Array.isArray(tokenMillCreate.examples)).toBe(true);
        });

        it('should have valid examples', () => {
            tokenMillCreate.examples.forEach(example => {
                expect(Array.isArray(example)).toBe(true);
                example.forEach(interaction => {
                    expect(interaction).toHaveProperty('user');
                    expect(interaction).toHaveProperty('content');
                });
            });
        });
    });

    describe('token creation', () => {
        it('should handle successful token creation', async () => {
            const mockContent = {
                name: 'Test Token',
                symbol: 'TEST'
            };

            vi.mocked(generateObject).mockResolvedValueOnce(mockContent);
            vi.mocked(composeContext).mockReturnValueOnce('mock-context');
            vi.mocked(tokenMill.createMarketAndToken).mockResolvedValueOnce({
                tx: '0x1234',
                baseToken: '0xabcdef1234567890',
                market: '0x0987654321fedcba'
            });

            const result = await tokenMillCreate.handler(
                mockRuntime,
                mockMessage,
                mockState,
                {},
                mockCallback
            );

            expect(result).toBe(true);
            expect(mockCallback).toHaveBeenCalledWith({
                text: 'Created token Test Token with symbol TEST. CA: 0xabcdef1234567890',
                content: {
                    tx: '0x1234',
                    baseToken: '0xabcdef1234567890',
                    market: '0x0987654321fedcba'
                },
            });
        });

        it('should handle invalid content', async () => {
            const mockInvalidContent = {
                invalidField: 'test'
            };

            vi.mocked(generateObject).mockResolvedValueOnce(mockInvalidContent);
            vi.mocked(composeContext).mockReturnValueOnce('mock-context');

            const result = await tokenMillCreate.handler(
                mockRuntime,
                mockMessage,
                mockState,
                {},
                mockCallback
            );

            expect(result).toBe(false);
            expect(mockCallback).toHaveBeenCalledWith({
                text: 'Unable to process transfer request. Invalid content provided.',
                content: { error: 'Invalid content' },
            });
        });
    });
});