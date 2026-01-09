import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { stringToUuid } from '@elizaos/core';
import { PostgresConnectionManager } from '../../../pg/manager';

// Generate unique UUIDs using stringToUuid with random strings
const generateUuid = () => stringToUuid(`test-${Date.now()}-${Math.random()}`);

/**
 * Integration tests for PostgresConnectionManager.withIsolationContext()
 *
 * These tests verify that withIsolationContext correctly executes SET LOCAL
 * without parameterization errors. This is a regression test for the bug
 * where sql`SET LOCAL app.entity_id = ${entityId}` produced a parameterized
 * query that PostgreSQL rejected.
 *
 * Requires: POSTGRES_URL environment variable and ENABLE_DATA_ISOLATION=true
 */
describe.skipIf(!process.env.POSTGRES_URL)(
  'PostgresConnectionManager.withIsolationContext Integration',
  () => {
    let manager: PostgresConnectionManager;
    const serverId = generateUuid();
    const testEntityId = generateUuid();

    const POSTGRES_URL =
      process.env.POSTGRES_URL || 'postgresql://eliza_test:test123@localhost:5432/eliza_test';

    beforeAll(async () => {
      manager = new PostgresConnectionManager(POSTGRES_URL, serverId);

      // Verify connection works
      const connected = await manager.testConnection();
      expect(connected).toBe(true);
    });

    afterAll(async () => {
      await manager?.close();
    });

    describe('when ENABLE_DATA_ISOLATION=false', () => {
      const originalEnv = process.env.ENABLE_DATA_ISOLATION;

      beforeAll(() => {
        delete process.env.ENABLE_DATA_ISOLATION;
      });

      afterAll(() => {
        if (originalEnv !== undefined) {
          process.env.ENABLE_DATA_ISOLATION = originalEnv;
        }
      });

      it('should execute callback without SET LOCAL', async () => {
        const result = await manager.withIsolationContext(testEntityId as any, async (_tx) => {
          // Just verify the callback executes successfully
          return 'success';
        });

        expect(result).toBe('success');
      });

      it('should work with null entityId', async () => {
        const result = await manager.withIsolationContext(null, async (tx) => {
          return 'null-entity-success';
        });

        expect(result).toBe('null-entity-success');
      });
    });

    describe('when ENABLE_DATA_ISOLATION=true', () => {
      const originalEnv = process.env.ENABLE_DATA_ISOLATION;

      beforeAll(() => {
        process.env.ENABLE_DATA_ISOLATION = 'true';
      });

      afterAll(() => {
        if (originalEnv !== undefined) {
          process.env.ENABLE_DATA_ISOLATION = originalEnv;
        } else {
          delete process.env.ENABLE_DATA_ISOLATION;
        }
      });

      it('should execute SET LOCAL without parameterization error (regression test)', async () => {
        // This is the main regression test for the bug:
        // Before the fix, this would throw:
        // "error: syntax error at or near "$1"" because PostgreSQL
        // doesn't support parameterized SET commands.

        // Note: This may still fail if app.entity_id GUC is not configured,
        // but it should NOT fail with "syntax error at or near $1"
        try {
          const result = await manager.withIsolationContext(testEntityId as any, async (tx) => {
            return 'isolation-enabled-success';
          });

          expect(result).toBe('isolation-enabled-success');
        } catch (error: any) {
          // If it fails, it should NOT be the parameterization error
          // It might fail because app.entity_id GUC doesn't exist, which is fine
          // The important thing is it's NOT the $1 syntax error
          expect(error.message).not.toContain('syntax error at or near "$1"');

          // If the error is about unrecognized configuration parameter,
          // that's okay - it means SET LOCAL was called correctly
          if (error.message.includes('unrecognized configuration parameter')) {
            console.log(
              '[withIsolationContext Test] SET LOCAL called correctly, but app.entity_id not configured'
            );
            return; // Test passes - SET LOCAL syntax was correct
          }

          // Re-throw unexpected errors
          throw error;
        }
      });

      it('should skip SET LOCAL when entityId is null', async () => {
        const result = await manager.withIsolationContext(null, async (tx) => {
          return 'null-entity-with-isolation';
        });

        expect(result).toBe('null-entity-with-isolation');
      });

      it('should properly quote UUID value in SET LOCAL', async () => {
        // Test with various UUID formats to ensure proper quoting
        const uuids = [
          generateUuid(),
          '00000000-0000-0000-0000-000000000000',
          'ffffffff-ffff-ffff-ffff-ffffffffffff',
        ];

        for (const uuid of uuids) {
          try {
            await manager.withIsolationContext(uuid as any, async (tx) => {
              return 'uuid-test';
            });
          } catch (error: any) {
            // Should not be parameterization error
            expect(error.message).not.toContain('syntax error at or near "$1"');

            // Unrecognized config param is okay
            if (!error.message.includes('unrecognized configuration parameter')) {
              throw error;
            }
          }
        }
      });
    });
  }
);
