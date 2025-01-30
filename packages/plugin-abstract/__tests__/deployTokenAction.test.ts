import { describe, it, expect, vi, beforeEach } from 'vitest';
import { deployTokenAction } from '../src/actions/deployTokenAction';
import { ModelClass, generateObject } from '@elizaos/core';
import { parseEther } from 'viem';
import { abstractTestnet } from 'viem/chains';
import { useGetWalletClient } from '../src/hooks';
import { validateAbstractConfig } from '../src/environment';
import { abstractPublicClient } from '../src/utils/viemHelpers';
import { createAbstractClient } from '@abstract-foundation/agw-client';

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
                name: 'Test Token',
                symbol: 'TEST',
                initialSupply: '1000000',
                useAGW: false
            }
        }),
        stringToUuid: vi.fn().mockReturnValue('mocked-uuid')
    };
});

vi.mock('viem', () => ({
    parseEther: vi.fn().mockReturnValue(BigInt(1000000))
}));

vi.mock('@abstract-foundation/agw-client', () => ({
    createAbstractClient: vi.fn().mockResolvedValue({
        deployContract: vi.fn().mockResolvedValue('0xhash')
    })
}));

vi.mock('../src/environment', () => ({
    validateAbstractConfig: vi.fn().mockResolvedValue(true)
}));

vi.mock('../src/hooks', () => {
    const deployContract = vi.fn();
    deployContract.mockResolvedValue('0xhash');
    return {
        useGetAccount: vi.fn().mockReturnValue('0xaccount'),
        useGetWalletClient: vi.fn().mockReturnValue({
            deployContract
        })
    };
});

vi.mock('../src/utils/viemHelpers', () => ({
    abstractPublicClient: {
        waitForTransactionReceipt: vi.fn().mockResolvedValue({
            status: 'success',
            contractAddress: '0xcontract'
        })
    }
}));

