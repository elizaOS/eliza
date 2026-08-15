/**
 * Coverage for the streaming-text reconciler (`mergeStreamingText`,
 * `computeStreamingDelta`, `resolveStreamingUpdate`) that folds incoming token
 * snapshots into the already-displayed chat text. Combines named regressions
 * (repeated single-char deltas, suffix/prefix overlap dedupe, cumulative
 * snapshots, in-place revisions) with fast-check property fuzzing of the
 * append / replace / unchanged classification.
 */
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  computeStreamingDelta,
  mergeStreamingText,
  resolveStreamingUpdate,
} from "./streaming-text";

const textArbitrary = fc.string({ maxLength: 120 });

describe("streaming text named regressions", () => {
  it("does not duplicate combining marks when a decomposed suffix overlaps", () => {
    // "cafe\u0301" (decomposed e + COMBINING ACUTE): the provider resends the
    // accented grapheme, still decomposed, plus the continuation. The overlap
    // is found against the NFC forms, so the appended remainder must also be
    // sliced from the NFC form -- slicing the raw incoming at the NFC index
    // used to re-append the combining mark ("cafe\u0301\u0301 more").
    const existing = "cafe\u0301";
    const incoming = "e\u0301 more";
    const merged = mergeStreamingText(existing, incoming);
    expect(merged.normalize("NFC")).toBe("caf\u00e9 more");
    expect(merged).not.toContain("\u0301\u0301");
    expect(merged.normalize("NFC")).not.toContain("\u0301");
  });

  it("keeps precomposed overlap merging byte-stable (no behavior change)", () => {
    expect(mergeStreamingText("caf\u00e9", "\u00e9 more")).toBe(
      "caf\u00e9 more",
    );
    expect(mergeStreamingText("Hello wor", "world!")).toBe("Hello world!");
  });

  it("merges a decomposed continuation through trailing whitespace cleanly", () => {
    // Trailing whitespace on existing is trimmed for overlap detection; a
    // decomposed overlap must still splice cleanly through the
    // whitespace-aware prefix arithmetic.
    const existing = "voila\u0300 ";
    const merged = mergeStreamingText(existing, "a\u0300 magnifique");
    expect(merged.normalize("NFC")).toBe("voil\u00e0 magnifique");
  });

  it("appends the untouched raw suffix when the overlap is ASCII and decomposed content follows the cut", () => {
    // The byte-preservation contract: normalization exists for comparison
    // only, so a decomposed sequence AFTER the overlap cut must reach the
    // caller byte-for-byte (U+0065 U+0301, never a rewritten U+00E9) through
    // every exported function.
    const existing = "hello";
    const incoming = "o cafe\u0301";
    const merged = mergeStreamingText(existing, incoming);
    expect(merged).toBe("hello cafe\u0301");
    expect(merged).not.toContain("\u00e9");
    expect(computeStreamingDelta(existing, incoming)).toBe(" cafe\u0301");
    expect(resolveStreamingUpdate(existing, incoming)).toEqual({
      kind: "append",
      nextText: "hello cafe\u0301",
      emittedText: " cafe\u0301",
    });
  });

  it("preserves reordered combining marks and the untouched raw suffix", () => {
    // NFC reorders dot-below before acute, so the overlapped precomposed
    // dot-below character has no exact boundary in the raw incoming prefix.
    const existing = "foo\u1ea1";
    const incoming = "a\u0301\u0323 cafe\u0301";
    const expected = "foo\u1ea1\u0301 cafe\u0301";

    expect(mergeStreamingText(existing, incoming)).toBe(expected);
    expect(computeStreamingDelta(existing, incoming)).toBe(
      "\u0301 cafe\u0301",
    );
    expect(resolveStreamingUpdate(existing, incoming)).toEqual({
      kind: "append",
      nextText: expected,
      emittedText: "\u0301 cafe\u0301",
    });
  });

  it("preserves repeated single-character deltas", () => {
    expect(mergeStreamingText("l", "l")).toBe("ll");
    expect(computeStreamingDelta("l", "l")).toBe("l");
    expect(resolveStreamingUpdate("l", "l")).toEqual({
      kind: "append",
      nextText: "ll",
      emittedText: "l",
    });
  });

  it("deduplicates overlapping suffix/prefix fragments", () => {
    expect(mergeStreamingText("Hello wor", "world")).toBe("Hello world");
    expect(computeStreamingDelta("Hello wor", "world")).toBe("ld");
  });

  it("does not duplicate combining marks when overlapping decomposed fragments", () => {
    // Decomposed "café" (cafe + U+0301) resending decomposed "é more"
    // (e + U+0301 + " more"). The NFC overlap is the single character "é",
    // but slicing the raw incoming at the NFC code-unit index would split the
    // decomposed "e" + combining-mark sequence and re-append the mark.
    const decomposedCafe = "cafe\u0301";
    const decomposedEMore = "e\u0301 more";
    const merged = mergeStreamingText(decomposedCafe, decomposedEMore);
    // Result should contain exactly one combining acute accent (U+0301).
    expect([...merged].filter((ch) => ch === "\u0301").length).toBe(1);
    // The NFC form must be correct "café more".
    expect(merged.normalize("NFC")).toBe("caf\u00e9 more");
  });

  it("handles Vietnamese decomposed overlap resends", () => {
    // "tự" decomposed = t + ư + dot-below (U+0323)
    const existing = "t\u01b0\u0323 do";
    // Overlapped tail: "ự do là" decomposed = ư + dot-below + " do là"
    const incoming = "\u01b0\u0323 do l\u00e0";
    const merged = mergeStreamingText(existing, incoming);
    expect(merged.normalize("NFC")).toBe("t\u1ef1 do l\u00e0");
    // Exactly one dot-below combining mark (U+0323), not duplicated.
    expect([...merged].filter((ch) => ch === "\u0323").length).toBe(1);
  });

  it("accepts cumulative provider snapshots without duplicating text", () => {
    expect(mergeStreamingText("Hello", "Hello world")).toBe("Hello world");
    expect(resolveStreamingUpdate("Hello", "Hello world")).toEqual({
      kind: "append",
      nextText: "Hello world",
      emittedText: " world",
    });
  });

  it("classifies in-place revisions as replacements", () => {
    expect(resolveStreamingUpdate("helo world", "hello world")).toEqual({
      kind: "replace",
      nextText: "hello world",
      emittedText: "hello world",
    });
  });
});

