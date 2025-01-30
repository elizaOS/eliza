import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getBalanceAction } from '../src/actions/getBalanceAction';
import { ModelClass, generateObject } from '@elizaos/core';
import { formatUnits } from 'viem';
import { ETH_ADDRESS } from '../src/constants';
import { useGetAccount } from '../src/hooks';
import { resolveAddress, getTokenByName, abstractPublicClient } from '../src/utils/viemHelpers';
import { validateAbstractConfig } from '../src/environment';

// Mock dependencies
vi.mock('@elizaos/core', () => {
    const actual = vi.importActual('@elizaos/core');
    return {
        ...actual,
        ModelClass: {
            SMALL: 'small'
        },
        elizaLogger: {
            log: vi.fn(),
            error: vi.fn(),
            success: vi.fn()
        },
        composeContext: vi.fn().mockReturnValue('mocked-context'),
        generateObject: vi.fn().mockResolvedValue({
            object: {
                tokenAddress: '0xtoken',
                walletAddress: '0xwallet',
                tokenSymbol: 'TEST'
            }
        }),
        stringToUuid: vi.fn().mockReturnValue('mocked-uuid')
    };
});

vi.mock('viem', () => ({
    formatUnits: vi.fn().mockReturnValue('1.0'),
    isAddress: vi.fn().mockReturnValue(true),
    erc20Abi: [
        {
            name: 'balanceOf',
            type: 'function',
            inputs: [{ type: 'address' }],
            outputs: [{ type: 'uint256' }]
        },
        {
            name: 'decimals',
            type: 'function',
            inputs: [],
            outputs: [{ type: 'uint8' }]
        },
        {
            name: 'symbol',
            type: 'function',
            inputs: [],
            outputs: [{ type: 'string' }]
        }
    ]
}));

vi.mock('../src/environment', () => ({
    validateAbstractConfig: vi.fn().mockResolvedValue(true)
}));

vi.mock('../src/hooks', () => ({
    useGetAccount: vi.fn().mockReturnValue({
        address: '0xaccount'
    })
}));

vi.mock('../src/utils/viemHelpers', () => ({
    resolveAddress: vi.fn().mockResolvedValue('0xresolved'),
    getTokenByName: vi.fn().mockReturnValue({ address: '0xtoken' }),
    abstractPublicClient: {
        getBalance: vi.fn().mockResolvedValue(BigInt(1000000000000000000)),
        readContract: vi.fn().mockImplementation(async ({ functionName }) => {
            switch (functionName) {
                case 'balanceOf':
                    return BigInt(1000000);
                case 'decimals':
                    return 18;
                case 'symbol':
                    return 'TEST';
                default:
                    throw new Error('Unexpected function call');
            }
        })
    }
}));

