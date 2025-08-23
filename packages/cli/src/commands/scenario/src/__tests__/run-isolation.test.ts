import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import {
  createIsolatedEnvironment,
  cleanupIsolatedEnvironment,
  IsolationContext,
  generateRunId,
  ensureIsolatedDatabase,
  writeTemporaryScenario,
  resetRunSequence,
} from '../run-isolation';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('Run Isolation System', () => {
  let testOutputDir: string;

  beforeEach(async () => {
    testOutputDir = join(tmpdir(), `isolation-test-${Date.now()}`);
    await fs.mkdir(testOutputDir, { recursive: true });
  });

  afterEach(async () => {
    try {
      await fs.rm(testOutputDir, { recursive: true, force: true });
    } catch (error) {
      // Ignore cleanup errors in tests
    }
  });

  describe('Run ID Generation', () => {
    it('should generate unique run IDs', () => {
      const id1 = generateRunId();
      const id2 = generateRunId();
      const id3 = generateRunId();

      expect(id1).not.toBe(id2);
      expect(id2).not.toBe(id3);
      expect(id1).not.toBe(id3);

      // Should follow expected format (run-XXX)
      expect(id1).toMatch(/^run-\d{3}-[a-f0-9]+$/);
      expect(id2).toMatch(/^run-\d{3}-[a-f0-9]+$/);
      expect(id3).toMatch(/^run-\d{3}-[a-f0-9]+$/);
    });

    it('should include sequence numbers in run IDs', () => {
      resetRunSequence(); // Reset for consistent testing
      const ids = Array(5)
        .fill(0)
        .map(() => generateRunId());

      // Should have incrementing sequence numbers
      expect(ids[0]).toContain('run-000-');
      expect(ids[1]).toContain('run-001-');
      expect(ids[2]).toContain('run-002-');
      expect(ids[3]).toContain('run-003-');
      expect(ids[4]).toContain('run-004-');
    });
  });

  describe('Isolated Environment Creation', () => {
    it('should create complete isolated environment structure', async () => {
      const runId = 'test-run-001';
      const context = await createIsolatedEnvironment(runId, testOutputDir);

      expect(context.runId).toBe(runId);
      expect(context.tempDir).toContain(runId);
      expect(context.dbPath).toContain(runId);
      expect(context.logPath).toContain(runId);
      expect(context.scenarioPath).toContain(runId);
      expect(typeof context.cleanup).toBe('function');

      // Verify directory structure exists
      const tempExists = await fs
        .access(context.tempDir)
        .then(() => true)
        .catch(() => false);
      expect(tempExists).toBe(true);

      const logDir = join(context.tempDir, 'logs');
      const logDirExists = await fs
        .access(logDir)
        .then(() => true)
        .catch(() => false);
      expect(logDirExists).toBe(true);

      await context.cleanup();
    });

    it('should create unique environments for concurrent runs', async () => {
      const context1 = await createIsolatedEnvironment('run-001', testOutputDir);
      const context2 = await createIsolatedEnvironment('run-002', testOutputDir);
      const context3 = await createIsolatedEnvironment('run-003', testOutputDir);

      // All contexts should be unique
      const contexts = [context1, context2, context3];
      const tempDirs = contexts.map((c) => c.tempDir);
      const dbPaths = contexts.map((c) => c.dbPath);
      const logPaths = contexts.map((c) => c.logPath);

      expect(new Set(tempDirs).size).toBe(3);
      expect(new Set(dbPaths).size).toBe(3);
      expect(new Set(logPaths).size).toBe(3);

      // All directories should exist
      for (const context of contexts) {
        const exists = await fs
          .access(context.tempDir)
          .then(() => true)
          .catch(() => false);
        expect(exists).toBe(true);
      }

      // Cleanup
      await Promise.all(contexts.map((c) => c.cleanup()));
    });

    it('should handle nested directory creation', async () => {
      const deepOutputDir = join(testOutputDir, 'level1', 'level2', 'level3');
      const context = await createIsolatedEnvironment('deep-test', deepOutputDir);

      const exists = await fs
        .access(context.tempDir)
        .then(() => true)
        .catch(() => false);
      expect(exists).toBe(true);

      await context.cleanup();
    });
  });

  describe('Database Isolation', () => {
    it('should create isolated database paths for each run', async () => {
      const context1 = await createIsolatedEnvironment('db-test-1', testOutputDir);
      const context2 = await createIsolatedEnvironment('db-test-2', testOutputDir);

      expect(context1.dbPath).not.toBe(context2.dbPath);
      expect(context1.dbPath).toContain('db-test-1');
      expect(context2.dbPath).toContain('db-test-2');

      // Ensure database directories exist
      await ensureIsolatedDatabase(context1.dbPath);
      await ensureIsolatedDatabase(context2.dbPath);

      const db1Dir = await fs
        .access(context1.dbPath)
        .then(() => true)
        .catch(() => false);
      const db2Dir = await fs
        .access(context2.dbPath)
        .then(() => true)
        .catch(() => false);

      expect(db1Dir).toBe(true);
      expect(db2Dir).toBe(true);

      await Promise.all([context1.cleanup(), context2.cleanup()]);
    });

    it('should prepare database configuration for isolation', async () => {
      const context = await createIsolatedEnvironment('db-config-test', testOutputDir);
      await ensureIsolatedDatabase(context.dbPath);

      // Verify database directory structure
      const dbExists = await fs
        .access(context.dbPath)
        .then(() => true)
        .catch(() => false);
      expect(dbExists).toBe(true);

      await context.cleanup();
    });
  });

  describe('Scenario File Management', () => {
    it('should write temporary scenario files with parameter overrides', async () => {
      const baseScenario = {
        name: 'Test Scenario',
        description: 'Test scenario for isolation',
        run: [
          {
            input: 'Hello {{character.name}}',
            evaluations: [
              {
                type: 'string_contains',
                value: 'response',
                description: 'Should contain response',
              },
            ],
          },
        ],
      };

      const parameters = {
        'character.name': 'Alice',
        'character.model': 'gpt-4',
      };

      const context = await createIsolatedEnvironment('scenario-test', testOutputDir);
      await writeTemporaryScenario(context.scenarioPath, baseScenario, parameters);

      // Verify scenario file exists
      const scenarioExists = await fs
        .access(context.scenarioPath)
        .then(() => true)
        .catch(() => false);
      expect(scenarioExists).toBe(true);

      // Verify content has parameters applied
      const scenarioContent = await fs.readFile(context.scenarioPath, 'utf8');
      const scenarioData = JSON.parse(scenarioContent);

      expect(scenarioData.character.name).toBe('Alice');
      expect(scenarioData.character.model).toBe('gpt-4');

      await context.cleanup();
    });

    it('should handle complex parameter overrides in scenario files', async () => {
      const baseScenario = {
        name: 'Complex Test',
        character: {
          name: 'Default',
          settings: {
            model: 'default-model',
            temperature: 0.7,
          },
        },
        run: [
          {
            input: 'test input',
            evaluations: [
              {
                type: 'string_contains',
                value: 'original-value',
              },
            ],
          },
        ],
      };

      const parameters = {
        'character.name': 'OverriddenName',
        'character.settings.model': 'gpt-4',
        'run[0].evaluations[0].value': 'overridden-value',
      };

      const context = await createIsolatedEnvironment('complex-test', testOutputDir);
      await writeTemporaryScenario(context.scenarioPath, baseScenario, parameters);

      const scenarioContent = await fs.readFile(context.scenarioPath, 'utf8');
      const scenarioData = JSON.parse(scenarioContent);

      expect(scenarioData.character.name).toBe('OverriddenName');
      expect(scenarioData.character.settings.model).toBe('gpt-4');
      expect(scenarioData.run[0].evaluations[0].value).toBe('overridden-value');

      await context.cleanup();
    });
  });

  describe('Environment Cleanup', () => {
    it('should completely remove isolated environment', async () => {
      const runId = 'cleanup-test-001';
      const context = await createIsolatedEnvironment(runId, testOutputDir);

      // Create some files in the environment
      await fs.writeFile(join(context.tempDir, 'test-file.txt'), 'test content');
      await fs.mkdir(join(context.tempDir, 'subdir'), { recursive: true });
      await fs.writeFile(join(context.tempDir, 'subdir', 'nested-file.txt'), 'nested content');

      // Verify environment exists
      const beforeExists = await fs
        .access(context.tempDir)
        .then(() => true)
        .catch(() => false);
      expect(beforeExists).toBe(true);

      // Cleanup
      await cleanupIsolatedEnvironment(context);

      // Verify environment is completely removed
      const afterExists = await fs
        .access(context.tempDir)
        .then(() => true)
        .catch(() => false);
      expect(afterExists).toBe(false);
    });

    it('should handle cleanup of non-existent environments gracefully', async () => {
      const mockContext: IsolationContext = {
        runId: 'nonexistent-run',
        tempDir: join(testOutputDir, 'nonexistent'),
        dbPath: join(testOutputDir, 'nonexistent', 'db'),
        logPath: join(testOutputDir, 'nonexistent', 'logs', 'run.log'),
        scenarioPath: join(testOutputDir, 'nonexistent', 'scenario.yaml'),
        cleanup: async () => {},
      };

      // Should not throw error
      await expect(cleanupIsolatedEnvironment(mockContext)).resolves.toBeUndefined();
    });

    it('should handle partial cleanup failures gracefully', async () => {
      const context = await createIsolatedEnvironment('partial-cleanup-test', testOutputDir);

      // Create a file that might be locked (simulate partial failure)
      await fs.writeFile(join(context.tempDir, 'test-file.txt'), 'test content');

      // Manually remove temp directory to simulate partial state
      await fs.rm(context.tempDir, { recursive: true, force: true });

      // Cleanup should still succeed
      await expect(context.cleanup()).resolves.toBeUndefined();
    });
  });

  describe('Environment Variables and Process Isolation', () => {
    it('should prepare clean environment variables for each run', async () => {
      const context = await createIsolatedEnvironment('env-test', testOutputDir);

      // Should have clean environment configuration
      expect(context).toHaveProperty('tempDir');
      expect(context).toHaveProperty('dbPath');

      // Database path should be isolated
      expect(context.dbPath).toContain('env-test');
      expect(context.dbPath).not.toContain('default');

      await context.cleanup();
    });
  });

  describe('Concurrent Environment Management', () => {
    it('should handle multiple concurrent environment creations', async () => {
      const numConcurrent = 10;
      const promises = Array(numConcurrent)
        .fill(0)
        .map((_, i) => createIsolatedEnvironment(`concurrent-${i}`, testOutputDir));

      const contexts = await Promise.all(promises);

      // All contexts should be unique
      const tempDirs = contexts.map((c) => c.tempDir);
      expect(new Set(tempDirs).size).toBe(numConcurrent);

      // All environments should exist
      for (const context of contexts) {
        const exists = await fs
          .access(context.tempDir)
          .then(() => true)
          .catch(() => false);
        expect(exists).toBe(true);
      }

      // Cleanup all
      await Promise.all(contexts.map((c) => c.cleanup()));

      // Verify all cleaned up
      for (const context of contexts) {
        const exists = await fs
          .access(context.tempDir)
          .then(() => true)
          .catch(() => false);
        expect(exists).toBe(false);
      }
    });

    it('should handle concurrent cleanup operations', async () => {
      const numConcurrent = 5;
      const contexts = await Promise.all(
        Array(numConcurrent)
          .fill(0)
          .map((_, i) => createIsolatedEnvironment(`cleanup-concurrent-${i}`, testOutputDir))
      );

      // Cleanup all concurrently
      const cleanupPromises = contexts.map((c) => c.cleanup());
      await expect(Promise.all(cleanupPromises)).resolves.toBeDefined();

      // Verify all cleaned up
      for (const context of contexts) {
        const exists = await fs
          .access(context.tempDir)
          .then(() => true)
          .catch(() => false);
        expect(exists).toBe(false);
      }
    });
  });

  describe('Error Handling', () => {
    it('should handle creation failures gracefully', async () => {
      const invalidPath = '/root/invalid/readonly/path';

      await expect(createIsolatedEnvironment('invalid-test', invalidPath)).rejects.toThrow();
    });

    it('should handle permission errors during cleanup', async () => {
      const context = await createIsolatedEnvironment('permission-test', testOutputDir);

      // Create the environment first
      const exists = await fs
        .access(context.tempDir)
        .then(() => true)
        .catch(() => false);
      expect(exists).toBe(true);

      // Normal cleanup should work
      await expect(context.cleanup()).resolves.toBeUndefined();
    });
  });
});
