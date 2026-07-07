/**
 * React hook wrapping the incremental streaming parser (#15280) for the two
 * chat render surfaces (`MessageContent`, `InlineWidgetText`). Holds one
 * `StreamingParseCache` per mounted component in a ref, so a growing turn
 * re-parses only its changed tail instead of the whole buffer every frame.
 *
 * The cache lives outside React state on purpose: it is a pure memo of the last
 * parse, never a render trigger. `useMemo` keyed on `[text, analysisMode]`
 * reproduces the old memo semantics (same inputs ⇒ same segment array identity),
 * while the ref threads the prefix cache across those memo recomputes.
 */

import { useMemo, useRef } from "react";
import type { Segment } from "./message-parser-helpers";
import {
  parseSegmentsStreaming,
  type StreamingParseCache,
} from "./message-parser-incremental";

export function useParsedSegments(
  text: string,
  analysisMode = false,
): Segment[] {
  const cacheRef = useRef<StreamingParseCache | null>(null);
  return useMemo(() => {
    try {
      const { segments, cache } = parseSegmentsStreaming(
        text,
        analysisMode,
        cacheRef.current,
      );
      cacheRef.current = cache;
      return segments;
    } catch {
      // error-policy:J3 malformed message markup — render the raw text as-is
      // rather than dropping the message; drop the cache so the next frame
      // starts clean instead of compounding a bad prefix.
      cacheRef.current = null;
      return [{ kind: "text", text }];
    }
  }, [text, analysisMode]);
}