describe('deployTokenAction', () => {
    const mockRuntime = {
        agentId: 'test-agent',
        composeState: vi.fn().mockResolvedValue({
            recentMessagesData: [
                { content: { text: 'previous message' } },
                { content: { text: 'Deploy a token named MyToken with symbol MTK and supply 1000000' } }
            ],
            currentMessage: 'Deploy a token named MyToken with symbol MTK and supply 1000000'
        }),
        updateRecentMessageState: vi.fn().mockImplementation((state) => ({
            ...state,
            recentMessagesData: [
                { content: { text: 'previous message' } },
                { content: { text: 'Deploy a token named MyToken with symbol MTK and supply 1000000' } }
            ],
            currentMessage: 'Deploy a token named MyToken with symbol MTK and supply 1000000'
        })),
        messageManager: {
            createMemory: vi.fn().mockResolvedValue(true)
        }
    };

    const mockCallback = vi.fn();
    let mockDeployContract;

    beforeEach(() => {
        vi.clearAllMocks();
        mockDeployContract = vi.mocked(useGetWalletClient()).deployContract;
    });

    describe('action properties', () => {
        it('should have correct name and similes', () => {
            expect(deployTokenAction.name).toBe('DEPLOY_TOKEN');
            expect(deployTokenAction.similes).toContain('CREATE_TOKEN');
            expect(deployTokenAction.similes).toContain('DEPLOY_NEW_TOKEN');
            expect(deployTokenAction.similes).toContain('CREATE_NEW_TOKEN');
            expect(deployTokenAction.similes).toContain('LAUNCH_TOKEN');
        });

        it('should have a description', () => {
            expect(deployTokenAction.description).toBe('Deploy a new ERC20 token contract');
        });
    });

    describe('validation', () => {
        it('should validate abstract config', async () => {
            const result = await deployTokenAction.validate(mockRuntime);
            expect(result).toBe(true);
        });

        it('should handle validation failure', async () => {
            const mockValidateAbstractConfig = vi.mocked(validateAbstractConfig);
            mockValidateAbstractConfig.mockRejectedValueOnce(new Error('Config validation failed'));

            await expect(deployTokenAction.validate(mockRuntime)).rejects.toThrow('Config validation failed');
        });
    });

    describe('state management', () => {
        it('should compose state if not provided', async () => {
            await deployTokenAction.handler(mockRuntime, {}, undefined, {}, mockCallback);
            expect(mockRuntime.composeState).toHaveBeenCalled();
        });

        it('should update state if provided', async () => {
            const mockState = {
                recentMessagesData: [
                    { content: { text: 'previous message' } },
                    { content: { text: 'Deploy a token named MyToken with symbol MTK and supply 1000000' } }
                ],
                currentMessage: 'Deploy a token named MyToken with symbol MTK and supply 1000000'
            };
            await deployTokenAction.handler(mockRuntime, {}, mockState, {}, mockCallback);
            expect(mockRuntime.updateRecentMessageState).toHaveBeenCalledWith(mockState);
        });
    });

    describe('handler', () => {
        it('should handle token deployment without AGW', async () => {
            const result = await deployTokenAction.handler(
                mockRuntime,
                {},
                undefined,
                {},
                mockCallback
            );

            expect(result).toBe(true);
            expect(parseEther).toHaveBeenCalledWith('1000000');
            expect(mockDeployContract).toHaveBeenCalledWith({
                chain: abstractTestnet,
                account: '0xaccount',
                abi: expect.any(Array),
                bytecode: expect.any(String),
                args: ['Test Token', 'TEST', BigInt(1000000)],
                kzg: undefined
            });
            expect(mockCallback).toHaveBeenCalledWith({
                text: expect.stringContaining('deployed successfully'),
                content: expect.objectContaining({
                    contractAddress: '0xcontract',
                    tokenName: 'Test Token',
                    tokenSymbol: 'TEST',
                    hash: '0xhash'
                })
            });
            expect(mockRuntime.messageManager.createMemory).toHaveBeenCalledWith({
                id: 'mocked-uuid',
                userId: 'test-agent',
                content: expect.objectContaining({
                    text: expect.stringContaining('Token deployed'),
                    tokenAddress: '0xcontract',
                    name: 'Test Token',
                    symbol: 'TEST',
                    initialSupply: '1000000',
                    source: 'abstract_token_deployment'
                }),
                agentId: 'test-agent',
                roomId: 'mocked-uuid',
                createdAt: expect.any(Number)
            });
        });

        it('should handle token deployment with AGW', async () => {
            const mockGenerateObject = vi.mocked(generateObject);
            mockGenerateObject.mockResolvedValueOnce({
                object: {
                    name: 'Test Token',
                    symbol: 'TEST',
                    initialSupply: '1000000',
                    useAGW: true
                }
            });

            const result = await deployTokenAction.handler(
                mockRuntime,
                {},
                undefined,
                {},
                mockCallback
            );

            expect(result).toBe(true);
            expect(parseEther).toHaveBeenCalledWith('1000000');
            expect(mockCallback).toHaveBeenCalledWith({
                text: expect.stringContaining('deployed successfully'),
                content: expect.objectContaining({
                    contractAddress: '0xcontract',
                    tokenName: 'Test Token',
                    tokenSymbol: 'TEST',
                    hash: '0xhash'
                })
            });
        });

        describe('validation cases', () => {
            it('should handle empty name', async () => {
                const mockGenerateObject = vi.mocked(generateObject);
                mockGenerateObject.mockResolvedValueOnce({
                    object: {
                        name: '',
                        symbol: 'TEST',
                        initialSupply: '1000000',
                        useAGW: false
                    }
                });

                const result = await deployTokenAction.handler(
                    mockRuntime,
                    {},
                    undefined,
                    {},
                    mockCallback
                );

                expect(result).toBe(false);
                expect(mockCallback).toHaveBeenCalledWith({
                    text: expect.stringContaining('Unable to process'),
                    content: expect.objectContaining({
                        error: 'Invalid deployment parameters'
                    })
                });
            });

            it('should handle invalid symbol length', async () => {
                const mockGenerateObject = vi.mocked(generateObject);
                mockGenerateObject.mockResolvedValueOnce({
                    object: {
                        name: 'Test Token',
                        symbol: 'TOOLONG',
                        initialSupply: '1000000',
                        useAGW: false
                    }
                });

                const result = await deployTokenAction.handler(
                    mockRuntime,
                    {},
                    undefined,
                    {},
                    mockCallback
                );

                expect(result).toBe(false);
                expect(mockCallback).toHaveBeenCalledWith({
                    text: expect.stringContaining('Unable to process'),
                    content: expect.objectContaining({
                        error: 'Invalid deployment parameters'
                    })
                });
            });

            it('should handle zero supply', async () => {
                const mockGenerateObject = vi.mocked(generateObject);
                mockGenerateObject.mockResolvedValueOnce({
                    object: {
                        name: 'Test Token',
                        symbol: 'TEST',
                        initialSupply: '0',
                        useAGW: false
                    }
                });

                const result = await deployTokenAction.handler(
                    mockRuntime,
                    {},
                    undefined,
                    {},
                    mockCallback
                );

                expect(result).toBe(false);
                expect(mockCallback).toHaveBeenCalledWith({
                    text: expect.stringContaining('Unable to process'),
                    content: expect.objectContaining({
                        error: 'Invalid deployment parameters'
                    })
                });
            });

            it('should handle negative supply', async () => {
                const mockGenerateObject = vi.mocked(generateObject);
                mockGenerateObject.mockResolvedValueOnce({
                    object: {
                        name: 'Test Token',
                        symbol: 'TEST',
                        initialSupply: '-1000',
                        useAGW: false
                    }
                });

                const result = await deployTokenAction.handler(
                    mockRuntime,
                    {},
                    undefined,
                    {},
                    mockCallback
                );

                expect(result).toBe(false);
                expect(mockCallback).toHaveBeenCalledWith({
                    text: expect.stringContaining('Unable to process'),
                    content: expect.objectContaining({
                        error: 'Invalid deployment parameters'
                    })
                });
            });

            it('should handle non-numeric supply', async () => {
                const mockGenerateObject = vi.mocked(generateObject);
                mockGenerateObject.mockResolvedValueOnce({
                    object: {
                        name: 'Test Token',
                        symbol: 'TEST',
                        initialSupply: 'not-a-number',
                        useAGW: false
                    }
                });

                const result = await deployTokenAction.handler(
                    mockRuntime,
                    {},
                    undefined,
                    {},
                    mockCallback
                );

                expect(result).toBe(false);
                expect(mockCallback).toHaveBeenCalledWith({
                    text: expect.stringContaining('Unable to process'),
                    content: expect.objectContaining({
                        error: 'Invalid deployment parameters'
                    })
                });
            });
        });

        describe('error handling', () => {
            it('should handle deployment errors', async () => {
                mockDeployContract.mockRejectedValueOnce(new Error('Deployment failed'));

                const result = await deployTokenAction.handler(
                    mockRuntime,
                    {},
                    undefined,
                    {},
                    mockCallback
                );

                expect(result).toBe(false);
                expect(mockCallback).toHaveBeenCalledWith({
                    text: expect.stringContaining('Error deploying token: Deployment failed'),
                    content: expect.objectContaining({
                        error: 'Deployment failed'
                    })
                });
            });

            it('should handle transaction receipt errors', async () => {
                const mockWaitForTransactionReceipt = vi.mocked(abstractPublicClient.waitForTransactionReceipt);
                mockWaitForTransactionReceipt.mockRejectedValueOnce(new Error('Transaction failed'));

                const result = await deployTokenAction.handler(
                    mockRuntime,
                    {},
                    undefined,
                    {},
                    mockCallback
                );

                expect(result).toBe(false);
                expect(mockCallback).toHaveBeenCalledWith({
                    text: expect.stringContaining('Error deploying token: Transaction failed'),
                    content: expect.objectContaining({
                        error: 'Transaction failed'
                    })
                });
            });

            it('should handle AGW client creation errors', async () => {
                const mockGenerateObject = vi.mocked(generateObject);
                mockGenerateObject.mockResolvedValueOnce({
                    object: {
                        name: 'Test Token',
                        symbol: 'TEST',
                        initialSupply: '1000000',
                        useAGW: true
                    }
                });

                const mockCreateAbstractClient = vi.mocked(createAbstractClient);
                mockCreateAbstractClient.mockRejectedValueOnce(new Error('AGW client creation failed'));

                const result = await deployTokenAction.handler(
                    mockRuntime,
                    {},
                    undefined,
                    {},
                    mockCallback
                );

                expect(result).toBe(false);
                expect(mockCallback).toHaveBeenCalledWith({
                    text: expect.stringContaining('Error deploying token: AGW client creation failed'),
                    content: expect.objectContaining({
                        error: 'AGW client creation failed'
                    })
                });
            });
        });
    });
});
