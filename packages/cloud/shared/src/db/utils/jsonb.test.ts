import { describe, expect, it } from "vitest";
import { jsonbParam } from "./jsonb.js";

describe("jsonbParam", () => {
  it("wraps value as jsonb with correct payload", () => {
    const p = jsonbParam({ a: 1 }) as unknown as { queryChunks: unknown[] };
    const chunk = p.queryChunks[1] as string;
    expect(chunk).toBe('{"a":1}');
  });

  it("handles null and undefined as empty object", () => {
    const p1 = jsonbParam(null) as unknown as { queryChunks: unknown[] };
    const p2 = jsonbParam(undefined) as unknown as { queryChunks: unknown[] };
    expect(p1.queryChunks[1]).toBe("{}");
    expect(p2.queryChunks[1]).toBe("{}");
  });

  it("falls back to empty object on circular", () => {
    const circ: Record<string, unknown> = {};
    circ.self = circ;
    const p = jsonbParam(circ) as unknown as { queryChunks: unknown[] };
    expect(p.queryChunks[1]).toBe("{}");
  });
});
