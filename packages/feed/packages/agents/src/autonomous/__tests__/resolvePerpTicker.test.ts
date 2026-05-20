import { describe, expect, test } from "bun:test";
import { resolvePerpTicker } from "../utils/resolvePerpTicker";

describe("resolvePerpTicker", () => {
  test("matches canonical ticker regardless of casing", () => {
    const result = resolvePerpTicker("tslai");
    expect(result).not.toBeNull();
    expect(result?.ticker).toBe("TSLAI");
  });

  test("matches by organization id", () => {
    const result = resolvePerpTicker("teslai");
    expect(result?.ticker).toBe("TSLAI");
  });

  test("matches by parody name", () => {
    const result = resolvePerpTicker("TeslAI");
    expect(result?.ticker).toBe("TSLAI");
  });

  test("matches by original name", () => {
    const result = resolvePerpTicker("Tesla");
    expect(result?.ticker).toBe("TSLAI");
  });

  test("handles empty-like inputs gracefully", () => {
    expect(resolvePerpTicker("")).toBeNull();
    expect(resolvePerpTicker("   ")).toBeNull();
    expect(resolvePerpTicker(undefined)).toBeNull();
    expect(resolvePerpTicker(null)).toBeNull();
  });

  test("handles special characters in identifier", () => {
    const result = resolvePerpTicker("$TSLAI!!");
    expect(result?.ticker).toBe("TSLAI");
  });

  test("supports prefix partial matches but avoids mid-string matches", () => {
    expect(resolvePerpTicker("tes")).not.toBeNull();
    expect(resolvePerpTicker("tes")?.ticker).toBe("TSLAI");
    expect(resolvePerpTicker("sla")).toBeNull();
  });

  test("returns null for unknown identifiers", () => {
    expect(resolvePerpTicker("not-real")).toBeNull();
  });
});
