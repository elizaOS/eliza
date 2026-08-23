import { describe, expect, it } from "vitest";
import { serializeForRuntimeDebug } from "./health-routes.ts";

describe("serializeForRuntimeDebug surrogate safety", () => {
  it("truncates long strings at unicode code point boundaries without lone surrogates", () => {
    const longString = `${"a".repeat(17)}😀${"b".repeat(10)}`;
    const result = serializeForRuntimeDebug(longString, {
      maxDepth: 4,
      maxArrayLength: 20,
      maxObjectKeys: 20,
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
  });
});
