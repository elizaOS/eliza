import { describe, it, expect, beforeAll } from 'vitest';
import { PolygonRpcService } from '../../src/services/PolygonRpcService';
import type { IAgentRuntime } from '@elizaos/core';

// Constants for integration tests
const KNOWN_HISTORICAL_CHECKPOINT_MAINNET = 20000000n;
const TEST_TIMEOUT = 60000; // 60 seconds

// Conditional describe for integration tests, depends on environment variables
const describeIntegration = describe.skipIf(
  !process.env.ETHEREUM_RPC_URL || !process.env.PRIVATE_KEY
);

describeIntegration('PolygonRpcService - Checkpoint Integration Tests', () => {
  let service: PolygonRpcService;
  let integrationRuntime: IAgentRuntime;

  beforeAll(async () => {
    // This check is mainly for type safety within the block, skipIf handles actual skipping
    if (!process.env.ETHEREUM_RPC_URL || !process.env.PRIVATE_KEY) {
      console.warn(
        'Skipping Checkpoint Integration Tests due to missing ETHEREUM_RPC_URL or PRIVATE_KEY in .env'
      );
      return;
    }

    integrationRuntime = {
      getSetting: (key: string): string | undefined => {
        if (key === 'ETHEREUM_RPC_URL') return process.env.ETHEREUM_RPC_URL;
        if (key === 'POLYGON_RPC_URL') return process.env.POLYGON_RPC_URL;
        if (key === 'PRIVATE_KEY') return process.env.PRIVATE_KEY;
        // Allow other potential settings from process.env for flexibility
        return process.env[key];
      },
      getService: () => null, // Not expected to be used by these specific checkpoint tests
    } as unknown as IAgentRuntime;

    try {
      console.log(
        `Integration Test: Attempting to start PolygonRpcService with ETHEREUM_RPC_URL: ${process.env.ETHEREUM_RPC_URL}`
      );
      service = await PolygonRpcService.start(integrationRuntime);
      console.log('Integration Test: PolygonRpcService started successfully.');
    } catch (error) {
      console.error(
        'Integration Test: Failed to start PolygonRpcService for integration tests:',
        error
      );
      throw new Error(
        `Failed to start PolygonRpcService for integration tests: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }, TEST_TIMEOUT);

  it(
    'should fetch a valid and reasonably high last checkpointed L2 block number (Mainnet expectation)',
    async () => {
      if (!service) {
        throw new Error('Service not initialized for integration test (beforeAll failed?)');
      }

      const lastCheckpoint = await service.getLastCheckpointedL2Block();
      console.log(`Integration Test: Last Checkpointed L2 Block: ${lastCheckpoint}`);

      expect(typeof lastCheckpoint).toBe('bigint');
      expect(lastCheckpoint).toBeGreaterThan(KNOWN_HISTORICAL_CHECKPOINT_MAINNET);
    },
    TEST_TIMEOUT
  );

  it(
    'should correctly determine checkpoint status for various L2 blocks (Mainnet expectation)',
    async () => {
      if (!service) {
        throw new Error('Service not initialized for integration test (beforeAll failed?)');
      }

      const lastCheckpoint = await service.getLastCheckpointedL2Block();
      console.log(
        `Integration Test (isL2BlockCheckpointed): Last Checkpointed L2 Block: ${lastCheckpoint}`
      );

      // 1. Test a known historical block (should be checkpointed)
      const isOldBlockCheckpointed = await service.isL2BlockCheckpointed(
        KNOWN_HISTORICAL_CHECKPOINT_MAINNET
      );
      console.log(
        `Integration Test: Is L2 block ${KNOWN_HISTORICAL_CHECKPOINT_MAINNET} checkpointed? ${isOldBlockCheckpointed}`
      );
      expect(isOldBlockCheckpointed).toBe(true);

      // 2. Test the last known checkpointed block (should be true)
      const isLastBlockItselfCheckpointed = await service.isL2BlockCheckpointed(lastCheckpoint);
      console.log(
        `Integration Test: Is L2 block ${lastCheckpoint} (itself) checkpointed? ${isLastBlockItselfCheckpointed}`
      );
      expect(isLastBlockItselfCheckpointed).toBe(true);

      // 3. Test a block far in the future (should not be checkpointed)
      const futureBlock = lastCheckpoint + 10000000n;
      const isFutureBlockCheckpointed = await service.isL2BlockCheckpointed(futureBlock);
      console.log(
        `Integration Test: Is L2 block ${futureBlock} checkpointed? ${isFutureBlockCheckpointed}`
      );
      expect(isFutureBlockCheckpointed).toBe(false);
    },
    TEST_TIMEOUT
  );
}); 