/**
 * Unit tests for proactive planner event safe date sorting.
 */
import { describe, expect, it } from "vitest";

describe("proactive-planner event date sorting", () => {
  it("maintains strict total ordering when startAt contains invalid dates", () => {
    const events = [
      {
        id: "evt-1",
        title: "Event 1",
        startAt: "2026-05-01T14:00:00.000Z",
      },
      {
        id: "evt-invalid",
        title: "Event Invalid",
        startAt: "not-a-date",
      },
      {
        id: "evt-2",
        title: "Event 2",
        startAt: "2026-05-01T16:00:00.000Z",
      },
    ];

    events.sort((a, b) => {
      const aTime = Number.isFinite(new Date(a.startAt).getTime())
        ? new Date(a.startAt).getTime()
        : 0;
      const bTime = Number.isFinite(new Date(b.startAt).getTime())
        ? new Date(b.startAt).getTime()
        : 0;
      return aTime - bTime;
    });

    expect(events).toHaveLength(3);
    expect(events[0]?.id).toBe("evt-invalid");
    expect(events[1]?.id).toBe("evt-1");
    expect(events[2]?.id).toBe("evt-2");
  });
});
