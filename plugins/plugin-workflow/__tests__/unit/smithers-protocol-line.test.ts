/** Unit coverage for the Smithers parent protocol line budget. */

import { describe, expect, test } from 'bun:test';
import {
  appendSmithersProtocolChunk,
  MAX_PROTOCOL_LINE_BYTES,
} from '../../src/services/smithers-runtime';

describe('appendSmithersProtocolChunk', () => {
  test('splits complete lines and keeps the incomplete tail', () => {
    const first = appendSmithersProtocolChunk('', 'hello\nwor');
    expect(first.overflow).toBe(false);
    expect(first.lines).toEqual(['hello']);
    expect(first.buffer).toBe('wor');
    const second = appendSmithersProtocolChunk(first.buffer, 'ld\n');
    expect(second.overflow).toBe(false);
    expect(second.lines).toEqual(['world']);
    expect(second.buffer).toBe('');
  });

  test('accepts a last-fit incomplete line and rejects the first overflowing tail', () => {
    const fit = 'x'.repeat(MAX_PROTOCOL_LINE_BYTES);
    const lastFit = appendSmithersProtocolChunk('', fit);
    expect(lastFit.overflow).toBe(false);
    expect(lastFit.buffer.length).toBe(MAX_PROTOCOL_LINE_BYTES);

    const overflow = appendSmithersProtocolChunk(fit, 'y');
    expect(overflow.overflow).toBe(true);
    expect(overflow.lines).toEqual([]);
    expect(overflow.buffer).toBe('');
  });

  test('rejects a complete line above the budget before the parent keeps it', () => {
    const bomb = `${'z'.repeat(MAX_PROTOCOL_LINE_BYTES + 1)}\n`;
    const result = appendSmithersProtocolChunk('', bomb);
    expect(result.overflow).toBe(true);
  });
});
