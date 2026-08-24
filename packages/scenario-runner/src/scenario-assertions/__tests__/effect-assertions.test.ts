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

describe("toRecord additional coercions", () => {
  it("rejects undefined, numbers, and booleans", () => {
    expect(toRecord(undefined)).toBeNull();
    expect(toRecord(42)).toBeNull();
    expect(toRecord(true)).toBeNull();
  });

  it("returns the identical object reference for objects", () => {
    const value = { nested: { deep: 1 } };
    expect(toRecord(value)).toBe(value);
  });

  it("passes class instances through as records", () => {
    const date = new Date(0);
    expect(toRecord(date)).toBe(date);
  });
});

describe("successfulActionData payload coercion", () => {
  it("skips successful calls whose data is not an object", () => {
    const c = ctx([
      action({
        actionName: "t",
        result: { success: true, data: "plain-text" },
      }),
      action({ actionName: "t", result: { success: true, data: [1, 2] } }),
      action({ actionName: "t", result: { success: true, data: null } }),
      action({ actionName: "t", result: { success: true, data: { good: 1 } } }),
    ]);
    expect(successfulActionData(c, "t")).toEqual({ good: 1 });
  });

  it("returns null when no qualifying call carries an object payload", () => {
    const c = ctx([
      action({ actionName: "t", result: { success: true, data: "s" } }),
      action({ actionName: "t", result: { success: true, data: null } }),
    ]);
    expect(successfulActionData(c, "t")).toBeNull();
  });

  it("only skips exact synthesized-reply markers", () => {
    const c = ctx([
      action({
        actionName: "t",
        result: {
          success: true,
          data: { source: "synthesized-reply-v2" },
        },
      }),
    ]);
    expect(successfulActionData(c, "t")).toEqual({
      source: "synthesized-reply-v2",
    });
  });
});

describe("successfulCalls ordering and filtering", () => {
  it("returns matching calls in capture order with identity intact", () => {
    const first = action({
      actionName: "t",
      result: { success: true, data: { n: 1 } },
    });
    const second = action({
      actionName: "t",
      result: { success: true, data: { n: 2 } },
    });
    const noise = action({
      actionName: "other",
      result: { success: true, data: { n: 3 } },
    });
    const failed = action({
      actionName: "t",
      result: { success: false, data: { n: 4 } },
    });
    const synthesized = action({
      actionName: "t",
      result: { success: true, data: { source: "synthesized-reply" } },
    });
    const result = successfulCalls(
      ctx([first, noise, failed, synthesized, second]),
      ["t", "u"],
    );
    expect(result).toEqual([first, second]);
    expect(result[0]).toBe(first);
    expect(result[1]).toBe(second);
  });

  it("returns an empty list for an empty context", () => {
    expect(successfulCalls(ctx([]), "t")).toEqual([]);
  });
});

describe("callPayloadBlob serialization details", () => {
  it("renders missing parameters and results as nulls", () => {
    const c = ctx([{ actionName: "t" } as CapturedAction]);
    expect(callPayloadBlob(c, "t")).toBe(
      '[{"parameters":null,"data":null,"text":null}]',
    );
  });

  it("excludes calls to other actions entirely", () => {
    const c = ctx([
      action({ actionName: "DeleteAll", result: { success: true } }),
      action({ actionName: "SendEmail", result: { success: true } }),
    ]);
    const blob = callPayloadBlob(c, "SendEmail");
    expect(blob).not.toContain("DeleteAll");
    expect(JSON.parse(blob)).toHaveLength(1);
  });

  it("keeps capture order across multiple matching calls", () => {
    const c = ctx([
      action({
        actionName: "t",
        result: { success: true, data: { n: 1 } },
      }),
      action({
        actionName: "t",
        result: { success: true, data: { n: 2 } },
      }),
    ]);
    const parsed = JSON.parse(callPayloadBlob(c, "t")) as Array<{
      data: { n: number };
    }>;
    expect(parsed.map((entry) => entry.data.n)).toEqual([1, 2]);
  });

  it("matches action names case-sensitively while lowercasing content", () => {
    const c = ctx([
      action({ actionName: "SendEmail", result: { success: true } }),
    ]);
    expect(callPayloadBlob(c, "sendemail")).toBe("[]");
  });
});

describe("describeCalls rendering details", () => {
  it("joins multiple call summaries with ' | '", () => {
    const c = ctx([
      action({ actionName: "one", result: { success: true } }),
      action({ actionName: "two", result: { success: true } }),
    ]);
    const detail = describeCalls(c);
    expect(detail).toContain("one(success=true");
    expect(detail).toContain(" | two(success=true");
  });

  it("truncates oversized data payloads at 200 characters", () => {
    const c = ctx([
      action({
        actionName: "go",
        result: { success: true, data: { k: "a".repeat(210) } },
      }),
    ]);
    const detail = describeCalls(c);
    expect(detail).toContain(`"k":"${"a".repeat(150)}`);
    expect(detail).not.toContain("a".repeat(195));
  });

  it("renders failures and missing results explicitly", () => {
    const failedOnly = ctx([
      action({ actionName: "go", result: { success: false } }),
    ]);
    expect(describeCalls(failedOnly)).toContain("go(success=false");
    const bare = ctx([{ actionName: "go" } as CapturedAction]);
    expect(describeCalls(bare)).toBe("go(success=undefined, data=null)");
  });
});

describe("expectNoActionCalled failure details", () => {
  it("lists every offending call and omits clean ones", () => {
    const message = expectNoActionCalled(
      ctx([
        action({ actionName: "bad", result: { success: true, data: null } }),
        action({ actionName: "fine" }),
        action({ actionName: "worse" }),
      ]),
      ["bad", "worse"],
    );
    expect(message).toContain("expected none of [bad, worse]");
    expect(message).toContain("bad(success=true");
    expect(message).toContain("worse(success=true");
    expect(message).not.toContain("fine");
  });

  it("passes when the forbidden list is empty", () => {
    const result = expectNoActionCalled(ctx([action({ actionName: "x" })]), []);
    expect(result).toBeUndefined();
  });
});
