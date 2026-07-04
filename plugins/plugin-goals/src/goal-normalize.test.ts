/**
 * Unit tests for the `goal-normalize` input coercers and `GoalsServiceError`,
 * asserting the HTTP status each rejection carries. Pure functions, no runtime.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  cloneRecord,
  fail,
  GoalsServiceError,
  goalsErrorMessage,
  isRecord,
  mergeMetadata,
  normalizeEnumValue,
  normalizeNullableRecord,
  normalizeOptionalRecord,
  normalizeOptionalString,
  requireAgentId,
  requireNonEmptyString,
  requireRecord,
} from "./goal-normalize.js";

const rt = (agentId: unknown): IAgentRuntime =>
  ({ agentId }) as unknown as IAgentRuntime;

function expectFail(fn: () => unknown, status: number): GoalsServiceError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(GoalsServiceError);
    expect((e as GoalsServiceError).status).toBe(status);
    return e as GoalsServiceError;
  }
  throw new Error("expected a GoalsServiceError to be thrown");
}

describe("goal-normalize errors", () => {
  it("fail throws a status-carrying GoalsServiceError", () => {
    const err = expectFail(() => fail(404, "nope", "NOT_FOUND"), 404);
    expect(err.message).toBe("nope");
    expect(err.code).toBe("NOT_FOUND");
  });

  it("goalsErrorMessage unwraps Error vs stringifies", () => {
    expect(goalsErrorMessage(new Error("boom"))).toBe("boom");
    expect(goalsErrorMessage("plain")).toBe("plain");
    expect(goalsErrorMessage(7)).toBe("7");
  });
});

describe("requireAgentId / required strings", () => {
  it("returns a present agentId and fails (500) otherwise", () => {
    expect(requireAgentId(rt("agent-1"))).toBe("agent-1");
    expectFail(() => requireAgentId(rt("")), 500);
    expectFail(() => requireAgentId(rt(undefined)), 500);
  });

  it("requireNonEmptyString trims and rejects non-strings/empties (400)", () => {
    expect(requireNonEmptyString("  hi  ", "f")).toBe("hi");
    expectFail(() => requireNonEmptyString("", "f"), 400);
    expectFail(() => requireNonEmptyString(5, "f"), 400);
  });

  it("normalizeOptionalString collapses empties to undefined", () => {
    expect(normalizeOptionalString("  x ")).toBe("x");
    expect(normalizeOptionalString("   ")).toBeUndefined();
    expect(normalizeOptionalString(5)).toBeUndefined();
  });
});

describe("normalizeEnumValue", () => {
  const allowed = ["a", "b"] as const;
  it("returns valid members and the fallback for empties", () => {
    expect(normalizeEnumValue("a", "f", allowed)).toBe("a");
    expect(normalizeEnumValue(undefined, "f", allowed, "b")).toBe("b");
    expect(normalizeEnumValue("", "f", allowed, "b")).toBe("b");
  });
  it("rejects out-of-set values (400)", () => {
    expectFail(() => normalizeEnumValue("z", "f", allowed), 400);
    // no fallback + empty → required error
    expectFail(() => normalizeEnumValue(undefined, "f", allowed), 400);
  });
});

describe("record helpers", () => {
  it("isRecord distinguishes plain objects", () => {
    expect(isRecord({ a: 1 })).toBe(true);
    expect(isRecord([])).toBe(false);
    expect(isRecord(null)).toBe(false);
    expect(isRecord("x")).toBe(false);
  });

  it("cloneRecord copies or yields {}", () => {
    const src = { a: 1 };
    const out = cloneRecord(src);
    expect(out).toEqual({ a: 1 });
    expect(out).not.toBe(src);
    expect(cloneRecord([])).toEqual({});
    expect(cloneRecord(null)).toEqual({});
  });

  it("requireRecord returns a copy or fails (400)", () => {
    const src = { a: 1 };
    const out = requireRecord(src, "f");
    expect(out).toEqual({ a: 1 });
    expect(out).not.toBe(src);
    expectFail(() => requireRecord([], "f"), 400);
    expectFail(() => requireRecord("x", "f"), 400);
  });

  it("optional/nullable record variants pass through undefined/null", () => {
    expect(normalizeOptionalRecord(undefined, "f")).toBeUndefined();
    expect(normalizeOptionalRecord({ a: 1 }, "f")).toEqual({ a: 1 });
    expectFail(() => normalizeOptionalRecord("x", "f"), 400);

    expect(normalizeNullableRecord(undefined, "f")).toBeUndefined();
    expect(normalizeNullableRecord(null, "f")).toBeNull();
    expect(normalizeNullableRecord({ a: 1 }, "f")).toEqual({ a: 1 });
  });
});

describe("mergeMetadata privacy defaulting", () => {
  it("merges updates over current", () => {
    expect(
      mergeMetadata({ a: 1 }, { b: 2, privacyClass: "team" }),
    ).toMatchObject({ a: 1, b: 2, privacyClass: "team" });
  });

  it("defaults privacyClass to private and blocks public context", () => {
    const out = mergeMetadata({});
    expect(out.privacyClass).toBe("private");
    expect(out.publicContextBlocked).toBe(true);

    const blank = mergeMetadata({ privacyClass: "  " });
    expect(blank.privacyClass).toBe("private");
    expect(blank.publicContextBlocked).toBe(true);
  });

  it("does not block public context for an explicit non-private class", () => {
    const out = mergeMetadata({ privacyClass: "public" });
    expect(out.privacyClass).toBe("public");
    expect(out.publicContextBlocked).toBeUndefined();
  });
});
