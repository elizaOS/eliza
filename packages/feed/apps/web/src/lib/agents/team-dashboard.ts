import "server-only";

import { db, eq, users } from "@feed/db";
import { getUserPositionsSnapshot } from "@/lib/markets/user-positions";
import { listOwnedAgentSummaries } from "./owned-agent-summaries";
import type { TeamDashboardData } from "./team-dashboard-types";
import { buildTeamTradingSummary } from "./team-trading-summary";

export type {
  TeamDashboardAgent,
  TeamDashboardData,
} from "./team-dashboard-types";

export async function getTeamDashboardData({
  ownerId,
  ownerName,
}: {
  ownerId: string;
  ownerName: string;
}): Promise<TeamDashboardData> {
  const [ownerRecord, agents, positions] = await Promise.all([
    db
      .select({
        virtualBalance: users.virtualBalance,
        lifetimePnL: users.lifetimePnL,
      })
      .from(users)
      .where(eq(users.id, ownerId))
      .limit(1)
      .then((rows) => rows[0] ?? null),
    listOwnedAgentSummaries(ownerId),
    getUserPositionsSnapshot({
      userId: ownerId,
      type: "all",
      status: "open",
      viewerUserId: ownerId,
    }),
  ]);

  if (!ownerRecord) {
    throw new Error(`Owner ${ownerId} not found`);
  }

  const openPositionsByAgentId = new Map<string, number>();

  for (const position of positions.perpetuals.positions) {
    if (!position.isAgentPosition || !position.agentId) {
      continue;
    }
    openPositionsByAgentId.set(
      position.agentId,
      (openPositionsByAgentId.get(position.agentId) ?? 0) + 1,
    );
  }

  for (const position of positions.predictions.positions) {
    if (!position.isAgentPosition || !position.agentId) {
      continue;
    }
    openPositionsByAgentId.set(
      position.agentId,
      (openPositionsByAgentId.get(position.agentId) ?? 0) + 1,
    );
  }

  return {
    agents: agents.map((agent) => ({
      ...agent,
      displayName: agent.name,
      openPositions: openPositionsByAgentId.get(agent.id) ?? 0,
    })),
    summary: buildTeamTradingSummary({
      ownerId,
      ownerName,
      ownerBalance: {
        balance: Number(ownerRecord.virtualBalance ?? 0),
        lifetimePnL: Number(ownerRecord.lifetimePnL ?? 0),
      },
      positions,
      agents,
    }),
  };
}
