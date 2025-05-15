import { describe, it, expect, beforeAll } from 'vitest';
import type { IAgentRuntime } from '@elizaos/core';
import { PolygonRpcService } from '../PolygonRpcService';
import { getGasPriceEstimates, type GasPriceEstimates } from '../GasService';

// Environment variables are expected to be loaded by vitest.setup.ts via dotenv

// Helper function to stringify BigInts for logging
function jsonStringifyWithBigInt(obj: unknown): string {
  return JSON.stringify(
    obj,
    (_key, value) => (typeof value === 'bigint' ? `${value.toString()}n` : value),
    2
  );
}

describe('GasService - Integration Tests', () => {
  let fullyConfiguredRuntime: IAgentRuntime;

  beforeAll(async () => {
    // Essential ENV checks
    if (
      !process.env.POLYGONSCAN_KEY ||
      !process.env.POLYGON_RPC_URL ||
      !process.env.ETHEREUM_RPC_URL ||
      !process.env.PRIVATE_KEY
    ) {
      throw new Error(
        'Missing required environment variables (POLYGONSCAN_KEY, POLYGON_RPC_URL, ETHEREUM_RPC_URL, PRIVATE_KEY) in .env'
      );
    }

    // Runtime for PolygonRpcService.start() - only needs getSetting
    const rpcServiceInitRuntime = {
      getSetting: (key: string): string | undefined => {
        if (key === 'POLYGON_RPC_URL') return process.env.POLYGON_RPC_URL;
        if (key === 'ETHEREUM_RPC_URL') return process.env.ETHEREUM_RPC_URL;
        if (key === 'PRIVATE_KEY') return process.env.PRIVATE_KEY;
        return undefined;
      },
      // Add other IAgentRuntime fields as minimal as possible if start() complains
    } as unknown as IAgentRuntime; // Cast to bypass full interface implementation for this specific use

    const actualRpcService = await PolygonRpcService.start(rpcServiceInitRuntime);

    // Runtime for GasService - needs getSetting (for POLYGONSCAN_KEY) and getService
    fullyConfiguredRuntime = {
      getSetting: (key: string): string | undefined => {
        if (key === 'POLYGONSCAN_KEY') return process.env.POLYGONSCAN_KEY;
        return process.env[key]; // General fallback for other settings if GasService evolves
      },
      getService: <T>(serviceType: string): T | undefined => {
        if (serviceType === PolygonRpcService.serviceType) {
          return actualRpcService as T;
        }
        return undefined;
      },
    } as unknown as IAgentRuntime; // Cast to bypass full interface for this specific use
  });

  it('should successfully fetch and parse live data from PolygonScan API', async () => {
    expect(fullyConfiguredRuntime).toBeDefined();
    const estimates: GasPriceEstimates = await getGasPriceEstimates(fullyConfiguredRuntime);

    console.log('Live PolygonScan API estimates:', jsonStringifyWithBigInt(estimates));

    expect(estimates).toBeDefined();
    expect(estimates.fallbackGasPrice).toBeNull();

    // Base Fee Check (PolygonScan usually provides this)
    expect(estimates.estimatedBaseFee).toBeTypeOf('bigint');
    if (estimates.estimatedBaseFee !== null) {
      expect(estimates.estimatedBaseFee).toBeGreaterThan(0n);
    }

    // Priority Fee Checks (at least one should be present and valid)
    const hasValidSafeLow =
      estimates.safeLow &&
      typeof estimates.safeLow.maxPriorityFeePerGas === 'bigint' &&
      estimates.safeLow.maxPriorityFeePerGas > 0n;
    const hasValidAverage =
      estimates.average &&
      typeof estimates.average.maxPriorityFeePerGas === 'bigint' &&
      estimates.average.maxPriorityFeePerGas > 0n;
    const hasValidFast =
      estimates.fast &&
      typeof estimates.fast.maxPriorityFeePerGas === 'bigint' &&
      estimates.fast.maxPriorityFeePerGas > 0n;

    expect(hasValidSafeLow || hasValidAverage || hasValidFast).toBe(true);

    // Individual checks (if present, must be valid bigint > 0)
    if (estimates.safeLow && estimates.safeLow.maxPriorityFeePerGas !== null) {
      expect(estimates.safeLow.maxPriorityFeePerGas).toBeTypeOf('bigint');
      expect(estimates.safeLow.maxPriorityFeePerGas).toBeGreaterThan(0n);
    }
    if (estimates.average && estimates.average.maxPriorityFeePerGas !== null) {
      expect(estimates.average.maxPriorityFeePerGas).toBeTypeOf('bigint');
      expect(estimates.average.maxPriorityFeePerGas).toBeGreaterThan(0n);
    }
    if (estimates.fast && estimates.fast.maxPriorityFeePerGas !== null) {
      expect(estimates.fast.maxPriorityFeePerGas).toBeTypeOf('bigint');
      expect(estimates.fast.maxPriorityFeePerGas).toBeGreaterThan(0n);
    }
  }, 30000);

  it('should successfully fetch live fallback gas price via RPC when API key is missing', async () => {
    expect(fullyConfiguredRuntime).toBeDefined();
    const rpcServiceInstance = fullyConfiguredRuntime.getService(PolygonRpcService.serviceType);
    expect(rpcServiceInstance).toBeDefined();

    const fallbackTestRuntime = {
      getSetting: (key: string): string | undefined => {
        if (key === 'POLYGONSCAN_KEY') return undefined;
        return process.env[key];
      },
      getService: fullyConfiguredRuntime.getService,
    } as unknown as IAgentRuntime; // Cast to bypass full interface for this specific use

    const estimates: GasPriceEstimates = await getGasPriceEstimates(fallbackTestRuntime);
    console.log('Live RPC fallback estimates:', jsonStringifyWithBigInt(estimates));

    expect(estimates).toBeDefined();
    expect(estimates.safeLow).toBeNull();
    expect(estimates.average).toBeNull();
    expect(estimates.fast).toBeNull();
    expect(estimates.estimatedBaseFee).toBeNull();

    expect(estimates.fallbackGasPrice).not.toBeNull();
    expect(estimates.fallbackGasPrice).toBeTypeOf('bigint');
    if (estimates.fallbackGasPrice !== null) {
      expect(estimates.fallbackGasPrice).toBeGreaterThan(0n);
    }
  }, 30000);
});
