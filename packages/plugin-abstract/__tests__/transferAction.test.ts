import { describe, it, expect, vi, beforeEach } from 'vitest';
import { transferAction } from '../src/actions/transferAction';
import { ModelClass, generateObject } from '@elizaos/core';
import { formatUnits, parseUnits, erc20Abi } from 'viem';
import { ETH_ADDRESS } from '../src/constants';
import { useGetAccount, useGetWalletClient } from '../src/hooks';
import { resolveAddress, getTokenByName, abstractPublicClient } from '../src/utils/viemHelpers';
import { createAbstractClient } from '@abstract-foundation/agw-client';
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
                recipient: '0xrecipient',
                amount: '1.0',
                useAGW: false,
                tokenSymbol: 'TEST'
            }
        }),
        stringToUuid: vi.fn().mockReturnValue('mocked-uuid')
    };
});

vi.mock('viem', () => ({
    formatUnits: vi.fn().mockReturnValue('1.0'),
    parseUnits: vi.fn().mockReturnValue(BigInt(1000000000000000000)),
    isAddress: vi.fn().mockReturnValue(true),
    erc20Abi: [
        {
            name: 'transfer',
            type: 'function',
            inputs: [
                { type: 'address' },
                { type: 'uint256' }
            ],
            outputs: [{ type: 'bool' }]
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

vi.mock('@abstract-foundation/agw-client', () => ({
    createAbstractClient: vi.fn().mockResolvedValue({
        sendTransaction: vi.fn().mockResolvedValue('0xhash'),
        writeContract: vi.fn().mockResolvedValue('0xhash')
    })
}));

vi.mock('../src/environment', () => ({
    validateAbstractConfig: vi.fn().mockResolvedValue(true)
}));

vi.mock('../src/hooks', () => {
    const writeContract = vi.fn().mockResolvedValue('0xhash');
    const sendTransaction = vi.fn().mockResolvedValue('0xhash');
    return {
        useGetAccount: vi.fn().mockReturnValue({
            address: '0xaccount'
        }),
        useGetWalletClient: vi.fn().mockReturnValue({
            writeContract,
            sendTransaction
        })
    };
});

vi.mock('../src/utils/viemHelpers', () => ({
    resolveAddress: vi.fn().mockResolvedValue('0xresolved'),
    getTokenByName: vi.fn().mockReturnValue({ address: '0xtoken' }),
    abstractPublicClient: {
        readContract: vi.fn().mockImplementation(async ({ functionName }) => {
            switch (functionName) {
                case 'symbol':
                    return 'TEST';
                case 'decimals':
                    return 18;
                default:
                    throw new Error('Unexpected function call');
            }
        })
    }
}));

describe('transferAction', () => {
    const mockRuntime = {
        agentId: 'test-agent',
        composeState: vi.fn().mockResolvedValue({
            recentMessagesData: [
                { content: { text: 'previous message' } },
                { content: { text: 'Send 1 ETH to 0xrecipient' } }
            ],
            currentMessage: 'Send 1 ETH to 0xrecipient'
        }),
        updateRecentMessageState: vi.fn().mockImplementation((state) => ({
            ...state,
            recentMessagesData: [
                { content: { text: 'previous message' } },
                { content: { text: 'Send 1 ETH to 0xrecipient' } }
            ],
            currentMessage: 'Send 1 ETH to 0xrecipient'
        })),
        messageManager: {
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
            expect(transferAction.name).toBe('SEND_TOKEN');
            expect(transferAction.similes).toContain('TRANSFER_TOKEN_ON_ABSTRACT');
            expect(transferAction.similes).toContain('TRANSFER_TOKENS_ON_ABSTRACT');
            expect(transferAction.similes).toContain('SEND_TOKENS_ON_ABSTRACT');
            expect(transferAction.similes).toContain('SEND_ETH_ON_ABSTRACT');
            expect(transferAction.similes).toContain('PAY_ON_ABSTRACT');
            expect(transferAction.similes).toContain('MOVE_TOKENS_ON_ABSTRACT');
            expect(transferAction.similes).toContain('MOVE_ETH_ON_ABSTRACT');
        });

        it('should have a description', () => {
            expect(transferAction.description).toBe("Transfer tokens from the agent's wallet to another address");
        });
    });

    describe('validation', () => {
        it('should validate abstract config', async () => {
            const result = await transferAction.validate(mockRuntime);
            expect(result).toBe(true);
        });

        it('should handle validation failure', async () => {
            const mockValidateAbstractConfig = vi.mocked(validateAbstractConfig);
            mockValidateAbstractConfig.mockRejectedValueOnce(new Error('Config validation failed'));

            await expect(transferAction.validate(mockRuntime)).rejects.toThrow('Config validation failed');
        });
    });

    describe('state management', () => {
        it('should compose state if not provided', async () => {
            await transferAction.handler(mockRuntime, {}, undefined, {}, mockCallback);
            expect(mockRuntime.composeState).toHaveBeenCalled();
        });

        it('should update state if provided', async () => {
            const mockState = {
                recentMessagesData: [
                    { content: { text: 'previous message' } },
                    { content: { text: 'Send 1 ETH to 0xrecipient' } }
                ],
                currentMessage: 'Send 1 ETH to 0xrecipient'
            };
            await transferAction.handler(mockRuntime, {}, mockState, {}, mockCallback);
            expect(mockRuntime.updateRecentMessageState).toHaveBeenCalledWith(mockState);
        });
    });

    describe('handler', () => {
        describe('ETH transfers', () => {
            it('should handle ETH transfer without AGW', async () => {
                const mockGenerateObject = vi.mocked(generateObject);
                mockGenerateObject.mockResolvedValueOnce({
                    object: {
                        tokenAddress: ETH_ADDRESS,
                        recipient: '0xrecipient',
                        amount: '1.0',
                        useAGW: false,
                        tokenSymbol: null
                    }
                });

                const result = await transferAction.handler(
                    mockRuntime,
                    {},
                    undefined,
                    {},
                    mockCallback
                );

                expect(result).toBe(true);
                const walletClient = useGetWalletClient();
                expect(walletClient.sendTransaction).toHaveBeenCalledWith({
                    account: expect.any(Object),
                    chain: expect.any(Object),
                    to: '0xresolved',
                    value: BigInt(1000000000000000000),
                    kzg: undefined
                });
                expect(mockCallback).toHaveBeenCalledWith({
                    text: expect.stringContaining('1.0 ETH'),
                    content: expect.objectContaining({
                        hash: '0xhash',
                        tokenAmount: '1.0',
                        symbol: 'ETH',
                        recipient: '0xresolved',
                        useAGW: false
                    })
                });
            });

            it('should handle ETH transfer with AGW', async () => {
                const mockGenerateObject = vi.mocked(generateObject);
                mockGenerateObject.mockResolvedValueOnce({
                    object: {
                        tokenAddress: ETH_ADDRESS,
                        recipient: '0xrecipient',
                        amount: '1.0',
                        useAGW: true,
                        tokenSymbol: null
                    }
                });

                const result = await transferAction.handler(
                    mockRuntime,
                    {},
                    undefined,
                    {},
                    mockCallback
                );

                expect(result).toBe(true);
                const mockAbstractClient = await createAbstractClient({});
                expect(mockAbstractClient.sendTransaction).toHaveBeenCalledWith({
                    chain: expect.any(Object),
                    to: '0xresolved',
                    value: BigInt(1000000000000000000),
                    kzg: undefined
                });
            });
        });

        describe('token transfers', () => {
            it('should handle token transfer without AGW', async () => {
                const mockGenerateObject = vi.mocked(generateObject);
                mockGenerateObject.mockResolvedValueOnce({
                    object: {
                        tokenAddress: '0xtoken',
                        recipient: '0xrecipient',
                        amount: '1.0',
                        useAGW: false,
                        tokenSymbol: null
                    }
                });

                const result = await transferAction.handler(
                    mockRuntime,
                    {},
                    undefined,
                    {},
                    mockCallback
                );

                expect(result).toBe(true);
                const walletClient = useGetWalletClient();
                expect(walletClient.writeContract).toHaveBeenCalledWith({
                    account: expect.any(Object),
                    chain: expect.any(Object),
                    address: '0xtoken',
                    abi: expect.any(Array),
                    functionName: 'transfer',
                    args: ['0xresolved', BigInt(1000000000000000000)]
                });
            });

            it('should handle token transfer with AGW', async () => {
                const mockGenerateObject = vi.mocked(generateObject);
                mockGenerateObject.mockResolvedValueOnce({
                    object: {
                        tokenAddress: '0xtoken',
                        recipient: '0xrecipient',
                        amount: '1.0',
                        useAGW: true,
                        tokenSymbol: null
                    }
                });

                const result = await transferAction.handler(
                    mockRuntime,
                    {},
                    undefined,
                    {},
                    mockCallback
                );

                expect(result).toBe(true);
                const mockAbstractClient = await createAbstractClient({});
                expect(mockAbstractClient.writeContract).toHaveBeenCalledWith({
                    chain: expect.any(Object),
                    address: '0xtoken',
                    abi: expect.any(Array),
                    functionName: 'transfer',
                    args: ['0xresolved', BigInt(1000000000000000000)]
                });
            });

            it('should handle token transfer by symbol', async () => {
                const mockGenerateObject = vi.mocked(generateObject);
                mockGenerateObject.mockResolvedValueOnce({
                    object: {
                        tokenAddress: null,
                        recipient: '0xrecipient',
                        amount: '1.0',
                        useAGW: false,
                        tokenSymbol: 'TEST'
                    }
                });

                const result = await transferAction.handler(
                    mockRuntime,
                    {},
                    undefined,
                    {},
                    mockCallback
                );

                expect(result).toBe(true);
                expect(mockRuntime.messageManager.getMemoryById).toHaveBeenCalledWith('mocked-uuid');
                const walletClient = useGetWalletClient();
                expect(walletClient.writeContract).toHaveBeenCalledWith({
                    account: expect.any(Object),
                    chain: expect.any(Object),
                    address: '0xtoken',
                    abi: expect.any(Array),
                    functionName: 'transfer',
                    args: ['0xresolved', BigInt(1000000000000000000)]
                });
            });
        });

        describe('error handling', () => {
            it('should handle invalid recipient address', async () => {
                const mockGenerateObject = vi.mocked(generateObject);
                mockGenerateObject.mockResolvedValueOnce({
                    object: {
                        tokenAddress: ETH_ADDRESS,
                        recipient: '0xinvalid',
                        amount: '1.0',
                        useAGW: false,
                        tokenSymbol: null
                    }
                });

                const mockResolveAddress = vi.mocked(resolveAddress);
                mockResolveAddress.mockResolvedValueOnce(null);

                const result = await transferAction.handler(
                    mockRuntime,
                    {},
                    undefined,
                    {},
                    mockCallback
                );

                expect(result).toBe(false);
                expect(mockCallback).toHaveBeenCalledWith({
                    text: 'Unable to process transfer request. Did not extract valid parameters.',
                    content: expect.objectContaining({
                        error: expect.stringContaining('Expected string, received null'),
                        recipient: null,
                        tokenAddress: ETH_ADDRESS,
                        useAGW: false,
                        amount: '1.0'
                    })
                });
            });

            it('should handle transfer errors without AGW', async () => {
                const mockGenerateObject = vi.mocked(generateObject);
                mockGenerateObject.mockResolvedValueOnce({
                    object: {
                        tokenAddress: ETH_ADDRESS,
                        recipient: '0xrecipient',
                        amount: '1.0',
                        useAGW: false,
                        tokenSymbol: null
                    }
                });

                const walletClient = useGetWalletClient();
                vi.mocked(walletClient.sendTransaction).mockRejectedValueOnce(new Error('Transfer failed'));

                const result = await transferAction.handler(
                    mockRuntime,
                    {},
                    undefined,
                    {},
                    mockCallback
                );

                expect(result).toBe(false);
                expect(mockCallback).toHaveBeenCalledWith({
                    text: expect.stringContaining('Error transferring tokens: Transfer failed'),
                    content: expect.objectContaining({
                        error: 'Transfer failed'
                    })
                });
            });

            it('should handle transfer errors with AGW', async () => {
                const mockGenerateObject = vi.mocked(generateObject);
                mockGenerateObject.mockResolvedValueOnce({
                    object: {
                        tokenAddress: ETH_ADDRESS,
                        recipient: '0xrecipient',
                        amount: '1.0',
                        useAGW: true,
                        tokenSymbol: null
                    }
                });

                const mockCreateAbstractClient = vi.mocked(createAbstractClient);
                mockCreateAbstractClient.mockRejectedValueOnce(new Error('AGW client creation failed'));

                const result = await transferAction.handler(
                    mockRuntime,
                    {},
                    undefined,
                    {},
                    mockCallback
                );

                expect(result).toBe(false);
                expect(mockCallback).toHaveBeenCalledWith({
                    text: expect.stringContaining('Error transferring tokens: AGW client creation failed'),
                    content: expect.objectContaining({
                        error: 'AGW client creation failed'
                    })
                });
            });

            it('should handle token contract errors', async () => {
                const mockGenerateObject = vi.mocked(generateObject);
                mockGenerateObject.mockResolvedValueOnce({
                    object: {
                        tokenAddress: '0xtoken',
                        recipient: '0xrecipient',
                        amount: '1.0',
                        useAGW: false,
                        tokenSymbol: null
                    }
                });

                const mockReadContract = vi.mocked(abstractPublicClient.readContract);
                mockReadContract.mockRejectedValueOnce(new Error('Contract read failed'));

                const result = await transferAction.handler(
                    mockRuntime,
                    {},
                    undefined,
                    {},
                    mockCallback
                );

                expect(result).toBe(false);
                expect(mockCallback).toHaveBeenCalledWith({
                    text: expect.stringContaining('Error transferring tokens: Contract read failed'),
                    content: expect.objectContaining({
                        error: 'Contract read failed'
                    })
                });
            });
        });
    });
});
