import { describe, expect, test } from "bun:test";
import {
  getDigestWindowStart,
  isDigestDue,
} from "../../../apps/web/src/lib/services/notification-digest-service";

describe("notification digest scheduling helpers", () => {
  const now = new Date("2026-03-18T15:00:00.000Z");

  test("computes the correct hourly, daily, and weekly windows", () => {
    expect(getDigestWindowStart(now, "hourly").toISOString()).toBe(
      "2026-03-18T14:00:00.000Z",
    );
    expect(getDigestWindowStart(now, "daily").toISOString()).toBe(
      "2026-03-17T15:00:00.000Z",
    );
    expect(getDigestWindowStart(now, "weekly").toISOString()).toBe(
      "2026-03-11T15:00:00.000Z",
    );
  });

  test("treats users with no prior digest as due immediately", () => {
    expect(
      isDigestDue({
        now,
        frequency: "daily",
        lastSentAt: null,
      }),
    ).toBe(true);
  });

  test("waits for the full window before sending another digest", () => {
    expect(
      isDigestDue({
        now,
        frequency: "hourly",
        lastSentAt: new Date("2026-03-18T14:30:00.000Z"),
      }),
    ).toBe(false);

    expect(
      isDigestDue({
        now,
        frequency: "weekly",
        lastSentAt: new Date("2026-03-11T14:59:59.000Z"),
      }),
    ).toBe(true);
  });
});
