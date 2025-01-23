import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DeriveKeyProvider } from '../src/providers/deriveKeyProvider';
import { TappdClient } from '@phala/dstack-sdk';
import { TEEMode } from '../src/types/tee';

// Mock dependencies
vi.mock('@phala/dstack-sdk', () => ({
    TappdClient: vi.fn().mockImplementation(() => ({
        deriveKey: vi.fn().mockResolvedValue({
            asUint8Array: () => new Uint8Array([1, 2, 3, 4, 5])
        }),
        tdxQuote: vi.fn().mockResolvedValue({
            quote: 'mock-quote-data',
            replayRtmrs: () => ['rtmr0', 'rtmr1', 'rtmr2', 'rtmr3']
        }),
        rawDeriveKey: vi.fn()
    }))
}));

vi.mock('@solana/web3.js', () => ({
    Keypair: {
        fromSeed: vi.fn().mockReturnValue({
            publicKey: {
                toBase58: () => 'mock-solana-public-key'
            }
        })
    }
}));

vi.mock('viem/accounts', () => ({
    privateKeyToAccount: vi.fn().mockReturnValue({
        address: 'mock-evm-address'
    })
}));

describe('DeriveKeyProvider', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    describe('constructor', () => {
        it('should initialize with LOCAL mode', () => {
            const _provider = new DeriveKeyProvider(TEEMode.LOCAL);
            expect(TappdClient).toHaveBeenCalledWith('http://localhost:8090');
        });

        it('should initialize with DOCKER mode', () => {
            const _provider = new DeriveKeyProvider(TEEMode.DOCKER);
            expect(TappdClient).toHaveBeenCalledWith('http://host.docker.internal:8090');
        });

        it('should initialize with PRODUCTION mode', () => {
            const _provider = new DeriveKeyProvider(TEEMode.PRODUCTION);
            expect(TappdClient).toHaveBeenCalledWith();
        });

        it('should throw error for invalid mode', () => {
            expect(() => new DeriveKeyProvider('INVALID_MODE')).toThrow('Invalid TEE_MODE');
        });
    });

    describe('rawDeriveKey', () => {
        let _provider: DeriveKeyProvider;

        beforeEach(() => {
            _provider = new DeriveKeyProvider(TEEMode.LOCAL);
        });

        it('should derive raw key successfully', async () => {
            const path = 'test-path';
            const subject = 'test-subject';
            const result = await _provider.rawDeriveKey(path, subject);

            const client = TappdClient.mock.results[0].value;
            expect(client.deriveKey).toHaveBeenCalledWith(path, subject);
            expect(result.asUint8Array()).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
        });

        it('should handle errors during raw key derivation', async () => {
            const mockError = new Error('Key derivation failed');
            vi.mocked(TappdClient).mockImplementationOnce(() => {
                const instance = new TappdClient();
                instance.deriveKey = vi.fn().mockRejectedValueOnce(mockError);
                instance.tdxQuote = vi.fn();
                instance.rawDeriveKey = vi.fn();
                return instance;
            });

            const provider = new DeriveKeyProvider(TEEMode.LOCAL);
            await expect(provider.rawDeriveKey('path', 'subject')).rejects.toThrow(mockError);
        });
    });

    describe('deriveEd25519Keypair', () => {
        let provider: DeriveKeyProvider;

        beforeEach(() => {
            provider = new DeriveKeyProvider(TEEMode.LOCAL);
        });

        it('should derive Ed25519 keypair successfully', async () => {
            const path = 'test-path';
            const subject = 'test-subject';
            const result = await provider.deriveEd25519Keypair(path, subject);

            const client = TappdClient.mock.results[0].value;
            expect(client.deriveKey).toHaveBeenCalledWith(path, subject);
            expect(result.keypair.publicKey.toBase58()).toEqual('mock-solana-public-key');
        });
    });
});