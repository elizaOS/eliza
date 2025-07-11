import { type IAgentRuntime, elizaLogger } from '@elizaos/core';
import { StorageService } from '../../services/StorageService';
import { WalletService } from '../../services/WalletService';

export class StorageServiceTestSuite {
  name = 'storage-service-integration';
  description = 'Integration tests for NEAR storage service';

  tests = [
    {
      name: 'Storage service initialization',
      fn: async (runtime: IAgentRuntime) => {
        const storageService = runtime.getService('near-storage' as any) as StorageService;
        const walletService = runtime.getService('near-wallet' as any) as WalletService;

        if (!storageService || !walletService) {
          throw new Error('Required services not available');
        }

        elizaLogger.info('✓ Storage service initialized with wallet service');
      },
    },
    {
      name: 'Store and retrieve data',
      fn: async (runtime: IAgentRuntime) => {
        const storageService = runtime.getService('near-storage' as any) as StorageService;
        if (!storageService) {
          throw new Error('Storage service not available');
        }

        const key = `test-key-${Date.now()}`;
        const value = { message: 'Hello NEAR!', timestamp: Date.now() };

        // Store data
        await storageService.set(key, value);
        elizaLogger.info(`✓ Stored data with key: ${key}`);

        // Wait a bit for transaction to be processed
        await new Promise((resolve) => setTimeout(resolve, 2000));

        // Retrieve data
        const retrieved = await storageService.get(key);
        if (!retrieved) {
          throw new Error('Failed to retrieve stored data');
        }

        if (JSON.stringify(retrieved) !== JSON.stringify(value)) {
          throw new Error(
            `Retrieved data doesn't match: ${JSON.stringify(retrieved)} vs ${JSON.stringify(value)}`
          );
        }

        elizaLogger.info('✓ Retrieved data matches stored value');
      },
    },
    {
      name: 'Handle non-existent keys',
      fn: async (runtime: IAgentRuntime) => {
        const storageService = runtime.getService('near-storage' as any) as StorageService;
        if (!storageService) {
          throw new Error('Storage service not available');
        }

        const result = await storageService.get(`non-existent-key-${Date.now()}`);
        if (result !== null) {
          throw new Error('Expected null for non-existent key');
        }

        elizaLogger.info('✓ Non-existent key returns null');
      },
    },
    {
      name: 'List stored keys',
      fn: async (runtime: IAgentRuntime) => {
        const storageService = runtime.getService('near-storage' as any) as StorageService;
        if (!storageService) {
          throw new Error('Storage service not available');
        }

        const key1 = `test-list-1-${Date.now()}`;
        const key2 = `test-list-2-${Date.now()}`;

        await storageService.set(key1, 'value1');
        await storageService.set(key2, 'value2');

        // Wait for transactions
        await new Promise((resolve) => setTimeout(resolve, 3000));

        const keys = await storageService.listKeys();
        if (!keys.includes(key1) || !keys.includes(key2)) {
          throw new Error(`Keys not found in list: ${keys.join(', ')}`);
        }

        elizaLogger.info(`✓ Listed keys include stored items: ${keys.length} total`);
      },
    },
    {
      name: 'Delete data',
      fn: async (runtime: IAgentRuntime) => {
        const storageService = runtime.getService('near-storage' as any) as StorageService;
        if (!storageService) {
          throw new Error('Storage service not available');
        }

        const key = `test-delete-${Date.now()}`;
        await storageService.set(key, 'to-be-deleted');

        // Wait for transaction
        await new Promise((resolve) => setTimeout(resolve, 2000));

        // Verify it exists
        let value = await storageService.get(key);
        if (value !== 'to-be-deleted') {
          throw new Error('Failed to store value before deletion');
        }

        // Delete it
        await storageService.delete(key);

        // Wait for deletion
        await new Promise((resolve) => setTimeout(resolve, 2000));

        // Verify it's gone
        value = await storageService.get(key);
        if (value !== null) {
          throw new Error('Value still exists after deletion');
        }

        elizaLogger.info('✓ Successfully deleted stored data');
      },
    },
    {
      name: 'Batch operations',
      fn: async (runtime: IAgentRuntime) => {
        const storageService = runtime.getService('near-storage' as any) as StorageService;
        if (!storageService) {
          throw new Error('Storage service not available');
        }

        const entries = [
          { key: `batch-1-${Date.now()}`, value: 'value1' },
          { key: `batch-2-${Date.now()}`, value: 'value2' },
          { key: `batch-3-${Date.now()}`, value: 'value3' },
        ];

        await storageService.setBatch(entries);

        // Wait for batch transaction
        await new Promise((resolve) => setTimeout(resolve, 3000));

        // Verify all were stored
        for (const entry of entries) {
          const value = await storageService.get(entry.key);
          if (value !== entry.value) {
            throw new Error(`Batch entry ${entry.key} not stored correctly`);
          }
        }

        elizaLogger.info('✓ Batch operations successful');
      },
    },
    {
      name: 'Complex data types',
      fn: async (runtime: IAgentRuntime) => {
        const storageService = runtime.getService('near-storage' as any) as StorageService;
        if (!storageService) {
          throw new Error('Storage service not available');
        }

        const complexData = {
          string: 'hello',
          number: 42,
          boolean: true,
          array: [1, 2, 3],
          nested: {
            deep: {
              value: 'found me!',
            },
          },
          date: new Date().toISOString(),
        };

        const key = `complex-${Date.now()}`;
        await storageService.set(key, complexData);

        // Wait for transaction
        await new Promise((resolve) => setTimeout(resolve, 2000));

        const retrieved = await storageService.get(key);
        if (!retrieved || JSON.stringify(retrieved) !== JSON.stringify(complexData)) {
          throw new Error('Complex data not stored/retrieved correctly');
        }

        elizaLogger.info('✓ Complex data types handled correctly');
      },
    },
  ];
}

export default new StorageServiceTestSuite();
