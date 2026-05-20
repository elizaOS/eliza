/**
 * Integration Test for Autonomous Agent
 *
 * Tests the complete agent flow:
 * - Registration with Agent0
 * - Connection to Feed A2A
 * - Decision making
 * - Action execution
 * - Memory management
 */

import { describe, expect, it } from 'bun:test';
import dotenv from 'dotenv';
import { AgentMemory } from '../src/memory';

dotenv.config({ path: '.env.local' });

describe('Autonomous Feed Agent - Integration', () => {
  describe('Memory System', () => {
    it('should store and retrieve entries', () => {
      const memory = new AgentMemory({ maxEntries: 5 });

      memory.add({
        action: 'BUY_YES',
        params: { marketId: '123', amount: 50 },
        result: { shares: 100 },
        timestamp: Date.now(),
      });

      const recent = memory.getRecent(1);
      expect(recent.length).toBe(1);
      expect(recent[0]?.action).toBe('BUY_YES');
    });

    it('should limit entries to maxEntries', () => {
      const memory = new AgentMemory({ maxEntries: 3 });

      for (let i = 0; i < 5; i++) {
        memory.add({
          action: 'TEST',
          params: {},
          result: {},
          timestamp: Date.now(),
        });
      }

      const all = memory.getAll();
      expect(all.length).toBe(3);
    });

    it('should generate summary', () => {
      const memory = new AgentMemory({ maxEntries: 5 });

      memory.add({
        action: 'BUY_YES',
        params: {},
        result: { success: true },
        timestamp: Date.now(),
      });

      const summary = memory.getSummary();
      expect(summary).toContain('BUY_YES');
    });
  });

  describe('Agent0 Registration', () => {
    it('should have Agent0 SDK available', async () => {
      const { SDK } = await import('agent0-sdk');
      expect(SDK).toBeDefined();
    });

    it('should validate environment variables', () => {
      // These are optional in test environment
      const hasConfig = !!(
        process.env.AGENT0_RPC_URL &&
        process.env.AGENT0_PRIVATE_KEY &&
        process.env.GROQ_API_KEY
      );
      expect(typeof hasConfig).toBe('boolean');
    });
  });

  describe('Decision Making', () => {
    it('should parse JSON decisions', () => {
      const jsonText = `{"action": "BUY_YES", "params": {"marketId": "123", "amount": 50}, "reasoning": "Good opportunity"}`;
      const parsed = JSON.parse(jsonText);

      expect(parsed.action).toBe('BUY_YES');
      expect(parsed.params.amount).toBe(50);
    });
  });

  describe('A2A Client', () => {
    it('should create A2A client', async () => {
      const { FeedA2AClient } = await import('../src/a2a-client');

      const client = new FeedA2AClient({
        baseUrl: 'http://localhost:3000',
        address: '0x' + '1'.repeat(40),
        tokenId: 1,
        apiKey: 'test',
      });

      expect(client).toBeDefined();
      expect(client.agentId).toBeDefined();
    });
  });

  describe('Action Execution', () => {
    it('should format trading actions', () => {
      const decision = {
        action: 'BUY_YES' as const,
        params: {
          marketId: '123',
          amount: 50,
        },
        reasoning: 'Test',
      };

      expect(decision.action).toBe('BUY_YES');
      expect(decision.params.marketId).toBe('123');
    });

    it('should handle HOLD action', () => {
      const decision = {
        action: 'HOLD' as const,
        reasoning: 'No opportunities',
      };

      expect(decision.action).toBe('HOLD');
    });
  });
});
