import { expect, it } from "vitest";
import { describeOnceAt } from "../src/triggers/humanize.ts";

// Live :5325 2026-10-30: TRIGGER_CREATE returned "in 20 minutes" for a
// 09:01:14Z fire at 01:41 PDT, and the evaluator told the user "Set for
// 1:01 AM" (tj-f85ef1c139592a); the 30-minute update came back as "1:21 AM"
// for a 2:11am fire (tj-f88c3965ed6ec9). The countdown now names the clock.
it("names the local clock time beside a near-term countdown", () => {
  const now = Date.parse("2026-10-30T08:41:14.410Z");
  const zone = "America/Los_Angeles";
  expect(describeOnceAt("2026-10-30T09:01:14.410Z", now, zone)).toBe(
    "in 20 minutes, at 2:01am",
  );
  expect(describeOnceAt("2026-10-30T09:11:25.589Z", now, zone)).toBe(
    "in 30 minutes, at 2:11am",
  );
  expect(describeOnceAt("2026-10-30T08:42:20.000Z", now, zone)).toBe(
    "in a minute, at 1:42am",
  );
  expect(describeOnceAt("2026-10-30T08:41:44.410Z", now, zone)).toBe(
    "in under a minute",
  );
  expect(describeOnceAt("2026-10-30T17:50:00.000Z", now, zone)).toBe(
    "today at 10:50am",
  );
});
