import { describe, expect, it, vi, beforeEach } from 'vitest';
import transfer, { isTransferContent } from '../../src/actions/transfer';
import { generateObjectDeprecated } from '@elizaos/core';
import { composeContext } from '@elizaos/core';
import * as availJsSdk from 'avail-js-sdk';

vi.mock('@elizaos/core', () => ({
    generateObjectDeprecated: vi.fn(),
    composeContext: vi.fn(),
}));

vi.mock('avail-js-sdk', () => ({
    initialize: vi.fn(),
    getKeyringFromSeed: vi.fn(),
    isValidAddress: vi.fn(),
    getDecimals: vi.fn(),
    formatNumberToBalance: vi.fn(),
}));

describe('transfer', () => {
    let mockRuntime;
    let mockMessage;
    let mockState;
    let mockCallback;
    const mockTxHash = '0x1234567890abcdef';
    const mockBlockHash = '0xabcdef1234567890';

    beforeEach(() => {
        mockRuntime = {
            getSetting: vi.fn((key: string) => {
                switch (key) {
                    case 'AVAIL_SEED':
                        return 'mock-seed';
                    case 'AVAIL_RPC_URL':
                        return 'mock-node-url';
                    case 'AVAIL_APP_ID':
                        return '0';
                    case 'AVAIL_ADDRESS':
                        return '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY';
                    default:
                        return undefined;
                }
            }),
            composeState: vi.fn().mockResolvedValue({}),
            updateRecentMessageState: vi.fn().mockResolvedValue({}),
        };

        mockMessage = {
            content: {
                recipient: '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY',
                amount: '1.5'
            }
        };
        mockState = {};
        mockCallback = vi.fn();

        const mockApi = {
            registry: {
                findMetaError: vi.fn().mockReturnValue({
                    docs: ['Transaction failed'],
                    name: 'InsufficientBalance',
                    section: 'balances'
                })
            },
            tx: {
                balances: {
                    transferKeepAlive: vi.fn().mockReturnValue({
                        paymentInfo: vi.fn().mockResolvedValue({
                            class: { toString: () => 'normal' },
                            weight: { toString: () => '1000' },
                            partialFee: { toHuman: () => '0.1 AVAIL' },
                        }),
                        signAndSend: vi.fn().mockImplementation((signer, options, callback) => {
                            const result = { 
                                status: { 
                                    isFinalized: true,
                                    asFinalized: mockBlockHash,
                                    toString: () => 'Finalized'
                                },
                                txHash: mockTxHash,
                                isError: false,
                                dispatchError: undefined,
                            };
                            callback(result);
                            return Promise.resolve();
                        }),
                    }),
                },
            },
            query: {
                system: {
                    account: vi.fn().mockResolvedValue({
                        data: {
                            free: {
                                toHuman: () => '100 AVAIL'
                            }
                        }
                    }),
                },
            },
        };

        vi.mocked(availJsSdk.initialize).mockResolvedValue(mockApi);
        vi.mocked(availJsSdk.getKeyringFromSeed).mockReturnValue({ address: 'mock-address' });
        vi.mocked(availJsSdk.isValidAddress).mockReturnValue(true);
        vi.mocked(availJsSdk.getDecimals).mockResolvedValue(18);
        vi.mocked(availJsSdk.formatNumberToBalance).mockReturnValue('1500000000000000000');
    });

    it('should validate correctly', async () => {
        const result = await transfer.validate(mockRuntime, mockMessage);
        expect(result).toBe(true);
    });

    it('should have correct action properties', () => {
        expect(transfer.name).toBe('SEND_AVAIL');
        expect(transfer.description).toBe('Transfer AVAIL tokens from the agent\'s wallet to another address');
        expect(transfer.examples).toBeDefined();
        expect(Array.isArray(transfer.examples)).toBe(true);
    });

    it('should validate transfer content correctly', () => {
        const validContent = {
            recipient: '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY',
            amount: '1.5'
        };
        expect(isTransferContent(validContent)).toBe(true);

        const invalidContent = { invalidField: 'test' };
        expect(isTransferContent(invalidContent)).toBe(false);

        const invalidAmountType = {
            recipient: '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY',
            amount: {}
        };
        expect(isTransferContent(invalidAmountType)).toBe(false);
    });
});
