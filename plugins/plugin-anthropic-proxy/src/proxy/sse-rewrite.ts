/**
 * SSE response transformation.
 *
 * Tail-buffer reverseMap to handle patterns split across TCP chunk boundaries.
 * Without this, "ocplatform" can split as "ocp"+"latform" and leak through.
 * TAIL_SIZE >= longest reverseMap pattern.
 *
 * The reverse map is applied to the WHOLE accumulated buffer before any bytes
 * leave, then only the mapped output beyond the retained tail is emitted. This
 * matters because a token can straddle the internal tail cut: it starts in the
 * flushable prefix and ends inside the retained tail. Transforming the prefix
 * in isolation would emit its head un-mapped and map its tail separately next
 * round, so the full token would never reverse-map and would leak verbatim
 * (e.g. `"Write"` reaching the framework instead of `"write_file"`). Mapping
 * the whole buffer first resolves any such straddling token before its head is
 * committed.
 *
 * The retained tail is the already-mapped suffix, not raw bytes. reverseFn must
 * be idempotent — its eliza-side output tokens (snake_case tool names, identity
 * replacements) do not re-trigger the quoted-PascalCase reverse keys — so a
 * settled tail is never double-transformed on the next round, while an
 * incomplete key at a real chunk boundary (kept literal because it did not
 * match) still completes and maps once its continuation arrives. TAIL_SIZE >=
 * longest quoted/escaped reverse key guarantees such an incomplete key is
 * always fully within the retained tail.
 *
 * Also uses StringDecoder to buffer partial UTF-8 sequences across TCP
 * chunks. chunk.toString() would emit U+FFFD whenever a multi-byte char
 * (中文, emoji, etc.) lands on a chunk boundary.
 *
 * Defends against splitting a UTF-16 surrogate pair (4-byte UTF-8 chars like
 * emoji).
 */

import { StringDecoder } from "node:string_decoder";

const SSE_TAIL_SIZE = 64;

export type ReverseFn = (text: string) => string;

export interface SseStream {
  write: (chunk: Buffer) => void;
  end: () => void;
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
      // Map the whole buffer so a token straddling the internal tail cut is
      // resolved before its head is emitted; retain the mapped tail (not raw)
      // for the next round.
      const mapped = reverseFn(pending);
      if (mapped.length > SSE_TAIL_SIZE) {
        let sliceIdx = mapped.length - SSE_TAIL_SIZE;
        // Don't cut between a UTF-16 surrogate pair
        const prev = mapped.charCodeAt(sliceIdx - 1);
        if (prev >= 0xd800 && prev <= 0xdbff) sliceIdx -= 1;
        emit(mapped.slice(0, sliceIdx));
        pending = mapped.slice(sliceIdx);
      } else {
        pending = mapped;
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
