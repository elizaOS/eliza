/**
 * Unit tests for the browser `cron-parser` shim's field grammar. The suite
 * exercises the real shim module (not a mock) and asserts it accepts the same
 * list/range/step syntax the shipped Triggers form relies on while still
 * rejecting out-of-range, inverted, and garbage fields. The accepted set mirrors
 * the server scheduler's `parseCronExpression` verdict (in
 * `packages/core/src/services/triggerScheduling.ts`) for the five-field
 * expressions the Triggers UI validation path feeds through this shim, so the
 * form neither blocks a schedule the backend runs nor saves one it never runs.
 */
import { describe, expect, it } from "vitest";

import { CronExpressionParser } from "./cron-parser";

describe("cron-parser shim field grammar", () => {
  const validExpressions = [
    "0,30 * * * *",
    "0 9 * * 1-5",
    "0 0-11/2 * * *",
    "15,45 8-17 * * 1-5",
    "*/5 * * * *",
    "0 9 * * *",
    "0-59 * * * *",
    "*/60 * * * *",
    // Value-steps (`N/step`): from N to the field max every step. The server
    // scheduler accepts these; the shim used to reject them, disabling the
    // Triggers submit button for the common "every 15 minutes from :00" form.
    "0/15 * * * *",
    "5/15 * * * *",
    "9/2 9-17 * * *",
    "0 0 * * 7",
  ];

  it.each(validExpressions)("accepts valid recurring schedule %s", (expr) => {
    expect(() => CronExpressionParser.parse(expr)).not.toThrow();
  });

  const invalidExpressions: Array<[string, string]> = [
    ["60 * * * *", "minute out of range"],
    ["0,30,60 * * * *", "list element out of range"],
    ["5-2 * * * *", "inverted range"],
    ["*/0 * * * *", "zero step"],
    ["0-11/0 * * * *", "zero range-step"],
    ["abc * * * *", "non-numeric garbage"],
    ["0, * * * *", "trailing empty list element"],
    ["0 9 * *", "only four fields"],
    ["8 25 * * *", "hour out of range"],
    ["5/0 * * * *", "zero value-step"],
    ["60/5 * * * *", "value-step base out of range"],
    ["5/2/3 * * * *", "double step separator"],
    // Named tokens are rejected on purpose: the server scheduler
    // (`parseCronExpression`) rejects them too, so accepting them here would
    // save a trigger the backend never runs.
    ["0 0 * * MON", "named day-of-week token"],
  ];

  it.each(invalidExpressions)("rejects %s (%s)", (expr) => {
    expect(() => CronExpressionParser.parse(expr)).toThrow();
  });

  it("keeps the iterator surface the Triggers preview consumes", () => {
    const from = new Date("2024-01-01T00:00:00.000Z");
    const schedule = CronExpressionParser.parse("0 9 * * 1-5", {
      currentDate: from,
    });
    const next = schedule.next().toDate();
    expect(next).toBeInstanceOf(Date);
    expect(next.getTime()).toBeGreaterThan(from.getTime());
  });
});
