import { describe, expect, test } from "bun:test";
import { StringChunk } from "drizzle-orm";
import { jsonbParam } from "@/db/utils/jsonb";

describe("jsonbParam", () => {
  test("produces a jsonb cast and binds JSON as a string parameter", () => {
    const q = jsonbParam({});

    // Drizzle SQL objects expose `queryChunks` which include string chunks and param values.
    const chunks = q.queryChunks;

    // Includes the cast token.
    const hasJsonbCast = chunks.some(
      (chunk) => chunk instanceof StringChunk && chunk.value.includes("::jsonb"),
    );
    expect(hasJsonbCast).toBe(true);

    // The param should be JSON string, not a raw object.
    const hasJsonStringParam = chunks.some((chunk) => typeof chunk === "string" && chunk === "{}");
    expect(hasJsonStringParam).toBe(true);
  });
});
