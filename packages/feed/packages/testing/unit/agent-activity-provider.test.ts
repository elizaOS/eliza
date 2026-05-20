/**
 * Agent Activity Provider Tests
 *
 * Tests the coordinatorAgentActivityProvider that surfaces
 * EventBus history for the coordinator's context window.
 *
 * Coverage:
 * - Empty event history → returns empty string
 * - Event formatting: timestamps, agent names, commands, responses
 * - Truncation of long commands (100 chars) and responses (200 chars)
 * - Missing fields: timestamp, agentUsername, command, response
 * - agent.dispatch.result type: special formatting with ✓/✗
 * - Other event types: generic JSON formatting
 * - Caps at 10 events even when 20 fetched
 */

import { describe, expect, mock, test } from 'bun:test';
import type { IAgentRuntime, Memory, State } from '@elizaos/core';

// ─── Mock EventBus ───────────────────────────────────────────────────────────

let mockHistory: Array<{
  type: string;
  data: Record<string, unknown>;
  timestamp?: string;
}> = [];

mock.module('../../agents/src/communication/EventBus', () => ({
  getEventBus: () => ({
    getHistory: (_pattern: string, _limit: number) => mockHistory,
  }),
}));

// ─── Import after mocks ──────────────────────────────────────────────────────

const { coordinatorAgentActivityProvider } = await import(
  '../../agents/src/plugins/plugin-user-core/src/providers/agent-activity'
);

// ─── Helpers ─────────────────────────────────────────────────────────────────

