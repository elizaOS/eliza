/**
 * NPC Trade Rate Limiter Unit Tests
 *
 * Tests for NPC trade rate limiting with cooldown and daily limits.
 * Uses a custom provider to avoid dependency on environment config.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import {
  type NpcTradeRateLimitConfig,
  NpcTradeRateLimiter,
  type NpcTradeRateLimitProvider,
  resetNpcTradeRateLimitProvider,
  setNpcTradeRateLimitProvider,
} from '@feed/engine';

/**
 * Test provider that allows full control over rate limiting behavior.
 * Mirrors the in-memory provider but with configurable limits.
 */
class TestableNpcTradeRateLimitProvider implements NpcTradeRateLimitProvider {
  private lastTradeTime = new Map<string, number>();
  private dailyTradeCount = new Map<string, { date: string; count: number }>();

  constructor(
    private config: {
      maxTradesPerDay: number;
      minMinutesBetweenTrades: number;
    }
  ) {}

  async canTrade(
    npcId: string,
    _config: NpcTradeRateLimitConfig
  ): Promise<boolean> {
    const now = Date.now();

    // Check cooldown
    const lastTrade = this.lastTradeTime.get(npcId) ?? 0;
    const cooldownMs = this.config.minMinutesBetweenTrades * 60 * 1000;

    if (now - lastTrade < cooldownMs) {
      return false;
    }

    // Check daily limit
    const today = new Date().toISOString().split('T')[0]!;
    const dailyData = this.dailyTradeCount.get(npcId);

    if (
      dailyData !== undefined &&
      dailyData.date === today &&
      dailyData.count >= this.config.maxTradesPerDay
    ) {
      return false;
    }

    return true;
  }

  async recordTrade(npcId: string): Promise<void> {
    const now = Date.now();
    this.lastTradeTime.set(npcId, now);

    const today = new Date().toISOString().split('T')[0]!;
    const dailyData = this.dailyTradeCount.get(npcId);

    if (dailyData !== undefined && dailyData.date === today) {
      dailyData.count++;
    } else {
      this.dailyTradeCount.set(npcId, { date: today, count: 1 });
    }
  }

  async resetForTesting(): Promise<void> {
    this.lastTradeTime.clear();
    this.dailyTradeCount.clear();
  }

  async getStats(npcId: string): Promise<{
    lastTradeTime: number;
    dailyCount: number;
    date: string;
  } | null> {
    const lastTrade = this.lastTradeTime.get(npcId);
    const dailyData = this.dailyTradeCount.get(npcId);

    if (!lastTrade && !dailyData) {
      return null;
    }

    const today = new Date().toISOString().split('T')[0]!;

    return {
      lastTradeTime: lastTrade ?? 0,
      dailyCount: dailyData && dailyData.date === today ? dailyData.count : 0,
      date: dailyData?.date ?? today,
    };
  }
}

