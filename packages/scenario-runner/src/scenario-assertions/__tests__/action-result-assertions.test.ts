/** Exercises the real scenario action-result assertion factories against captured records. */

import type {
  CapturedAction,
  ScenarioContext,
  ScenarioTurnExecution,
} from "@elizaos/scenario-runner/schema";
import { describe, expect, it } from "vitest";
import {
  expectScenarioActionResultData,
  expectTurnActionResultData,
} from "../action-result-assertions.ts";

function action(overrides: Partial<CapturedAction> = {}): CapturedAction {
  return {
    actionName: "test",
    parameters: {},
    result: { success: true, data: { ok: 1 } },
    ...overrides,
  } as CapturedAction;
}

function turn(actions: CapturedAction[]): ScenarioTurnExecution {
  return { actionsCalled: actions };
}

function ctx(actions: CapturedAction[]): ScenarioContext {
  return { actionsCalled: actions } as ScenarioContext;
}

describe("expectScenarioActionResultData", () => {
  it("returns undefined when the payload satisfies the expectation", () => {
    const check = expectScenarioActionResultData({
      description: "email sent",
      actionName: "SEND_EMAIL",
      includesAll: ["queued", /id-\d+/],
    });
    const c = ctx([
      action({
        actionName: "SEND_EMAIL",
        result: { success: true, data: { status: "QUEUED", id: "id-42" } },
      }),
    ]);
    expect(check(c)).toBeUndefined();
  });

  it("reports no matching action result for an empty context", () => {
    const check = expectScenarioActionResultData({ description: "reply" });
    expect(check(ctx([]))).toBe(
      "Expected reply: no matching action result found.",
    );
  });

  it("filters by a single action name", () => {
    const check = expectScenarioActionResultData({
      description: "send",
      actionName: "SEND_EMAIL",
    });
    const c = ctx([
      action({
        actionName: "DELETE_EMAIL",
        result: { success: true, data: {} },
      }),
    ]);
    expect(check(c)).toBe("Expected send: no matching action result found.");
  });

  it("matches any name from a list of candidate names", () => {
    const check = expectScenarioActionResultData({
      description: "notify",
      actionName: ["SEND_EMAIL", "SEND_SMS"],
      includesAll: ["sms"],
    });
    const c = ctx([
      action({ actionName: "SEND_EMAIL", result: { success: true, data: {} } }),
      action({
        actionName: "SEND_SMS",
        result: { success: true, data: { channel: "SMS" } },
      }),
    ]);
    expect(check(c)).toBeUndefined();
  });

  it("never matches a synthesized reply, even with the right name and payload", () => {
    const check = expectScenarioActionResultData({
      description: "send",
      actionName: "SEND_EMAIL",
      includesAll: ["queued"],
    });
    const c = ctx([
      action({
        actionName: "SEND_EMAIL",
        result: {
          success: true,
          data: { source: "synthesized-reply", status: "QUEUED" },
        },
      }),
    ]);
    expect(check(c)).toBe("Expected send: no matching action result found.");
  });

  it("does not require success when collecting candidate results", () => {
    const check = expectScenarioActionResultData({
      description: "error detail",
      includesAll: ["quota exceeded"],
    });
    const c = ctx([
      action({
        result: { success: false, data: { message: "QUOTA EXCEEDED" } },
      }),
    ]);
    expect(check(c)).toBeUndefined();
  });
});

describe("action result payload blob", () => {
  it("serializes data, falls back to values, and joins matches with ' || '", () => {
    const check = expectScenarioActionResultData({
      description: "payload",
      includesAll: ["__absent__"],
    });
    const c = ctx([
      action({ actionName: "a", result: { success: true, values: { x: 1 } } }),
      action({ actionName: "b", result: { success: true, data: null } }),
    ]);
    expect(check(c)).toBe(
      'Expected payload: result payload missing __absent__. Payload: {"actionName":"a","result":{"x":1}} || {"actionName":"b","result":{}}',
    );
  });

  it("compares strings case-insensitively and RegExp patterns case-sensitively", () => {
    const c = ctx([
      action({ result: { success: true, data: { token: "AbC" } } }),
    ]);
    const loose = expectScenarioActionResultData({
      description: "loose",
      includesAll: ["aBc"],
    });
    expect(loose(c)).toBeUndefined();
    const strict = expectScenarioActionResultData({
      description: "strict",
      includesAll: [/abc/],
    });
    expect(strict(c)).toBe(
      'Expected strict: result payload missing /abc/. Payload: {"actionName":"test","result":{"token":"AbC"}}',
    );
    const flagged = expectScenarioActionResultData({
      description: "flagged",
      includesAll: [/abc/i],
    });
    expect(flagged(c)).toBeUndefined();
  });

  it("passes when any includesAny pattern matches and lists all candidates when none do", () => {
    const c = ctx([
      action({ result: { success: true, data: { state: "SENT" } } }),
    ]);
    const passing = expectScenarioActionResultData({
      description: "any",
      includesAny: ["nope", /sent/i],
    });
    expect(passing(c)).toBeUndefined();
    const failing = expectScenarioActionResultData({
      description: "none",
      includesAny: ["zzz1", "zzz2"],
    });
    expect(failing(c)).toBe(
      'Expected none: result payload missing any of [zzz1, zzz2]. Payload: {"actionName":"test","result":{"state":"SENT"}}',
    );
  });

  it("skips the includesAny check when its array is empty", () => {
    const check = expectScenarioActionResultData({
      description: "empty-any",
      includesAny: [],
    });
    expect(
      check(ctx([action({ result: { success: true, data: {} } })])),
    ).toBeUndefined();
  });

  it("checks includesAll before includesAny when both are provided", () => {
    const check = expectScenarioActionResultData({
      description: "ordering",
      includesAll: ["first-absent"],
      includesAny: ["second-absent"],
    });
    const c = ctx([action({ result: { success: true, data: { k: "v" } } })]);
    expect(check(c)).toBe(
      'Expected ordering: result payload missing first-absent. Payload: {"actionName":"test","result":{"k":"v"}}',
    );
  });
});

describe("expectTurnActionResultData", () => {
  it("validates against turn.actionsCalled", () => {
    const check = expectTurnActionResultData({
      description: "turn send",
      actionName: "DO_THING",
      includesAll: ["done"],
    });
    expect(
      check(
        turn([
          action({
            actionName: "DO_THING",
            result: { success: true, data: { status: "DONE" } },
          }),
        ]),
      ),
    ).toBeUndefined();
    expect(
      check(
        turn([
          action({
            actionName: "OTHER",
            result: { success: true, data: { status: "DONE" } },
          }),
        ]),
      ),
    ).toBe("Expected turn send: no matching action result found.");
  });
});
