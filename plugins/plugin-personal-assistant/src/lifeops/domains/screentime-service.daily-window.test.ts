/**
 * ScreenTimeDomain.getScreenTimeDaily's read window. Deterministic: the row
 * collector is replaced by a recorder so the test pins exactly which instant
 * range a civil date maps to, with and without the owner's time zone.
 */

import { describe, expect, it, vi } from "vitest";
import { ScreenTimeDomain } from "./screentime-service.ts";

function domain() {
  const screenTime = new ScreenTimeDomain(
    { agentId: () => "agent-1" } as never,
    {} as never,
  );
  const collect = vi
    .spyOn(screenTime, "collectScreenTimeRows")
    .mockResolvedValue([]);
  return { screenTime, collect };
}

describe("getScreenTimeDaily window", () => {
  it("rejects malformed civil dates before collecting rows in any zone", async () => {
    const { screenTime, collect } = domain();
    for (const date of ["2026-13-01", "2026-00-01", "2026-10-00"]) {
      await expect(
        screenTime.getScreenTimeDaily({
          date,
          timeZone: "America/Los_Angeles",
        }),
      ).rejects.toThrow("date must be a valid");
    }
    expect(collect).not.toHaveBeenCalled();
  });
  it("reads the owner's local day when given a time zone", async () => {
    const { screenTime, collect } = domain();

    await screenTime.getScreenTimeDaily({
      date: "2026-10-06",
      timeZone: "America/Los_Angeles",
    });

    expect(collect).toHaveBeenCalledWith(
      expect.objectContaining({
        since: "2026-10-06T07:00:00.000Z",
        until: "2026-10-07T06:59:59.999Z",
      }),
    );
  });

  it("covers a 25-hour local day across the DST change", async () => {
    const { screenTime, collect } = domain();

    await screenTime.getScreenTimeDaily({
      date: "2026-11-01",
      timeZone: "America/Los_Angeles",
    });

    expect(collect).toHaveBeenCalledWith(
      expect.objectContaining({
        since: "2026-11-01T07:00:00.000Z",
        until: "2026-11-02T07:59:59.999Z",
      }),
    );
  });

  it("keeps the UTC day without a time zone", async () => {
    const { screenTime, collect } = domain();

    await screenTime.getScreenTimeDaily({ date: "2026-10-06" });

    expect(collect).toHaveBeenCalledWith(
      expect.objectContaining({
        since: "2026-10-06T00:00:00.000Z",
        until: "2026-10-06T23:59:59.999Z",
      }),
    );
  });
});
