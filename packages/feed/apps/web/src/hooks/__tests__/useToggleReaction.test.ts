/**
 * Unit tests for applyReactionDelta – the pure function behind
 * optimistic reaction updates (used by useToggleReaction and useChatMessages).
 *
 * Run with:
 *   bun test apps/web/src/hooks/__tests__/useToggleReaction.test.ts
 */

import { describe, expect, it } from 'bun:test';
import type { MessageReactionSummary } from '@/components/chats/types';
import { applyReactionDelta } from '../useToggleReaction';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function summary(
  emoji: string,
  count: number,
  reactedByMe: boolean
): MessageReactionSummary {
  return { emoji, count, reactedByMe };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('applyReactionDelta', () => {
  // ---- Adding reactions ----

  describe('adding a reaction', () => {
    it('adds a new emoji to an empty reactions array', () => {
      const result = applyReactionDelta([], '👍', 'added', true);
      expect(result).toEqual([summary('👍', 1, true)]);
    });

    it('adds a new emoji to undefined reactions', () => {
      const result = applyReactionDelta(undefined, '❤️', 'added', true);
      expect(result).toEqual([summary('❤️', 1, true)]);
    });

    it('increments count when emoji already exists', () => {
      const existing = [summary('👍', 2, false)];
      const result = applyReactionDelta(existing, '👍', 'added', false);
      expect(result).toEqual([summary('👍', 3, false)]);
    });

    it('increments count and sets reactedByMe when isMine', () => {
      const existing = [summary('👍', 2, false)];
      const result = applyReactionDelta(existing, '👍', 'added', true);
      expect(result).toEqual([summary('👍', 3, true)]);
    });

    it('adds a different emoji alongside existing ones', () => {
      const existing = [summary('👍', 3, true)];
      const result = applyReactionDelta(existing, '🔥', 'added', true);
      // Sorted by count descending: 👍(3) then 🔥(1)
      expect(result).toEqual([summary('👍', 3, true), summary('🔥', 1, true)]);
    });

    it('preserves reactedByMe for existing emojis from other users', () => {
      const existing = [summary('👍', 2, true)];
      const result = applyReactionDelta(existing, '👍', 'added', false);
      // isMine=false, so reactedByMe is preserved from prev (true)
      expect(result).toEqual([summary('👍', 3, true)]);
    });
  });

  // ---- Removing reactions ----

  describe('removing a reaction', () => {
    it('decrements the count', () => {
      const existing = [summary('👍', 3, true)];
      const result = applyReactionDelta(existing, '👍', 'removed', true);
      expect(result).toEqual([summary('👍', 2, false)]);
    });

    it('removes the emoji entirely when count reaches zero', () => {
      const existing = [summary('👍', 1, true)];
      const result = applyReactionDelta(existing, '👍', 'removed', true);
      expect(result).toEqual([]);
    });

    it('does not produce negative counts', () => {
      const result = applyReactionDelta([], '👍', 'removed', true);
      expect(result).toEqual([]);
    });

    it('does not produce negative counts for undefined', () => {
      const result = applyReactionDelta(undefined, '❤️', 'removed', true);
      expect(result).toEqual([]);
    });

    it('clears reactedByMe when isMine removes', () => {
      const existing = [summary('❤️', 2, true)];
      const result = applyReactionDelta(existing, '❤️', 'removed', true);
      expect(result).toEqual([summary('❤️', 1, false)]);
    });

    it('preserves reactedByMe when someone else removes', () => {
      const existing = [summary('❤️', 3, true)];
      const result = applyReactionDelta(existing, '❤️', 'removed', false);
      expect(result).toEqual([summary('❤️', 2, true)]);
    });
  });

  // ---- Sorting ----

  describe('sorting', () => {
    it('sorts results by count descending', () => {
      const existing = [
        summary('😂', 1, false),
        summary('👍', 5, true),
        summary('🔥', 3, false),
      ];
      const result = applyReactionDelta(existing, '😂', 'added', false);
      expect(result.map((r) => r.emoji)).toEqual(['👍', '🔥', '😂']);
      expect(result.map((r) => r.count)).toEqual([5, 3, 2]);
    });

    it('re-sorts after a removal changes relative order', () => {
      const existing = [summary('👍', 3, false), summary('🔥', 3, true)];
      // Removing one 👍 puts it below 🔥
      const result = applyReactionDelta(existing, '👍', 'removed', false);
      expect(result.map((r) => r.emoji)).toEqual(['🔥', '👍']);
      expect(result.map((r) => r.count)).toEqual([3, 2]);
    });
  });

  // ---- Immutability ----

  describe('immutability', () => {
    it('does not mutate the input array', () => {
      const existing = [summary('👍', 2, false)];
      const copy = [...existing.map((r) => ({ ...r }))];
      applyReactionDelta(existing, '👍', 'added', true);
      expect(existing).toEqual(copy);
    });
  });
});
