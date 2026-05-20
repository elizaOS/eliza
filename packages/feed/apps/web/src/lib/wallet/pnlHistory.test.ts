import { describe, expect, it } from "bun:test";
import {
  buildPnlMetricIdentityMap,
  buildScopedPnlHistoryPoints,
  getHourBoundary,
} from "./pnlHistory";

describe("buildScopedPnlHistoryPoints", () => {
  it("aggregates snapshots across the full team scope and appends a live point", () => {
    const now = new Date("2026-03-20T20:45:00.000Z");
    const points = buildScopedPnlHistoryPoints({
      now,
      scopeUserIds: ["owner-1", "agent-1"],
      snapshots: [
        {
          userId: "owner-1",
          snapshotAt: new Date("2026-03-20T18:00:00.000Z"),
          currentPnL: 10,
        },
        {
          userId: "agent-1",
          snapshotAt: new Date("2026-03-20T18:00:00.000Z"),
          currentPnL: 5,
        },
        {
          userId: "owner-1",
          snapshotAt: new Date("2026-03-20T19:00:00.000Z"),
          currentPnL: 12,
        },
        {
          userId: "agent-1",
          snapshotAt: new Date("2026-03-20T19:00:00.000Z"),
          currentPnL: 8,
        },
      ],
      liveMetricsByUserId: new Map([
        [
          "owner-1",
          {
            userId: "owner-1",
            lifetimePnL: 0,
            unrealizedPnL: 0,
            currentPnL: 14,
          },
        ],
        [
          "agent-1",
          {
            userId: "agent-1",
            lifetimePnL: 0,
            unrealizedPnL: 0,
            currentPnL: 9,
          },
        ],
      ]),
    });

    expect(points).toEqual([
      { time: new Date("2026-03-20T18:00:00.000Z").getTime(), value: 15 },
      { time: new Date("2026-03-20T19:00:00.000Z").getTime(), value: 20 },
      { time: now.getTime(), value: 23 },
    ]);
  });

  it("isolates a single agent scope from team snapshots", () => {
    const points = buildScopedPnlHistoryPoints({
      scopeUserIds: ["agent-2"],
      snapshots: [
        {
          userId: "owner-1",
          snapshotAt: new Date("2026-03-20T18:00:00.000Z"),
          currentPnL: 10,
        },
        {
          userId: "agent-2",
          snapshotAt: new Date("2026-03-20T18:00:00.000Z"),
          currentPnL: -3,
        },
      ],
    });

    expect(points).toEqual([
      { time: new Date("2026-03-20T18:00:00.000Z").getTime(), value: -3 },
    ]);
  });
});

describe("getHourBoundary", () => {
  it("normalizes dates to the top of the UTC hour", () => {
    expect(
      getHourBoundary(new Date("2026-03-20T20:45:31.222Z")).toISOString(),
    ).toBe("2026-03-20T20:00:00.000Z");
  });
});

describe("buildPnlMetricIdentityMap", () => {
  it("maps privy aliases back to the canonical user id", () => {
    const result = buildPnlMetricIdentityMap([
      {
        id: "owner-1",
        lifetimePnL: "12",
        privyId: "did:privy:owner-1",
      },
      {
        id: "agent-1",
        lifetimePnL: "5",
        privyId: null,
      },
    ]);

    expect(result.positionUserIds).toEqual([
      "owner-1",
      "did:privy:owner-1",
      "agent-1",
    ]);
    expect(result.aliasToCanonicalUserId.get("owner-1")).toBe("owner-1");
    expect(result.aliasToCanonicalUserId.get("did:privy:owner-1")).toBe(
      "owner-1",
    );
    expect(result.aliasToCanonicalUserId.get("agent-1")).toBe("agent-1");
  });
});
