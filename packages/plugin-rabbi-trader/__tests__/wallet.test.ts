import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getWalletKeypair, getWalletBalance } from '../src/wallet';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import type { IAgentRuntime } from '@elizaos/core';

// Mock dependencies
vi.mock('@solana/web3.js', () => {
    const mockGetBalance = vi.fn().mockResolvedValue(1000000000); // 1 SOL in lamports
    const mockConnection = {
        getBalance: mockGetBalance
    };
    return {
        Connection: vi.fn(() => mockConnection),
        Keypair: {
            fromSecretKey: vi.fn().mockReturnValue({
                publicKey: {
                    toBase58: () => 'mocked-public-key'
                }
            })
        },
        PublicKey: vi.fn()
    };
});

describe('Wallet Functions', () => {
    let mockRuntime: IAgentRuntime;

    beforeEach(() => {
        // Reset mocks
        vi.clearAllMocks();

        // Setup mock runtime
        mockRuntime = {
            getSetting: vi.fn((key: string) => {
                switch (key) {
                    case 'WALLET_PRIVATE_KEY':
                        // Use a valid base58 string (this is just an example, not a real private key)
                        return '5KQFVpCEW7wEDVzAj6HnE6YpQem6X2L8qzqXNbrWJCVB';
                    case 'SOLANA_RPC_URL':
                        return 'https://api.mainnet-beta.solana.com';
                    default:
                        return undefined;
                }
            }),
            log: vi.fn(),
            error: vi.fn()
        };
    });

    describe('getWalletKeypair', () => {
        it('should create a keypair from private key', () => {
            const keypair = getWalletKeypair(mockRuntime);
            expect(keypair).toBeDefined();
            expect(keypair.publicKey).toBeDefined();
            expect(keypair.publicKey.toBase58).toBeDefined();
            expect(keypair.publicKey.toBase58()).toBe('mocked-public-key');
        });

        it('should throw error if private key is missing', () => {
            mockRuntime.getSetting = vi.fn().mockReturnValue(undefined);
            expect(() => getWalletKeypair(mockRuntime)).toThrow('No wallet private key configured');
        });

        it('should throw error if private key is invalid', () => {
            mockRuntime.getSetting = vi.fn().mockReturnValue('invalid-key');
            expect(() => getWalletKeypair(mockRuntime)).toThrow();
        });
    });

    describe('getWalletBalance', () => {
        it('should return correct SOL balance', async () => {
            const balance = await getWalletBalance(mockRuntime);
            expect(balance).toBe(1); // 1 SOL (1000000000 lamports)
            expect(Connection).toHaveBeenCalledWith('https://api.mainnet-beta.solana.com');
        });

        it('should use default RPC URL if not provided', async () => {
            mockRuntime.getSetting = vi.fn((key: string) => {
                if (key === 'WALLET_PRIVATE_KEY') {
                    return '5MaiiCavjCmn9Hs1o3eznqDEhRwxo7pXiAYez7keQUviUkauRiTMD8DrESdrNjN8zd9mTmVhRvBJeg5vhyvgrAhG';
                }
                return undefined;
            });

            await getWalletBalance(mockRuntime);
            expect(Connection).toHaveBeenCalledWith('https://api.mainnet-beta.solana.com');
        });

        it('should handle connection errors by returning 0', async () => {
            const mockConnection = {
                getBalance: vi.fn().mockRejectedValue(new Error('Connection failed'))
            };
            vi.mocked(Connection).mockImplementation(() => mockConnection as any);

            const balance = await getWalletBalance(mockRuntime);
            expect(balance).toBe(0);
            expect(mockConnection.getBalance).toHaveBeenCalled();
        });
    });
});
