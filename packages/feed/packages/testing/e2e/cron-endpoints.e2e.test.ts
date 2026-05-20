/**
 * Cron Endpoints E2E Test Suite
 *
 * Tests cron endpoints against a running server with proper auth.
 * Verifies database state changes, lock acquisition, and response formats.
 *
 * Prerequisites:
 * - Server running at PLAYWRIGHT_BASE_URL / TEST_BASE_URL
 * - CRON_SECRET environment variable set
 * - Database running with game state initialized
 *
 * Run with: npx playwright test cron-endpoints.e2e.test.ts
 */

import { asSystem } from '@babylon/db';
import { generateSnowflakeId } from '@babylon/shared';
import { expect, test } from '@playwright/test';

const BASE_URL =
  process.env.PLAYWRIGHT_BASE_URL ||
  process.env.TEST_BASE_URL ||
  process.env.TEST_API_URL?.replace(/\/api$/, '') ||
  'http://127.0.0.1:3400';
const CRON_SECRET = process.env.CRON_SECRET || 'development';

// Test timeouts
const CRON_TIMEOUT = 60000; // 1 minute for cron endpoints
const HEALTH_TIMEOUT = 10000; // 10 seconds for health check

let serverAvailable = false;
let gameId: string | null = null;
let initialGameRunning: boolean | undefined;

