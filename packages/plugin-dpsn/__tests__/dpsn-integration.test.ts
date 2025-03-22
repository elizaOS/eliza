import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { DpsnService } from '../src';
import { logger } from '@elizaos/core';

// This is an integration test that connects to the real DPSN network
// It requires valid credentials to run

describe('DPSN Integration', () => {
  let dpsnService: DpsnService;
  let mockRuntime: any;

  beforeAll(async () => {
    // Create a runtime with real credentials
    mockRuntime = {
      getSetting: vi.fn((key: string) => {
        // This won't be used directly since we're passing values to initializeDpsnClient
        return undefined;
      }),
      getService: (name: string) => {
        if (name === 'dpsn') return dpsnService;
        return null;
      },
      // Add other required methods
    };

    // Create the service instance
    dpsnService = new DpsnService(mockRuntime);

    // Directly call initializeDpsnClient with real values
    // @ts-ignore - Accessing private method for testing
    await dpsnService.initializeDpsnClient(
      'betanet.dpsn.org',
      '44185c015d82247881a787bb912c10a219f4b7c3bca752da6316b61beb22170b'
    );

    // Register event handlers after initialization
    dpsnService
      .on('connect', (res) => {
        logger.log(res);
      })
      .on('error', (err) => {
        logger.log(err);
      });
  }, 10000); // Longer timeout for network connection

  it('should connect to DPSN network', async () => {
    // Test that the client is initialized
    expect(dpsnService.getDpsnClient()).toBeDefined();
    // Add more assertions as needed
  });

  it('Should handle unvalid DPSN URL with error code 400', async () => {
    const invalidUrlService = new DpsnService(mockRuntime);

    try {
      // Directly call initializeDpsnClient with real values
      // @ts-ignore - Accessing private method for testing
      await invalidUrlService.initializeDpsnClient(
        'invalid-url',
        '44185c015d82247881a787bb912c10a219f4b7c3bca752da6316b61beb22170b'
      );
      const errorPromise = new Promise((resolve) => {
        invalidUrlService.on('error', (err) => {
          resolve(err);
        });
      });
      await errorPromise;
    } catch (error) {
      expect(error).toBeDefined();
      expect(error.code).toBe(400);
      await invalidUrlService.stop();
    }
  }, 10000);

  it('should handle invalid private key with error code 411', async () => {
    const invalidPvtKeyService = new DpsnService(mockRuntime);

    try {
      // Directly call initializeDpsnClient with real values
      // @ts-ignore - Accessing private method for testing
      await invalidPvtKeyService.initializeDpsnClient('betanet.dpsn.org', 'invalid-pvt-key');
      const errorPromise = new Promise((resolve) => {
        invalidPvtKeyService.on('error', (err) => {
          resolve(err);
        });
      });
      await errorPromise;
    } catch (error) {
      expect(error).toBeDefined();
      expect(error.code).toBe(411);
      await invalidPvtKeyService.stop();
    }
  }, 10000);
  afterAll(async () => {
    // Clean up
    if (dpsnService) {
      await dpsnService.stop();
    }
  });
});
