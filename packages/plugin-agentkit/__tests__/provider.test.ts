import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getClient, walletProvider } from '../src/provider';
import { CdpAgentkit } from '@coinbase/cdp-agentkit-core';
import * as fs from 'fs';

// Mock dependencies
vi.mock('@coinbase/cdp-agentkit-core', () => ({
    CdpAgentkit: {
        configureWithWallet: vi.fn().mockImplementation(async (config) => ({
            exportWallet: vi.fn().mockResolvedValue('mocked-wallet-data'),
            wallet: {
                addresses: [{ id: '0x123...abc' }]
            }
        }))
    }
}));

vi.mock('fs', () => ({
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn()
}));

describe('AgentKit Provider', () => {
    const mockRuntime = {
        name: 'test-runtime',
        memory: new Map(),
        getMemory: vi.fn(),
        setMemory: vi.fn(),
        clearMemory: vi.fn()
    };

    beforeEach(() => {
        vi.clearAllMocks();
        process.env.CDP_AGENT_KIT_NETWORK = 'base-sepolia';
    });

    afterEach(() => {
        delete process.env.CDP_AGENT_KIT_NETWORK;
    });

    describe('getClient', () => {
        it('should create new wallet when no existing wallet data', async () => {
            vi.mocked(fs.existsSync).mockReturnValue(false);

            const client = await getClient();
            
            expect(CdpAgentkit.configureWithWallet).toHaveBeenCalledWith({
                networkId: 'base-sepolia'
            });
            expect(fs.writeFileSync).toHaveBeenCalledWith(
                'wallet_data.txt',
                'mocked-wallet-data'
            );
            expect(client).toBeDefined();
        });

        it('should use existing wallet data when available', async () => {
            vi.mocked(fs.existsSync).mockReturnValue(true);
            vi.mocked(fs.readFileSync).mockReturnValue('existing-wallet-data');

            const client = await getClient();
            
            expect(CdpAgentkit.configureWithWallet).toHaveBeenCalledWith({
                cdpWalletData: 'existing-wallet-data',
                networkId: 'base-sepolia'
            });
            expect(fs.writeFileSync).toHaveBeenCalledWith(
                'wallet_data.txt',
                'mocked-wallet-data'
            );
            expect(client).toBeDefined();
        });

        it('should handle file read errors gracefully', async () => {
            vi.mocked(fs.existsSync).mockReturnValue(true);
            vi.mocked(fs.readFileSync).mockImplementation(() => {
                throw new Error('File read error');
            });

            const client = await getClient();
            
            expect(CdpAgentkit.configureWithWallet).toHaveBeenCalledWith({
                networkId: 'base-sepolia'
            });
            expect(fs.writeFileSync).toHaveBeenCalledWith(
                'wallet_data.txt',
                'mocked-wallet-data'
            );
            expect(client).toBeDefined();
        });

        it('should use custom network from environment variable', async () => {
            process.env.CDP_AGENT_KIT_NETWORK = 'custom-network';
            vi.mocked(fs.existsSync).mockReturnValue(false);

            await getClient();
            
            expect(CdpAgentkit.configureWithWallet).toHaveBeenCalledWith({
                networkId: 'custom-network'
            });
        });
    });

    describe('walletProvider', () => {
        it('should return wallet address', async () => {
            const result = await walletProvider.get(mockRuntime);
            expect(result).toBe('AgentKit Wallet Address: 0x123...abc');
        });

        it('should handle errors and return null', async () => {
            vi.mocked(CdpAgentkit.configureWithWallet).mockRejectedValueOnce(
                new Error('Configuration failed')
            );

            const result = await walletProvider.get(mockRuntime);
            expect(result).toBeNull();
        });
    });
});
