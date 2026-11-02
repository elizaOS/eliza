/** Abbreviated month names are judged like full ones by the current-time guard. */
import type { StateData } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { statedTimeIsUngrounded } from "./time-observations.ts";

// Friday, September 11, 2026 at 11:18 AM EDT (the live block in the module doc).
const providers = {
  CURRENT_TIME: {
    data: {
      humanReadable: "Friday, September 11, 2026 at 11:18:30 AM EDT",
      date: "2026-09-11",
      iso: "2026-09-11T15:18:30.000Z",
      timeZone: "America/New_York",
      dayOfWeek: "Friday",
    },
  },
} as unknown as StateData["providers"];

const judge = (reply: string) =>
  statedTimeIsUngrounded({ reply, request: "What's the date?", providers });

describe("statedTimeIsUngrounded with abbreviated months", () => {
  it.each([
    "It's Sunday, Nov 22, 2026 at 5:01 PM EST.",
    "It's Nov 22, 2026.",
    "Today is Nov. 22.",
    "It's Sept 12.",
    "It's Sep 11, 2025.",
  ])("rejects the ungrounded reply %j", (reply) => {
    expect(judge(reply)).toBe(true);
  });

  it.each([
    "It's Friday, Sep 11, 2026 at 11:18 AM EDT.",
    "It's Sept. 11.",
    "Today is Sep 11th, 2026.",
  ])("accepts the grounded reply %j", (reply) => {
    expect(judge(reply)).toBe(false);
  });

  it("still judges full month names", () => {
    expect(judge("It's November 22, 2026.")).toBe(true);
    expect(judge("It's September 11, 2026.")).toBe(false);
  });
});
