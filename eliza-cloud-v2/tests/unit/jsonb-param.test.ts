import { describe, test, expect } from "bun:test";
import { jsonbParam } from "@/db/utils/jsonb";

describe("jsonbParam", () => {
  test("produces a jsonb cast and binds JSON as a string parameter", () => {
    const q = jsonbParam({});

    // Drizzle SQL objects expose `queryChunks` which include string chunks and param values.
    const chunks = (q as any).queryChunks as any[];

    // Includes the cast token.
    const hasJsonbCast = chunks.some(
      (c) =>
        c?.constructor?.name === "StringChunk" && c?.value?.[0] === "::jsonb",
    );
    expect(hasJsonbCast).toBe(true);

    // The param should be JSON string, not a raw object.
    const hasJsonStringParam = chunks.some(
      (c) => typeof c === "string" && c === "{}",
    );
    expect(hasJsonStringParam).toBe(true);
  });
});
