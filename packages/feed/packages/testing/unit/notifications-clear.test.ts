/**
 * Notification Clear (DELETE /api/notifications) Unit Tests
 *
 * Tests the ClearNotificationsSchema validation logic and JSON parse
 * guard for the notification clearing endpoint.
 */

import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

// Replicate the schema from notifications/route.ts for isolated testing
const ClearNotificationsSchema = z
  .object({
    notificationIds: z.array(z.string().min(1)).min(1).optional(),
    clearAll: z.boolean().optional(),
  })
  .refine(
    (value) => value.clearAll === true || value.notificationIds !== undefined,
    {
      message: 'Provide notificationIds or clearAll=true',
    }
  );

describe('ClearNotificationsSchema', () => {
  describe('valid inputs', () => {
    it('accepts clearAll=true', () => {
      const result = ClearNotificationsSchema.parse({ clearAll: true });
      expect(result.clearAll).toBe(true);
    });

    it('accepts notificationIds with entries', () => {
      const result = ClearNotificationsSchema.parse({
        notificationIds: ['id-1', 'id-2'],
      });
      expect(result.notificationIds).toEqual(['id-1', 'id-2']);
    });

    it('accepts both clearAll and notificationIds', () => {
      const result = ClearNotificationsSchema.parse({
        clearAll: true,
        notificationIds: ['id-1'],
      });
      expect(result.clearAll).toBe(true);
      expect(result.notificationIds).toEqual(['id-1']);
    });

    it('accepts a single notification ID', () => {
      const result = ClearNotificationsSchema.parse({
        notificationIds: ['single-id'],
      });
      expect(result.notificationIds).toHaveLength(1);
    });
  });

  describe('invalid inputs', () => {
    it('rejects empty object (no clearAll or notificationIds)', () => {
      expect(() => ClearNotificationsSchema.parse({})).toThrow();
    });

    it('rejects clearAll=false without notificationIds', () => {
      expect(() =>
        ClearNotificationsSchema.parse({ clearAll: false })
      ).toThrow();
    });

    it('rejects empty notificationIds array', () => {
      expect(() =>
        ClearNotificationsSchema.parse({ notificationIds: [] })
      ).toThrow();
    });

    it('rejects notificationIds with empty strings', () => {
      expect(() =>
        ClearNotificationsSchema.parse({ notificationIds: [''] })
      ).toThrow();
    });

    it('rejects non-string notificationIds', () => {
      expect(() =>
        ClearNotificationsSchema.parse({ notificationIds: [123] })
      ).toThrow();
    });
  });
});

describe('JSON parse guard', () => {
  // Replicate the parse logic from the DELETE handler
  function parseBody(rawBody: string): { parsed: unknown } | { error: string } {
    if (rawBody.trim().length === 0) {
      return { parsed: {} };
    }
    try {
      return { parsed: JSON.parse(rawBody) };
    } catch {
      return { error: 'Invalid JSON body' };
    }
  }

  it('returns empty object for empty body', () => {
    const result = parseBody('');
    expect(result).toEqual({ parsed: {} });
  });

  it('returns empty object for whitespace-only body', () => {
    const result = parseBody('   ');
    expect(result).toEqual({ parsed: {} });
  });

  it('parses valid JSON', () => {
    const result = parseBody('{"clearAll": true}');
    expect(result).toEqual({ parsed: { clearAll: true } });
  });

  it('returns error for malformed JSON', () => {
    const result = parseBody('{not valid json}');
    expect(result).toEqual({ error: 'Invalid JSON body' });
  });

  it('returns error for truncated JSON', () => {
    const result = parseBody('{"clearAll":');
    expect(result).toEqual({ error: 'Invalid JSON body' });
  });
});
