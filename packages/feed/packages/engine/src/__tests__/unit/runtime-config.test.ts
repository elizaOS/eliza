/**
 * Runtime Configuration Unit Tests
 *
 * Tests for centralized runtime configuration utilities.
 */

import { describe, expect, test } from 'bun:test';
import {
  BLOCKCHAIN_CONFIG,
  createDeadline,
  ENV_CONFIG,
  GAME_TICK_CONFIG,
  getTimeRemaining,
  hasTimeRemaining,
  MARKET_DECISION_CONFIG,
  RUNTIME_CONFIG,
  WORLD_FACTS_CONFIG,
} from '../../config/runtime-config';

describe('Runtime Configuration', () => {
  describe('GAME_TICK_CONFIG', () => {
    test('has budgetMs as a positive number', () => {
      expect(typeof GAME_TICK_CONFIG.budgetMs).toBe('number');
      expect(GAME_TICK_CONFIG.budgetMs).toBeGreaterThan(0);
    });

    test('has criticalOpsReserveMs defined', () => {
      expect(typeof GAME_TICK_CONFIG.criticalOpsReserveMs).toBe('number');
      expect(GAME_TICK_CONFIG.criticalOpsReserveMs).toBeGreaterThan(0);
    });

    test('getContentDeadline returns deadline before budget end', () => {
      const startedAt = Date.now();
      const contentDeadline = GAME_TICK_CONFIG.getContentDeadline(startedAt);
      const fullDeadline = GAME_TICK_CONFIG.getDeadline(startedAt);

      expect(contentDeadline).toBeLessThan(fullDeadline);
      expect(fullDeadline - contentDeadline).toBe(
        GAME_TICK_CONFIG.criticalOpsReserveMs
      );
    });

    test('getDeadline returns startedAt + budgetMs', () => {
      const startedAt = Date.now();
      const deadline = GAME_TICK_CONFIG.getDeadline(startedAt);

      expect(deadline).toBe(startedAt + GAME_TICK_CONFIG.budgetMs);
    });
  });

  describe('MARKET_DECISION_CONFIG', () => {
    test('has model defined as string', () => {
      expect(typeof MARKET_DECISION_CONFIG.model).toBe('string');
      expect(MARKET_DECISION_CONFIG.model.length).toBeGreaterThan(0);
    });

    test('has maxOutputTokens as positive number', () => {
      expect(typeof MARKET_DECISION_CONFIG.maxOutputTokens).toBe('number');
      expect(MARKET_DECISION_CONFIG.maxOutputTokens).toBeGreaterThan(0);
    });

    test('has strictValidation as boolean', () => {
      expect(typeof MARKET_DECISION_CONFIG.strictValidation).toBe('boolean');
    });
  });

  describe('WORLD_FACTS_CONFIG', () => {
    test('has updateIntervalHours as positive number', () => {
      expect(typeof WORLD_FACTS_CONFIG.updateIntervalHours).toBe('number');
      expect(WORLD_FACTS_CONFIG.updateIntervalHours).toBeGreaterThan(0);
    });

    test('updateIntervalMs equals hours * 3600000', () => {
      expect(WORLD_FACTS_CONFIG.updateIntervalMs).toBe(
        WORLD_FACTS_CONFIG.updateIntervalHours * 3600000
      );
    });

    test('lockDurationMs equals minutes * 60000', () => {
      expect(WORLD_FACTS_CONFIG.lockDurationMs).toBe(
        WORLD_FACTS_CONFIG.lockDurationMinutes * 60000
      );
    });
  });

  describe('BLOCKCHAIN_CONFIG', () => {
    test('isConfigured returns boolean', () => {
      expect(typeof BLOCKCHAIN_CONFIG.isConfigured()).toBe('boolean');
    });
  });

  describe('ENV_CONFIG', () => {
    test('has nodeEnv defined', () => {
      expect(typeof ENV_CONFIG.nodeEnv).toBe('string');
    });

    test('isProduction, isTest, isDevelopment are booleans', () => {
      expect(typeof ENV_CONFIG.isProduction).toBe('boolean');
      expect(typeof ENV_CONFIG.isTest).toBe('boolean');
      expect(typeof ENV_CONFIG.isDevelopment).toBe('boolean');
    });

    test('at least one environment flag is true', () => {
      const anyEnv =
        ENV_CONFIG.isProduction ||
        ENV_CONFIG.isTest ||
        ENV_CONFIG.isDevelopment;
      expect(anyEnv).toBe(true);
    });
  });

  describe('hasTimeRemaining', () => {
    test('returns true when deadline is in the future', () => {
      const deadline = Date.now() + 10000;
      expect(hasTimeRemaining(deadline)).toBe(true);
    });

    test('returns false when deadline is in the past', () => {
      const deadline = Date.now() - 1000;
      expect(hasTimeRemaining(deadline)).toBe(false);
    });

    test('returns false when deadline equals now', async () => {
      // Use a manual approach to test boundary: set deadline slightly in the past
      // to ensure deterministic behavior without race conditions
      const now = Date.now();
      // When deadline === now, Date.now() >= deadline, so hasTimeRemaining returns false
      // We simulate this by checking immediately after setting
      const deadline = now;
      // Small delay to ensure Date.now() has advanced past the deadline
      await new Promise((resolve) => setTimeout(resolve, 1));
      expect(hasTimeRemaining(deadline)).toBe(false);
    });
  });

  describe('getTimeRemaining', () => {
    test('returns positive value for future deadline', () => {
      const deadline = Date.now() + 5000;
      const remaining = getTimeRemaining(deadline);
      expect(remaining).toBeGreaterThan(0);
      expect(remaining).toBeLessThanOrEqual(5000);
    });

    test('returns 0 for past deadline', () => {
      const deadline = Date.now() - 1000;
      expect(getTimeRemaining(deadline)).toBe(0);
    });
  });

  describe('createDeadline', () => {
    test('returns future timestamp', () => {
      const now = Date.now();
      const deadline = createDeadline(5000);
      expect(deadline).toBeGreaterThan(now);
      expect(deadline).toBeLessThanOrEqual(now + 5100); // Allow small timing variance
    });

    test('deadline is approximately budgetMs in the future', () => {
      const budgetMs = 10000;
      const before = Date.now();
      const deadline = createDeadline(budgetMs);
      const after = Date.now();

      expect(deadline).toBeGreaterThanOrEqual(before + budgetMs);
      expect(deadline).toBeLessThanOrEqual(after + budgetMs);
    });
  });

  describe('RUNTIME_CONFIG', () => {
    test('aggregates all config sections', () => {
      expect(RUNTIME_CONFIG.gameTick).toBe(GAME_TICK_CONFIG);
      expect(RUNTIME_CONFIG.marketDecision).toBe(MARKET_DECISION_CONFIG);
      expect(RUNTIME_CONFIG.worldFacts).toBe(WORLD_FACTS_CONFIG);
      expect(RUNTIME_CONFIG.blockchain).toBe(BLOCKCHAIN_CONFIG);
      expect(RUNTIME_CONFIG.env).toBe(ENV_CONFIG);
    });
  });
});
