import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { EnvFileService } from '../env-file.service';

// Create mocks
const mockFs = {
  promises: {
    readFile: mock(() => Promise.resolve('')),
    writeFile: mock(() => Promise.resolve()),
    mkdir: mock(() => Promise.resolve()),
    copyFile: mock(() => Promise.resolve()),
  },
  existsSync: mock(() => true),
};

const mockLogger = {
  info: mock(() => {}),
  error: mock(() => {}),
};

// Mock the modules
mock.module('node:fs', () => mockFs);
mock.module('@elizaos/core', () => ({ logger: mockLogger }));
mock.module('@/src/utils', () => ({
  UserEnvironment: {
    getInstanceInfo: mock(() =>
      Promise.resolve({
        paths: {
          envFilePath: '/test/.env',
        },
      })
    ),
  },
}));

describe('EnvFileService', () => {
  let service: EnvFileService;

  beforeEach(async () => {
    service = new EnvFileService('/test/.env');
    // Reset all mocks
    Object.values(mockFs.promises).forEach((fn) => fn.mockClear?.());
    mockFs.existsSync.mockClear?.();
    mockLogger.info.mockClear?.();
    mockLogger.error.mockClear?.();
  });

  describe('write method', () => {
    it('should not mutate the input vars object', async () => {
      const mockExistingContent = 'EXISTING_KEY=existing_value\n';
      mockFs.existsSync.mockReturnValue(true);
      mockFs.promises.readFile.mockResolvedValue(mockExistingContent);
      mockFs.promises.writeFile.mockResolvedValue(undefined);

      const originalVars = {
        EXISTING_KEY: 'new_value',
        NEW_KEY: 'new_key_value',
      };

      // Create a copy to verify the original is not mutated
      const varsCopy = { ...originalVars };

      await service.write(originalVars, { preserveComments: true });

      // Verify the original object was not mutated
      expect(originalVars).toEqual(varsCopy);
      expect(Object.keys(originalVars)).toHaveLength(2);
      expect(originalVars.EXISTING_KEY).toBe('new_value');
      expect(originalVars.NEW_KEY).toBe('new_key_value');
    });

    it('should handle objects with overridden hasOwnProperty', async () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.promises.readFile.mockResolvedValue('');
      mockFs.promises.writeFile.mockResolvedValue(undefined);

      // Create an object with overridden hasOwnProperty
      const maliciousVars = Object.create(null);
      maliciousVars.TEST_KEY = 'test_value';
      maliciousVars.hasOwnProperty = () => {
        throw new Error('hasOwnProperty was called directly!');
      };

      // This should not throw an error
      let error: Error | null = null;
      try {
        await service.write(maliciousVars);
      } catch (e) {
        error = e as Error;
      }
      expect(error).toBeNull();

      // Verify the file was written correctly
      expect(mockFs.promises.writeFile).toHaveBeenCalled();
      const calls = mockFs.promises.writeFile.mock.calls as any[];
      expect(calls.length).toBe(1);
      expect(calls[0]).toEqual(['/test/.env', 'TEST_KEY=test_value\n', 'utf-8']);
    });
  });

  describe('exists method', () => {
    it('should handle objects with overridden hasOwnProperty', async () => {
      // Mock read to return an object with overridden hasOwnProperty
      const mockContent = 'TEST_KEY=test_value\nhasOwnProperty=malicious\n';
      mockFs.existsSync.mockReturnValue(true);
      mockFs.promises.readFile.mockResolvedValue(mockContent);

      // This should not throw an error and should work correctly
      const existsTestKey = await service.exists('TEST_KEY');
      const existsNonExistent = await service.exists('NON_EXISTENT');
      const existsHasOwnProperty = await service.exists('hasOwnProperty');

      expect(existsTestKey).toBe(true);
      expect(existsNonExistent).toBe(false);
      expect(existsHasOwnProperty).toBe(true);
    });

    it('should handle null prototype objects', async () => {
      // Override the read method to return an object with null prototype
      const originalRead = service.read;
      service.read = mock(() =>
        Promise.resolve(
          Object.assign(Object.create(null), {
            TEST_KEY: 'test_value',
          })
        )
      );

      // This should not throw an error
      const exists = await service.exists('TEST_KEY');
      expect(exists).toBe(true);

      const notExists = await service.exists('NON_EXISTENT');
      expect(notExists).toBe(false);

      // Restore original method
      service.read = originalRead;
    });
  });
});
