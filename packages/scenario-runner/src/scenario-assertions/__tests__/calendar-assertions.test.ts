/** Exercises the real calendar assertion factories against captured CALENDAR calls. */

import type {
  CapturedAction,
  ScenarioContext,
} from "@elizaos/scenario-runner/schema";
import { describe, expect, it } from "vitest";
import {
  expectCalendarPayload,
  expectCalendarResultData,
} from "../calendar-assertions.ts";

function action(overrides: Partial<CapturedAction> = {}): CapturedAction {
  return {
    actionName: "CALENDAR",
    parameters: {},
    result: { success: true, data: { ok: 1 } },
    ...overrides,
  } as CapturedAction;
}

function ctx(actions: CapturedAction[]): ScenarioContext {
  return { actionsCalled: actions } as ScenarioContext;
}

describe("expectCalendarResultData", () => {
  it("fails when no action was called at all", () => {
    const check = expectCalendarResultData({ description: "event created" });
    const result = check(ctx([]));
    expect(result).toContain("Expected successful CALENDAR action");
    expect(result).toContain("(no actions called)");
  });

  it("fails when only non-CALENDAR actions ran", () => {
    const check = expectCalendarResultData({ description: "event created" });
    const result = check(ctx([action({ actionName: "SEND_EMAIL" })]));
    expect(result).toContain("Expected successful CALENDAR action");
    expect(result).toContain("SEND_EMAIL(success=true");
  });

  it("ignores failed CALENDAR calls", () => {
    const check = expectCalendarResultData({ description: "event created" });
    const result = check(
      ctx([
        action({
          result: { success: false, data: { title: "Standup" }, text: "ok" },
        }),
      ]),
    );
    expect(result).toContain("Expected successful CALENDAR action");
    expect(result).toContain("CALENDAR(success=false");
  });

  it("ignores synthesized replies", () => {
    const check = expectCalendarResultData({ description: "event created" });
    const result = check(
      ctx([
        action({
          result: {
            success: true,
            data: { source: "synthesized-reply", title: "Standup" },
          },
        }),
      ]),
    );
    expect(result).toContain("Expected successful CALENDAR action");
  });

  it("passes when successful data satisfies includesAll case-insensitively", () => {
    const check = expectCalendarResultData({
      description: "event created",
      includesAll: ["Event-ID-42"],
    });
    expect(
      check(
        ctx([
          action({ result: { success: true, data: { id: "event-id-42" } } }),
        ]),
      ),
    ).toBeUndefined();
  });

  it("tests RegExp patterns against the serialized data", () => {
    const passing = expectCalendarResultData({
      description: "event created",
      includesAll: [/standup-\d+/],
    });
    expect(
      passing(
        ctx([
          action({ result: { success: true, data: { title: "Standup-7" } } }),
        ]),
      ),
    ).toBeUndefined();

    const failing = expectCalendarResultData({
      description: "event created",
      includesAll: [/weekly-\d{3}/],
    });
    expect(
      failing(
        ctx([
          action({ result: { success: true, data: { title: "Standup-7" } } }),
        ]),
      ),
    ).toContain("missing /weekly-\\d{3}/");
  });

  it("reports the first missing includesAll pattern with the description and payload preview", () => {
    const check = expectCalendarResultData({
      description: "event created",
      includesAll: ["alpha", "beta"],
    });
    const result = check(
      ctx([action({ result: { success: true, data: { note: "alpha" } } })]),
    );
    expect(result).toContain("Expected event created: missing beta");
    expect(result).toContain('"note":"alpha"');
  });

  it("preserves the complete payload when an assertion fails", () => {
    const distinguishingTail = "calendar-evidence-tail";
    const check = expectCalendarResultData({
      description: "event created",
      includesAll: ["missing"],
    });
    const result = check(
      ctx([
        action({
          result: {
            success: true,
            data: { note: `${"x".repeat(700)}${distinguishingTail}` },
          },
        }),
      ]),
    );
    expect(result).toContain(distinguishingTail);
  });

  it("checks includesAll before includesAny", () => {
    const check = expectCalendarResultData({
      description: "event created",
      includesAll: ["zzz"],
      includesAny: ["yyy"],
    });
    const result = check(
      ctx([action({ result: { success: true, data: { note: "neither" } } })]),
    );
    expect(result).toContain("missing zzz");
    expect(result).not.toContain("missing any of");
  });

  it("passes when any includesAny alternative matches", () => {
    const check = expectCalendarResultData({
      description: "event created",
      includesAny: ["nope", "standup"],
    });
    expect(
      check(
        ctx([
          action({ result: { success: true, data: { title: "Standup" } } }),
        ]),
      ),
    ).toBeUndefined();
  });

  it("fails when no includesAny alternative matches", () => {
    const check = expectCalendarResultData({
      description: "event created",
      includesAny: ["nope", "nada"],
    });
    const result = check(
      ctx([action({ result: { success: true, data: { title: "Standup" } } })]),
    );
    expect(result).toContain("missing any of [nope, nada]");
    expect(result).toContain('"title":"standup"');
  });

  it("skips includesAny when it is absent or empty", () => {
    const empty = expectCalendarResultData({
      description: "event created",
      includesAny: [],
    });
    expect(
      empty(ctx([action({ result: { success: true, data: { ok: true } } })])),
    ).toBeUndefined();
  });

  it("requires one data-bearing call by default and counts null data as missing", () => {
    const check = expectCalendarResultData({ description: "event created" });
    const noData = check(
      ctx([action({ result: { success: true, text: "done" } })]),
    );
    expect(noData).toContain("successful CALENDAR result data, saw 0");

    const nullData = check(
      ctx([action({ result: { success: true, data: null } })]),
    );
    expect(nullData).toContain("saw 0");
  });

  it("honours an explicit minCount", () => {
    const strict = expectCalendarResultData({
      description: "two events",
      minCount: 2,
      includesAll: ["standup"],
    });
    const single = strict(
      ctx([action({ result: { success: true, data: { title: "Standup" } } })]),
    );
    expect(single).toContain("saw 1");

    const both = strict(
      ctx([
        action({ result: { success: true, data: { title: "Standup" } } }),
        action({ result: { success: true, data: { series: "standup" } } }),
      ]),
    );
    expect(both).toBeUndefined();
  });
});