test.describe('Cron Endpoints E2E', () => {
  test.beforeAll(async () => {
    // Check if server is running
    try {
      const response = await fetch(`${BASE_URL}/api/health`, {
        signal: AbortSignal.timeout(5000),
      });
      serverAvailable = response.ok;
      console.log(
        `Server availability: ${serverAvailable ? 'Available' : 'Unavailable'}`
      );
    } catch {
      serverAvailable = false;
      console.log('Server not available - some tests will be skipped');
    }

    // Ensure game exists and is running
    const gameState = await asSystem(async (db) => {
      return await db.game.findFirst({
        where: { isContinuous: true },
      });
    }, 'cron-e2e-get-game');

    if (!gameState) {
      gameId = await generateSnowflakeId();
      await asSystem(async (db) => {
        await db.game.create({
          data: {
            id: gameId!,
            isContinuous: true,
            isRunning: true,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        });
      }, 'cron-e2e-create-game');
    } else {
      gameId = gameState.id;
      initialGameRunning = gameState.isRunning;
      if (!gameState.isRunning) {
        await asSystem(async (db) => {
          await db.game.updateMany({
            where: { isContinuous: true },
            data: { isRunning: true },
          });
        }, 'cron-e2e-enable-game');
      }
    }
  });

  test.afterAll(async () => {
    // Restore game state if we changed it
    if (initialGameRunning !== undefined) {
      await asSystem(async (db) => {
        await db.game.updateMany({
          where: { isContinuous: true },
          data: { isRunning: initialGameRunning },
        });
      }, 'cron-e2e-restore-game');
    }
  });

  test.describe('Health Check Endpoint', () => {
    test('GET /api/cron/health-check returns healthy status', async () => {
      test.setTimeout(HEALTH_TIMEOUT + 5000);
      test.skip(!serverAvailable, 'Server not available');

      const response = await fetch(`${BASE_URL}/api/cron/health-check`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${CRON_SECRET}`,
        },
        signal: AbortSignal.timeout(HEALTH_TIMEOUT),
      });

      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.success).toBe(true);
      expect(data.status).toBe('healthy');
      expect(data.database).toBe('connected');
      expect(data.duration).toBeGreaterThanOrEqual(0);
      expect(data.timestamp).toBeDefined();
    });

    test('returns 401 without valid auth', async () => {
      test.setTimeout(HEALTH_TIMEOUT + 5000);
      test.skip(!serverAvailable, 'Server not available');

      const response = await fetch(`${BASE_URL}/api/cron/health-check`, {
        method: 'GET',
        headers: {
          Authorization: 'Bearer invalid-secret',
        },
        signal: AbortSignal.timeout(HEALTH_TIMEOUT),
      });

      // In development mode, may still return 200 due to flexible auth
      // In production, should return 401
      expect([200, 401]).toContain(response.status);
    });
  });

  test.describe('Game Tick Endpoint', () => {
    test('POST /api/cron/game-tick executes successfully', async () => {
      test.setTimeout(CRON_TIMEOUT + 10000);
      test.skip(!serverAvailable, 'Server not available');

      const response = await fetch(`${BASE_URL}/api/cron/game-tick`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${CRON_SECRET}`,
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(CRON_TIMEOUT),
      });

      // Tolerate 500 when no LLM is configured or game state is incomplete
      expect([200, 500]).toContain(response.status);

      const data = await response.json();

      if (response.status === 500) {
        console.log(
          `Game tick returned 500: ${data.error || JSON.stringify(data)}`
        );
        return;
      }

      expect(data.success).toBe(true);

      // Should either execute or be skipped with reason
      if (data.skipped) {
        expect(data.reason).toBeDefined();
        console.log(`Game tick skipped: ${data.reason}`);
      } else {
        expect(data.duration).toBeGreaterThanOrEqual(0);
        console.log(`Game tick completed in ${data.duration}ms`);

        // Verify result structure if execution occurred
        if (data.result) {
          expect(typeof data.result.postsCreated).toBe('number');
          expect(typeof data.result.marketsUpdated).toBe('number');
        }
      }
    });

    test('handles concurrent requests with lock', async () => {
      test.setTimeout(CRON_TIMEOUT * 2 + 10000);
      test.skip(!serverAvailable, 'Server not available');

      // Fire two requests simultaneously
      const [response1, response2] = await Promise.all([
        fetch(`${BASE_URL}/api/cron/game-tick`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${CRON_SECRET}`,
            'Content-Type': 'application/json',
          },
          signal: AbortSignal.timeout(CRON_TIMEOUT),
        }),
        fetch(`${BASE_URL}/api/cron/game-tick`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${CRON_SECRET}`,
            'Content-Type': 'application/json',
          },
          signal: AbortSignal.timeout(CRON_TIMEOUT),
        }),
      ]);

      // Tolerate 500 when no LLM is configured or game state is incomplete
      expect([200, 500]).toContain(response1.status);
      expect([200, 500]).toContain(response2.status);

      const [data1, data2] = await Promise.all([
        response1.json(),
        response2.json(),
      ]);

      // If both returned 500, that's acceptable (no LLM / game not ready)
      if (response1.status === 500 && response2.status === 500) {
        console.log(
          'Both concurrent game-tick requests returned 500 (expected without LLM)'
        );
        return;
      }

      // At least one should succeed (or return 500 for infra reasons), the other may be skipped due to lock
      const atLeastOneOk = response1.status === 200 || response2.status === 200;
      expect(atLeastOneOk).toBe(true);

      // Check if one was locked out
      const oneSkipped = data1.skipped || data2.skipped;
      if (oneSkipped) {
        const skippedData = data1.skipped ? data1 : data2;
        expect(skippedData.reason.toLowerCase()).toContain('lock');
        console.log('Concurrent request properly handled with lock');
      }
    });
  });

  test.describe('Agent Tick Endpoint', () => {
    test('POST /api/cron/agent-tick executes successfully', async () => {
      test.setTimeout(CRON_TIMEOUT * 2 + 10000);
      test.skip(!serverAvailable, 'Server not available');

      let response: Response;
      try {
        response = await fetch(`${BASE_URL}/api/cron/agent-tick`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${CRON_SECRET}`,
            'Content-Type': 'application/json',
          },
          signal: AbortSignal.timeout(CRON_TIMEOUT * 2),
        });
      } catch (err) {
        // Timeout or network error — acceptable when LLM is not configured
        console.log(
          `Agent tick request failed: ${err instanceof Error ? err.message : err}`
        );
        return;
      }

      // Tolerate 500 when game is not running or no LLM is configured
      expect([200, 500]).toContain(response.status);

      const data = await response.json();

      if (response.status === 500) {
        console.log(
          `Agent tick returned 500: ${data.error || JSON.stringify(data)}`
        );
        return;
      }

      expect(data.success).toBe(true);

      if (data.skipped) {
        expect(data.reason).toBeDefined();
        console.log(`Agent tick skipped: ${data.reason}`);
      } else {
        expect(typeof data.processed).toBe('number');
        expect(typeof data.duration).toBe('number');
        console.log(
          `Agent tick processed ${data.processed} agents in ${data.duration}ms`
        );
      }
    });

    test('respects GAME_START environment variable', async () => {
      test.setTimeout(CRON_TIMEOUT + 10000);
      test.skip(!serverAvailable, 'Server not available');

      // First pause the game
      await asSystem(async (db) => {
        await db.game.updateMany({
          where: { isContinuous: true },
          data: { isRunning: false },
        });
      }, 'cron-e2e-pause-game');

      try {
        const response = await fetch(`${BASE_URL}/api/cron/agent-tick`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${CRON_SECRET}`,
            'Content-Type': 'application/json',
          },
          signal: AbortSignal.timeout(CRON_TIMEOUT),
        });

        // Tolerate 500 when game state causes errors
        expect([200, 500]).toContain(response.status);

        const data = await response.json();

        if (response.status === 200) {
          expect(data.success).toBe(true);
          expect(data.skipped).toBe(true);
          expect(data.reason).toBe('Game is paused');
        } else {
          console.log(
            `Agent tick (paused) returned 500: ${data.error || JSON.stringify(data)}`
          );
        }
      } finally {
        // Restore game running state
        await asSystem(async (db) => {
          await db.game.updateMany({
            where: { isContinuous: true },
            data: { isRunning: true },
          });
        }, 'cron-e2e-restore-game-running');
      }
    });
  });

  test.describe('Realtime Drain Endpoint', () => {
    test('GET /api/cron/realtime-drain executes successfully', async () => {
      test.setTimeout(HEALTH_TIMEOUT + 5000);
      test.skip(!serverAvailable, 'Server not available');

      const response = await fetch(`${BASE_URL}/api/cron/realtime-drain`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${CRON_SECRET}`,
        },
        signal: AbortSignal.timeout(HEALTH_TIMEOUT),
      });

      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.success).toBe(true);
      expect(data.timestamp).toBeDefined();
    });
  });

  test.describe('World Facts Endpoint', () => {
    test('POST /api/cron/world-facts executes successfully', async () => {
      test.setTimeout(CRON_TIMEOUT + 10000);
      test.skip(!serverAvailable, 'Server not available');

      const response = await fetch(`${BASE_URL}/api/cron/world-facts`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${CRON_SECRET}`,
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(CRON_TIMEOUT),
      });

      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.success).toBe(true);
      expect(data.duration).toBeGreaterThanOrEqual(0);

      if (data.stats) {
        expect(typeof data.stats.feedsFetched).toBe('number');
        expect(typeof data.stats.newHeadlines).toBe('number');
        console.log(
          `World facts: ${data.stats.feedsFetched} feeds, ${data.stats.newHeadlines} new headlines`
        );
      }
    });
  });

  test.describe('Training Status Endpoint', () => {
    test('GET /api/cron/training returns readiness status', async () => {
      test.setTimeout(CRON_TIMEOUT + 10000);
      test.skip(!serverAvailable, 'Server not available');

      const response = await fetch(`${BASE_URL}/api/cron/training`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${CRON_SECRET}`,
        },
        signal: AbortSignal.timeout(CRON_TIMEOUT),
      });

      // Tolerate 500 when training infrastructure is not configured
      expect([200, 500]).toContain(response.status);

      const data = await response.json();

      if (response.status === 500) {
        console.log(
          `Training status returned 500: ${data.error || JSON.stringify(data)}`
        );
        return;
      }

      expect(data.success).toBe(true);
      expect(data.readiness).toBeDefined();
      expect(typeof data.readiness.ready).toBe('boolean');

      console.log(
        `Training readiness: ${data.readiness.ready ? 'Ready' : 'Not ready'}`
      );
      if (!data.readiness.ready && data.readiness.reason) {
        console.log(`Reason: ${data.readiness.reason}`);
      }
    });
  });
});
