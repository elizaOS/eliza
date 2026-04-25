import { describe, expect, it } from "vitest";
import {
  buildAutomationsHash,
  buildLifeOpsHash,
  parseAutomationsRoute,
  parseHashParams,
  parseLifeOpsRoute,
  serializeHashParams,
} from "./lifeops-route";

describe("parseHashParams", () => {
  it("returns empty for empty / '#' hashes", () => {
    expect(parseHashParams("")).toEqual({});
    expect(parseHashParams("#")).toEqual({});
  });

  it("parses simple key=value&... with and without leading #", () => {
    expect(parseHashParams("a=1&b=2")).toEqual({ a: "1", b: "2" });
    expect(parseHashParams("#a=1&b=2")).toEqual({ a: "1", b: "2" });
  });

  it("decodes URL-encoded values", () => {
    expect(parseHashParams("#x=hello%20world&y=a%26b")).toEqual({
      x: "hello world",
      y: "a&b",
    });
  });

  it("tolerates valueless keys and trailing separators", () => {
    expect(parseHashParams("#a&b=2&")).toEqual({ a: "", b: "2" });
  });

  it("tolerates malformed percent-encoding without throwing", () => {
    expect(parseHashParams("#bad=%E0%A4%A")).toEqual({});
  });
});

describe("serializeHashParams", () => {
  it("produces #key=value&key=value", () => {
    expect(serializeHashParams({ a: "1", b: "2" })).toBe("#a=1&b=2");
  });

  it("drops null / undefined / empty values", () => {
    expect(
      serializeHashParams({ a: "1", b: null, c: undefined, d: "" }),
    ).toBe("#a=1");
  });

  it("returns empty string when no keys survive", () => {
    expect(serializeHashParams({ a: null })).toBe("");
  });

  it("URL-encodes keys and values with special characters", () => {
    expect(serializeHashParams({ "a&b": "x y" })).toBe("#a%26b=x%20y");
  });
});

describe("parseLifeOpsRoute", () => {
  it("reports nulls for an empty hash", () => {
    expect(parseLifeOpsRoute("")).toEqual({
      section: null,
      eventId: null,
      messageId: null,
    });
  });

  it("reads section, event, and message keys when present", () => {
    expect(
      parseLifeOpsRoute(
        "#lifeops.section=calendar&lifeops.event=evt-1",
      ),
    ).toEqual({ section: "calendar", eventId: "evt-1", messageId: null });
    expect(
      parseLifeOpsRoute(
        "#lifeops.section=messages&lifeops.message=m-1",
      ),
    ).toEqual({ section: "messages", eventId: null, messageId: "m-1" });
  });

  it("rejects unknown sections but keeps ids so the app can decide what to do", () => {
    expect(
      parseLifeOpsRoute("#lifeops.section=bogus&lifeops.event=evt-1"),
    ).toEqual({ section: null, eventId: "evt-1", messageId: null });
  });
});

describe("parseAutomationsRoute", () => {
  it("reports null when no trigger is in the hash", () => {
    expect(parseAutomationsRoute("")).toEqual({ triggerId: null });
    expect(parseAutomationsRoute("#lifeops.section=calendar")).toEqual({
      triggerId: null,
    });
  });

  it("reads an automations.trigger=<id>", () => {
    expect(parseAutomationsRoute("#automations.trigger=abc-123")).toEqual({
      triggerId: "abc-123",
    });
  });
});

describe("buildLifeOpsHash", () => {
  it("adds a LifeOps section + event to an empty hash", () => {
    expect(
      buildLifeOpsHash("", { section: "calendar", eventId: "evt-1" }),
    ).toBe("#lifeops.section=calendar&lifeops.event=evt-1");
  });

  it("preserves unrelated keys (e.g. automations.trigger)", () => {
    const next = buildLifeOpsHash(
      "#automations.trigger=abc",
      { section: "messages", messageId: "m-1" },
    );
    expect(next).toContain("automations.trigger=abc");
    expect(next).toContain("lifeops.section=messages");
    expect(next).toContain("lifeops.message=m-1");
  });

  it("drops keys when set to null (close detail view)", () => {
    const hash = buildLifeOpsHash(
      "#lifeops.section=calendar&lifeops.event=evt-1",
      { eventId: null },
    );
    expect(hash).toBe("#lifeops.section=calendar");
  });

  it("is undefined-tolerant — missing fields are not touched", () => {
    expect(
      buildLifeOpsHash("#lifeops.section=calendar&lifeops.event=evt-1", {}),
    ).toBe("#lifeops.section=calendar&lifeops.event=evt-1");
  });
});

describe("buildAutomationsHash", () => {
  it("adds and clears the trigger id without disturbing other keys", () => {
    expect(
      buildAutomationsHash("#lifeops.section=overview", { triggerId: "t-1" }),
    ).toContain("automations.trigger=t-1");
    expect(
      buildAutomationsHash(
        "#automations.trigger=t-1&lifeops.section=overview",
        { triggerId: null },
      ),
    ).toBe("#lifeops.section=overview");
  });
});