describe("streaming text fuzz invariants", () => {
  it("treats cumulative snapshots as replacements, not duplicated appends", () => {
    fc.assert(
      fc.property(textArbitrary, textArbitrary, (prefix, suffix) => {
        fc.pre(!(suffix === "" && prefix.length === 1 && /\S/u.test(prefix)));
        const incoming = `${prefix}${suffix}`;

        expect(mergeStreamingText(prefix, incoming)).toBe(incoming);
        expect(computeStreamingDelta(prefix, incoming)).toBe(suffix);
      }),
      { numRuns: 500 },
    );
  });

  it("ignores regressive snapshots that are prefixes of existing text", () => {
    fc.assert(
      fc.property(textArbitrary, textArbitrary, (prefix, suffix) => {
        fc.pre(!(suffix === "" && prefix.length === 1 && /\S/u.test(prefix)));
        const existing = `${prefix}${suffix}`;

        expect(mergeStreamingText(existing, prefix)).toBe(existing);
        expect(resolveStreamingUpdate(existing, prefix)).toEqual({
          kind: "unchanged",
          nextText: existing,
          emittedText: "",
        });
      }),
      { numRuns: 500 },
    );
  });

  it("keeps append/update classification consistent with merged output", () => {
    fc.assert(
      fc.property(textArbitrary, textArbitrary, (existing, incoming) => {
        const update = resolveStreamingUpdate(existing, incoming);
        const merged = mergeStreamingText(existing, incoming);

        expect(update.nextText).toBe(merged);
        if (merged === existing) {
          expect(update).toEqual({
            kind: "unchanged",
            nextText: existing,
            emittedText: "",
          });
        } else if (merged.startsWith(existing)) {
          expect(update.kind).toBe("append");
          expect(update.emittedText).toBe(merged.slice(existing.length));
        } else {
          expect(update.kind).toBe("replace");
          expect(update.emittedText).toBe(merged);
        }
      }),
      { numRuns: 500 },
    );
  });
});
