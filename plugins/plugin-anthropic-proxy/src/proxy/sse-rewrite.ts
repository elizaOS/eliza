/**
 * SSE response transformation.
 *
 * Buffers complete SSE events before applying the reverse map. An SSE consumer
 * cannot dispatch an event before its blank-line terminator, so this preserves
 * streaming behavior while ensuring every event is transformed exactly once.
 * It also allows custom dictionaries to contain length-changing, non-idempotent,
 * or longer-than-fixed-tail replacements without leaking or double-mapping
 * tokens split across TCP chunks.
 *
 * Also uses StringDecoder to buffer partial UTF-8 sequences across TCP
 * chunks. chunk.toString() would emit U+FFFD whenever a multi-byte char
 * (中文, emoji, etc.) lands on a chunk boundary.
 *
 * Event boundaries accept CRLF, LF, and CR line endings as required by the SSE
 * wire format. A replacement spanning separate SSE events is intentionally not
 * supported because events are independent protocol messages.
 */

import { StringDecoder } from "node:string_decoder";

export type ReverseFn = (text: string) => string;

export interface SseStream {
  write: (chunk: Buffer) => void;
  end: () => void;
}

function firstCompletedEventEnd(text: string): number {
  // Spell out the pairs so one CRLF line ending cannot backtrack into a
  // separate CR + LF blank line.
  const match = /\r\n(?:\r\n|\r|\n)|\n(?:\r\n|\r|\n)|\r\r/.exec(text);
  return match ? match.index + match[0].length : 0;
}

export function createSseStream(
  reverseFn: ReverseFn,
  emit: (text: string) => void,
  finish: () => void
): SseStream {
  const decoder = new StringDecoder("utf8");
  let pending = "";

  return {
    write(chunk: Buffer): void {
      pending += decoder.write(chunk);
      for (let eventEnd = firstCompletedEventEnd(pending); eventEnd > 0; ) {
        const completeEvent = pending.slice(0, eventEnd);
        pending = pending.slice(eventEnd);
        emit(reverseFn(completeEvent));
        eventEnd = firstCompletedEventEnd(pending);
      }
    },
    end(): void {
      pending += decoder.end();
      const mapped = reverseFn(pending);
      if (mapped.length > 0) {
        emit(mapped);
      }
      finish();
    },
  };
}