describe('getBalanceAction', () => {
    const mockRuntime = {
        agentId: 'test-agent',
        composeState: vi.fn().mockResolvedValue({
            recentMessagesData: [
                { content: { text: 'previous message' } },
                { content: { text: 'Check my ETH balance' } }
            ],
            currentMessage: 'Check my ETH balance'
        }),
        updateRecentMessageState: vi.fn().mockImplementation((state) => ({
            ...state,
            recentMessagesData: [
                { content: { text: 'previous message' } },
                { content: { text: 'Check my ETH balance' } }
            ],
            currentMessage: 'Check my ETH balance'
        })),
        messageManager: {
            createMemory: vi.fn().mockResolvedValue(true),
            getMemoryById: vi.fn().mockResolvedValue({
                content: {
                    tokenAddress: '0xtoken'
                }
            })
        }
    };

    const mockCallback = vi.fn();

    beforeEach(() => {
        vi.clearAllMocks();
    });

    describe('action properties', () => {
        it('should have correct name and similes', () => {
            expect(getBalanceAction.name).toBe('GET_BALANCE');
            expect(getBalanceAction.similes).toContain('CHECK_BALANCE');
            expect(getBalanceAction.similes).toContain('VIEW_BALANCE');
            expect(getBalanceAction.similes).toContain('SHOW_BALANCE');
            expect(getBalanceAction.similes).toContain('BALANCE_CHECK');
            expect(getBalanceAction.similes).toContain('TOKEN_BALANCE');
        });

        it('should have a description', () => {
            expect(getBalanceAction.description).toBe('Check token balance for a given address');
        });
    });

    describe('validation', () => {
        it('should validate abstract config', async () => {
            const result = await getBalanceAction.validate(mockRuntime, {});
            expect(result).toBe(true);
        });

        it('should handle validation failure', async () => {
            const mockValidateAbstractConfig = vi.mocked(validateAbstractConfig);
            mockValidateAbstractConfig.mockRejectedValueOnce(new Error('Config validation failed'));

            await expect(getBalanceAction.validate(mockRuntime, {})).rejects.toThrow('Config validation failed');
        });
    });

    describe('state management', () => {
        it('should compose state if not provided', async () => {
            await getBalanceAction.handler(mockRuntime, {}, undefined, {}, mockCallback);
            expect(mockRuntime.composeState).toHaveBeenCalled();
        });

        it('should update state if provided', async () => {
            const mockState = {
                recentMessagesData: [
                    { content: { text: 'previous message' } },
                    { content: { text: 'Check my ETH balance' } }
                ],
                currentMessage: 'Check my ETH balance'
            };
            await getBalanceAction.handler(mockRuntime, {}, mockState, {}, mockCallback);
            expect(mockRuntime.updateRecentMessageState).toHaveBeenCalledWith(mockState);
        });
    });

    describe('handler', () => {
        describe('ETH balance checks', () => {
            it('should handle ETH balance check with default address', async () => {
                const mockGenerateObject = vi.mocked(generateObject);
                mockGenerateObject.mockResolvedValueOnce({
                    object: {
                        tokenAddress: ETH_ADDRESS,
                        walletAddress: null,
                        tokenSymbol: null
                    }
                });

                const result = await getBalanceAction.handler(
                    mockRuntime,
                    {},
                    undefined,
                    {},
                    mockCallback
                );

                expect(result).toBe(true);
                expect(abstractPublicClient.getBalance).toHaveBeenCalledWith({
                    address: '0xresolved'
                });
                expect(mockCallback).toHaveBeenCalledWith({
                    text: expect.stringContaining('1.0 ETH'),
                    content: expect.objectContaining({
                        balance: '1.0',
                        symbol: 'ETH'
                    })
                });
            });

            it('should handle ETH balance check with specific address', async () => {
                const mockGenerateObject = vi.mocked(generateObject);
                mockGenerateObject.mockResolvedValueOnce({
                    object: {
                        tokenAddress: ETH_ADDRESS,
                        walletAddress: '0xspecific',
                        tokenSymbol: null
                    }
                });

                const result = await getBalanceAction.handler(
                    mockRuntime,
                    {},
                    undefined,
                    {},
                    mockCallback
                );

                expect(result).toBe(true);
                expect(resolveAddress).toHaveBeenCalledWith('0xspecific');
                expect(abstractPublicClient.getBalance).toHaveBeenCalledWith({
                    address: '0xresolved'
                });
            });
        });

        describe('token balance checks', () => {
            it('should handle token balance check with address', async () => {
                const mockGenerateObject = vi.mocked(generateObject);
                mockGenerateObject.mockResolvedValueOnce({
                    object: {
                        tokenAddress: '0xtoken',
                        walletAddress: null,
                        tokenSymbol: null
                    }
                });

                const result = await getBalanceAction.handler(
                    mockRuntime,
                    {},
                    undefined,
                    {},
                    mockCallback
                );

                expect(result).toBe(true);
                expect(abstractPublicClient.readContract).toHaveBeenCalledWith(
                    expect.objectContaining({
                        address: '0xtoken',
                        functionName: 'balanceOf',
                        args: ['0xresolved']
                    })
                );
            });

            it('should handle token balance check with symbol', async () => {
                const mockGenerateObject = vi.mocked(generateObject);
                mockGenerateObject.mockResolvedValueOnce({
                    object: {
                        tokenAddress: null,
                        walletAddress: null,
                        tokenSymbol: 'TEST'
                    }
                });

                const result = await getBalanceAction.handler(
                    mockRuntime,
                    {},
                    undefined,
                    {},
                    mockCallback
                );

                expect(result).toBe(true);
                expect(mockRuntime.messageManager.getMemoryById).toHaveBeenCalledWith('mocked-uuid');
                expect(abstractPublicClient.readContract).toHaveBeenCalledWith(
                    expect.objectContaining({
                        address: '0xtoken',
                        functionName: 'balanceOf',
                        args: ['0xresolved']
                    })
                );
            });
        });

        describe('error handling', () => {
            it('should handle invalid address', async () => {
                const mockResolveAddress = vi.mocked(resolveAddress);
                mockResolveAddress.mockResolvedValueOnce(null);

                const result = await getBalanceAction.handler(
                    mockRuntime,
                    {},
                    undefined,
                    {},
                    mockCallback
                );

                expect(result).toBe(false);
                expect(mockCallback).toHaveBeenCalledWith({
                    text: expect.stringContaining('Invalid address or ENS name'),
                    content: expect.objectContaining({
                        error: 'Invalid address or ENS name'
                    })
                });
            });

            it('should handle balance check errors', async () => {
                const mockGenerateObject = vi.mocked(generateObject);
                mockGenerateObject.mockResolvedValueOnce({
                    object: {
                        tokenAddress: ETH_ADDRESS,
                        walletAddress: '0xwallet',
                        tokenSymbol: null
                    }
                });

                const mockGetBalance = vi.mocked(abstractPublicClient.getBalance);
                mockGetBalance.mockRejectedValueOnce(new Error('Balance check failed'));

                const result = await getBalanceAction.handler(
                    mockRuntime,
                    {},
                    undefined,
                    {},
                    mockCallback
                );

                expect(result).toBe(false);
                expect(mockCallback).toHaveBeenCalledWith({
                    text: expect.stringContaining('Error checking balance: Balance check failed'),
                    content: expect.objectContaining({
                        error: 'Balance check failed'
                    })
                });
            });

            it('should handle token contract errors', async () => {
                const mockGenerateObject = vi.mocked(generateObject);
                mockGenerateObject.mockResolvedValueOnce({
                    object: {
                        tokenAddress: '0xtoken',
                        walletAddress: null,
                        tokenSymbol: null
                    }
                });

                const mockReadContract = vi.mocked(abstractPublicClient.readContract);
                mockReadContract.mockRejectedValueOnce(new Error('Contract read failed'));

                const result = await getBalanceAction.handler(
                    mockRuntime,
                    {},
                    undefined,
                    {},
                    mockCallback
                );

                expect(result).toBe(false);
                expect(mockCallback).toHaveBeenCalledWith({
                    text: expect.stringContaining('Error checking balance: Contract read failed'),
                    content: expect.objectContaining({
                        error: 'Contract read failed'
                    })
                });
            });
        });
    });
});
