import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RemoteAttestationProvider } from '../src/providers/remoteAttestationProvider';
import { TappdClient } from '@phala/dstack-sdk';
import { TEEMode } from '../src/types/tee';

// Mock TappdClient
vi.mock('@phala/dstack-sdk', () => ({
    TappdClient: vi.fn().mockImplementation(() => ({
        tdxQuote: vi.fn().mockResolvedValue({
            quote: 'mock-quote-data',
            replayRtmrs: () => ['rtmr0', 'rtmr1', 'rtmr2', 'rtmr3']
        }),
        deriveKey: vi.fn()
    }))
}));

describe('RemoteAttestationProvider', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    describe('constructor', () => {
        it('should initialize with LOCAL mode', () => {
            const _provider = new RemoteAttestationProvider(TEEMode.LOCAL);
            expect(TappdClient).toHaveBeenCalledWith('http://localhost:8090');
        });

        it('should initialize with DOCKER mode', () => {
            const _provider = new RemoteAttestationProvider(TEEMode.DOCKER);
            expect(TappdClient).toHaveBeenCalledWith('http://host.docker.internal:8090');
        });

        it('should initialize with PRODUCTION mode', () => {
            const _provider = new RemoteAttestationProvider(TEEMode.PRODUCTION);
            expect(TappdClient).toHaveBeenCalledWith();
        });

        it('should throw error for invalid mode', () => {
            expect(() => new RemoteAttestationProvider('INVALID_MODE')).toThrow('Invalid TEE_MODE');
        });
    });

    describe('generateAttestation', () => {
        let provider: RemoteAttestationProvider;

        beforeEach(() => {
            provider = new RemoteAttestationProvider(TEEMode.LOCAL);
        });

        it('should generate attestation successfully', async () => {
            const reportData = 'test-report-data';
            const quote = await provider.generateAttestation(reportData);

            expect(quote).toEqual({
                quote: 'mock-quote-data',
                timestamp: expect.any(Number)
            });
        });

        it('should handle errors during attestation generation', async () => {
            const mockError = new Error('TDX Quote generation failed');
            const mockTdxQuote = vi.fn().mockRejectedValue(mockError);
            vi.mocked(TappdClient).mockImplementationOnce(() => ({
                tdxQuote: mockTdxQuote,
                deriveKey: vi.fn()
            }));

            const provider = new RemoteAttestationProvider(TEEMode.LOCAL);
            await expect(provider.generateAttestation('test-data')).rejects.toThrow('Failed to generate TDX Quote');
        });

        it('should pass hash algorithm to tdxQuote when provided', async () => {
            const reportData = 'test-report-data';
            const hashAlgorithm = 'raw';
            await provider.generateAttestation(reportData, hashAlgorithm);

            const client = TappdClient.mock.results[0].value;
            expect(client.tdxQuote).toHaveBeenCalledWith(reportData, hashAlgorithm);
        });
    });
});