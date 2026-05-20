/**
 * DAG Tracer Unit Tests
 *
 * Tests for the TickTracer class that captures all data flowing through
 * the game engine during a tick.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { endTrace, getActiveTracer, startTrace } from '../../dag-trace/tracer';
import type { LLMCallInput, NPCDecision } from '../../dag-trace/types';

// Helper to create a minimal LLM call input
function makeLLMCall(overrides: Partial<LLMCallInput> = {}): LLMCallInput {
  return {
    provider: 'groq',
    model: 'llama-3.3-70b',
    promptType: 'test-prompt',
    format: 'json',
    temperature: 0.7,
    maxTokens: 1024,
    systemPrompt: 'You are a test agent.',
    userPrompt: 'Do something.',
    rawResponse: '{"action": "test"}',
    parsedResponse: { action: 'test' },
    inputTokens: 100,
    outputTokens: 50,
    totalTokens: 150,
    durationMs: 500,
    success: true,
    ...overrides,
  };
}

describe('TickTracer', () => {
  afterEach(() => {
    // Clean up any active tracer
    endTrace();
  });

  describe('startTrace / getActiveTracer / endTrace', () => {
    test('startTrace creates an active tracer', () => {
      startTrace('tick-1', 1);
      expect(getActiveTracer()).not.toBeNull();
    });

    test('endTrace returns finalized TickTrace and clears active tracer', () => {
      startTrace('tick-2', 2);
      const trace = endTrace();
      expect(trace).not.toBeNull();
      expect(trace!.tickId).toBe('tick-2');
      expect(trace!.tickNumber).toBe(2);
      expect(getActiveTracer()).toBeNull();
    });

    test('endTrace returns null when no tracer is active', () => {
      expect(endTrace()).toBeNull();
    });

    test('getActiveTracer returns null when no tracer started', () => {
      expect(getActiveTracer()).toBeNull();
    });
  });

  describe('startNode / endNode', () => {
    test('records timing and success status', () => {
      startTrace('tick-3', 3);
      const tracer = getActiveTracer()!;

      tracer.startNode('init', { fastMode: false });
      tracer.endNode('init', { ready: true });

      const trace = endTrace()!;
      const node = trace.nodes.find((n) => n.nodeId === 'init');

      expect(node).toBeDefined();
      expect(node!.status).toBe('success');
      expect(node!.durationMs).toBeGreaterThanOrEqual(0);
      expect(node!.inputs).toEqual({ fastMode: false });
      expect(node!.outputs).toEqual({ ready: true });
    });

    test('endNode clears currentNodeId', () => {
      startTrace('tick-4', 4);
      const tracer = getActiveTracer()!;

      tracer.startNode('test-node');
      expect(tracer.getCurrentNodeId()).toBe('test-node');

      tracer.endNode('test-node');
      expect(tracer.getCurrentNodeId()).toBeNull();
    });

    test('endNode is a no-op for unknown nodeId', () => {
      startTrace('tick-5', 5);
      const tracer = getActiveTracer()!;

      // Should not throw
      tracer.endNode('nonexistent-node', { data: 123 });
      const trace = endTrace()!;
      expect(trace.nodes.length).toBe(0);
    });
  });

  describe('skipNode', () => {
    test('records skipped status with reason', () => {
      startTrace('tick-6', 6);
      const tracer = getActiveTracer()!;

      tracer.skipNode('market-decisions', 'unifiedNpcPipeline');

      const trace = endTrace()!;
      const node = trace.nodes.find((n) => n.nodeId === 'market-decisions');

      expect(node).toBeDefined();
      expect(node!.status).toBe('skipped');
      expect(node!.error).toBe('unifiedNpcPipeline');
      expect(node!.durationMs).toBe(0);
    });
  });

  describe('delegateNode', () => {
    test('records delegated status with source', () => {
      startTrace('tick-7', 7);
      const tracer = getActiveTracer()!;

      tracer.delegateNode('trade-execution', 'npc-tick', {
        tradesExecuted: 35,
      });

      const trace = endTrace()!;
      const node = trace.nodes.find((n) => n.nodeId === 'trade-execution');

      expect(node).toBeDefined();
      expect(node!.status).toBe('delegated');
      expect(node!.inputs).toEqual({ delegatedTo: 'npc-tick' });
      expect(node!.outputs).toEqual({ tradesExecuted: 35 });
    });
  });

  describe('failNode', () => {
    test('records error status and message', () => {
      startTrace('tick-8', 8);
      const tracer = getActiveTracer()!;

      tracer.startNode('events', { count: 5 });
      tracer.failNode('events', new Error('LLM timeout'));

      const trace = endTrace()!;
      const node = trace.nodes.find((n) => n.nodeId === 'events');

      expect(node).toBeDefined();
      expect(node!.status).toBe('error');
      expect(node!.error).toBe('LLM timeout');
      expect(node!.durationMs).toBeGreaterThanOrEqual(0);
    });

    test('handles non-Error values', () => {
      startTrace('tick-9', 9);
      const tracer = getActiveTracer()!;

      tracer.startNode('test');
      tracer.failNode('test', 'string error');

      const trace = endTrace()!;
      const node = trace.nodes.find((n) => n.nodeId === 'test');
      expect(node!.error).toBe('string error');
    });

    test('clears currentNodeId', () => {
      startTrace('tick-10', 10);
      const tracer = getActiveTracer()!;

      tracer.startNode('failing-node');
      expect(tracer.getCurrentNodeId()).toBe('failing-node');

      tracer.failNode('failing-node', 'boom');
      expect(tracer.getCurrentNodeId()).toBeNull();
    });
  });

  describe('recordLLMCall', () => {
    test('associates call with current node', () => {
      startTrace('tick-11', 11);
      const tracer = getActiveTracer()!;

      tracer.startNode('events');
      const callId = tracer.recordLLMCall(makeLLMCall());
      tracer.endNode('events');

      const trace = endTrace()!;
      const node = trace.nodes.find((n) => n.nodeId === 'events');
      expect(node!.llmCallIds).toContain(callId);

      const call = trace.llmCalls.find((c) => c.callId === callId);
      expect(call).toBeDefined();
      expect(call!.nodeId).toBe('events');
    });

    test('explicit nodeId overrides currentNodeId', () => {
      startTrace('tick-12', 12);
      const tracer = getActiveTracer()!;

      tracer.startNode('node-a');
      // Even though node-a is current, explicitly attribute to node-b
      tracer.startNode('node-b');
      const callId = tracer.recordLLMCall(makeLLMCall(), 'node-b');
      tracer.endNode('node-b');
      tracer.endNode('node-a');

      const trace = endTrace()!;
      const call = trace.llmCalls.find((c) => c.callId === callId);
      expect(call!.nodeId).toBe('node-b');

      // node-b should have the call, not node-a
      const nodeB = trace.nodes.find((n) => n.nodeId === 'node-b');
      expect(nodeB!.llmCallIds).toContain(callId);
    });

    test('nodeId in LLMCallInput is used when no explicit override', () => {
      startTrace('tick-13', 13);
      const tracer = getActiveTracer()!;

      tracer.startNode('node-c');
      const callId = tracer.recordLLMCall(makeLLMCall({ nodeId: 'node-c' }));
      tracer.endNode('node-c');

      const trace = endTrace()!;
      const call = trace.llmCalls.find((c) => c.callId === callId);
      expect(call!.nodeId).toBe('node-c');
    });

    test('orphaned call gets nodeId "unknown"', () => {
      startTrace('tick-14', 14);
      const tracer = getActiveTracer()!;

      // No node is active
      const callId = tracer.recordLLMCall(makeLLMCall());

      const trace = endTrace()!;
      const call = trace.llmCalls.find((c) => c.callId === callId);
      expect(call!.nodeId).toBe('unknown');
    });

    test('updates token stats', () => {
      startTrace('tick-15', 15);
      const tracer = getActiveTracer()!;

      tracer.recordLLMCall(
        makeLLMCall({ inputTokens: 100, outputTokens: 50, totalTokens: 150 })
      );
      tracer.recordLLMCall(
        makeLLMCall({ inputTokens: 200, outputTokens: 100, totalTokens: 300 })
      );

      const trace = endTrace()!;
      expect(trace.tokenStats.totalCalls).toBe(2);
      expect(trace.tokenStats.totalInputTokens).toBe(300);
      expect(trace.tokenStats.totalOutputTokens).toBe(150);
      expect(trace.tokenStats.totalTokens).toBe(450);
    });

    test('tracks byPromptType breakdown', () => {
      startTrace('tick-16', 16);
      const tracer = getActiveTracer()!;

      tracer.recordLLMCall(
        makeLLMCall({
          promptType: 'trading',
          inputTokens: 100,
          outputTokens: 50,
        })
      );
      tracer.recordLLMCall(
        makeLLMCall({
          promptType: 'trading',
          inputTokens: 200,
          outputTokens: 100,
        })
      );
      tracer.recordLLMCall(
        makeLLMCall({ promptType: 'social', inputTokens: 50, outputTokens: 25 })
      );

      const trace = endTrace()!;
      expect(trace.tokenStats.byPromptType['trading'].calls).toBe(2);
      expect(trace.tokenStats.byPromptType['trading'].inputTokens).toBe(300);
      expect(trace.tokenStats.byPromptType['social'].calls).toBe(1);
    });
  });

  describe('recordSubOperation', () => {
    test('records sub-operations on a node', () => {
      startTrace('tick-17', 17);
      const tracer = getActiveTracer()!;

      tracer.startNode('reputation-sync');
      tracer.recordSubOperation('reputation-sync', {
        name: 'db-write',
        type: 'db_write',
        startMs: Date.now(),
        endMs: Date.now() + 100,
        details: { table: 'reputations', rows: 5 },
      });
      tracer.endNode('reputation-sync');

      const trace = endTrace()!;
      const node = trace.nodes.find((n) => n.nodeId === 'reputation-sync');
      expect(node!.subOperations).toBeDefined();
      expect(node!.subOperations!.length).toBe(1);
      expect(node!.subOperations![0].name).toBe('db-write');
      expect(node!.subOperations![0].type).toBe('db_write');
    });

    test('ignores sub-op for nonexistent node', () => {
      startTrace('tick-18', 18);
      const tracer = getActiveTracer()!;

      // Should not throw
      tracer.recordSubOperation('nonexistent', {
        name: 'test',
        type: 'computation',
        startMs: 0,
        endMs: 0,
        details: {},
      });

      const trace = endTrace()!;
      expect(trace.nodes.length).toBe(0);
    });
  });

  describe('NPC trajectory recording', () => {
    test('records decisions with auto-timestamp', () => {
      startTrace('tick-19', 19);
      const tracer = getActiveTracer()!;

      const decision: NPCDecision = {
        action: 'BUY',
        ticker: 'aiBitcoin',
        amount: 1000,
        confidence: 0.8,
        reasoning: 'Bullish signal',
      };
      tracer.recordNPCDecision('npc-01', 'CryptoWhale', decision);

      const trace = endTrace()!;
      expect(trace.npcTrajectories.length).toBe(1);
      expect(trace.npcTrajectories[0].npcName).toBe('CryptoWhale');
      expect(trace.npcTrajectories[0].decisions.length).toBe(1);
      expect(trace.npcTrajectories[0].decisions[0].timestamp).toBeDefined();
      expect(typeof trace.npcTrajectories[0].decisions[0].timestamp).toBe(
        'number'
      );
    });

    test('accumulates multiple actions per NPC', () => {
      startTrace('tick-20', 20);
      const tracer = getActiveTracer()!;

      tracer.recordNPCDecision('npc-01', 'Whale', {
        action: 'BUY',
        amount: 100,
        confidence: 0.5,
        reasoning: 'test',
      });
      tracer.recordNPCTrade('npc-01', 'Whale', {
        action: 'BUY',
        amount: 100,
        success: true,
      });
      tracer.recordNPCPost('npc-01', 'Whale', {
        postId: 'p1',
        content: 'Hello',
        type: 'post',
      });
      tracer.recordNPCGroupMessage('npc-01', 'Whale', {
        groupId: 'g1',
        groupName: 'Alpha',
        content: 'Hi',
      });

      const trace = endTrace()!;
      const npc = trace.npcTrajectories[0];
      expect(npc.decisions.length).toBe(1);
      expect(npc.trades.length).toBe(1);
      expect(npc.posts.length).toBe(1);
      expect(npc.groupMessages.length).toBe(1);
    });

    test('groups by NPC ID correctly', () => {
      startTrace('tick-21', 21);
      const tracer = getActiveTracer()!;

      tracer.recordNPCDecision('npc-01', 'Alice', {
        action: 'BUY',
        amount: 100,
        confidence: 0.5,
        reasoning: 'a',
      });
      tracer.recordNPCDecision('npc-02', 'Bob', {
        action: 'SELL',
        amount: 200,
        confidence: 0.7,
        reasoning: 'b',
      });
      tracer.recordNPCDecision('npc-01', 'Alice', {
        action: 'HOLD',
        amount: 0,
        confidence: 0.3,
        reasoning: 'c',
      });

      const trace = endTrace()!;
      expect(trace.npcTrajectories.length).toBe(2);

      const alice = trace.npcTrajectories.find((n) => n.npcName === 'Alice');
      expect(alice!.decisions.length).toBe(2);

      const bob = trace.npcTrajectories.find((n) => n.npcName === 'Bob');
      expect(bob!.decisions.length).toBe(1);
    });
  });

  describe('environmentFlags', () => {
    test('records environment flags', () => {
      startTrace('tick-22', 22);
      const tracer = getActiveTracer()!;

      tracer.setEnvironmentFlags({
        FEED_DAG_TRACE: true,
        GAME_TICK_BUDGET_MS: '180000',
      });

      const trace = endTrace()!;
      expect(trace.environmentFlags).toBeDefined();
      expect(trace.environmentFlags!.FEED_DAG_TRACE).toBe(true);
      expect(trace.environmentFlags!.GAME_TICK_BUDGET_MS).toBe('180000');
    });

    test('omits environmentFlags when empty', () => {
      startTrace('tick-23', 23);
      const trace = endTrace()!;
      expect(trace.environmentFlags).toBeUndefined();
    });
  });

  describe('safeSerialize', () => {
    test('handles circular references', () => {
      startTrace('tick-24', 24);
      const tracer = getActiveTracer()!;

      const circular: Record<string, unknown> = { a: 1 };
      circular.self = circular;

      tracer.startNode('test', circular);
      tracer.endNode('test');

      const trace = endTrace()!;
      const node = trace.nodes[0];
      expect(node.inputs.a).toBe(1);
      expect(node.inputs.self).toBe('[Circular]');
    });

    test('converts BigInt to string', () => {
      startTrace('tick-25', 25);
      const tracer = getActiveTracer()!;

      tracer.startNode('test', { value: BigInt(12345678901234567890n) });
      tracer.endNode('test');

      const trace = endTrace()!;
      expect(typeof trace.nodes[0].inputs.value).toBe('string');
    });

    test('converts Error to {name, message, stack}', () => {
      startTrace('tick-26', 26);
      const tracer = getActiveTracer()!;

      tracer.startNode('test', { err: new Error('test error') });
      tracer.endNode('test');

      const trace = endTrace()!;
      const err = trace.nodes[0].inputs.err as Record<string, string>;
      expect(err.name).toBe('Error');
      expect(err.message).toBe('test error');
      expect(err.stack).toBeDefined();
    });

    test('truncates strings over 50KB and records metadata', () => {
      startTrace('tick-27', 27);
      const tracer = getActiveTracer()!;

      const longString = 'x'.repeat(60000);
      tracer.startNode('test', { bigField: longString });
      tracer.endNode('test');

      const trace = endTrace()!;
      const input = trace.nodes[0].inputs;
      const val = input.bigField as string;
      expect(val.length).toBeLessThan(60000);
      expect(val).toContain('truncated');

      // Should have truncation metadata
      const truncated = input._truncated as Array<{
        key: string;
        originalLength: number;
      }>;
      expect(truncated).toBeDefined();
      expect(truncated.length).toBeGreaterThan(0);
      expect(truncated[0].originalLength).toBe(60000);
    });
  });

  describe('finalize', () => {
    test('produces complete TickTrace with all fields', () => {
      startTrace('tick-28', 28);
      const tracer = getActiveTracer()!;

      tracer.startNode('init', { ready: true });
      tracer.recordLLMCall(makeLLMCall());
      tracer.endNode('init', { done: true });
      tracer.recordNPCDecision('npc-01', 'Test', {
        action: 'BUY',
        amount: 100,
        confidence: 0.5,
        reasoning: 'test',
      });
      tracer.setGameTickResult({ success: true });
      tracer.setEnvironmentFlags({ FEED_DAG_TRACE: true });

      const trace = endTrace()!;

      // All top-level fields present
      expect(trace.tickId).toBe('tick-28');
      expect(trace.tickNumber).toBe(28);
      expect(trace.timestamp).toBeDefined();
      expect(trace.startMs).toBeGreaterThan(0);
      expect(trace.endMs).toBeGreaterThanOrEqual(trace.startMs);
      expect(trace.durationMs).toBeGreaterThanOrEqual(0);
      expect(trace.dag).toBeDefined();
      expect(trace.nodes.length).toBe(1);
      expect(trace.llmCalls.length).toBe(1);
      expect(trace.npcTrajectories.length).toBe(1);
      expect(trace.tokenStats.totalCalls).toBe(1);
      expect(trace.gameTickResult).toEqual({ success: true });
      expect(trace.environmentFlags).toEqual({ FEED_DAG_TRACE: true });
    });
  });

  describe('setTokenStats', () => {
    test('preserves byPromptType accumulated from recordLLMCall', () => {
      startTrace('tick-29', 29);
      const tracer = getActiveTracer()!;

      // Record some calls that build up byPromptType
      tracer.recordLLMCall(
        makeLLMCall({
          promptType: 'trading',
          inputTokens: 100,
          outputTokens: 50,
          totalTokens: 150,
        })
      );
      tracer.recordLLMCall(
        makeLLMCall({
          promptType: 'social',
          inputTokens: 200,
          outputTokens: 100,
          totalTokens: 300,
        })
      );

      // Now setTokenStats with official numbers — should NOT destroy byPromptType
      tracer.setTokenStats({
        totalCalls: 2,
        totalInputTokens: 300,
        totalOutputTokens: 150,
        totalTokens: 450,
        estimatedCostUSD: 0.005,
        byPromptType: {}, // empty — should NOT overwrite the accumulated data
      });

      const trace = endTrace()!;
      // byPromptType should still have the per-call data
      expect(trace.tokenStats.byPromptType['trading']).toBeDefined();
      expect(trace.tokenStats.byPromptType['trading'].calls).toBe(1);
      expect(trace.tokenStats.byPromptType['social']).toBeDefined();
      expect(trace.tokenStats.byPromptType['social'].calls).toBe(1);
      // But the top-level stats should be from setTokenStats
      expect(trace.tokenStats.estimatedCostUSD).toBe(0.005);
    });

    test('uses provided byPromptType when no calls have been recorded', () => {
      startTrace('tick-30', 30);
      const tracer = getActiveTracer()!;

      tracer.setTokenStats({
        totalCalls: 5,
        totalInputTokens: 1000,
        totalOutputTokens: 500,
        totalTokens: 1500,
        estimatedCostUSD: 0.01,
        byPromptType: {
          test: { calls: 5, inputTokens: 1000, outputTokens: 500 },
        },
      });

      const trace = endTrace()!;
      expect(trace.tokenStats.byPromptType['test']).toBeDefined();
      expect(trace.tokenStats.byPromptType['test'].calls).toBe(5);
    });
  });
});
