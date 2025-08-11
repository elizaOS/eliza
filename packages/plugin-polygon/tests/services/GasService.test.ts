import { describe, it, expect, beforeEach, vi } from 'vitest';
import { getGasPriceEstimates, type GasPriceEstimates } from '../../src/services/GasService';
import { PolygonRpcService } from '../../src/services/PolygonRpcService';
import { mockRuntime, mockGasEstimates } from '../../vitest.setup';
import { resetCommonMocks } from '../test-helpers';

// Helper function to stringify BigInts for logging
function jsonStringifyWithBigInt(obj: unknown): string {
  return JSON.stringify(
    obj,
    (_key, value) => (typeof value === 'bigint' ? `${value.toString()}n` : value),
    2
  );
}

describe('GasService', () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    resetCommonMocks();

    // Store original fetch
    originalFetch = global.fetch;

    // Setup mockRuntime for this test
    vi.spyOn(mockRuntime, 'getSetting').mockImplementation((key: string) => {
      if (key === 'POLYGONSCAN_KEY') return 'test-polygonscan-key';
      if (key === 'POLYGON_RPC_URL') return 'https://polygon-mainnet.infura.io/v3/test-key';
      if (key === 'ETHEREUM_RPC_URL') return 'https://mainnet.infura.io/v3/test-key';
      if (key === 'PRIVATE_KEY')
        return '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
      return null;
    });
  });

  afterEach(() => {
    // Restore original fetch
    global.fetch = originalFetch;
  });

  describe('Gas Price Estimation', () => {
    it('should return mock gas estimates with polygonscan key available', async () => {
      // Type-safe mock of fetch
      global.fetch = vi.fn().mockImplementation(
        (): Promise<Response> =>
          Promise.resolve({
            status: 200,
            json: () =>
              Promise.resolve({
                status: '1',
                message: 'OK',
                result: {
                  SafeGasPrice: '30',
                  ProposeGasPrice: '50',
                  FastGasPrice: '80',
                  suggestBaseFee: '29',
                  gasUsedRatio: '0.5,0.6,0.7,0.8,0.9',
                },
              }),
            headers: new Headers(),
            ok: true,
            redirected: false,
            statusText: 'OK',
            type: 'basic',
            url: '',
            clone: () => ({}) as Response,
            arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
            blob: () => Promise.resolve(new Blob()),
            formData: () => Promise.resolve(new FormData()),
            text: () => Promise.resolve(''),
          } as Response)
      );

      const estimates = await getGasPriceEstimates(mockRuntime);

      expect(estimates).toBeDefined();
      expect(estimates.estimatedBaseFee).toEqual(BigInt(29000000000));
      expect(estimates.safeLow?.maxPriorityFeePerGas).toEqual(BigInt(30000000000));
      expect(estimates.average?.maxPriorityFeePerGas).toEqual(BigInt(50000000000));
      expect(estimates.fast?.maxPriorityFeePerGas).toEqual(BigInt(80000000000));
    });

    it('should fallback to RPC gas price when polygonscan key is missing', async () => {
      // Setup mock runtime with missing polygonscan key
      vi.spyOn(mockRuntime, 'getSetting').mockImplementation((key: string) => {
        if (key === 'POLYGONSCAN_KEY') return null;
        if (key === 'POLYGON_RPC_URL') return 'https://polygon-mainnet.infura.io/v3/test-key';
        if (key === 'ETHEREUM_RPC_URL') return 'https://mainnet.infura.io/v3/test-key';
        if (key === 'PRIVATE_KEY')
          return '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
        return null;
      });

      // Mock the PolygonRpcService.getL2Provider
      const mockProvider = {
        getFeeData: vi.fn().mockResolvedValue({
          gasPrice: BigInt(40000000000), // 40 Gwei
          maxFeePerGas: null,
          maxPriorityFeePerGas: null,
        }),
      };

      const mockPolygonRpcService = {
        getL2Provider: vi.fn().mockReturnValue(mockProvider),
      };

      vi.spyOn(mockRuntime, 'getService').mockImplementation((serviceType: string) => {
        if (serviceType === 'PolygonRpcService') {
          return mockPolygonRpcService;
        }
        return null;
      });

      const estimates = await getGasPriceEstimates(mockRuntime);

      expect(estimates).toBeDefined();
      expect(estimates.fallbackGasPrice).toEqual(BigInt(40000000000));
      expect(estimates.safeLow).toBeNull();
      expect(estimates.average).toBeNull();
      expect(estimates.fast).toBeNull();
      expect(estimates.estimatedBaseFee).toBeNull();
    });

    it('should handle API errors gracefully', async () => {
      // Type-safe mock of fetch for error response
      global.fetch = vi.fn().mockImplementation(
        (): Promise<Response> =>
          Promise.resolve({
            status: 400,
            json: () =>
              Promise.resolve({
                status: '0',
                message: 'NOTOK',
                result: 'Invalid API Key',
              }),
            headers: new Headers(),
            ok: false,
            redirected: false,
            statusText: 'Bad Request',
            type: 'basic',
            url: '',
            clone: () => ({}) as Response,
            arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
            blob: () => Promise.resolve(new Blob()),
            formData: () => Promise.resolve(new FormData()),
            text: () => Promise.resolve(''),
          } as Response)
      );

      // Setup mock provider for fallback
      const mockProvider = {
        getFeeData: vi.fn().mockResolvedValue({
          gasPrice: BigInt(40000000000), // 40 Gwei
          maxFeePerGas: null,
          maxPriorityFeePerGas: null,
        }),
      };

      const mockPolygonRpcService = {
        getL2Provider: vi.fn().mockReturnValue(mockProvider),
      };

      vi.spyOn(mockRuntime, 'getService').mockImplementation((serviceType: string) => {
        if (serviceType === 'PolygonRpcService') {
          return mockPolygonRpcService;
        }
        return null;
      });

      const estimates = await getGasPriceEstimates(mockRuntime);

      // Should use fallback
      expect(estimates.fallbackGasPrice).toEqual(BigInt(40000000000));
      expect(estimates.safeLow).toBeNull();
      expect(estimates.average).toBeNull();
      expect(estimates.fast).toBeNull();
    });

    it('should handle network errors gracefully', async () => {
      // Mock fetch to throw an error
      global.fetch = vi.fn().mockImplementation(() => Promise.reject(new Error('Network Error')));

      // Setup mock provider for fallback
      const mockProvider = {
        getFeeData: vi.fn().mockResolvedValue({
          gasPrice: BigInt(40000000000), // 40 Gwei
          maxFeePerGas: null,
          maxPriorityFeePerGas: null,
        }),
      };

      const mockPolygonRpcService = {
        getL2Provider: vi.fn().mockReturnValue(mockProvider),
      };

      vi.spyOn(mockRuntime, 'getService').mockImplementation((serviceType: string) => {
        if (serviceType === 'PolygonRpcService') {
          return mockPolygonRpcService;
        }
        return null;
      });

      const estimates = await getGasPriceEstimates(mockRuntime);

      // Should use fallback
      expect(estimates.fallbackGasPrice).toEqual(BigInt(40000000000));
      expect(estimates.safeLow).toBeNull();
      expect(estimates.average).toBeNull();
      expect(estimates.fast).toBeNull();
    });
  });
});
