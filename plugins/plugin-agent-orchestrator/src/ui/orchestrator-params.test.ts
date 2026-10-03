// Coverage for the orchestrator capability param coercion/validation helpers,
// shared by the workbench and the voice/chat capability dispatcher. These guard
// what reaches the agent-orchestrator task API, so their accept/reject contract
// is pinned here.

import { describe, expect, it } from "vitest";
import {
  paramPriority,
  paramString,
  paramStringArray,
  requireTaskId,
} from "./orchestrator-params";

describe("paramString", () => {
  it("trims non-empty strings and rejects everything else", () => {
    expect(paramString("  hi  ")).toBe("hi");
    expect(paramString("")).toBeUndefined();
    expect(paramString("   ")).toBeUndefined();
    expect(paramString(5)).toBeUndefined();
    expect(paramString(null)).toBeUndefined();
  });
});

describe("paramPriority", () => {
  it("accepts only the known priority literals", () => {
    expect(paramPriority("low")).toBe("low");
    expect(paramPriority("urgent")).toBe("urgent");
    expect(paramPriority("bogus")).toBeUndefined();
    expect(paramPriority(3)).toBeUndefined();
  });
});

describe("paramStringArray", () => {
  it("keeps trimmed non-empty string entries, else undefined", () => {
    expect(paramStringArray(["a", "", "  b  ", 2])).toEqual(["a", "b"]);
    expect(paramStringArray([])).toBeUndefined();
    expect(paramStringArray(["", "   "])).toBeUndefined();
    expect(paramStringArray("not-an-array")).toBeUndefined();
  });
});

describe("requireTaskId", () => {
  it("returns the trimmed taskId or throws when absent", () => {
    expect(requireTaskId({ taskId: "  t1  " })).toBe("t1");
    expect(() => requireTaskId({})).toThrow(/taskId is required/);
    expect(() => requireTaskId()).toThrow(/taskId is required/);
    expect(() => requireTaskId({ taskId: "" })).toThrow(/taskId is required/);
  });
});
