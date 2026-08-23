/**
 * Behavioral regression for error J2 — context-adding rethrow must preserve cause
 */
import { describe, it, expect } from "vitest";
import { ElizaError } from "../errors";

function riskyOp(cause: Error): never {
  try {
    throw cause;
  } catch (err) {
    // J2: wrap with typed error preserving cause
    throw new ElizaError("wrapped", { code: "TEST_J2", cause: err, context: { scope: "test" } });
  }
}

describe("error J2 — real ElizaError cause", () => {
  it("preserves cause", () => {
    const cause = new Error("original");
    try {
      riskyOp(cause);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ElizaError);
      expect((e as ElizaError).cause).toBe(cause);
      expect((e as ElizaError).code).toBe("TEST_J2");
    }
  });
  it("cause chain visible", () => {
    const cause = new Error("deep");
    const err = new ElizaError("wrap", { code: "A", cause });
    expect(err.cause).toBe(cause);
    expect(err.message).toBe("wrap");
  });
});
