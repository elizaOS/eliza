import { describe, expect, it } from "vitest";
import { serializeForRuntimeDebug } from "./health-routes.ts";

describe("serializeForRuntimeDebug surrogate safety", () => {
  it("truncates long strings at unicode code point boundaries without lone surrogates", () => {
    // 16 leading "a" puts the old slice(0, maxStringLength - 3) boundary at index
    // 17, i.e. between the two code units of the astral char. With 17 the cut
    // landed cleanly before it, so the old code produced no lone surrogate and
    // this test passed against unfixed code.
    const longString = `${"a".repeat(16)}😀${"b".repeat(10)}`;
    const result = serializeForRuntimeDebug(longString, {
      maxDepth: 4,
      maxArrayLength: 20,
      maxObjectEntries: 20,
      maxStringLength: 20,
    }) as {
      __type: string;
      length: number;
      preview: string;
      truncated: boolean;
    };

    expect(result.__type).toBe("string");
    expect(result.truncated).toBe(true);
    expect(result.preview.endsWith("...")).toBe(true);
    expect(result.preview.includes("😀")).toBe(false);
    // The real invariant: truncation must not leave an unpaired surrogate.
    expect(result.preview).toBe(result.preview.toWellFormed());
    expect(
      /[\uD800-\uDFFF]/.test(
        result.preview.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, ""),
      ),
    ).toBe(false);
  });
});