describe("expectCalendarPayload", () => {
  it("matches tokens found in parameters", () => {
    const check = expectCalendarPayload({
      description: "event arguments",
      includesAll: ["standup"],
    });
    expect(
      check(
        ctx([
          action({
            parameters: { title: "Standup" },
            result: { success: true },
          }),
        ]),
      ),
    ).toBeUndefined();
  });

  it("matches tokens found in result text", () => {
    const check = expectCalendarPayload({
      description: "event confirmation",
      includesAll: ["event created"],
    });
    expect(
      check(
        ctx([
          action({
            result: { success: true, text: "Event Created: Standup" },
          }),
        ]),
      ),
    ).toBeUndefined();
  });

  it("excludes failed calls from the payload blob", () => {
    const check = expectCalendarPayload({
      description: "event arguments",
      includesAll: ["standup"],
    });
    const result = check(
      ctx([
        action({
          parameters: { title: "Standup" },
          result: { success: false },
        }),
      ]),
    );
    expect(result).toContain("Expected successful CALENDAR action");
  });

  it("excludes synthesized replies whose parameters carry the token", () => {
    const check = expectCalendarPayload({
      description: "event arguments",
      includesAll: ["standup"],
    });
    const result = check(
      ctx([
        action({
          parameters: { title: "Standup" },
          result: {
            success: true,
            data: { source: "synthesized-reply", title: "Standup" },
          },
        }),
      ]),
    );
    expect(result).toContain("Expected successful CALENDAR action");
  });

  it("reports missing patterns with the lowercased payload preview", () => {
    const check = expectCalendarPayload({
      description: "event arguments",
      includesAll: ["gym"],
    });
    const result = check(
      ctx([
        action({
          parameters: { title: "Standup" },
          result: { success: true, data: { id: "E-1" }, text: "Booked" },
        }),
      ]),
    );
    expect(result).toContain("Expected event arguments: missing gym");
    expect(result).toContain('"title":"standup"');
    expect(result).toContain('"text":"booked"');
  });

  it("renders absent fields as null instead of dropping them", () => {
    const check = expectCalendarPayload({
      description: "event arguments",
      includesAll: ["anything"],
    });
    const result = check(
      ctx([action({ parameters: undefined, result: { success: true } })]),
    );
    expect(result).toContain('"parameters":null');
    expect(result).toContain('"data":null');
    expect(result).toContain('"text":null');
  });
});
