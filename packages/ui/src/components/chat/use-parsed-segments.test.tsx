// @vitest-environment jsdom
//
// Hook smoke for useParsedSegments: it threads the streaming cache across
// re-renders (stable output as text grows) and, per its J3 fallback, renders the
// raw text when a registered widget parser throws. jsdom only for renderHook.

import { renderHook } from "@testing-library/react";
import { afterAll, describe, expect, it } from "vitest";
import { parseSegments } from "./message-parser-helpers";
import { useParsedSegments } from "./use-parsed-segments";
import "./widgets/inline-builtins";
import { registerInlineWidget } from "./widgets/inline-registry";

// A harmless widget that returns no regions for ordinary text but throws when a
// sentinel is present, so we can exercise the hook's parse-failure fallback
// without breaking any other parse. Scoped to this jsdom file only.
registerInlineWidget({
  kind: "boom",
  parse: (text) => {
    if (text.includes("__BOOM__")) throw new Error("widget parse blew up");
    return [];
  },
  render: () => null,
});

afterAll(() => {
  // Neutralize the throwing widget so a shared registry can't leak the failure.
  registerInlineWidget({ kind: "boom", parse: () => [], render: () => null });
});

describe("useParsedSegments", () => {
  it("stays byte-identical to a full parse across a streamed update", () => {
    const frames = [
      "Here is the answer",
      "Here is the answer:\n\n```ts\nconst",
      "Here is the answer:\n\n```ts\nconst a = 1;\n```\n\nDone.",
    ];
    const { result, rerender } = renderHook(
      ({ text }: { text: string }) => useParsedSegments(text, false),
      { initialProps: { text: frames[0] } },
    );
    expect(result.current).toEqual(parseSegments(frames[0], false));
    for (const text of frames.slice(1)) {
      rerender({ text });
      expect(result.current).toEqual(parseSegments(text, false));
    }
  });

  it("returns a stable array reference when the text does not change", () => {
    const { result, rerender } = renderHook(
      ({ text }: { text: string }) => useParsedSegments(text, false),
      { initialProps: { text: "unchanged text here" } },
    );
    const first = result.current;
    rerender({ text: "unchanged text here" });
    expect(result.current).toBe(first);
  });

  it("falls back to raw text when a widget parser throws", () => {
    const text = "before __BOOM__ after";
    const { result } = renderHook(() => useParsedSegments(text, false));
    expect(result.current).toEqual([{ kind: "text", text }]);
  });
});
