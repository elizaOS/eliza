/** The current-time question guard recognizes "What time is it now?". */
import type { StateData } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  groundedCurrentTimeReply,
  requestAsksCurrentTime,
  statedTimeIsUngrounded,
} from "./time-observations.ts";

// Live 2026-09-11 incident documented in time-observations.ts: the provider
// observed Friday, September 11, 2026 at 11:18:30 AM EDT; the model answered
// "Sunday, November 22, 2026 at 5:01:28 PM EST".
const providers: StateData["providers"] = {
  CURRENT_TIME: {
    data: {
      humanReadable: "Friday, September 11, 2026 at 11:18:30 AM EDT",
      date: "2026-09-11",
      iso: "2026-09-11T15:18:30.000Z",
      timeZone: "America/New_York",
      dayOfWeek: "Friday",
    },
    values: {
      currentTime: "2026-09-11T15:18:30.000Z",
      currentDate: "2026-09-11",
      timeZone: "America/New_York",
      dayOfWeek: "Friday",
    },
  },
};

const invented = "It's Sunday, November 22, 2026 at 5:01:28 PM EST.";
const grounded = "It's Friday, September 11, 2026 at 11:18:30 AM EDT.";

describe("current-time question guard", () => {
  it("recognizes 'What time is it now?' and flags an invented time", () => {
    expect(requestAsksCurrentTime("What time is it now?")).toBe(true);
    expect(
      statedTimeIsUngrounded({
        reply: invented,
        request: "What time is it now?",
        providers,
      }),
    ).toBe(true);
    expect(groundedCurrentTimeReply(providers)).toBe(grounded);
  });

  it("does not recognize 'now' starting a subordinate clause", () => {
    expect(
      requestAsksCurrentTime("What time is it now that the meeting has ended?"),
    ).toBe(false);
  });

  it("still recognizes the bare and 'right now' wordings", () => {
    for (const request of ["What time is it?", "What time is it right now?"]) {
      expect(requestAsksCurrentTime(request)).toBe(true);
      expect(
        statedTimeIsUngrounded({ reply: invented, request, providers }),
      ).toBe(true);
    }
  });

  it("does not flag a grounded answer to 'What time is it now?'", () => {
    expect(
      statedTimeIsUngrounded({
        reply: grounded,
        request: "What time is it now?",
        providers,
      }),
    ).toBe(false);
  });
});
