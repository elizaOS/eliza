/**
 * NPC Memory Service Test Suite
 *
 * Tests for NPC memory management:
 * - Memory formatting for prompts
 * - Time ago formatting
 */

import { describe, expect, test } from 'bun:test';
import type { NpcMemory } from '@babylon/db';
import { npcMemoryService } from '../services/npc-memory-service';

describe('NPC Memory Service - Format Memories For Prompt', () => {
  test('returns empty string for empty memories', () => {
    const formatted = npcMemoryService.formatMemoriesForPrompt([]);
    expect(formatted).toBe('');
  });

  test('formats single memory correctly', () => {
    // Use a timestamp relative to now to avoid test flakiness over time
    const now = new Date();
    const recentTimestamp = new Date(now.getTime() - 30 * 1000).toISOString(); // 30 seconds ago

    const memory: NpcMemory = {
      id: 'mem-1',
      type: 'posted',
      timestamp: recentTimestamp,
      summary: 'Posted about crypto news',
      sentiment: 0.5,
    };

    // Verify formatTimeAgo works correctly with fixed now
    const formattedTimeAgo = npcMemoryService.formatTimeAgo(
      recentTimestamp,
      now
    );
    expect(formattedTimeAgo).toBe('just now');

    // Verify formatMemoriesForPrompt includes the required components
    const formatted = npcMemoryService.formatMemoriesForPrompt([memory]);
    expect(formatted).toContain('## Recent Memories');
    expect(formatted).toContain('Posted about crypto news');
    // Since we used a timestamp 30 seconds ago from current time, it should show "just now"
    expect(formatted).toContain('just now');
  });

  test('formats multiple memories correctly', () => {
    // Use fixed timestamps for deterministic testing
    const memories: NpcMemory[] = [
      {
        id: 'mem-1',
        type: 'posted',
        timestamp: '2025-01-01T12:00:00.000Z',
        summary: 'Posted about crypto news',
        sentiment: 0.5,
      },
      {
        id: 'mem-2',
        type: 'replied_to',
        timestamp: '2025-01-01T11:30:00.000Z', // 30 mins before first memory
        summary: 'Replied to a comment about trading',
        sentiment: 0.3,
      },
    ];

    const formatted = npcMemoryService.formatMemoriesForPrompt(memories);
    expect(formatted).toContain('## Recent Memories');
    expect(formatted).toContain('Posted about crypto news');
    expect(formatted).toContain('Replied to a comment about trading');
  });

  test('formats time ago for minutes', () => {
    // Use a fixed timestamp to avoid timing flakiness
    const fixedNow = new Date('2025-01-01T12:00:00.000Z');
    const fifteenMinsAgo = new Date(
      fixedNow.getTime() - 15 * 60 * 1000
    ).toISOString();

    // Test the formatTimeAgo method directly with fixed 'now'
    const formatted = npcMemoryService.formatTimeAgo(fifteenMinsAgo, fixedNow);
    expect(formatted).toBe('15m ago');
  });

  test('formats time ago for hours', () => {
    // Use fixed timestamps for deterministic testing
    const fixedNow = new Date('2025-01-01T15:00:00.000Z');
    const threeHoursAgo = new Date(
      fixedNow.getTime() - 3 * 60 * 60 * 1000
    ).toISOString();

    // Test the formatTimeAgo method directly with fixed 'now'
    const formatted = npcMemoryService.formatTimeAgo(threeHoursAgo, fixedNow);
    expect(formatted).toBe('3h ago');
  });

  test('formats time ago for days', () => {
    // Use fixed timestamps for deterministic testing
    const fixedNow = new Date('2025-01-03T12:00:00.000Z');
    const twoDaysAgo = new Date(
      fixedNow.getTime() - 2 * 24 * 60 * 60 * 1000
    ).toISOString();

    // Test the formatTimeAgo method directly with fixed 'now'
    const formatted = npcMemoryService.formatTimeAgo(twoDaysAgo, fixedNow);
    expect(formatted).toBe('2d ago');
  });
});
