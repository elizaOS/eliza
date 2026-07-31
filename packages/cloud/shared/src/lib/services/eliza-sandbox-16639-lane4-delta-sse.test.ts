/**
 * Exercises ElizaSandboxService delta-SSE framing over the real streaming
 * bridge ladder. This path has its own entry because the other sandbox
 * composites do not drive streaming responses.
 */
import { describe, expect, test } from "bun:test";
import "./eliza-sandbox-bridge-delta-sse.test.ts";

describe("eliza-sandbox composite lane 4 (bridge delta-SSE)", () => {
  test("runs under bun with its composed suite", () => {
    expect(typeof test).toBe("function");
  });
});
