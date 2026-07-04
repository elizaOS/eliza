import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  nextUnansweredQuestion,
  parseCategories,
  parsePreferredName,
  parseRelationships,
  parseTimeWindow,
  parseTimezone,
  setChannelInspector,
  validateChannel,
} from "../src/lifeops/first-run/questions.js";

/**
 * First-run onboarding parsers capture owner facts (#8833). Each must reject
 * malformed input to null rather than coerce it, and channel validation must
 * always degrade to in-app with a warning rather than route to a dead channel.
 */

const runtime = {} as IAgentRuntime;
afterEach(() => setChannelInspector(null));

describe("scalar parsers", () => {
  it("parsePreferredName trims and bounds length", () => {
    expect(parsePreferredName("  Bob ")).toBe("Bob");
    expect(parsePreferredName("")).toBeNull();
    expect(parsePreferredName("x".repeat(61))).toBeNull();
    expect(parsePreferredName(42)).toBeNull();
  });

  it("parseTimezone trims, bounds length, rejects non-strings", () => {
    expect(parseTimezone(" America/New_York ")).toBe("America/New_York");
    expect(parseTimezone("")).toBeNull();
    expect(parseTimezone("z".repeat(65))).toBeNull();
    expect(parseTimezone(null)).toBeNull();
  });
});

describe("parseTimeWindow", () => {
  it("accepts a well-ordered HH:MM window and rejects malformed ones", () => {
    expect(parseTimeWindow({ startLocal: "06:00", endLocal: "11:00" })).toEqual(
      {
        startLocal: "06:00",
        endLocal: "11:00",
      },
    );
    expect(
      parseTimeWindow({ startLocal: "11:00", endLocal: "06:00" }),
    ).toBeNull();
    expect(
      parseTimeWindow({ startLocal: "6:00", endLocal: "11:00" }),
    ).toBeNull();
    expect(parseTimeWindow({ startLocal: "06:00" })).toBeNull();
    expect(parseTimeWindow("nope")).toBeNull();
  });
});

describe("parseCategories", () => {
  it("lowercases, filters to the allowed set, ignores junk", () => {
    expect(parseCategories(["Inbox Triage", "follow-ups", "bogus", 7])).toEqual(
      ["inbox triage", "follow-ups"],
    );
    expect(parseCategories("not-an-array")).toBeNull();
    expect(parseCategories([])).toEqual([]);
  });
});

describe("parseRelationships", () => {
  it("keeps named entries with a positive cadence, caps at 5", () => {
    expect(
      parseRelationships([
        { name: "Mom", cadenceDays: 7.9 },
        { name: "", cadenceDays: 3 },
        { name: "Dad", cadenceDays: 0 },
      ]),
    ).toEqual([{ name: "Mom", cadenceDays: 7 }]);
    expect(
      parseRelationships(
        Array.from({ length: 8 }, (_, i) => ({
          name: `p${i}`,
          cadenceDays: 1,
        })),
      ),
    ).toHaveLength(5);
    expect(parseRelationships("x")).toBeNull();
  });
});

describe("nextUnansweredQuestion", () => {
  it("advances as answers are supplied", () => {
    const first = nextUnansweredQuestion({});
    expect(first).not.toBeNull();
    expect(typeof first?.id).toBe("string");
    // Answering the first question must not return that same question again.
    const next = nextUnansweredQuestion({ [first?.id]: "answered" });
    expect(next?.id).not.toBe(first?.id);
  });
});

describe("validateChannel", () => {
  it("defaults to in_app for empty input", () => {
    expect(validateChannel("", runtime)).toMatchObject({
      channel: "in_app",
      fallbackToInApp: true,
    });
  });

  it("falls back when a channel is unregistered", () => {
    const res = validateChannel("slack", runtime);
    expect(res).toMatchObject({
      channel: "in_app",
      registered: false,
      fallbackToInApp: true,
    });
  });

  it("keeps a registered-but-disconnected channel with a fallback warning", () => {
    const res = validateChannel("push", runtime);
    expect(res).toMatchObject({
      channel: "push",
      registered: true,
      connected: false,
      fallbackToInApp: true,
    });
    expect(res.warning).toMatch(/disconnected/);
  });

  it("passes a connected channel through cleanly (injected inspector)", () => {
    setChannelInspector({
      isRegistered: (c) => c === "discord",
      isConnected: (c) => c === "discord",
    });
    expect(validateChannel("discord", runtime)).toEqual({
      channel: "discord",
      registered: true,
      connected: true,
      fallbackToInApp: false,
    });
  });
});
