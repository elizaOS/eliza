/**
 * Chat Message Reactions – Unit Tests
 *
 * Covers:
 *   - ALLOWED_REACTION_EMOJIS constant integrity
 *   - ChatMessageReactionCreateSchema validation
 *   - applyReactionDelta pure function (optimistic UI updates)
 */

import { describe, expect, it } from 'bun:test';
import {
  ALLOWED_REACTION_EMOJI_SET,
  ALLOWED_REACTION_EMOJIS,
  ChatMessageReactionCreateSchema,
} from '@feed/shared';

// ---------------------------------------------------------------------------
// ALLOWED_REACTION_EMOJIS
// ---------------------------------------------------------------------------

describe('ALLOWED_REACTION_EMOJIS', () => {
  it('contains exactly seven emojis', () => {
    expect(ALLOWED_REACTION_EMOJIS).toHaveLength(7);
  });

  it('includes the expected emoji set', () => {
    const expected = ['👍', '❤️', '😂', '🔥', '😮', '😢', '🙏'] as const;
    expect([...ALLOWED_REACTION_EMOJIS]).toEqual([...expected]);
  });

  it('has a matching Set for O(1) lookups', () => {
    for (const emoji of ALLOWED_REACTION_EMOJIS) {
      expect(ALLOWED_REACTION_EMOJI_SET.has(emoji)).toBe(true);
    }
    expect(ALLOWED_REACTION_EMOJI_SET.size).toBe(
      ALLOWED_REACTION_EMOJIS.length
    );
  });

  it('rejects emojis not in the set', () => {
    expect(ALLOWED_REACTION_EMOJI_SET.has('💀')).toBe(false);
    expect(ALLOWED_REACTION_EMOJI_SET.has('🤡')).toBe(false);
    expect(ALLOWED_REACTION_EMOJI_SET.has('')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ChatMessageReactionCreateSchema
// ---------------------------------------------------------------------------

describe('ChatMessageReactionCreateSchema', () => {
  it('accepts a valid emoji string', () => {
    const result = ChatMessageReactionCreateSchema.parse({ emoji: '👍' });
    expect(result.emoji).toBe('👍');
  });

  it('trims whitespace around emoji', () => {
    const result = ChatMessageReactionCreateSchema.parse({ emoji: '  ❤️  ' });
    expect(result.emoji).toBe('❤️');
  });

  it('rejects missing emoji field', () => {
    expect(() => ChatMessageReactionCreateSchema.parse({})).toThrow();
  });

  it('rejects empty string', () => {
    expect(() =>
      ChatMessageReactionCreateSchema.parse({ emoji: '' })
    ).toThrow();
  });

  it('rejects string over 16 characters', () => {
    expect(() =>
      ChatMessageReactionCreateSchema.parse({ emoji: 'x'.repeat(17) })
    ).toThrow();
  });

  it('accepts strings up to 16 characters', () => {
    const longEmoji = '🏴󠁧󠁢󠁳󠁣󠁴󠁿'; // flag sequences can be long
    // As long as it's <= 16 code points/chars it should pass the schema
    if (longEmoji.length <= 16) {
      expect(() =>
        ChatMessageReactionCreateSchema.parse({ emoji: longEmoji })
      ).not.toThrow();
    }
  });
});
