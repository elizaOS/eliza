import { describe, expect, it } from "bun:test";
import { buildPnlHistoryUrl } from "./usePnlHistory";

describe("buildPnlHistoryUrl", () => {
  it("builds a team scope history request without an entity id", () => {
    expect(
      buildPnlHistoryUrl({
        scope: "team",
        timeframe: "1D",
        userId: "owner-1",
      }),
    ).toBe("/api/users/owner-1/pnl-history?range=1D&scope=team");
  });

  it("builds an owner scope history request", () => {
    expect(
      buildPnlHistoryUrl({
        scope: "owner",
        timeframe: "4H",
        userId: "owner-1",
      }),
    ).toBe("/api/users/owner-1/pnl-history?range=4H&scope=owner");
  });

  it("builds an agent scope history request that includes the entity id", () => {
    expect(
      buildPnlHistoryUrl({
        entityId: "agent-7",
        scope: "agent",
        timeframe: "1W",
        userId: "owner-1",
      }),
    ).toBe(
      "/api/users/owner-1/pnl-history?range=1W&scope=agent&entityId=agent-7",
    );
  });
});
