import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  computeOverdueFollowups: vi.fn(),
  FOLLOWUP_DEFAULT_THRESHOLD_DAYS: 30,
}));

vi.mock("../followup-tracker.js", () => ({
  computeOverdueFollowups: mocks.computeOverdueFollowups,
  FOLLOWUP_DEFAULT_THRESHOLD_DAYS: mocks.FOLLOWUP_DEFAULT_THRESHOLD_DAYS,
}));

import { listOverdueFollowupsAction } from "./listOverdueFollowups";

const runtime = {};

function overdueEntries(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    displayName: `Contact ${i + 1}`,
    lastContactedAt: "2026-07-01T10:00:00.000Z",
    daysOverdue: i + 1,
    thresholdDays: 30,
  }));
}

function digest(overdue: unknown[]) {
  return { generatedAt: "2026-08-01T00:00:00.000Z", overdue };
}

async function run(params: Record<string, unknown> | undefined) {
  return listOverdueFollowupsAction.handler(
    runtime,
    {},
    {},
    {
      parameters: params,
    },
  );
}

describe("listOverdueFollowupsAction", () => {
  it("is an OWNER-gated read-only action", () => {
    expect(listOverdueFollowupsAction.name).toBe("LIST_OVERDUE_FOLLOWUPS");
    expect(listOverdueFollowupsAction.roleGate).toEqual({ minRole: "OWNER" });
  });

  it("uses the default threshold when no override is provided", async () => {
    mocks.computeOverdueFollowups.mockResolvedValue(digest([]));
    await run(undefined);
    expect(mocks.computeOverdueFollowups).toHaveBeenCalledWith(
      runtime,
      expect.any(Number),
      30,
    );
  });

  it("accepts a numeric string threshold override", async () => {
    mocks.computeOverdueFollowups.mockResolvedValue(digest([]));
    await run({ thresholdDays: "7" });
    expect(mocks.computeOverdueFollowups).toHaveBeenCalledWith(
      runtime,
      expect.any(Number),
      7,
    );
  });

  it("falls back to the default for zero, negative, and non-numeric thresholds", async () => {
    mocks.computeOverdueFollowups.mockResolvedValue(digest([]));
    for (const bad of ["0", "-3", "abc", "   ", 0]) {
      await run({ thresholdDays: bad });
      expect(mocks.computeOverdueFollowups).toHaveBeenLastCalledWith(
        runtime,
        expect.any(Number),
        30,
      );
    }
  });

  it("reports when nothing is overdue", async () => {
    mocks.computeOverdueFollowups.mockResolvedValue(digest([]));
    const result = await run(undefined);
    expect(result.success).toBe(true);
    expect(result.text).toBe("No overdue follow-ups.");
  });

  it("formats one line per overdue contact", async () => {
    mocks.computeOverdueFollowups.mockResolvedValue(
      digest([
        {
          displayName: "Carol Patel",
          lastContactedAt: "2026-06-01T09:00:00.000Z",
          daysOverdue: 30,
          thresholdDays: 30,
        },
      ]),
    );
    const result = await run(undefined);
    expect(result.text).toBe(
      "Carol Patel: last contacted 2026-06-01T09:00:00.000Z (+30d over 30d threshold)",
    );
    expect(result.data.digest.overdue).toHaveLength(1);
  });

  it("slices the overdue list when a limit override is provided", async () => {
    mocks.computeOverdueFollowups.mockResolvedValue(digest(overdueEntries(3)));
    const result = await run({ limit: "2" });
    expect(
      result.data.digest.overdue.map(
        (e: { displayName: string }) => e.displayName,
      ),
    ).toEqual(["Contact 1", "Contact 2"]);
  });

  it("floors fractional limits", async () => {
    mocks.computeOverdueFollowups.mockResolvedValue(digest(overdueEntries(3)));
    const result = await run({ limit: "1.9" });
    expect(result.data.digest.overdue).toHaveLength(1);
  });

  it("treats a zero or invalid limit as no limit", async () => {
    mocks.computeOverdueFollowups.mockResolvedValue(digest(overdueEntries(3)));
    const zero = await run({ limit: "0" });
    expect(zero.data.digest.overdue).toHaveLength(3);
    const invalid = await run({ limit: "nope" });
    expect(invalid.data.digest.overdue).toHaveLength(3);
  });

  it("preserves the rest of the digest alongside the sliced overdue list", async () => {
    mocks.computeOverdueFollowups.mockResolvedValue(digest(overdueEntries(2)));
    const result = await run({ limit: "1" });
    expect(result.data.digest.generatedAt).toBe("2026-08-01T00:00:00.000Z");
    expect(result.data.digest.overdue).toHaveLength(1);
  });
});
