/**
 * Covers the native scorers: planner action/view extraction and the view-aware
 * agreement score (pure).
 */

import { describe, expect, it } from "vitest";
import {
  extractPlannerAction,
  extractPlannerView,
  scoreAgreement,
  scorePlannerAction,
} from "./scoring.js";

describe("extractPlannerAction", () => {
  it("reads v5 toolCalls shape", () => {
    expect(
      extractPlannerAction('{"toolCalls":[{"name":"VIEWS","args":{}}]}'),
    ).toBe("VIEWS");
  });

  it("reads bare {action, parameters} shape", () => {
    expect(
      extractPlannerAction('{"action":"VIEWS","parameters":{"view":"inbox"}}'),
    ).toBe("VIEWS");
  });

  it("reads top-level action field, upper-cased", () => {
    expect(extractPlannerAction('{"action":"reply"}')).toBe("REPLY");
  });

  it("falls back to the XML <actions> token via the uppercase regex", () => {
    expect(
      extractPlannerAction(
        "<response><thought>nav</thought><actions>VIEWS</actions></response>",
      ),
    ).toBe("VIEWS");
  });

  it("returns null for empty input", () => {
    expect(extractPlannerAction("")).toBeNull();
  });
});

describe("extractPlannerView", () => {
  it("reads view from a tool-call args object", () => {
    expect(
      extractPlannerView(
        '{"toolCalls":[{"name":"VIEWS","args":{"action":"show","view":"calendar"}}]}',
      ),
    ).toBe("calendar");
  });

  it("reads view from tool-call arguments/parameters aliases", () => {
    expect(
      extractPlannerView(
        '{"toolCalls":[{"name":"VIEWS","arguments":{"view":"wallet"}}]}',
      ),
    ).toBe("wallet");
    expect(
      extractPlannerView(
        '{"toolCalls":[{"name":"VIEWS","parameters":{"view":"finances"}}]}',
      ),
    ).toBe("finances");
  });

  it("reads view from bare {action, parameters}", () => {
    expect(
      extractPlannerView('{"action":"VIEWS","parameters":{"view":"inbox"}}'),
    ).toBe("inbox");
  });

  it("reads viewId / id / target aliases", () => {
    expect(extractPlannerView('{"viewId":"goals"}')).toBe("goals");
    expect(
      extractPlannerView('{"action":"VIEWS","parameters":{"id":"health"}}'),
    ).toBe("health");
    expect(
      extractPlannerView('{"action":"VIEWS","parameters":{"target":"todos"}}'),
    ).toBe("todos");
  });

  it("lower-cases the view id", () => {
    expect(
      extractPlannerView('{"action":"VIEWS","parameters":{"view":"Calendar"}}'),
    ).toBe("calendar");
  });

  it("does NOT treat the top-level tool name as a view", () => {
    // `name` is the action name at tool-call level — must not be read as a view.
    expect(
      extractPlannerView('{"toolCalls":[{"name":"VIEWS","args":{}}]}'),
    ).toBeNull();
  });

  it("returns null when no view is present", () => {
    expect(extractPlannerView('{"action":"REPLY"}')).toBeNull();
    expect(extractPlannerView("")).toBeNull();
  });
});

describe("scorePlannerAction — action only (back-compat)", () => {
  it("rewards an exact action match", () => {
    expect(scorePlannerAction('{"action":"REPLY"}', '{"action":"REPLY"}')).toBe(
      1,
    );
  });

  it("punishes a mismatched action", () => {
    expect(scorePlannerAction('{"action":"REPLY"}', '{"action":"VIEWS"}')).toBe(
      0,
    );
  });

  it("returns 0 when the expected action is unreadable", () => {
    expect(scorePlannerAction('{"action":"REPLY"}', "")).toBe(0);
  });

  it("returns 0 when the actual action is unreadable", () => {
    expect(scorePlannerAction("", '{"action":"REPLY"}')).toBe(0);
  });
});

describe("scorePlannerAction — view-aware (the fix)", () => {
  const want = '{"action":"VIEWS","parameters":{"view":"calendar"}}';

  it("gives full credit only when BOTH action and view match", () => {
    expect(
      scorePlannerAction(
        '{"action":"VIEWS","parameters":{"view":"calendar"}}',
        want,
      ),
    ).toBe(1);
  });

  it("gives partial credit (0.5) for the right action but the wrong view", () => {
    // This is the gap that made entry-tier wrong-view output look perfect.
    expect(
      scorePlannerAction(
        '{"action":"VIEWS","parameters":{"view":"wallet"}}',
        want,
      ),
    ).toBe(0.5);
  });

  it("gives partial credit (0.5) for the right action but a missing view", () => {
    expect(scorePlannerAction('{"action":"VIEWS"}', want)).toBe(0.5);
  });

  it("gives zero for the wrong action even with a coincidentally-named view", () => {
    expect(
      scorePlannerAction(
        '{"action":"REPLY","parameters":{"view":"calendar"}}',
        want,
      ),
    ).toBe(0);
  });

  it("matches views case-insensitively across tool-call and bare shapes", () => {
    expect(
      scorePlannerAction(
        '{"toolCalls":[{"name":"VIEWS","args":{"view":"CALENDAR"}}]}',
        want,
      ),
    ).toBe(1);
  });

  it("scores non-view actions action-only (no view in expected)", () => {
    // No view in expected => behaves exactly like the old action-only scorer.
    expect(
      scorePlannerAction(
        '{"action":"WALLET","parameters":{"to":"0xabc"}}',
        '{"action":"WALLET"}',
      ),
    ).toBe(1);
  });
});

describe("scoreAgreement", () => {
  it("is 1.0 for identical token sets", () => {
    expect(scoreAgreement("open the calendar", "open the calendar")).toBe(1);
  });

  it("is 0 for disjoint token sets", () => {
    expect(scoreAgreement("alpha beta", "gamma delta")).toBe(0);
  });
});
