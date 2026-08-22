/** Exercises the real scenario effect-assertion helpers against captured action records. */

import type {
  CapturedAction,
  ScenarioContext,
} from "@elizaos/scenario-runner/schema";
import { describe, expect, it } from "vitest";
import {
  callPayloadBlob,
  describeCalls,
  expectNoActionCalled,
  successfulActionData,
  successfulCalls,
  toRecord,
} from "../effect-assertions.ts";

function action(overrides: Partial<CapturedAction> = {}): CapturedAction {
  return {
    actionName: "test",
    parameters: {},
    result: { success: true, data: { ok: 1 } },
    ...overrides,
  } as CapturedAction;
}

function ctx(actions: CapturedAction[]): ScenarioContext {
  return { actionsCalled: actions } as ScenarioContext;
}

describe("toRecord", () => {
  it("accepts plain objects and rejects everything else", () => {
    expect(toRecord({ a: 1 })).toEqual({ a: 1 });
    expect(toRecord(null)).toBeNull();
    expect(toRecord([])).toBeNull();
    expect(toRecord("x")).toBeNull();
  });
});

describe("successfulActionData", () => {
  it("returns the first successful non-synthesized data payload", () => {
    const c = ctx([
      action({ actionName: "other" }),
      action({
        actionName: "target",
        result: { success: true, data: { value: 42 } },
      }),
    ]);
    expect(successfulActionData(c, "target")).toEqual({ value: 42 });
  });

  it("accepts multiple names", () => {
    const c = ctx([
      action({ actionName: "b", result: { success: true, data: { x: 1 } } }),
    ]);
    expect(successfulActionData(c, ["a", "b"])).toEqual({ x: 1 });
  });

  it("skips failed and synthesized replies", () => {
    const c = ctx([
      action({ actionName: "t", result: { success: false, data: { bad: 1 } } }),
      action({
        actionName: "t",
        result: { success: true, data: { source: "synthesized-reply" } },
      }),
      action({ actionName: "t", result: { success: true, data: { good: 2 } } }),
    ]);
    expect(successfulActionData(c, "t")).toEqual({ good: 2 });
  });

  it("returns null when nothing qualifies", () => {
    expect(successfulActionData(ctx([]), "missing")).toBeNull();
  });
});

describe("successfulCalls", () => {
  it("filters successful non-synthesized calls", () => {
    const calls = [
      action({ actionName: "t" }),
      action({ actionName: "t", result: { success: false, data: null } }),
      action({
        actionName: "t",
        result: { success: true, data: { source: "synthesized-reply" } },
      }),
    ];
    expect(successfulCalls(ctx(calls), "t")).toHaveLength(1);
  });
});

describe("callPayloadBlob", () => {
  it("lowercases the JSON blob of matching calls", () => {
    const c = ctx([
      action({
        actionName: "SendEmail",
        parameters: { to: "A@B.C" },
        result: { success: true, data: { id: "X" }, text: "SENT" },
      }),
    ]);
    const blob = callPayloadBlob(c, "SendEmail");
    expect(blob).toContain('"to":"a@b.c"');
    expect(blob).toContain('"id":"x"');
    expect(blob).toBe(blob.toLowerCase());
  });
});

describe("describeCalls", () => {
  it("summarizes calls and handles the empty case", () => {
    expect(describeCalls(ctx([]))).toBe("(no actions called)");
    const c = ctx([
      action({ actionName: "go", result: { success: true, data: null } }),
    ]);
    expect(describeCalls(c)).toContain("go(success=true");
  });
});

describe("expectNoActionCalled", () => {
  it("returns undefined when no forbidden action fired", () => {
    expect(
      expectNoActionCalled(ctx([action({ actionName: "ok" })]), ["bad"]),
    ).toBeUndefined();
  });

  it("returns a failure message when a forbidden action fired", () => {
    const message = expectNoActionCalled(ctx([action({ actionName: "bad" })]), [
      "bad",
      "worse",
    ]);
    expect(message).toContain("expected none of");
    expect(message).toContain("bad");
  });
});
