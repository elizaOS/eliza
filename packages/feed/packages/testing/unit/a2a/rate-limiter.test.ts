/**
 * A2A Rate Limiter Unit Tests
 *
 * Tests for the token bucket rate limiter used in A2A protocol
 */

import { beforeEach, describe, expect, it } from 'bun:test';
import { RateLimiter } from '@feed/a2a';

describe('A2A RateLimiter', () => {
  let limiter: RateLimiter;

  beforeEach(() => {
    limiter = new RateLimiter(10); // 10 messages per minute
  });

  describe('Token Bucket Algorithm', () => {
    it('should allow requests within rate limit', () => {
      const agentId = 'agent-001';

      // First request should be allowed
      expect(limiter.checkLimit(agentId)).toBe(true);
      expect(limiter.getTokens(agentId)).toBe(9);

      // Second request should be allowed
      expect(limiter.checkLimit(agentId)).toBe(true);
      expect(limiter.getTokens(agentId)).toBe(8);
    });

    it('should block requests exceeding rate limit', () => {
      const agentId = 'agent-002';

      // Use up all 10 tokens
      for (let i = 0; i < 10; i++) {
        expect(limiter.checkLimit(agentId)).toBe(true);
      }

      // 11th request should be blocked
      expect(limiter.checkLimit(agentId)).toBe(false);
      expect(limiter.getTokens(agentId)).toBe(0);
    });

    it('should track limits separately per agent', () => {
      const agent1 = 'agent-003';
      const agent2 = 'agent-004';

      // Agent 1 uses 5 tokens
      for (let i = 0; i < 5; i++) {
        limiter.checkLimit(agent1);
      }

      // Agent 2 should have full quota
      expect(limiter.getTokens(agent2)).toBe(10);
      expect(limiter.checkLimit(agent2)).toBe(true);
      expect(limiter.getTokens(agent2)).toBe(9);
    });

    it('should reset agent limit', () => {
      const agentId = 'agent-005';

      // Use some tokens
      limiter.checkLimit(agentId);
      limiter.checkLimit(agentId);
      expect(limiter.getTokens(agentId)).toBe(8);

      // Reset
      limiter.reset(agentId);

      // Should have full tokens again
      expect(limiter.getTokens(agentId)).toBe(10);
    });

    it('should clear all rate limits', () => {
      const agent1 = 'agent-006';
      const agent2 = 'agent-007';

      // Use tokens for both agents
      limiter.checkLimit(agent1);
      limiter.checkLimit(agent2);

      // Clear all
      limiter.clear();

      // Both should have full tokens
      expect(limiter.getTokens(agent1)).toBe(10);
      expect(limiter.getTokens(agent2)).toBe(10);
    });

    it('should start with max tokens for new agents', () => {
      const newAgent = 'new-agent-001';
      expect(limiter.getTokens(newAgent)).toBe(10);
    });
  });

  describe('Different Rate Configurations', () => {
    it('should support low rate limits', () => {
      const lowRateLimiter = new RateLimiter(2); // Only 2 per minute
      const agentId = 'low-rate-agent';

      expect(lowRateLimiter.checkLimit(agentId)).toBe(true);
      expect(lowRateLimiter.checkLimit(agentId)).toBe(true);
      expect(lowRateLimiter.checkLimit(agentId)).toBe(false);
    });

    it('should support high rate limits', () => {
      const highRateLimiter = new RateLimiter(100); // 100 per minute
      const agentId = 'high-rate-agent';

      // Should be able to make 100 requests
      for (let i = 0; i < 100; i++) {
        expect(highRateLimiter.checkLimit(agentId)).toBe(true);
      }

      // 101st should be blocked
      expect(highRateLimiter.checkLimit(agentId)).toBe(false);
    });
  });
});
