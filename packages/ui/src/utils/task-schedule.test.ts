import { describe, expect, it } from "vitest";
import { decodeScheduleTags, encodeScheduleTags } from "./task-schedule";

describe("encodeScheduleTags", () => {
  it("emits no tags for once-off tasks", () => {
    expect(encodeScheduleTags("once", "0 9 * * *", "evt")).toEqual([]);
  });

  it("encodes recurring schedules with the cron expression", () => {
    expect(encodeScheduleTags("recurring", "0 9 * * 1-5", "")).toEqual([
      "schedule:0 9 * * 1-5",
    ]);
  });

  it("encodes events", () => {
    expect(encodeScheduleTags("event", "", "email.received")).toEqual([
      "event:email.received",
    ]);
  });

  it("ignores empty cron / event values", () => {
    expect(encodeScheduleTags("recurring", "  ", "")).toEqual([]);
    expect(encodeScheduleTags("event", "", "  ")).toEqual([]);
  });
});

describe("decodeScheduleTags", () => {
  it("round-trips recurring", () => {
    const encoded = encodeScheduleTags("recurring", "0 9 * * 1-5", "");
    expect(decodeScheduleTags(encoded)).toEqual({
      kind: "recurring",
      cronExpression: "0 9 * * 1-5",
      eventName: "",
    });
  });

  it("round-trips events", () => {
    const encoded = encodeScheduleTags("event", "", "email.received");
    expect(decodeScheduleTags(encoded)).toEqual({
      kind: "event",
      cronExpression: "",
      eventName: "email.received",
    });
  });

  it("defaults to once for unknown / empty tags", () => {
    expect(decodeScheduleTags(undefined)).toEqual({
      kind: "once",
      cronExpression: "",
      eventName: "",
    });
    expect(decodeScheduleTags(["unrelated:foo"])).toEqual({
      kind: "once",
      cronExpression: "",
      eventName: "",
    });
  });
});