describe('NpcTradeRateLimiter', () => {
  let testProvider: TestableNpcTradeRateLimitProvider;

  beforeEach(async () => {
    // Create a fresh test provider with controllable config
    testProvider = new TestableNpcTradeRateLimitProvider({
      maxTradesPerDay: 20,
      minMinutesBetweenTrades: 5,
    });
    setNpcTradeRateLimitProvider(testProvider);
  });

  afterEach(() => {
    // Reset to default provider after each test
    resetNpcTradeRateLimitProvider();
  });

  describe('Cooldown Logic', () => {
    it('should allow trade when no previous trades exist', async () => {
      const npcId = 'npc-test-1';

      const canTrade = await NpcTradeRateLimiter.canTrade(npcId);
      expect(canTrade).toBe(true);
    });

    it('should block trade within cooldown period', async () => {
      testProvider = new TestableNpcTradeRateLimitProvider({
        maxTradesPerDay: 20,
        minMinutesBetweenTrades: 5, // 5 minutes cooldown
      });
      setNpcTradeRateLimitProvider(testProvider);

      const npcId = 'npc-test-2';

      // First trade should succeed
      const canTrade1 = await NpcTradeRateLimiter.canTrade(npcId);
      expect(canTrade1).toBe(true);

      await NpcTradeRateLimiter.recordTrade(npcId);

      // Immediate second trade should be blocked (within 5 minute cooldown)
      const canTrade2 = await NpcTradeRateLimiter.canTrade(npcId);
      expect(canTrade2).toBe(false);
    });

    it('should allow trade when cooldown is 0 (no cooldown)', async () => {
      testProvider = new TestableNpcTradeRateLimitProvider({
        maxTradesPerDay: 100,
        minMinutesBetweenTrades: 0, // No cooldown
      });
      setNpcTradeRateLimitProvider(testProvider);

      const npcId = 'npc-test-3';

      // First trade
      await NpcTradeRateLimiter.recordTrade(npcId);

      // With 0 cooldown, next trade should be allowed immediately
      const canTrade = await NpcTradeRateLimiter.canTrade(npcId);
      expect(canTrade).toBe(true);
    });

    it('should allow multiple rapid trades with no cooldown', async () => {
      testProvider = new TestableNpcTradeRateLimitProvider({
        maxTradesPerDay: 100,
        minMinutesBetweenTrades: 0,
      });
      setNpcTradeRateLimitProvider(testProvider);

      const npcId = 'npc-test-4';

      // Multiple rapid trades should all be allowed with 0 cooldown
      await NpcTradeRateLimiter.recordTrade(npcId);
      const canTrade1 = await NpcTradeRateLimiter.canTrade(npcId);
      expect(canTrade1).toBe(true);

      await NpcTradeRateLimiter.recordTrade(npcId);
      const canTrade2 = await NpcTradeRateLimiter.canTrade(npcId);
      expect(canTrade2).toBe(true);
    });
  });

  describe('Daily Trade Limit', () => {
    it('should allow trades up to the daily limit', async () => {
      testProvider = new TestableNpcTradeRateLimitProvider({
        maxTradesPerDay: 3,
        minMinutesBetweenTrades: 0, // Disable cooldown for this test
      });
      setNpcTradeRateLimitProvider(testProvider);

      const npcId = 'npc-test-5';

      // First 3 trades should be allowed
      for (let i = 0; i < 3; i++) {
        const canTrade = await NpcTradeRateLimiter.canTrade(npcId);
        expect(canTrade).toBe(true);
        await NpcTradeRateLimiter.recordTrade(npcId);
      }

      // 4th trade should be blocked
      const canTrade = await NpcTradeRateLimiter.canTrade(npcId);
      expect(canTrade).toBe(false);
    });

    it('should track daily count accurately', async () => {
      testProvider = new TestableNpcTradeRateLimitProvider({
        maxTradesPerDay: 5,
        minMinutesBetweenTrades: 0,
      });
      setNpcTradeRateLimitProvider(testProvider);

      const npcId = 'npc-test-6';

      // Record 3 trades
      await NpcTradeRateLimiter.recordTrade(npcId);
      await NpcTradeRateLimiter.recordTrade(npcId);
      await NpcTradeRateLimiter.recordTrade(npcId);

      const stats = await NpcTradeRateLimiter.getStats(npcId);
      expect(stats).not.toBeNull();
      expect(stats!.dailyCount).toBe(3);
    });

    it('should block when daily limit is 1', async () => {
      testProvider = new TestableNpcTradeRateLimitProvider({
        maxTradesPerDay: 1,
        minMinutesBetweenTrades: 0,
      });
      setNpcTradeRateLimitProvider(testProvider);

      const npcId = 'npc-test-7';

      const canTrade1 = await NpcTradeRateLimiter.canTrade(npcId);
      expect(canTrade1).toBe(true);
      await NpcTradeRateLimiter.recordTrade(npcId);

      const canTrade2 = await NpcTradeRateLimiter.canTrade(npcId);
      expect(canTrade2).toBe(false);
    });
  });

  describe('Combined Cooldown + Daily Limit', () => {
    it('should enforce both cooldown and daily limit', async () => {
      testProvider = new TestableNpcTradeRateLimitProvider({
        maxTradesPerDay: 2,
        minMinutesBetweenTrades: 5, // 5 minute cooldown
      });
      setNpcTradeRateLimitProvider(testProvider);

      const npcId = 'npc-test-8';

      // First trade allowed
      const canTrade1 = await NpcTradeRateLimiter.canTrade(npcId);
      expect(canTrade1).toBe(true);
      await NpcTradeRateLimiter.recordTrade(npcId);

      // Second trade blocked by cooldown (not by daily limit yet)
      const canTrade2 = await NpcTradeRateLimiter.canTrade(npcId);
      expect(canTrade2).toBe(false);
    });
  });

  describe('Multiple NPCs', () => {
    it('should track rate limits independently per NPC', async () => {
      testProvider = new TestableNpcTradeRateLimitProvider({
        maxTradesPerDay: 2,
        minMinutesBetweenTrades: 0,
      });
      setNpcTradeRateLimitProvider(testProvider);

      const npcId1 = 'npc-test-9';
      const npcId2 = 'npc-test-10';

      // NPC 1 uses up all trades
      await NpcTradeRateLimiter.recordTrade(npcId1);
      await NpcTradeRateLimiter.recordTrade(npcId1);

      // NPC 1 should be blocked
      const canTrade1 = await NpcTradeRateLimiter.canTrade(npcId1);
      expect(canTrade1).toBe(false);

      // NPC 2 should still be allowed
      const canTrade2 = await NpcTradeRateLimiter.canTrade(npcId2);
      expect(canTrade2).toBe(true);
    });
  });

  describe('Stats Reporting', () => {
    it('should return null stats for unknown NPC', async () => {
      const stats = await NpcTradeRateLimiter.getStats('unknown-npc');
      expect(stats).toBeNull();
    });

    it('should return accurate stats after trades', async () => {
      testProvider = new TestableNpcTradeRateLimitProvider({
        maxTradesPerDay: 10,
        minMinutesBetweenTrades: 0,
      });
      setNpcTradeRateLimitProvider(testProvider);

      const npcId = 'npc-test-11';

      await NpcTradeRateLimiter.recordTrade(npcId);
      await NpcTradeRateLimiter.recordTrade(npcId);

      const stats = await NpcTradeRateLimiter.getStats(npcId);
      expect(stats).not.toBeNull();
      expect(stats!.dailyCount).toBe(2);
      expect(stats!.lastTradeTime).toBeGreaterThan(0);
      expect(stats!.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });
  });

  describe('Reset for Testing', () => {
    it('should clear all state when reset', async () => {
      testProvider = new TestableNpcTradeRateLimitProvider({
        maxTradesPerDay: 1,
        minMinutesBetweenTrades: 0,
      });
      setNpcTradeRateLimitProvider(testProvider);

      const npcId = 'npc-test-12';

      // Use up the daily limit
      await NpcTradeRateLimiter.recordTrade(npcId);
      const canTradeBefore = await NpcTradeRateLimiter.canTrade(npcId);
      expect(canTradeBefore).toBe(false);

      // Reset
      await NpcTradeRateLimiter.resetForTesting();

      // Should be allowed again
      const canTradeAfter = await NpcTradeRateLimiter.canTrade(npcId);
      expect(canTradeAfter).toBe(true);
    });
  });

  describe('Custom Provider Integration', () => {
    it('should allow setting a custom provider', async () => {
      const customProvider: NpcTradeRateLimitProvider = {
        canTrade: mock(async () => false),
        recordTrade: mock(async () => {}),
        resetForTesting: mock(async () => {}),
        getStats: mock(async () => null),
      };

      setNpcTradeRateLimitProvider(customProvider);

      const canTrade = await NpcTradeRateLimiter.canTrade('any-npc');
      expect(canTrade).toBe(false);
      expect(customProvider.canTrade).toHaveBeenCalled();
    });

    it('should return null for provider stats with custom provider', () => {
      const customProvider: NpcTradeRateLimitProvider = {
        canTrade: async () => true,
        recordTrade: async () => {},
        resetForTesting: async () => {},
        getStats: async () => null,
      };

      setNpcTradeRateLimitProvider(customProvider);

      // Custom providers don't have getProviderStats (in-memory only feature)
      const stats = NpcTradeRateLimiter.getProviderStats();
      expect(stats).toBeNull();
    });

    it('should return 0 for cleanup with custom provider', () => {
      const customProvider: NpcTradeRateLimitProvider = {
        canTrade: async () => true,
        recordTrade: async () => {},
        resetForTesting: async () => {},
        getStats: async () => null,
      };

      setNpcTradeRateLimitProvider(customProvider);

      // Custom providers don't support cleanup (in-memory only feature)
      const cleaned = NpcTradeRateLimiter.cleanupStaleEntries();
      expect(cleaned).toBe(0);
    });
  });

  describe('Default In-Memory Provider', () => {
    beforeEach(() => {
      // Reset to default in-memory provider
      resetNpcTradeRateLimitProvider();
    });

    it('should report provider stats for in-memory provider', () => {
      const stats = NpcTradeRateLimiter.getProviderStats();
      expect(stats).not.toBeNull();
      expect(stats!.lastTradeTime).toBe(0);
      expect(stats!.dailyTradeCount).toBe(0);
    });

    it('should report cleanup count as 0 when no stale entries', () => {
      const cleaned = NpcTradeRateLimiter.cleanupStaleEntries();
      expect(cleaned).toBe(0);
    });
  });
});
