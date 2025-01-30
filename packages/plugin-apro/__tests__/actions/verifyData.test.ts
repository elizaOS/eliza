// Mock declarations must come first
vi.mock('@elizaos/core', () => ({
    Action: class {},
    composeContext: vi.fn(),
    elizaLogger: {
        info: vi.fn(),
        error: vi.fn()
    },
    generateObject: vi.fn(),
    ModelClass: {
        LARGE: 'LARGE'
    }
}));

vi.mock('ai-agent-sdk-js', () => {
    const mockVerify = vi.fn();
    return {
        AgentSDK: vi.fn().mockImplementation(() => ({
            verify: mockVerify
        }))
    };
});

import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { IAgentRuntime, Memory, State } from '@elizaos/core';
import { generateObject } from '@elizaos/core';
import { verifyData } from '../../src/actions/verifyData';
import { AgentSDK } from 'ai-agent-sdk-js';

describe('verifyData', () => {
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
            text: 'verify data'
        }
    } as Memory;

    const mockState: State = {};
    const mockCallback = vi.fn();
    const mockVerify = vi.fn();

    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(mockRuntime.composeState).mockResolvedValue(mockState);
        vi.mocked(mockRuntime.updateRecentMessageState).mockResolvedValue(mockState);
    });

    describe('validate', () => {
        it('should always return true', async () => {
            const result = await verifyData.validate(mockRuntime, mockMessage);
            expect(result).toBe(true);
        });
    });

    describe('handler', () => {
        const mockVerifyParams = {
            agent: 'test-agent',
            digest: 'test-digest',
            payload: {
                data: 'test-data',
                dataHash: 'test-hash',
                signatures: [{
                    r: 'test-r',
                    s: 'test-s',
                    v: 27
                }]
            }
        };

        it('should successfully verify data', async () => {
            // Mock generateObject to return verify params
            vi.mocked(generateObject).mockResolvedValueOnce({
                object: mockVerifyParams
            });

            const mockTx = {
                hash: 'test-hash',
                wait: vi.fn().mockResolvedValue({ hash: 'test-hash' })
            };

            const mockAgent = {
                verify: vi.fn().mockResolvedValue(mockTx)
            };
            vi.mocked(AgentSDK).mockImplementation(() => mockAgent);

            await verifyData.handler(
                mockRuntime,
                mockMessage,
                mockState,
                {},
                mockCallback
            );

            expect(mockCallback).toHaveBeenCalledWith({
                text: 'Success: Data verified successfully. Transaction ID: test-hash'
            });
            expect(mockAgent.verify).toHaveBeenCalledWith(mockVerifyParams);
        });

        it('should handle verify params generation failure', async () => {
            // Mock generateObject to throw an error
            vi.mocked(generateObject).mockRejectedValueOnce(
                new Error('Failed to generate params')
            );

            await verifyData.handler(
                mockRuntime,
                mockMessage,
                mockState,
                {},
                mockCallback
            );

            expect(mockCallback).toHaveBeenCalledWith({
                text: 'Failed to generate verify params. Please provide valid input.'
            });
        });

        it('should handle verification failure', async () => {
            // Mock generateObject to return verify params
            vi.mocked(generateObject).mockResolvedValueOnce({
                object: mockVerifyParams
            });

            const mockAgent = {
                verify: vi.fn().mockRejectedValue(new Error('Verification failed'))
            };
            vi.mocked(AgentSDK).mockImplementation(() => mockAgent);

            await verifyData.handler(
                mockRuntime,
                mockMessage,
                mockState,
                {},
                mockCallback
            );

            expect(mockCallback).toHaveBeenCalledWith({
                text: 'Error verifying data: Verification failed'
            });
        });
    });

    describe('metadata', () => {
        it('should have correct name and description', () => {
            expect(verifyData.name).toBe('VERIFY');
            expect(verifyData.description).toContain('Verify data with APRO');
        });

        it('should have valid examples', () => {
            expect(Array.isArray(verifyData.examples)).toBe(true);
            expect(verifyData.examples.length).toBeGreaterThan(0);
            
            verifyData.examples.forEach(example => {
                expect(Array.isArray(example)).toBe(true);
                expect(example.length).toBe(2);
                expect(example[1].content.action).toBe('VERIFY');
            });
        });
    });
});
