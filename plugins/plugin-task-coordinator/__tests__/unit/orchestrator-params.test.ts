// Pure coercion-helper tests for src/orchestrator-params.ts. No mocks: these are
// the exact functions runOrchestratorCapability() relies on to coerce voice/chat
// params into the typed client payloads, so their edge behavior (trim/empty,
// priority whitelist, array filtering, required-id throw) is what protects every
// orchestrator capability from forwarding junk to the client.
import { describe, expect, it } from "vitest";
import {
  paramPriority,
  paramString,
  paramStringArray,
  requireTaskId,
  TASK_LIST_LIMIT,
} from "../../src/orchestrator-params";

describe("orchestrator-params: paramString", () => {
  it("trims surrounding whitespace from a non-empty string", () => {
    expect(paramString("  hello  ")).toBe("hello");
  });

  it("returns the string unchanged when already trimmed", () => {
    expect(paramString("done")).toBe("done");
  });

  it("returns undefined for an empty or whitespace-only string", () => {
    expect(paramString("")).toBeUndefined();
    expect(paramString("   ")).toBeUndefined();
    expect(paramString("\t\n")).toBeUndefined();
  });

  it("returns undefined for non-string inputs", () => {
    expect(paramString(42)).toBeUndefined();
    expect(paramString(null)).toBeUndefined();
    expect(paramString(undefined)).toBeUndefined();
    expect(paramString({ value: "x" })).toBeUndefined();
    expect(paramString(["x"])).toBeUndefined();
    expect(paramString(true)).toBeUndefined();
  });
});

describe("orchestrator-params: paramPriority", () => {
  it("accepts each of the four whitelisted priorities", () => {
    expect(paramPriority("low")).toBe("low");
    expect(paramPriority("normal")).toBe("normal");
    expect(paramPriority("high")).toBe("high");
    expect(paramPriority("urgent")).toBe("urgent");
  });

  it("rejects unknown priority tokens", () => {
    expect(paramPriority("medium")).toBeUndefined();
    expect(paramPriority("critical")).toBeUndefined();
    expect(paramPriority("LOW")).toBeUndefined();
    expect(paramPriority(" high ")).toBeUndefined();
  });

  it("rejects non-string values", () => {
    expect(paramPriority(1)).toBeUndefined();
    expect(paramPriority(null)).toBeUndefined();
    expect(paramPriority(undefined)).toBeUndefined();
  });
});

describe("orchestrator-params: paramStringArray", () => {
  it("trims each entry and drops empties/non-strings", () => {
    expect(paramStringArray(["  a ", "", "b", 7, null, "  ", " c"])).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("returns undefined when nothing survives the filter", () => {
    expect(paramStringArray(["", "   ", 1, null])).toBeUndefined();
    expect(paramStringArray([])).toBeUndefined();
  });

  it("returns undefined for a non-array input", () => {
    expect(paramStringArray("a,b,c")).toBeUndefined();
    expect(paramStringArray(undefined)).toBeUndefined();
    expect(paramStringArray({ 0: "a" })).toBeUndefined();
  });
});

describe("orchestrator-params: requireTaskId", () => {
  it("returns the trimmed taskId when present", () => {
    expect(requireTaskId({ taskId: "  task-9  " })).toBe("task-9");
  });

  it("throws a descriptive error when taskId is missing or blank", () => {
    expect(() => requireTaskId({})).toThrow(/taskId is required/);
    expect(() => requireTaskId(undefined)).toThrow(/taskId is required/);
    expect(() => requireTaskId({ taskId: "   " })).toThrow(
      /taskId is required/,
    );
    expect(() => requireTaskId({ taskId: 5 })).toThrow(/taskId is required/);
  });
});

describe("orchestrator-params: constants", () => {
  it("TASK_LIST_LIMIT is the documented default of 100", () => {
    expect(TASK_LIST_LIMIT).toBe(100);
  });
});