const mockRuntime = {} as IAgentRuntime;
const mockMessage = {} as Memory;
const mockState = {} as State;

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('coordinatorAgentActivityProvider', () => {
  test('returns empty string when no events exist', async () => {
    mockHistory = [];

    const result = await coordinatorAgentActivityProvider.get(
      mockRuntime,
      mockMessage,
      mockState
    );

    expect(result.text).toBe('');
  });

  test('formats agent.dispatch.result events with ✓ for success', async () => {
    mockHistory = [
      {
        type: 'agent.dispatch.result',
        data: {
          agentUsername: 'trader-bot',
          command: 'buy OPENAGI',
          response: 'Bought 100 shares',
          success: true,
          timestamp: '2025-06-15T10:30:00.000Z',
        },
        timestamp: '2025-06-15T10:30:00.000Z',
      },
    ];

    const result = await coordinatorAgentActivityProvider.get(
      mockRuntime,
      mockMessage,
      mockState
    );

    expect(result.text).toContain('## Recent Agent Activity');
    expect(result.text).toContain('@trader-bot');
    expect(result.text).toContain('✓');
    expect(result.text).toContain('buy OPENAGI');
    expect(result.text).toContain('Bought 100 shares');
  });

  test('formats agent.dispatch.result events with ✗ for failure', async () => {
    mockHistory = [
      {
        type: 'agent.dispatch.result',
        data: {
          agentUsername: 'trader-bot',
          command: 'buy NONEXIST',
          response: 'Market not found',
          success: false,
          timestamp: '2025-06-15T10:30:00.000Z',
        },
        timestamp: '2025-06-15T10:30:00.000Z',
      },
    ];

    const result = await coordinatorAgentActivityProvider.get(
      mockRuntime,
      mockMessage,
      mockState
    );

    expect(result.text).toContain('✗');
  });

  test('falls back to agentId when agentUsername is missing', async () => {
    mockHistory = [
      {
        type: 'agent.dispatch.result',
        data: {
          agentId: 'agent-xyz-123',
          command: 'check balance',
          response: 'Balance: $500',
          success: true,
          timestamp: '2025-06-15T10:30:00.000Z',
        },
        timestamp: '2025-06-15T10:30:00.000Z',
      },
    ];

    const result = await coordinatorAgentActivityProvider.get(
      mockRuntime,
      mockMessage,
      mockState
    );

    expect(result.text).toContain('@agent-xyz-123');
  });

  test('shows "unknown" when both agentUsername and agentId are missing', async () => {
    mockHistory = [
      {
        type: 'agent.dispatch.result',
        data: {
          command: 'check',
          response: 'OK',
          success: true,
          timestamp: '2025-06-15T10:30:00.000Z',
        },
        timestamp: '2025-06-15T10:30:00.000Z',
      },
    ];

    const result = await coordinatorAgentActivityProvider.get(
      mockRuntime,
      mockMessage,
      mockState
    );

    expect(result.text).toContain('@unknown');
  });

  test('truncates long commands to 100 chars', async () => {
    mockHistory = [
      {
        type: 'agent.dispatch.result',
        data: {
          agentUsername: 'bot',
          command: 'A'.repeat(200),
          response: 'OK',
          success: true,
          timestamp: '2025-06-15T10:30:00.000Z',
        },
        timestamp: '2025-06-15T10:30:00.000Z',
      },
    ];

    const result = await coordinatorAgentActivityProvider.get(
      mockRuntime,
      mockMessage,
      mockState
    );

    // The 200-char command should be truncated to 100
    const commandInOutput = result.text!.match(/"(.+?)"/)?.[1] ?? '';
    expect(commandInOutput.length).toBeLessThanOrEqual(100);
  });

  test('truncates long responses to 200 chars', async () => {
    mockHistory = [
      {
        type: 'agent.dispatch.result',
        data: {
          agentUsername: 'bot',
          command: 'check',
          response: 'R'.repeat(500),
          success: true,
          timestamp: '2025-06-15T10:30:00.000Z',
        },
        timestamp: '2025-06-15T10:30:00.000Z',
      },
    ];

    const result = await coordinatorAgentActivityProvider.get(
      mockRuntime,
      mockMessage,
      mockState
    );

    // The response slice is applied to the data.response field (200 chars)
    // The formatted output includes the truncated response in quotes
    // Verify the full 500-char response is NOT in the output
    expect(result.text).not.toContain('R'.repeat(500));
    // But truncated version should be
    expect(result.text).toContain('R'.repeat(200));
  });

  test('handles non-string command gracefully', async () => {
    mockHistory = [
      {
        type: 'agent.dispatch.result',
        data: {
          agentUsername: 'bot',
          command: { action: 'buy' }, // Object, not string
          response: 'OK',
          success: true,
          timestamp: '2025-06-15T10:30:00.000Z',
        },
        timestamp: '2025-06-15T10:30:00.000Z',
      },
    ];

    const result = await coordinatorAgentActivityProvider.get(
      mockRuntime,
      mockMessage,
      mockState
    );

    // Should not throw, command should be empty string
    expect(result.text).toContain('bot');
  });

  test('handles non-string response gracefully', async () => {
    mockHistory = [
      {
        type: 'agent.dispatch.result',
        data: {
          agentUsername: 'bot',
          command: 'check',
          response: null, // Not a string
          success: true,
          timestamp: '2025-06-15T10:30:00.000Z',
        },
        timestamp: '2025-06-15T10:30:00.000Z',
      },
    ];

    const result = await coordinatorAgentActivityProvider.get(
      mockRuntime,
      mockMessage,
      mockState
    );

    // Should not throw
    expect(result.text).toContain('bot');
  });

  test('formats unknown event types with generic JSON', async () => {
    mockHistory = [
      {
        type: 'agent.custom.event',
        data: {
          foo: 'bar',
          timestamp: '2025-06-15T10:30:00.000Z',
        },
        timestamp: '2025-06-15T10:30:00.000Z',
      },
    ];

    const result = await coordinatorAgentActivityProvider.get(
      mockRuntime,
      mockMessage,
      mockState
    );

    expect(result.text).toContain('agent.custom.event');
    expect(result.text).toContain('foo');
  });

  test('only formats last 10 events when more than 10 exist', async () => {
    mockHistory = Array.from({ length: 15 }, (_, i) => ({
      type: 'agent.dispatch.result',
      data: {
        agentUsername: `bot-${i}`,
        command: `cmd-${i}`,
        response: `res-${i}`,
        success: true,
        timestamp: `2025-06-15T10:${String(i).padStart(2, '0')}:00.000Z`,
      },
      timestamp: `2025-06-15T10:${String(i).padStart(2, '0')}:00.000Z`,
    }));

    const result = await coordinatorAgentActivityProvider.get(
      mockRuntime,
      mockMessage,
      mockState
    );

    // Should show last 10 (indices 5-14)
    expect(result.text).not.toContain('bot-0');
    expect(result.text).not.toContain('bot-4');
    expect(result.text).toContain('bot-5');
    expect(result.text).toContain('bot-14');
  });

  test('uses ??:?? when timestamp cannot be determined', async () => {
    mockHistory = [
      {
        type: 'agent.dispatch.result',
        data: {
          agentUsername: 'bot',
          command: 'check',
          response: 'OK',
          success: true,
          // No timestamp in data
        },
        // No event.timestamp either
      },
    ];

    const result = await coordinatorAgentActivityProvider.get(
      mockRuntime,
      mockMessage,
      mockState
    );

    expect(result.text).toContain('??:??');
  });

  test('defaults success to true when not specified', async () => {
    mockHistory = [
      {
        type: 'agent.dispatch.result',
        data: {
          agentUsername: 'bot',
          command: 'check',
          response: 'OK',
          // success not specified
          timestamp: '2025-06-15T10:30:00.000Z',
        },
        timestamp: '2025-06-15T10:30:00.000Z',
      },
    ];

    const result = await coordinatorAgentActivityProvider.get(
      mockRuntime,
      mockMessage,
      mockState
    );

    expect(result.text).toContain('✓'); // Defaults to success
  });
});
