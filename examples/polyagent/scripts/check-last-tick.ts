#!/usr/bin/env bun

/**
 * Check when the last agent tick ran
 */

import { db } from "@polyagent/db";
import { agentLogs, games, users } from "@polyagent/db/schema";
import { desc, eq, sql } from "drizzle-orm";

async function checkLastTick() {
  console.log("🕐 Checking last agent tick times...\n");

  try {
    // 1. Check game tick
    console.log("1️⃣  Game Tick:");
    console.log("=".repeat(80));

    const game = await db
      .select({
        id: games.id,
        currentDay: games.currentDay,
        lastTickAt: games.lastTickAt,
        isRunning: games.isRunning,
      })
      .from(games)
      .where(eq(games.isContinuous, true))
      .limit(1);

    if (game[0]) {
      const lastTick = game[0].lastTickAt
        ? `${getTimeAgo(game[0].lastTickAt)} (${game[0].lastTickAt.toISOString()})`
        : "never";
      console.log(`Game: ${game[0].id}`);
      console.log(`Last Tick: ${lastTick}`);
      console.log(`Status: ${game[0].isRunning ? "RUNNING" : "PAUSED"}`);
    }
    console.log("");

    // 2. Check agent last tick times from User table
    console.log("2️⃣  Agent Last Tick (from User table):");
    console.log("=".repeat(80));

    const agentsWithTicks = await db
      .select({
        id: users.id,
        username: users.username,
        agentLastTickAt: users.agentLastTickAt,
        agentStatus: users.agentStatus,
        agentPointsBalance: users.agentPointsBalance,
      })
      .from(users)
      .where(eq(users.isAgent, true))
      .orderBy(desc(users.agentLastTickAt))
      .limit(10);

    console.log("Agents with most recent ticks:");
    agentsWithTicks.forEach((agent, idx) => {
      const lastTick = agent.agentLastTickAt
        ? `${getTimeAgo(agent.agentLastTickAt)} (${agent.agentLastTickAt.toISOString()})`
        : "never";
      console.log(
        `${idx + 1}. ${agent.username} | ` +
          `Last tick: ${lastTick} | ` +
          `Status: ${agent.agentStatus} | ` +
          `Points: ${agent.agentPointsBalance}`,
      );
    });

    // Count agents by tick status
    const tickStats = await db
      .select({
        hasTickedRecently: sql<boolean>`CASE WHEN "agentLastTickAt" > NOW() - INTERVAL '1 hour' THEN true ELSE false END`,
        count: sql<number>`count(*)::int`,
      })
      .from(users)
      .where(eq(users.isAgent, true))
      .groupBy(
        sql`CASE WHEN "agentLastTickAt" > NOW() - INTERVAL '1 hour' THEN true ELSE false END`,
      );

    console.log("\nTick Statistics:");
    tickStats.forEach((stat) => {
      const label = stat.hasTickedRecently
        ? "Ticked in last hour"
        : "Not ticked recently";
      console.log(`  ${label}: ${stat.count}`);
    });
    console.log("");

    // 3. Check agent logs for tick events
    console.log("3️⃣  Recent Tick Logs:");
    console.log("=".repeat(80));

    const recentTickLogs = await db
      .select({
        agentUserId: agentLogs.agentUserId,
        username: users.username,
        type: agentLogs.type,
        level: agentLogs.level,
        message: agentLogs.message,
        createdAt: agentLogs.createdAt,
      })
      .from(agentLogs)
      .leftJoin(users, eq(agentLogs.agentUserId, users.id))
      .where(eq(agentLogs.type, "tick"))
      .orderBy(desc(agentLogs.createdAt))
      .limit(10);

    if (recentTickLogs.length > 0) {
      console.log("Most recent tick logs:");
      recentTickLogs.forEach((log, idx) => {
        const timeAgo = getTimeAgo(log.createdAt);
        console.log(
          `${idx + 1}. ${log.username} | ` + `${timeAgo} | ` + `${log.message}`,
        );
      });
    } else {
      console.log("❌ No tick logs found in AgentLog table");
    }
    console.log("");

    // 4. Summary
    console.log("4️⃣  Summary:");
    console.log("=".repeat(80));

    const anyRecentTicks = agentsWithTicks.some(
      (a) =>
        a.agentLastTickAt && Date.now() - a.agentLastTickAt.getTime() < 3600000, // 1 hour
    );

    if (anyRecentTicks) {
      console.log("✅ Agents have ticked recently");
    } else if (agentsWithTicks.some((a) => a.agentLastTickAt !== null)) {
      const mostRecent = agentsWithTicks.find(
        (a) => a.agentLastTickAt !== null,
      );
      if (mostRecent?.agentLastTickAt) {
        console.log(
          `⚠️  Last agent tick was ${getTimeAgo(mostRecent.agentLastTickAt)}`,
        );
        console.log("   Agent tick cron may not be running");
      }
    } else {
      console.log("❌ No agents have ever ticked");
      console.log(
        "   The /api/cron/agent-tick endpoint has never run successfully",
      );
    }
  } catch (error) {
    console.error("Error checking last tick:", error);
    throw error;
  }
}

function getTimeAgo(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);

  if (diffSec < 60) return `${diffSec}s ago`;
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHour < 24) return `${diffHour}h ago`;
  return `${diffDay}d ago`;
}

// Run the check
checkLastTick()
  .then(() => {
    console.log("\n✅ Check complete");
    process.exit(0);
  })
  .catch((error) => {
    console.error("\n❌ Check failed:", error);
    process.exit(1);
  });
